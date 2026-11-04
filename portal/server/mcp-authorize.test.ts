import { describe, expect, it, vi } from "vitest";
import { handleAuthorizeRequest, type AuthorizeDeps } from "./mcp-authorize";
import { SCOPES_SUPPORTED } from "./mcp-oauth";
import { agentRecord, NOW } from "./mcp-test-support";

const ORIGIN = "https://portal.test";
const CLIENT_ID = "pri_client_abc";
const REDIRECT = "https://claude.example/callback";
const CHALLENGE = "a".repeat(43);

const client = (clientName?: string) => ({
  clientId: CLIENT_ID,
  clientName: clientName ?? "OpenClaw",
  redirectUris: [REDIRECT],
  createdAt: NOW
});

function makeDeps(owner = true, clientName?: string) {
  const grantClient = vi.fn(async () => agentRecord());
  const createAuthorizationCode = vi.fn(async () => ({
    code: "pri_code_xyz",
    expiresAt: new Date(NOW.getTime() + 120_000)
  }));
  const deps: AuthorizeDeps = {
    findClient: async (id) => (id === CLIENT_ID ? client(clientName) : null),
    isOwner: async () => owner,
    grantClient,
    createAuthorizationCode,
    now: () => NOW
  };
  return { deps, grantClient, createAuthorizationCode };
}

const params = (extra: Record<string, string | null> = {}) => {
  const base: Record<string, string> = {
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    state: "st-1"
  };
  for (const [key, value] of Object.entries(extra)) {
    if (value === null) delete base[key];
    else base[key] = value;
  }
  return new URLSearchParams(base);
};

const get = (extra: Record<string, string | null> = {}) =>
  new Request(`${ORIGIN}/oauth/authorize?${params(extra)}`, { headers: { host: "portal.test" } });

const post = (
  extra: Record<string, string | null> = {},
  headers: Record<string, string> = { origin: ORIGIN },
  decision = "approve"
) => {
  const body = params(extra);
  body.set("decision", decision);
  return new Request(`${ORIGIN}/oauth/authorize`, {
    method: "POST",
    headers: { host: "portal.test", "content-type": "application/x-www-form-urlencoded", ...headers },
    body
  });
};

const location = (response: Response) => new URL(response.headers.get("location") as string);

describe("bad client or redirect", () => {
  it("shows an error page, never a redirect, for an unknown client", async () => {
    const response = await handleAuthorizeRequest(get({ client_id: "pri_client_nope" }), makeDeps().deps);
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("content-type")).toContain("text/html");
  });
  it("shows an error page for a redirect that is not exactly registered", async () => {
    for (const redirect_uri of [`${REDIRECT}/`, `${REDIRECT}?x=1`, "https://evil.example/callback"]) {
      const response = await handleAuthorizeRequest(get({ redirect_uri }), makeDeps().deps);
      expect(response.status).toBe(400);
      expect(response.headers.get("location")).toBeNull();
    }
  });
});

describe("other bad parameters redirect with an error", () => {
  it("answers invalid_request when PKCE is missing or plain", async () => {
    for (const extra of [
      { code_challenge: null },
      { code_challenge_method: null },
      { code_challenge_method: "plain" }
    ]) {
      const response = await handleAuthorizeRequest(get(extra), makeDeps().deps);
      expect(response.status).toBe(302);
      const url = location(response);
      expect(url.origin + url.pathname).toBe(REDIRECT);
      expect(url.searchParams.get("error")).toBe("invalid_request");
      expect(url.searchParams.get("state")).toBe("st-1");
      expect(url.searchParams.get("iss")).toBe(ORIGIN);
    }
  });
  it("answers invalid_scope for a scope this server does not offer", async () => {
    const response = await handleAuthorizeRequest(get({ scope: "read:plan admin:everything" }), makeDeps().deps);
    expect(response.status).toBe(302);
    expect(location(response).searchParams.get("error")).toBe("invalid_scope");
  });
  it("refuses a resource other than this server's /mcp and a response_type other than code", async () => {
    const wrongResource = await handleAuthorizeRequest(get({ resource: "https://other.example/mcp" }), makeDeps().deps);
    expect(location(wrongResource).searchParams.get("error")).toBe("invalid_target");
    const wrongType = await handleAuthorizeRequest(get({ response_type: "token" }), makeDeps().deps);
    expect(location(wrongType).searchParams.get("error")).toBe("unsupported_response_type");
  });
});

describe("GET", () => {
  it("asks for sign-in when there is no owner credential", async () => {
    const response = await handleAuthorizeRequest(get(), makeDeps(false).deps);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('id="sign-in"');
    expect(html).not.toContain("Approve");
  });
  it("shows the consent page to the owner, with the client name escaped", async () => {
    const response = await handleAuthorizeRequest(
      get({ scope: "read:plan" }),
      makeDeps(true, '<script>alert("x")</script>').deps
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(html).toContain("claude.example");
    expect(html).toContain("read:plan");
    expect(html).toContain('name="decision" value="approve"');
    expect(html).toContain('name="decision" value="deny"');
    expect(html).toContain(`name="state" value="st-1"`);
    expect(html).toContain("change your plan directly, with every change listed and undoable");
    expect(html).toContain("still wait for you");
  });
  it("sends the hardening headers", async () => {
    const response = await handleAuthorizeRequest(get(), makeDeps().deps);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    // Not no-referrer: that makes the browser send `Origin: null` on the consent POST, which sameOrigin() refuses.
    expect(response.headers.get("referrer-policy")).toBe("same-origin");
    expect(await response.text()).toContain('<meta name="referrer" content="same-origin">');
  });
  it("escapes hostile state in hidden fields", async () => {
    const response = await handleAuthorizeRequest(get({ state: '"><b>x' }), makeDeps().deps);
    const html = await response.text();
    expect(html).not.toContain("<b>x");
    expect(html).toContain("&quot;&gt;&lt;b&gt;x");
  });
});

describe("POST", () => {
  it("refuses a request that is not same-origin", async () => {
    const { deps, grantClient } = makeDeps();
    const response = await handleAuthorizeRequest(post({}, { origin: "https://evil.example" }), deps);
    expect(response.status).toBe(403);
    const none = await handleAuthorizeRequest(post({}, {}), deps);
    expect(none.status).toBe(403);
    expect(grantClient).not.toHaveBeenCalled();
  });
  it("refuses a caller without an owner credential", async () => {
    const { deps, grantClient } = makeDeps(false);
    const response = await handleAuthorizeRequest(post(), deps);
    expect(response.status).toBe(403);
    expect(grantClient).not.toHaveBeenCalled();
  });
  it("redirects access_denied on Deny without granting anything", async () => {
    const { deps, grantClient, createAuthorizationCode } = makeDeps();
    const response = await handleAuthorizeRequest(post({}, { origin: ORIGIN }, "deny"), deps);
    expect(response.status).toBe(302);
    const url = location(response);
    expect(url.searchParams.get("error")).toBe("access_denied");
    expect(url.searchParams.get("state")).toBe("st-1");
    expect(url.searchParams.get("iss")).toBe(ORIGIN);
    expect(grantClient).not.toHaveBeenCalled();
    expect(createAuthorizationCode).not.toHaveBeenCalled();
  });
  it("on Approve grants the requested scopes and redirects with code, state and iss", async () => {
    const { deps, grantClient, createAuthorizationCode } = makeDeps();
    const response = await handleAuthorizeRequest(post({ scope: "read:plan propose:capture" }), deps);
    expect(response.status).toBe(302);
    const url = location(response);
    expect(url.searchParams.get("code")).toBe("pri_code_xyz");
    expect(url.searchParams.get("state")).toBe("st-1");
    expect(url.searchParams.get("iss")).toBe(ORIGIN);
    expect(grantClient).toHaveBeenCalledWith({
      client: expect.objectContaining({ clientId: CLIENT_ID }),
      scopes: ["read:plan", "propose:capture"]
    });
    expect(createAuthorizationCode).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: CLIENT_ID,
        redirectUri: REDIRECT,
        codeChallenge: CHALLENGE,
        resource: `${ORIGIN}/mcp`,
        scopes: ["read:plan", "propose:capture"]
      })
    );
  });
  it("treats an empty scope as every supported scope", async () => {
    const { deps, grantClient } = makeDeps();
    await handleAuthorizeRequest(post({ scope: "" }), deps);
    expect(grantClient).toHaveBeenCalledWith(expect.objectContaining({ scopes: SCOPES_SUPPORTED }));
  });
  it("re-validates on POST", async () => {
    const { deps, grantClient } = makeDeps();
    const response = await handleAuthorizeRequest(post({ code_challenge_method: "plain" }), deps);
    expect(location(response).searchParams.get("error")).toBe("invalid_request");
    expect(grantClient).not.toHaveBeenCalled();
  });
  it("refuses a body over 8 KB", async () => {
    const response = await handleAuthorizeRequest(post({ state: "s".repeat(9000) }), makeDeps().deps);
    expect(response.status).toBe(413);
  });
  it("shows an error page when the store fails", async () => {
    const { deps } = makeDeps();
    deps.grantClient = async () => {
      throw new Error("down");
    };
    const response = await handleAuthorizeRequest(post(), deps);
    expect(response.status).toBe(503);
    expect(response.headers.get("location")).toBeNull();
  });
});
