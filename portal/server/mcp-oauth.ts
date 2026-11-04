import { createHash, timingSafeEqual } from "node:crypto";
import {
  AGENT_DRIVE_WRITE_SCOPES,
  MCP_TOOL_MANIFEST,
  READ_SCOPES,
  rateLimitMessage,
  scopeCovers
} from "@openrhen/contracts";
import type { AgentPrincipal } from "./agent-tokens";
import type { StoredAgentToken } from "./agent-token-store";
import { remoteAddress, sharedFailureThrottle, type FailureThrottle } from "./agent-token-throttle";
import type { IssuedAccessToken, StoredAccessToken } from "./mcp-access-tokens";
import { ACCESS_TOKEN_TTL_SECONDS, hashAccessToken } from "./mcp-access-tokens";
import type { OauthClient, StoredAuthorizationCode, StoredRefreshToken } from "./mcp-oauth-store";
import { portalHostAllowed } from "./security/allowed-hosts";

/**
 * The OAuth side of the remote `/mcp` endpoint: this portal is both
 * the resource server and its own tiny authorization server. Metadata documents (RFC 9728, RFC 8414), the one
 * grant that is built (`client_credentials`, the long-lived agent token as `client_secret`), and the check that
 * `/mcp` makes on every request: an unexpired access token minted for this very resource (RFC 8707) whose agent
 * token is still live. The long-lived secret is accepted at the token endpoint and nowhere else.
 */

/**
 * The scopes a client may ask for, for `scopes_supported`, and what approving grants when it asks for none: every
 * read scope, every scope a served tool names, and the broad write scopes a direct-drive agent needs for those
 * tools to apply (AGENT_DRIVE_WRITE_SCOPES: saves, a settle, plan-map Inbox actions) plus agent time. Outward
 * (`act:`) and admin scopes are never here.
 */
export const SCOPES_SUPPORTED: string[] = [
  ...new Set([
    ...READ_SCOPES,
    ...MCP_TOOL_MANIFEST.flatMap((tool) => tool.scopes),
    ...AGENT_DRIVE_WRITE_SCOPES,
    "write:agent-session"
  ])
];

export const MCP_PATH = "/mcp";
export const TOKEN_PATH = "/oauth/token";
export const AUTHORIZE_PATH = "/oauth/authorize";
export const REGISTER_PATH = "/oauth/register";
export const PROTECTED_RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";
export const AUTHORIZATION_SERVER_METADATA_PATH = "/.well-known/oauth-authorization-server";

/**
 * The origin this request was addressed to, as the client sees it: Caddy terminates TLS, so the scheme comes
 * from `X-Forwarded-Proto` when it says `https` or `http`. Host is the one the client used; with
 * `PORTAL_ALLOWED_HOSTS` set the caller has already been checked against it (`hostRefusal`).
 */
export function publicOrigin(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  const url = new URL(request.url);
  const scheme = forwarded === "https" || forwarded === "http" ? forwarded : url.protocol.replace(":", "");
  const host = request.headers.get("host")?.trim().toLowerCase() || url.host;
  return `${scheme}://${host}`;
}

/** The canonical resource identifier access tokens are bound to. */
export const resourceUrl = (request: Request): string => `${publicOrigin(request)}${MCP_PATH}`;

/**
 * Whether a client's `resource` names the same URL as ours. A client sends what it was configured with, so
 * the case of scheme and host, a default port and a trailing slash are not differences (RFC 3986 section 6.2.3);
 * anything else (another path, a query, a fragment) is.
 */
export function sameResource(presented: string, canonical: string): boolean {
  const normal = (value: string): string | null => {
    try {
      const url = new URL(value);
      if (url.search || url.hash || url.username || url.password) return null;
      return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "") || "/"}`;
    } catch {
      return null;
    }
  };
  const a = normal(presented);
  return a !== null && a === normal(canonical);
}

/** Where a client finds this resource's metadata (RFC 9728 section 3: the well-known path with the resource path appended). */
export const resourceMetadataUrl = (request: Request): string =>
  `${publicOrigin(request)}${PROTECTED_RESOURCE_METADATA_PATH}${MCP_PATH}`;

const NO_STORE = { "cache-control": "no-store", pragma: "no-cache" };

export function protectedResourceMetadata(request: Request): Response {
  return Response.json(
    {
      resource: resourceUrl(request),
      authorization_servers: [publicOrigin(request)],
      scopes_supported: SCOPES_SUPPORTED,
      bearer_methods_supported: ["header"],
      resource_name: "OpenRhen"
    },
    { headers: { "cache-control": "public, max-age=300" } }
  );
}

export function authorizationServerMetadata(request: Request): Response {
  const origin = publicOrigin(request);
  return Response.json(
    {
      issuer: origin,
      token_endpoint: `${origin}${TOKEN_PATH}`,
      authorization_endpoint: `${origin}${AUTHORIZE_PATH}`,
      registration_endpoint: `${origin}${REGISTER_PATH}`,
      grant_types_supported: ["client_credentials", "authorization_code", "refresh_token"],
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
      authorization_response_iss_parameter_supported: true,
      scopes_supported: SCOPES_SUPPORTED
    },
    { headers: { "cache-control": "public, max-age=300" } }
  );
}

/** `WWW-Authenticate` for the resource: always carries `resource_metadata`; a 403 lists every scope the operation needs. */
export function bearerChallenge(
  request: Request,
  detail: { error?: "invalid_token" | "insufficient_scope"; description?: string; scopes?: string[] } = {}
): string {
  const parts = [
    ...(detail.error ? [`error="${detail.error}"`] : []),
    ...(detail.description ? [`error_description="${detail.description.replace(/"/g, "'")}"`] : []),
    ...(detail.scopes && detail.scopes.length > 0 ? [`scope="${detail.scopes.join(" ")}"`] : []),
    `resource_metadata="${resourceMetadataUrl(request)}"`
  ];
  return `Bearer ${parts.join(", ")}`;
}

export function unauthorized(request: Request, error: "invalid_token" | undefined, description: string): Response {
  return Response.json(
    { error: error ?? "unauthorized", error_description: description },
    {
      status: 401,
      // RFC 6750: a request with no credentials gets no error code, and an error description only goes with one.
      headers: { "www-authenticate": bearerChallenge(request, error ? { error, description } : {}) }
    }
  );
}

export function insufficientScope(request: Request, scopes: string[]): Response {
  return Response.json(
    { error: "insufficient_scope", error_description: `This token needs the scope ${scopes.join(" ")}.` },
    { status: 403, headers: { "www-authenticate": bearerChallenge(request, { error: "insufficient_scope", scopes }) } }
  );
}

/**
 * DNS-rebinding and cross-origin defence for `/mcp` (design section 4). A browser page cannot be an MCP client
 * here: when `Origin` is present its host must equal `Host`, and the host must be allowed (`portalHostAllowed`). Desktop and script clients send no `Origin` and pass.
 */
export function originRefusal(request: Request): Response | null {
  const host = request.headers.get("host")?.trim().toLowerCase();
  if (!portalHostAllowed(host)) return Response.json({ error: "This host is not allowed." }, { status: 403 });
  const origin = request.headers.get("origin");
  if (origin === null) return null;
  let originHost: string | null = null;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    originHost = null;
  }
  return originHost && host && originHost === host
    ? null
    : Response.json({ error: "Cross-origin requests are not allowed." }, { status: 403 });
}

export interface OauthDeps {
  /** The live agent token a hex sha256 belongs to. Throwing means the table could not be read. */
  findAgentToken: (hash: string) => Promise<StoredAgentToken | null>;
  mintAccessToken: (input: {
    agent: StoredAgentToken;
    resource: string;
    scopes: string[];
  }) => Promise<IssuedAccessToken>;
  findAccessToken: (hash: string) => Promise<StoredAccessToken | null>;
  /** The registered public client for a client_id, or null. */
  findClient: (clientId: string) => Promise<OauthClient | null>;
  /** Registers a public client; throws `OauthStoreFull` when the store is at its cap with no client to evict. */
  registerClient: (input: { clientName: string; redirectUris: string[] }) => Promise<OauthClient>;
  /** Atomically consumes a code by hash; returns the row as it was before (consumedAt non-null = replay). */
  consumeAuthorizationCode: (hash: string) => Promise<StoredAuthorizationCode | null>;
  issueRefreshToken: (input: {
    clientId: string;
    agent: StoredAgentToken;
    resource: string;
    scopes: string[];
  }) => Promise<{ token: string; expiresAt: Date }>;
  /** Atomically marks a refresh token used by hash; returns the row as it was before (usedAt non-null = replay). */
  useRefreshToken: (hash: string) => Promise<StoredRefreshToken | null>;
  revokeAgentToken: (agentTokenId: string) => Promise<void>;
  throttle: FailureThrottle;
  now: () => Date;
}

/** The production dependencies. The database layer loads on first use, so a request that never reaches it never pays. */
export function databaseOauthDeps(): OauthDeps {
  const sql = async () => {
    const [{ databaseUrl }, { sqlPool }] = await Promise.all([
      import("./runtime-env"),
      import("./persistence/postgres/sql-pool")
    ]);
    const url = databaseUrl();
    if (!url) throw new Error("No database.");
    return sqlPool(url);
  };
  return {
    findAgentToken: async (hash) => (await import("./agent-token-store")).findAgentTokenByHash(await sql(), hash),
    mintAccessToken: async (input) => (await import("./mcp-access-tokens")).createAccessToken(await sql(), input),
    findAccessToken: async (hash) => (await import("./mcp-access-tokens")).findAccessTokenByHash(await sql(), hash),
    findClient: async (clientId) => (await import("./mcp-oauth-store")).findClient(await sql(), clientId),
    registerClient: async (input) => (await import("./mcp-oauth-store")).registerClient(await sql(), input),
    consumeAuthorizationCode: async (hash) =>
      (await import("./mcp-oauth-store")).consumeAuthorizationCode(await sql(), hash),
    issueRefreshToken: async (input) => (await import("./mcp-oauth-store")).issueRefreshToken(await sql(), input),
    useRefreshToken: async (hash) => (await import("./mcp-oauth-store")).useRefreshToken(await sql(), hash),
    revokeAgentToken: async (id) => {
      await (await import("./agent-token-store")).revokeAgentToken(await sql(), id);
    },
    throttle: sharedFailureThrottle,
    now: () => new Date()
  };
}

const oauthError = (status: number, error: string, description: string, headers: Record<string, string> = {}) =>
  Response.json(
    {
      error,
      error_description: description,
      // A wait is data as well as prose, so a client does not have to parse the sentence.
      ...(headers["retry-after"] !== undefined && Number(headers["retry-after"]) > 0
        ? { retryAfterSeconds: Number(headers["retry-after"]) }
        : {})
    },
    { status, headers: { ...NO_STORE, ...headers } }
  );

const sameHash = (a: string, b: string): boolean =>
  a.length === 64 && b.length === 64 && timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));

const MAX_TOKEN_REQUEST_BYTES = 8 * 1024;

/** The body as text, or null once it passes `max` bytes; a stream is cut off there rather than read whole. */
async function readCappedText(request: Request, max: number): Promise<string | null> {
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Reads the client's id and secret from HTTP Basic (RFC 6749 section 2.3.1) or from the body. */
function clientCredentials(
  request: Request,
  form: URLSearchParams
): { id: string; secret: string } | { error: string } {
  const header = request.headers.get("authorization");
  const bodySecret = form.get("client_secret");
  if (header !== null && /^basic\s/i.test(header)) {
    if (bodySecret !== null) return { error: "Send the client secret with HTTP Basic or in the body, not both." };
    let decoded: string;
    try {
      decoded = Buffer.from(header.replace(/^basic\s+/i, ""), "base64").toString("utf8");
    } catch {
      return { error: "The Basic credentials could not be decoded." };
    }
    const colon = decoded.indexOf(":");
    if (colon < 0) return { error: "The Basic credentials are not id:secret." };
    try {
      return { id: decodeURIComponent(decoded.slice(0, colon)), secret: decodeURIComponent(decoded.slice(colon + 1)) };
    } catch {
      return { error: "The Basic credentials are not form-encoded." };
    }
  }
  const id = form.get("client_id");
  if (id === null || bodySecret === null) return { error: "client_id and client_secret are required." };
  return { id, secret: bodySecret };
}

/**
 * `POST /oauth/token`, `client_credentials` here and the two public-client grants below. The `client_secret` is a database agent token
 * (`pri_...`); `client_id` is its name (or id). The `resource` parameter is required and must be this server's
 * `/mcp`. The access token's scopes are the requested ones the agent token holds (all of them when none are
 * asked for). Failures use the shared throttle, like every other secret the portal checks.
 */
export async function handleTokenRequest(request: Request, deps: OauthDeps = databaseOauthDeps()): Promise<Response> {
  if (request.method.toUpperCase() !== "POST")
    return oauthError(405, "invalid_request", "Use POST.", { allow: "POST" });
  const address = remoteAddress(request.headers);
  const wait = deps.throttle.retryAfter(address);
  if (wait > 0)
    return oauthError(429, "temporarily_unavailable", rateLimitMessage(wait), {
      "retry-after": String(wait)
    });
  const tooLarge = () => oauthError(413, "invalid_request", "The request is too large.");
  const declared = request.headers.get("content-length");
  if (declared !== null && !(Number(declared) <= MAX_TOKEN_REQUEST_BYTES)) return tooLarge();
  const type = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (type !== "application/x-www-form-urlencoded")
    return oauthError(400, "invalid_request", "Send application/x-www-form-urlencoded.");
  const text = await readCappedText(request, MAX_TOKEN_REQUEST_BYTES);
  if (text === null) return tooLarge();
  const form = new URLSearchParams(text);
  for (const name of [
    "grant_type",
    "resource",
    "scope",
    "client_id",
    "client_secret",
    "code",
    "redirect_uri",
    "code_verifier",
    "refresh_token"
  ])
    if (form.getAll(name).length > 1) return oauthError(400, "invalid_request", `${name} is given twice.`);

  const basic = /^basic\s/i.test(request.headers.get("authorization") ?? "");
  const clientError = (status: number, description: string) =>
    oauthError(status, "invalid_client", description, basic ? { "www-authenticate": 'Basic realm="rhen"' } : {});

  const grant = form.get("grant_type");
  if (grant === "authorization_code") return authorizationCodeGrant(request, form, address, deps);
  if (grant === "refresh_token") return refreshTokenGrant(request, form, address, deps);
  if (grant !== "client_credentials")
    return oauthError(
      400,
      "unsupported_grant_type",
      "Supported grants: client_credentials, authorization_code, refresh_token."
    );
  const credentials = clientCredentials(request, form);
  if ("error" in credentials) return oauthError(400, "invalid_request", credentials.error);
  const resource = form.get("resource");
  if (resource === null) return oauthError(400, "invalid_target", "The resource parameter is required.");
  if (!sameResource(resource, resourceUrl(request)))
    return oauthError(400, "invalid_target", `This server issues tokens only for ${resourceUrl(request)}.`);

  const digest = createHash("sha256").update(credentials.secret).digest("hex");
  let agent: StoredAgentToken | null;
  try {
    agent = await deps.findAgentToken(digest);
  } catch {
    return oauthError(503, "temporarily_unavailable", "Tokens could not be checked just now; try again.");
  }
  if (!agent || !sameHash(digest, agent.tokenHash) || (credentials.id !== agent.name && credentials.id !== agent.id)) {
    deps.throttle.fail(address);
    return clientError(401, "The client id or secret is not recognised.");
  }
  // A revoked or expired token is a known secret, not a guess, so it does not count against the throttle.
  if (agent.revokedAt) return clientError(401, "The agent token was revoked.");
  if (agent.expiresAt.getTime() <= deps.now().getTime()) return clientError(401, "The agent token has expired.");

  const requested = [...new Set((form.get("scope") ?? "").split(/\s+/).filter(Boolean))];
  const scopes =
    requested.length === 0
      ? [...agent.scopes]
      : requested.filter((scope) => agent.scopes.some((held) => scopeCovers(held, scope)));
  if (scopes.length === 0)
    return oauthError(400, "invalid_scope", "The agent token holds none of the requested scopes.");

  let issued: IssuedAccessToken;
  try {
    issued = await deps.mintAccessToken({ agent, resource: resourceUrl(request), scopes });
  } catch {
    return oauthError(503, "temporarily_unavailable", "A token could not be issued just now; try again.");
  }
  return Response.json(
    {
      access_token: issued.token,
      token_type: "Bearer",
      expires_in: Math.max(
        1,
        Math.min(ACCESS_TOKEN_TTL_SECONDS, Math.floor((issued.expiresAt.getTime() - deps.now().getTime()) / 1000))
      ),
      scope: issued.scopes.join(" ")
    },
    { headers: NO_STORE }
  );
}

const S256_VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;

/** `base64url(sha256(verifier))` equals the stored challenge, compared in constant time (RFC 7636 section 4.6). */
function pkceMatches(verifier: string, challenge: string): boolean {
  const computed = Buffer.from(createHash("sha256").update(verifier).digest("base64url"));
  const stored = Buffer.from(challenge);
  return computed.length === stored.length && timingSafeEqual(computed, stored);
}

const scopesFromParam = (value: string | null): string[] => [...new Set((value ?? "").split(/\s+/).filter(Boolean))];

const grantFailed = (description: string) => oauthError(400, "invalid_grant", description);
const unavailable = (description: string) => oauthError(503, "temporarily_unavailable", description);

/** The tokens a successful code or refresh grant answers with: an access token plus a rotated refresh token. */
async function issueGrant(
  deps: OauthDeps,
  input: { clientId: string; agent: StoredAgentToken; resource: string; scopes: string[]; refreshScopes: string[] }
): Promise<Response> {
  let issued: IssuedAccessToken;
  let refresh: { token: string; expiresAt: Date };
  try {
    issued = await deps.mintAccessToken({ agent: input.agent, resource: input.resource, scopes: input.scopes });
    refresh = await deps.issueRefreshToken({
      clientId: input.clientId,
      agent: input.agent,
      resource: input.resource,
      scopes: input.refreshScopes
    });
  } catch {
    return unavailable("A token could not be issued just now; try again.");
  }
  return Response.json(
    {
      access_token: issued.token,
      token_type: "Bearer",
      expires_in: Math.max(
        1,
        Math.min(ACCESS_TOKEN_TTL_SECONDS, Math.floor((issued.expiresAt.getTime() - deps.now().getTime()) / 1000))
      ),
      refresh_token: refresh.token,
      scope: issued.scopes.join(" ")
    },
    { headers: NO_STORE }
  );
}

/** Revoking the agent token is what ends a client whose code or refresh token was replayed (RFC 9700 section 4.14). */
async function revokeAfterReplay(deps: OauthDeps, agentTokenId: string, what: string): Promise<Response> {
  try {
    await deps.revokeAgentToken(agentTokenId);
  } catch {
    return unavailable("The grant could not be revoked just now; try again.");
  }
  return grantFailed(`The ${what} was already used; the authorization was revoked.`);
}

const agentLiveError = (agent: StoredAgentToken, now: Date): string | null =>
  agent.revokedAt
    ? "The authorization was revoked."
    : agent.expiresAt.getTime() <= now.getTime()
      ? "The authorization has expired."
      : null;

/** `grant_type=authorization_code`: a public client trades its single-use code and PKCE verifier for tokens. */
async function authorizationCodeGrant(
  request: Request,
  form: URLSearchParams,
  address: string,
  deps: OauthDeps
): Promise<Response> {
  const clientId = form.get("client_id");
  const code = form.get("code");
  const redirectUri = form.get("redirect_uri");
  const verifier = form.get("code_verifier");
  if (!clientId || !code || !redirectUri || !verifier)
    return oauthError(400, "invalid_request", "client_id, code, redirect_uri and code_verifier are required.");
  if (!S256_VERIFIER.test(verifier)) return grantFailed("The code_verifier is not 43 to 128 URL-safe characters.");
  const resourceParam = form.get("resource");

  let stored: StoredAuthorizationCode | null;
  try {
    stored = await deps.consumeAuthorizationCode(createHash("sha256").update(code).digest("hex"));
  } catch {
    return unavailable("The code could not be checked just now; try again.");
  }
  if (!stored) {
    deps.throttle.fail(address);
    return grantFailed("The authorization code is not recognised.");
  }
  if (stored.consumedAt) return revokeAfterReplay(deps, stored.agentTokenId, "authorization code");
  const now = deps.now();
  if (stored.expiresAt.getTime() <= now.getTime()) return grantFailed("The authorization code has expired.");
  if (stored.clientId !== clientId) return grantFailed("The code was issued to a different client.");
  if (stored.redirectUri !== redirectUri)
    return grantFailed("The redirect_uri does not match the authorization request.");
  if (!pkceMatches(verifier, stored.codeChallenge)) {
    deps.throttle.fail(address);
    return grantFailed("The code_verifier does not match the code_challenge.");
  }
  if (resourceParam !== null && !sameResource(resourceParam, stored.resource))
    return oauthError(400, "invalid_target", "The resource does not match the authorization request.");
  if (stored.resource !== resourceUrl(request))
    return oauthError(400, "invalid_target", `This server issues tokens only for ${resourceUrl(request)}.`);
  const dead = agentLiveError(stored.agent, now);
  if (dead) return grantFailed(dead);
  const scopes = stored.scopes.filter((scope) => stored.agent.scopes.some((held) => scopeCovers(held, scope)));
  if (scopes.length === 0) return grantFailed("The authorization holds none of the granted scopes.");
  return issueGrant(deps, {
    clientId,
    agent: stored.agent,
    resource: stored.resource,
    scopes,
    refreshScopes: stored.scopes
  });
}

/** `grant_type=refresh_token`: rotates the refresh token; presenting a used one revokes the whole authorization. */
async function refreshTokenGrant(
  request: Request,
  form: URLSearchParams,
  address: string,
  deps: OauthDeps
): Promise<Response> {
  const clientId = form.get("client_id");
  const presented = form.get("refresh_token");
  if (!clientId || !presented) return oauthError(400, "invalid_request", "client_id and refresh_token are required.");
  const resourceParam = form.get("resource");

  let stored: StoredRefreshToken | null;
  try {
    stored = await deps.useRefreshToken(createHash("sha256").update(presented).digest("hex"));
  } catch {
    return unavailable("The refresh token could not be checked just now; try again.");
  }
  if (!stored) {
    deps.throttle.fail(address);
    return grantFailed("The refresh token is not recognised.");
  }
  if (stored.usedAt) return revokeAfterReplay(deps, stored.agentTokenId, "refresh token");
  const now = deps.now();
  if (stored.expiresAt.getTime() <= now.getTime()) return grantFailed("The refresh token has expired.");
  if (stored.clientId !== clientId) return grantFailed("The refresh token was issued to a different client.");
  if (resourceParam !== null && !sameResource(resourceParam, stored.resource))
    return oauthError(400, "invalid_target", "The resource does not match the original authorization.");
  if (stored.resource !== resourceUrl(request))
    return oauthError(400, "invalid_target", `This server issues tokens only for ${resourceUrl(request)}.`);
  const dead = agentLiveError(stored.agent, now);
  if (dead) return grantFailed(dead);
  const requested = scopesFromParam(form.get("scope"));
  if (requested.some((scope) => !stored.scopes.some((held) => scopeCovers(held, scope))))
    return oauthError(400, "invalid_scope", "The scope asked for is wider than the original grant.");
  const granted = (requested.length === 0 ? stored.scopes : requested).filter((scope) =>
    stored.agent.scopes.some((held) => scopeCovers(held, scope))
  );
  if (granted.length === 0) return grantFailed("The authorization holds none of the granted scopes.");
  return issueGrant(deps, {
    clientId,
    agent: stored.agent,
    resource: stored.resource,
    scopes: granted,
    refreshScopes: stored.scopes
  });
}

/**
 * Whether a redirect URI may be registered: `https` on any host, or `http` on a loopback host (`127.0.0.1`,
 * `localhost`, `[::1]`, any port) for native clients (RFC 8252). No fragment and no userinfo either way.
 */
export function validRedirectUri(uri: string): boolean {
  if (typeof uri !== "string" || uri.length === 0 || uri.length > 2048 || uri.includes("#")) return false;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.username !== "" || url.password !== "" || url.hostname === "") return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
}

const isStoreFull = (error: unknown): boolean =>
  error instanceof Error && (error.name === "OauthStoreFull" || error.constructor.name === "OauthStoreFull");

/** `POST /oauth/register` (RFC 7591): open registration of public clients. Failures share the token endpoint's throttle. */
export async function handleRegisterRequest(
  request: Request,
  deps: OauthDeps = databaseOauthDeps()
): Promise<Response> {
  if (request.method.toUpperCase() !== "POST")
    return oauthError(405, "invalid_request", "Use POST.", { allow: "POST" });
  const address = remoteAddress(request.headers);
  const wait = deps.throttle.retryAfter(address);
  if (wait > 0)
    return oauthError(429, "temporarily_unavailable", rateLimitMessage(wait), {
      "retry-after": String(wait)
    });
  const refuse = (error: "invalid_redirect_uri" | "invalid_client_metadata", description: string) => {
    deps.throttle.fail(address);
    return oauthError(400, error, description);
  };
  const tooLarge = () => oauthError(413, "invalid_client_metadata", "The request is too large.");
  const declared = request.headers.get("content-length");
  if (declared !== null && !(Number(declared) <= MAX_TOKEN_REQUEST_BYTES)) return tooLarge();
  const type = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (type !== "application/json") return refuse("invalid_client_metadata", "Send application/json.");
  const text = await readCappedText(request, MAX_TOKEN_REQUEST_BYTES);
  if (text === null) return tooLarge();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return refuse("invalid_client_metadata", "The body is not valid JSON.");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body))
    return refuse("invalid_client_metadata", "The body must be a JSON object.");
  const metadata = body as Record<string, unknown>;

  const uris = metadata.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > 5)
    return refuse("invalid_redirect_uri", "redirect_uris must list 1 to 5 URIs.");
  if (!uris.every((uri) => typeof uri === "string" && validRedirectUri(uri)))
    return refuse(
      "invalid_redirect_uri",
      "Each redirect URI must be https, or http on 127.0.0.1, localhost or [::1], with no fragment or userinfo."
    );
  const name = metadata.client_name;
  if (name !== undefined && typeof name !== "string")
    return refuse("invalid_client_metadata", "client_name must be a string.");
  // Every client is registered public. A client asking for a secret-based method (a gateway's SDK may default to
  // `client_secret_post` because the metadata lists it for client_credentials) gets `none` back, which RFC 7591
  // section 3.2.1 allows and obliges it to use; refusing would fail its sign-in behind a generic error.
  const clientName = (typeof name === "string" ? name.trim().slice(0, 64).trim() : "") || "MCP client";

  let client: OauthClient;
  try {
    client = await deps.registerClient({ clientName, redirectUris: [...new Set(uris as string[])] });
  } catch (error) {
    return isStoreFull(error)
      ? oauthError(503, "temporarily_unavailable", "Too many clients are registered; try again later.", {
          "retry-after": "3600"
        })
      : unavailable("The client could not be registered just now; try again.");
  }
  return Response.json(
    {
      client_id: client.clientId,
      client_name: client.clientName,
      redirect_uris: client.redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000)
    },
    { status: 201, headers: NO_STORE }
  );
}

export type BearerResult = { ok: true; principal: AgentPrincipal } | { ok: false; response: Response };

/**
 * What `/mcp` makes of `Authorization: Bearer`: only an access token minted by this server for this resource is
 * accepted. The long-lived agent secret, an owner token and any other string fall through to the same 401, and
 * nothing is forwarded anywhere. The agent token behind it is read on every request, so a revocation bites at once.
 */
export async function authenticateBearer(
  request: Request,
  deps: OauthDeps = databaseOauthDeps()
): Promise<BearerResult> {
  const header = request.headers.get("authorization");
  const match = header === null ? null : /^bearer\s+(\S+)$/i.exec(header.trim());
  if (!match) return { ok: false, response: unauthorized(request, undefined, "A bearer access token is required.") };
  const address = remoteAddress(request.headers);
  const wait = deps.throttle.retryAfter(address);
  if (wait > 0)
    return {
      ok: false,
      response: Response.json(
        { error: rateLimitMessage(wait), retryAfterSeconds: wait },
        { status: 429, headers: { "retry-after": String(wait) } }
      )
    };
  const digest = hashAccessToken(match[1] as string);
  let stored: StoredAccessToken | null;
  try {
    stored = await deps.findAccessToken(digest);
  } catch {
    return {
      ok: false,
      response: Response.json({ error: "Tokens could not be checked just now; try again." }, { status: 503 })
    };
  }
  const fail = (description: string, count: boolean): BearerResult => {
    if (count) deps.throttle.fail(address);
    return { ok: false, response: unauthorized(request, "invalid_token", description) };
  };
  if (!stored) return fail("The access token is not recognised.", true);
  if (stored.resource !== resourceUrl(request))
    return fail("The access token was issued for a different resource.", false);
  const now = deps.now().getTime();
  if (stored.expiresAt.getTime() <= now) return fail("The access token has expired.", false);
  if (stored.agent.revokedAt) return fail("The agent token behind this access token was revoked.", false);
  if (stored.agent.expiresAt.getTime() <= now)
    return fail("The agent token behind this access token has expired.", false);
  return {
    ok: true,
    principal: {
      name: stored.agent.name,
      source: "db",
      tokenId: stored.agentTokenId,
      // Never wider than the agent token holds now, whatever was asked for when this was minted.
      scopes: stored.scopes.filter((scope) => stored.agent.scopes.some((held) => scopeCovers(held, scope))),
      directWrites: stored.agent.directWrites
    }
  };
}
