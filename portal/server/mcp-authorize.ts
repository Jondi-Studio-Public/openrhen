import type { StoredAgentToken } from "./agent-token-store";
import type { OauthClient } from "./mcp-oauth-store";
import { SCOPES_SUPPORTED, publicOrigin, resourceUrl, sameResource } from "./mcp-oauth";
import { sameOrigin, verifyOwnerCredential } from "./owner-auth";

/**
 * The owner's consent step of the authorization-code flow:
 * `GET /oauth/authorize` shows who is asking for what, `POST /oauth/authorize` records the owner's answer. The
 * owner must hold a valid owner credential in every owner-auth mode, because approving mints an agent token.
 */

export const AUTHORIZE_PATH = "/oauth/authorize";
const MAX_FORM_BYTES = 8 * 1024;
const MAX_STATE_LENGTH = 1024;
const CHALLENGE = /^[A-Za-z0-9_-]{43,128}$/;

export interface AuthorizeDeps {
  findClient: (clientId: string) => Promise<OauthClient | null>;
  /** True only for a valid owner credential (cookie or header). */
  isOwner: (request: Request) => Promise<boolean>;
  grantClient: (input: { client: OauthClient; scopes: string[] }) => Promise<StoredAgentToken>;
  createAuthorizationCode: (input: {
    clientId: string;
    agent: StoredAgentToken;
    redirectUri: string;
    codeChallenge: string;
    resource: string;
    scopes: string[];
  }) => Promise<{ code: string; expiresAt: Date }>;
  now: () => Date;
}

export function databaseAuthorizeDeps(): AuthorizeDeps {
  const load = async () => {
    const [{ databaseUrl }, { sqlPool }, store] = await Promise.all([
      import("./runtime-env"),
      import("./persistence/postgres/sql-pool"),
      import("./mcp-oauth-store")
    ]);
    const url = databaseUrl();
    if (!url) throw new Error("No database.");
    return { sql: sqlPool(url), store };
  };
  return {
    findClient: async (clientId) => {
      const { sql, store } = await load();
      return store.findClient(sql, clientId);
    },
    isOwner: async (request) => (await verifyOwnerCredential(request)).kind === "ok",
    grantClient: async (input) => {
      const { sql, store } = await load();
      return store.grantClient(sql, input);
    },
    createAuthorizationCode: async (input) => {
      const { sql, store } = await load();
      return store.createAuthorizationCode(sql, input);
    },
    now: () => new Date()
  };
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export type AuthorizeValidation =
  | { kind: "page-error"; message: string }
  | { kind: "redirect-error"; redirectUri: string; error: string; description: string; state: string | null }
  | {
      kind: "ok";
      client: OauthClient;
      redirectUri: string;
      codeChallenge: string;
      scopes: string[];
      state: string | null;
      resource: string;
      /** Whether the client sent `resource` (so the consent form can carry it on). */
      resourceGiven: boolean;
    };

const SINGLE = [
  "response_type",
  "client_id",
  "redirect_uri",
  "code_challenge",
  "code_challenge_method",
  "scope",
  "state",
  "resource"
];

/**
 * The checks GET and POST share. A bad client or redirect can never be answered by redirecting (the redirect
 * target is the thing in doubt), so those are page errors; everything else goes back to the client.
 */
export async function validateAuthorizeParams(
  params: URLSearchParams,
  context: { resource: string; findClient: AuthorizeDeps["findClient"] }
): Promise<AuthorizeValidation> {
  const clientId = params.get("client_id");
  const redirectUri = params.get("redirect_uri");
  if (!clientId || params.getAll("client_id").length > 1)
    return { kind: "page-error", message: "The request names no client." };
  let client: OauthClient | null;
  try {
    client = await context.findClient(clientId);
  } catch {
    return { kind: "page-error", message: "The client could not be looked up just now; try again." };
  }
  if (!client) return { kind: "page-error", message: "This client is not registered." };
  if (!redirectUri || params.getAll("redirect_uri").length > 1 || !client.redirectUris.includes(redirectUri))
    return { kind: "page-error", message: "The redirect address is not one this client registered." };

  const rawState = params.get("state");
  const state = rawState !== null && rawState.length <= MAX_STATE_LENGTH ? rawState : null;
  const fail = (error: string, description: string): AuthorizeValidation => ({
    kind: "redirect-error",
    redirectUri,
    error,
    description,
    state
  });
  if (rawState !== null && state === null) return fail("invalid_request", "state is too long.");
  for (const name of SINGLE)
    if (params.getAll(name).length > 1) return fail("invalid_request", `${name} is given twice.`);
  if (params.get("response_type") !== "code")
    return fail("unsupported_response_type", "Only response_type=code is supported.");
  const challenge = params.get("code_challenge");
  if (!challenge || !CHALLENGE.test(challenge))
    return fail("invalid_request", "code_challenge is required (43 to 128 base64url characters).");
  if (params.get("code_challenge_method") !== "S256")
    return fail("invalid_request", "code_challenge_method must be S256.");
  const resourceParam = params.get("resource");
  if (resourceParam !== null && !sameResource(resourceParam, context.resource))
    return fail("invalid_target", `This server issues tokens only for ${context.resource}.`);
  const requested = [...new Set((params.get("scope") ?? "").split(/\s+/).filter(Boolean))];
  const unknown = requested.filter((scope) => !SCOPES_SUPPORTED.includes(scope));
  if (unknown.length > 0) return fail("invalid_scope", `Unknown scope: ${unknown.join(" ")}.`);
  return {
    kind: "ok",
    client,
    redirectUri,
    codeChallenge: challenge,
    scopes: requested.length === 0 ? [...SCOPES_SUPPORTED] : requested,
    state,
    resource: context.resource,
    resourceGiven: resourceParam !== null
  };
}

function securityHeaders(): Record<string, string> {
  return {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    pragma: "no-cache",
    "x-frame-options": "DENY",
    // No form-action: browsers apply it to the redirect after the form posts, and that goes to the client.
    "content-security-policy":
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'",
    // same-origin, not no-referrer: under no-referrer Chromium sends `Origin: null` on the form POST, which
    // sameOrigin() then refuses. The page URL still never leaves this origin.
    "referrer-policy": "same-origin",
    "x-content-type-options": "nosniff"
  };
}

function page(title: string, body: string, status = 200, script = false): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="same-origin">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="/oauth-authorize.css">
</head>
<body>
<main class="oauth-page">
${body}
</main>
${script ? '<script src="/oauth-authorize.js"></script>' : ""}
</body>
</html>`;
  return new Response(html, { status, headers: securityHeaders() });
}

const errorPage = (message: string, status = 400): Response =>
  page(
    "Cannot authorize",
    `<h1>Cannot authorize</h1>\n<p class="error" role="alert">${escapeHtml(message)}</p>\n<p>Nothing was approved. Close this page and start again from the app that sent you here.</p>`,
    status
  );

function redirectTo(redirectUri: string, origin: string, values: Record<string, string | null>): Response {
  const target = new URL(redirectUri);
  for (const [key, value] of Object.entries(values)) if (value !== null) target.searchParams.set(key, value);
  target.searchParams.set("iss", origin);
  return new Response(null, {
    status: 302,
    headers: { location: target.toString(), "cache-control": "no-store", "referrer-policy": "no-referrer" }
  });
}

const hidden = (name: string, value: string) =>
  `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;

function signInPage(): Response {
  return page(
    "Sign in to approve",
    `<h1>Sign in</h1>
<p>An app is asking to connect to OpenRhen. Sign this browser in as the owner first, then you will see what it is asking for.</p>
<form id="sign-in" method="post" action="/api/owner/enroll">
<label>Owner token
<input type="password" name="secret" autocomplete="off"></label>
<button type="submit">Sign in</button>
</form>
<p id="sign-in-error" class="error" role="alert" hidden></p>
<noscript><p class="error">Signing in needs JavaScript.</p></noscript>`,
    200,
    true
  );
}

function consentPage(valid: Extract<AuthorizeValidation, { kind: "ok" }>): Response {
  const host = new URL(valid.redirectUri).host;
  const fields = [
    hidden("response_type", "code"),
    hidden("client_id", valid.client.clientId),
    hidden("redirect_uri", valid.redirectUri),
    hidden("code_challenge", valid.codeChallenge),
    hidden("code_challenge_method", "S256"),
    hidden("scope", valid.scopes.join(" ")),
    ...(valid.state !== null ? [hidden("state", valid.state)] : []),
    ...(valid.resourceGiven ? [hidden("resource", valid.resource)] : [])
  ].join("\n");
  const name = valid.client.clientName.trim() || valid.client.clientId;
  return page(
    "Approve connection",
    `<h1>Connect ${escapeHtml(name)}?</h1>
<p><strong>${escapeHtml(name)}</strong> wants to connect to your OpenRhen. After you approve, it returns to <code>${escapeHtml(host)}</code>.</p>
<p>It asks for these permissions:</p>
<ul class="scopes">
${valid.scopes.map((scope) => `<li><code>${escapeHtml(scope)}</code></li>`).join("\n")}
</ul>
<p>Approving makes an agent token you can see and revoke in Settings. It lets the agent change your plan directly, with every change listed and undoable; deleting things, changing settings and anything sent outward still wait for you.</p>
<form method="post" action="${AUTHORIZE_PATH}">
${fields}
<button type="submit" name="decision" value="approve">Approve</button>
<button type="submit" name="decision" value="deny" class="secondary">Deny</button>
</form>`
  );
}

async function readCappedForm(request: Request): Promise<URLSearchParams | Response> {
  const declared = request.headers.get("content-length");
  if (declared !== null && !(Number(declared) <= MAX_FORM_BYTES)) return errorPage("The request is too large.", 413);
  const type = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (type !== "application/x-www-form-urlencoded") return errorPage("Send a form.", 415);
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (reader)
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_FORM_BYTES) {
        await reader.cancel().catch(() => {});
        return errorPage("The request is too large.", 413);
      }
      chunks.push(value);
    }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

export async function handleAuthorizeRequest(
  request: Request,
  deps: AuthorizeDeps = databaseAuthorizeDeps()
): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "POST")
    return new Response("Use GET or POST.", {
      status: 405,
      headers: { allow: "GET, POST", "cache-control": "no-store" }
    });
  const origin = publicOrigin(request);
  const resource = resourceUrl(request);

  if (method === "GET") {
    const params = new URL(request.url).searchParams;
    const valid = await validateAuthorizeParams(params, { resource, findClient: deps.findClient });
    if (valid.kind === "page-error") return errorPage(valid.message);
    if (valid.kind === "redirect-error")
      return redirectTo(valid.redirectUri, origin, {
        error: valid.error,
        error_description: valid.description,
        state: valid.state
      });
    return (await deps.isOwner(request)) ? consentPage(valid) : signInPage();
  }

  if (!sameOrigin(request)) return errorPage("This form must be sent from this site (Origin must match Host).", 403);
  if (!(await deps.isOwner(request))) return errorPage("Sign in as the owner first, then approve again.", 403);
  const form = await readCappedForm(request);
  if (form instanceof Response) return form;
  const valid = await validateAuthorizeParams(form, { resource, findClient: deps.findClient });
  if (valid.kind === "page-error") return errorPage(valid.message);
  if (valid.kind === "redirect-error")
    return redirectTo(valid.redirectUri, origin, {
      error: valid.error,
      error_description: valid.description,
      state: valid.state
    });
  const decision = form.get("decision");
  if (decision === "deny")
    return redirectTo(valid.redirectUri, origin, {
      error: "access_denied",
      error_description: "The owner denied the request.",
      state: valid.state
    });
  if (decision !== "approve") return errorPage("Choose Approve or Deny.");
  try {
    const agent = await deps.grantClient({ client: valid.client, scopes: valid.scopes });
    const issued = await deps.createAuthorizationCode({
      clientId: valid.client.clientId,
      agent,
      redirectUri: valid.redirectUri,
      codeChallenge: valid.codeChallenge,
      resource: valid.resource,
      scopes: valid.scopes
    });
    return redirectTo(valid.redirectUri, origin, { code: issued.code, state: valid.state });
  } catch {
    return errorPage("The approval could not be saved just now; try again.", 503);
  }
}
