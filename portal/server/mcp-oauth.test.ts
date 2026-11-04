import { createHash } from "node:crypto";
import { MCP_TOOL_MANIFEST, requiredScopes } from "@openrhen/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateAccessToken, hashAccessToken } from "./mcp-access-tokens";
import {
  authenticateBearer,
  authorizationServerMetadata,
  handleRegisterRequest,
  handleTokenRequest,
  originRefusal,
  protectedResourceMetadata,
  resourceUrl,
  sameResource,
  SCOPES_SUPPORTED,
  validRedirectUri,
  type OauthDeps
} from "./mcp-oauth";
import {
  NOW,
  RESOURCE,
  SECRET,
  agentRecord,
  codeRequest,
  fakeDeps,
  mcpRequest,
  seedCode,
  sha,
  tokenRequest
} from "./mcp-test-support";

describe("SCOPES_SUPPORTED", () => {
  it("offers what a direct-drive agent needs, and nothing outward or admin", () => {
    for (const scope of ["read:plan", "write:entity", "write:catch-up", "write:session", "write:undo"])
      expect(SCOPES_SUPPORTED).toContain(scope);
    expect(SCOPES_SUPPORTED.filter((scope) => /^(act|admin):/.test(scope))).toEqual([]);
  });

  it("offers every scope an Inbox action asks for at call time, outward replies aside", () => {
    expect(MCP_TOOL_MANIFEST.some((tool) => tool.command === "inbox-act")).toBe(true);
    const rooms = ["captured", "kept", "people", "map"];
    const actions = ["confirm", "ignore", "drop", "keep", "seen", "link", "links-bulk", "finding"];
    for (const room of rooms)
      for (const action of actions)
        for (const scope of requiredScopes({ tool: "inbox-act", room, action }))
          if (!scope.startsWith("act:")) expect(SCOPES_SUPPORTED, `${room} ${action}`).toContain(scope);
  });
});

describe("the metadata documents", () => {
  it("name this server as the resource and as its own authorization server", async () => {
    const request = new Request("https://portal.test/.well-known/oauth-protected-resource", {
      headers: { host: "portal.test" }
    });
    const resource = (await protectedResourceMetadata(request).json()) as Record<string, unknown>;
    expect(resource).toMatchObject({
      resource: RESOURCE,
      authorization_servers: ["https://portal.test"],
      bearer_methods_supported: ["header"]
    });
    expect(resource.scopes_supported).toEqual(expect.arrayContaining(["read:plan", "propose:capture"]));
    expect(resource.scopes_supported).not.toContain("admin:tokens");
  });

  it("advertise the authorization-code flow with PKCE, registration and public clients", async () => {
    const server = (await authorizationServerMetadata(
      new Request("https://portal.test/.well-known/oauth-authorization-server", { headers: { host: "portal.test" } })
    ).json()) as Record<string, unknown>;
    expect(server).toMatchObject({
      issuer: "https://portal.test",
      token_endpoint: "https://portal.test/oauth/token",
      authorization_endpoint: "https://portal.test/oauth/authorize",
      registration_endpoint: "https://portal.test/oauth/register",
      grant_types_supported: ["client_credentials", "authorization_code", "refresh_token"],
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
      authorization_response_iss_parameter_supported: true
    });
  });

  it("takes the scheme from X-Forwarded-Proto behind the proxy", () => {
    const request = new Request("http://portal:8787/mcp", {
      headers: { host: "openrhen.example.com", "x-forwarded-proto": "https" }
    });
    expect(resourceUrl(request)).toBe("https://openrhen.example.com/mcp");
  });
});

describe("POST /oauth/token", () => {
  it("issues an opaque hour-long token bound to the resource, with the scopes asked for that the agent holds", async () => {
    const { deps, access } = fakeDeps();
    const response = await handleTokenRequest(tokenRequest({ scope: "read:plan read:mail propose:capture" }), deps);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "read:plan propose:capture" });
    expect(String(body.access_token)).toMatch(/^pri_at_/);
    const stored = access.get(hashAccessToken(String(body.access_token)))!;
    expect(stored.resource).toBe(RESOURCE);
    expect(stored.scopes).toEqual(["read:plan", "propose:capture"]);
  });

  it("answers 413 for a declared or streamed body past 8 KB without parsing it", async () => {
    const { deps } = fakeDeps();
    const declared = tokenRequest({}, { "content-length": "9000" });
    const text = vi.spyOn(declared, "text");
    expect((await handleTokenRequest(declared, deps)).status).toBe(413);
    expect(text).not.toHaveBeenCalled();
    const streamed = new Request("https://portal.test/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", host: "portal.test" },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("x=".padEnd(5000, "a")));
          controller.enqueue(new TextEncoder().encode("a".repeat(5000)));
          controller.close();
        }
      }),
      duplex: "half"
    } as RequestInit);
    expect((await handleTokenRequest(streamed, deps)).status).toBe(413);
  });

  it("grants every scope the agent holds when none are asked for", async () => {
    const body = (await (await handleTokenRequest(tokenRequest(), fakeDeps().deps)).json()) as { scope: string };
    expect(body.scope).toBe("read:plan read:changes propose:capture");
  });

  it("never grants more than the agent holds: asking for only scopes it lacks is invalid_scope", async () => {
    const response = await handleTokenRequest(
      tokenRequest({ scope: "write:entity:action read:mail" }),
      fakeDeps().deps
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_scope" });
  });

  it("takes the client secret over HTTP Basic too, but not both ways at once", async () => {
    const basic = `Basic ${Buffer.from(`companion:${SECRET}`).toString("base64")}`;
    const viaBasic = tokenRequest({ client_id: "", client_secret: "" }, { authorization: basic });
    expect((await handleTokenRequest(viaBasic, fakeDeps().deps)).status).toBe(200);
    const both = tokenRequest({}, { authorization: basic });
    const refused = await handleTokenRequest(both, fakeDeps().deps);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: "invalid_request" });
  });

  it("accepts the client id as the agent name or the token id", async () => {
    const id = agentRecord().id;
    expect((await handleTokenRequest(tokenRequest({ client_id: id }), fakeDeps().deps)).status).toBe(200);
    expect((await handleTokenRequest(tokenRequest({ client_id: "someone-else" }), fakeDeps().deps)).status).toBe(401);
  });

  it("refuses a wrong secret with invalid_client and counts it against the throttle", async () => {
    const { deps } = fakeDeps();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await handleTokenRequest(tokenRequest({ client_secret: `pri_guess${attempt}` }), deps);
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: "invalid_client" });
    }
    const throttled = await handleTokenRequest(tokenRequest({ client_secret: SECRET }), deps);
    expect(throttled.status).toBe(429);
    expect(Number(throttled.headers.get("retry-after"))).toBeGreaterThan(0);
    // The wait is in the text an agent reads, and as data.
    const body = (await throttled.json()) as { error_description?: string; retryAfterSeconds?: number };
    expect(body.error_description).toContain(`Wait ${throttled.headers.get("retry-after")} seconds`);
    expect(body.retryAfterSeconds).toBe(Number(throttled.headers.get("retry-after")));
  });

  it("refuses a revoked or expired agent token without counting it as a guess", async () => {
    const revoked = fakeDeps([agentRecord({ revokedAt: new Date("2026-10-18T00:00:00Z") })]);
    for (let attempt = 0; attempt < 12; attempt += 1)
      expect((await handleTokenRequest(tokenRequest(), revoked.deps)).status).toBe(401);
    const expired = fakeDeps([agentRecord({ expiresAt: new Date("2026-10-18T00:00:00Z") })]);
    const response = await handleTokenRequest(tokenRequest(), expired.deps);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: "invalid_client",
      error_description: "The agent token has expired."
    });
    const revokedResponse = await handleTokenRequest(tokenRequest(), revoked.deps);
    expect(await revokedResponse.json()).toMatchObject({
      error: "invalid_client",
      error_description: "The agent token was revoked."
    });
  });

  it("requires the resource and refuses another audience (RFC 8707)", async () => {
    const { deps } = fakeDeps();
    const missing = await handleTokenRequest(tokenRequest({ resource: "" }), deps);
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ error: "invalid_target" });
    const other = await handleTokenRequest(tokenRequest({ resource: "https://elsewhere.test/mcp" }), deps);
    expect(await other.json()).toMatchObject({ error: "invalid_target" });
  });

  it("refuses a grant type it does not know", async () => {
    for (const grant of ["password", "implicit"]) {
      const response = await handleTokenRequest(tokenRequest({ grant_type: grant }), fakeDeps().deps);
      expect(await response.json()).toMatchObject({ error: "unsupported_grant_type" });
    }
  });

  it("does not take an owner token or an access token as a client secret", async () => {
    const { deps } = fakeDeps();
    expect((await handleTokenRequest(tokenRequest({ client_secret: "pri_own_abcdef" }), deps)).status).toBe(401);
    expect((await handleTokenRequest(tokenRequest({ client_secret: generateAccessToken() }), deps)).status).toBe(401);
  });

  it("answers 503 when the token table cannot be read", async () => {
    const { deps } = fakeDeps();
    const broken: OauthDeps = { ...deps, findAgentToken: async () => Promise.reject(new Error("down")) };
    const response = await handleTokenRequest(tokenRequest(), broken);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "temporarily_unavailable" });
  });

  it("wants a form body", async () => {
    const response = await handleTokenRequest(
      new Request("https://portal.test/oauth/token", {
        method: "POST",
        headers: { host: "portal.test", "content-type": "application/json" },
        body: "{}"
      }),
      fakeDeps().deps
    );
    expect(response.status).toBe(400);
  });
});

const registerRequest = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("https://portal.test/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json", host: "portal.test", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body)
  });

describe("validRedirectUri", () => {
  it("takes https anywhere and http only on loopback, with no fragment or userinfo", () => {
    for (const ok of [
      "https://claude.ai/api/mcp/auth_callback",
      "http://127.0.0.1:8123/cb",
      "http://localhost/cb",
      "http://[::1]:9/cb"
    ])
      expect(validRedirectUri(ok), ok).toBe(true);
    for (const bad of [
      "http://example.com/cb",
      "https://a.test/cb#frag",
      "https://a.test/cb#",
      "https://user:pw@a.test/cb",
      "javascript:alert(1)",
      "myapp://cb",
      "/relative",
      ""
    ])
      expect(validRedirectUri(bad), bad).toBe(false);
  });
});

describe("sameResource", () => {
  it("treats case, a default port and a trailing slash as the same resource, and nothing else", () => {
    const ours = "https://openrhen.example/mcp";
    for (const same of [ours, "https://openrhen.example/mcp/", "HTTPS://OpenRhen.Example:443/mcp"])
      expect(sameResource(same, ours), same).toBe(true);
    for (const other of [
      "https://openrhen.example/mcp/x",
      "https://openrhen.example/",
      "http://openrhen.example/mcp",
      "https://openrhen.example:8443/mcp",
      "https://other.example/mcp",
      "https://openrhen.example/mcp?x=1",
      "https://openrhen.example/mcp#x",
      "not a url"
    ])
      expect(sameResource(other, ours), other).toBe(false);
  });
});

describe("POST /oauth/register", () => {
  it("registers a public client and answers 201 with its metadata", async () => {
    const { deps, clients } = fakeDeps();
    const response = await handleRegisterRequest(
      registerRequest({ redirect_uris: ["http://127.0.0.1:5000/cb"], client_name: " OpenClaw " }),
      deps
    );
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      client_name: "OpenClaw",
      redirect_uris: ["http://127.0.0.1:5000/cb"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      client_id_issued_at: Math.floor(NOW.getTime() / 1000)
    });
    expect(String(body.client_id)).toMatch(/^pri_client_[A-Za-z0-9_-]{22}$/);
    expect(clients.has(String(body.client_id))).toBe(true);
  });

  it("registers a gateway's https callback, as public, whatever auth method it asked for", async () => {
    // OpenClaw's web Control UI registers its gateway's https callbacks, and an SDK may ask for a secret-based
    // method because the metadata lists one for client_credentials; it gets `none` back (RFC 7591 section 3.2.1).
    const { deps } = fakeDeps();
    for (const method of [undefined, "none", "client_secret_post", "client_secret_basic"]) {
      const response = await handleRegisterRequest(
        registerRequest({
          client_name: "OpenClaw Gateway",
          redirect_uris: [
            "https://agent-host.tail1234.ts.net/oauth/provider/callback",
            "https://agent-host.tail1234.ts.net:18789/oauth/mcp/callback"
          ],
          ...(method ? { token_endpoint_auth_method: method } : {})
        }),
        deps
      );
      expect(response.status, String(method)).toBe(201);
      expect(await response.json()).toMatchObject({ token_endpoint_auth_method: "none" });
    }
  });

  it("cuts a long client_name to 64 characters rather than refusing it", async () => {
    const { deps } = fakeDeps();
    const response = await handleRegisterRequest(
      registerRequest({ redirect_uris: ["https://a.test/cb"], client_name: "x".repeat(80) }),
      deps
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ client_name: "x".repeat(64) });
  });

  it("refuses bad redirect URIs and bad metadata with the RFC 7591 errors, and counts them against the throttle", async () => {
    const { deps } = fakeDeps();
    const cases: [unknown, string][] = [
      [{}, "invalid_redirect_uri"],
      [{ redirect_uris: [] }, "invalid_redirect_uri"],
      [{ redirect_uris: ["http://example.com/cb"] }, "invalid_redirect_uri"],
      [{ redirect_uris: ["https://a.test/cb#x"] }, "invalid_redirect_uri"],
      [{ redirect_uris: Array(6).fill("https://a.test/cb") }, "invalid_redirect_uri"],
      [{ redirect_uris: [1] }, "invalid_redirect_uri"],
      [{ redirect_uris: ["https://a.test/cb"], client_name: 5 }, "invalid_client_metadata"],
      [{ redirect_uris: ["ftp://a.test/cb"] }, "invalid_redirect_uri"],
      ["not json", "invalid_client_metadata"],
      [[], "invalid_client_metadata"]
    ];
    for (const [body, error] of cases) {
      const response = await handleRegisterRequest(registerRequest(body), deps);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await response.json()).toMatchObject({ error, error_description: expect.any(String) });
    }
    expect((await handleRegisterRequest(registerRequest({ redirect_uris: ["https://a.test/cb"] }), deps)).status).toBe(
      429
    );
  });

  it("wants JSON, caps the body at 8 KB and only answers POST", async () => {
    const { deps } = fakeDeps();
    const form = new Request("https://portal.test/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", host: "portal.test" },
      body: "redirect_uris=x"
    });
    expect((await handleRegisterRequest(form, deps)).status).toBe(400);
    const big = registerRequest({ redirect_uris: ["https://a.test/cb"], pad: "a".repeat(9000) });
    expect((await handleRegisterRequest(big, deps)).status).toBe(413);
    const get = new Request("https://portal.test/oauth/register", { headers: { host: "portal.test" } });
    expect((await handleRegisterRequest(get, deps)).status).toBe(405);
  });

  it("answers 503 when the client store is full", async () => {
    const { deps, limits } = fakeDeps();
    limits.maxClients = 0;
    const response = await handleRegisterRequest(registerRequest({ redirect_uris: ["https://a.test/cb"] }), deps);
    expect(response.status).toBe(503);
  });
});

describe("POST /oauth/token, authorization_code", () => {
  const grant = (fakes: ReturnType<typeof fakeDeps>, fields: Record<string, string> = {}) => {
    const seeded = seedCode(fakes);
    return {
      seeded,
      request: codeRequest({
        code: seeded.code,
        code_verifier: seeded.verifier,
        client_id: seeded.clientId,
        redirect_uri: seeded.redirectUri,
        ...fields
      })
    };
  };

  it("trades a code and an S256 verifier for an access token and a refresh token", async () => {
    const fakes = fakeDeps();
    const { request } = grant(fakes);
    const response = await handleTokenRequest(request, fakes.deps);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "read:plan propose:capture" });
    expect(String(body.access_token)).toMatch(/^pri_at_/);
    expect(String(body.refresh_token)).toMatch(/^pri_rt_/);
    expect(fakes.access.get(createHash("sha256").update(String(body.access_token)).digest("hex"))?.resource).toBe(
      RESOURCE
    );
    const bearer = await authenticateBearer(mcpRequest(String(body.access_token)), fakes.deps);
    expect(bearer).toMatchObject({ ok: true, principal: { scopes: ["read:plan", "propose:capture"] } });
  });

  it("accepts the resource when it matches and refuses another with invalid_target", async () => {
    const fakes = fakeDeps();
    expect((await handleTokenRequest(grant(fakes, { resource: RESOURCE }).request, fakes.deps)).status).toBe(200);
    const other = await handleTokenRequest(
      grant(fakes, { resource: "https://elsewhere.test/mcp" }).request,
      fakes.deps
    );
    expect(other.status).toBe(400);
    expect(await other.json()).toMatchObject({ error: "invalid_target" });
  });

  it("refuses a wrong verifier, redirect_uri, client or code with invalid_grant", async () => {
    for (const fields of [
      { code_verifier: "v".repeat(43) },
      { code_verifier: "short" },
      { redirect_uri: "http://127.0.0.1:8123/other" },
      { client_id: "pri_client_other" },
      { code: "pri_code_unknown" }
    ]) {
      const fakes = fakeDeps();
      const response = await handleTokenRequest(grant(fakes, fields).request, fakes.deps);
      expect(response.status, JSON.stringify(fields)).toBe(400);
      expect(await response.json()).toMatchObject({ error: "invalid_grant" });
    }
  });

  it("refuses an expired code", async () => {
    const fakes = fakeDeps();
    const { request } = grant(fakes);
    fakes.clock.now = new Date(NOW.getTime() + 121_000);
    const response = await handleTokenRequest(request, fakes.deps);
    expect(await response.json()).toMatchObject({
      error: "invalid_grant",
      error_description: expect.stringContaining("expired")
    });
  });

  it("revokes the agent token when a code is used twice", async () => {
    const fakes = fakeDeps();
    const { seeded } = grant(fakes);
    const again = () =>
      codeRequest({
        code: seeded.code,
        code_verifier: seeded.verifier,
        client_id: seeded.clientId,
        redirect_uri: seeded.redirectUri
      });
    const first = await handleTokenRequest(again(), fakes.deps);
    expect(first.status).toBe(200);
    const { access_token } = (await first.json()) as { access_token: string };
    expect((await authenticateBearer(mcpRequest(access_token), fakes.deps)).ok).toBe(true);
    const second = await handleTokenRequest(again(), fakes.deps);
    expect(second.status).toBe(400);
    expect(await second.json()).toMatchObject({ error: "invalid_grant" });
    expect(fakes.revoked).toEqual([agentRecord().id]);
    expect((await authenticateBearer(mcpRequest(access_token), fakes.deps)).ok).toBe(false);
  });

  it("refuses a code whose agent token was revoked, and counts unknown codes against the throttle", async () => {
    const fakes = fakeDeps();
    const seeded = seedCode(fakes, { agent: agentRecord({ revokedAt: new Date("2026-10-18T00:00:00Z") }) });
    const response = await handleTokenRequest(
      codeRequest({
        code: seeded.code,
        code_verifier: seeded.verifier,
        client_id: seeded.clientId,
        redirect_uri: seeded.redirectUri
      }),
      fakes.deps
    );
    expect(await response.json()).toMatchObject({ error: "invalid_grant" });
    const throttled = fakeDeps();
    for (let attempt = 0; attempt < 10; attempt += 1)
      await handleTokenRequest(grant(throttled, { code: `pri_code_guess${attempt}` }).request, throttled.deps);
    expect((await handleTokenRequest(grant(throttled).request, throttled.deps)).status).toBe(429);
  });
});

describe("POST /oauth/token, refresh_token", () => {
  async function fresh(fakes = fakeDeps()) {
    const seeded = seedCode(fakes);
    const body = (await (
      await handleTokenRequest(
        codeRequest({
          code: seeded.code,
          code_verifier: seeded.verifier,
          client_id: seeded.clientId,
          redirect_uri: seeded.redirectUri
        }),
        fakes.deps
      )
    ).json()) as { refresh_token: string; access_token: string };
    return { ...fakes, clientId: seeded.clientId, refreshToken: body.refresh_token };
  }
  const refreshRequest = (fields: Record<string, string>) =>
    tokenRequest({ grant_type: "refresh_token", client_id: "", client_secret: "", resource: "", ...fields });

  it("rotates: a new access token and a new refresh token, the old one spent", async () => {
    const { deps, clientId, refreshToken, refresh } = await fresh();
    const response = await handleTokenRequest(
      refreshRequest({ refresh_token: refreshToken, client_id: clientId }),
      deps
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { refresh_token: string; scope: string };
    expect(body.refresh_token).toMatch(/^pri_rt_/);
    expect(body.refresh_token).not.toBe(refreshToken);
    expect(body.scope).toBe("read:plan propose:capture");
    expect(refresh.get(sha(refreshToken))?.usedAt).not.toBeNull();
    expect(refresh.get(sha(body.refresh_token))?.usedAt).toBeNull();
  });

  it("narrows scope to a subset and refuses a wider one", async () => {
    const { deps, clientId, refreshToken } = await fresh();
    const narrow = await handleTokenRequest(
      refreshRequest({ refresh_token: refreshToken, client_id: clientId, scope: "read:plan" }),
      deps
    );
    const body = (await narrow.json()) as { refresh_token: string; scope: string };
    expect(body.scope).toBe("read:plan");
    const wide = await handleTokenRequest(
      refreshRequest({ refresh_token: body.refresh_token, client_id: clientId, scope: "read:plan read:changes" }),
      deps
    );
    expect(wide.status).toBe(400);
    expect(await wide.json()).toMatchObject({ error: "invalid_scope" });
  });

  it("revokes the agent token when a used refresh token is replayed", async () => {
    const { deps, clientId, refreshToken, revoked } = await fresh();
    const request = () => refreshRequest({ refresh_token: refreshToken, client_id: clientId });
    expect((await handleTokenRequest(request(), deps)).status).toBe(200);
    const replay = await handleTokenRequest(request(), deps);
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ error: "invalid_grant" });
    expect(revoked).toEqual([agentRecord().id]);
  });

  it("refuses another client, an unknown token, another resource, an expired token and a revoked agent", async () => {
    const wrongClient = await fresh();
    const mismatch = await handleTokenRequest(
      refreshRequest({ refresh_token: wrongClient.refreshToken, client_id: "pri_client_other" }),
      wrongClient.deps
    );
    expect(await mismatch.json()).toMatchObject({ error: "invalid_grant" });

    const unknown = await fresh();
    const guess = await handleTokenRequest(
      refreshRequest({ refresh_token: "pri_rt_guess", client_id: unknown.clientId }),
      unknown.deps
    );
    expect(await guess.json()).toMatchObject({ error: "invalid_grant" });

    const target = await fresh();
    const elsewhere = await handleTokenRequest(
      refreshRequest({
        refresh_token: target.refreshToken,
        client_id: target.clientId,
        resource: "https://elsewhere.test/mcp"
      }),
      target.deps
    );
    expect(await elsewhere.json()).toMatchObject({ error: "invalid_target" });

    const old = await fresh();
    old.clock.now = new Date(NOW.getTime() + 31 * 86_400_000);
    const expired = await handleTokenRequest(
      refreshRequest({ refresh_token: old.refreshToken, client_id: old.clientId }),
      old.deps
    );
    expect(await expired.json()).toMatchObject({ error: "invalid_grant" });

    const dead = await fresh();
    const stored = dead.refresh.get(sha(dead.refreshToken))!;
    stored.agent.revokedAt = NOW;
    const revoked = await handleTokenRequest(
      refreshRequest({ refresh_token: dead.refreshToken, client_id: dead.clientId }),
      dead.deps
    );
    expect(await revoked.json()).toMatchObject({ error: "invalid_grant" });
  });
});

describe("the bearer check for /mcp", () => {
  async function issued(fakes = fakeDeps(), fields: Record<string, string> = {}) {
    const body = (await (await handleTokenRequest(tokenRequest(fields), fakes.deps)).json()) as {
      access_token: string;
    };
    return { ...fakes, token: body.access_token };
  }

  it("accepts an access token minted for this resource and names the agent with the scopes it was given", async () => {
    const { deps, token } = await issued(fakeDeps(), { scope: "read:plan" });
    const result = await authenticateBearer(mcpRequest(token), deps);
    expect(result).toMatchObject({ ok: true, principal: { name: "companion", source: "db", scopes: ["read:plan"] } });
  });

  it("answers 401 with the resource metadata and no error when there is no token", async () => {
    const result = await authenticateBearer(mcpRequest(), fakeDeps().deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(401);
    expect(result.response.headers.get("www-authenticate")).toBe(
      'Bearer resource_metadata="https://portal.test/.well-known/oauth-protected-resource/mcp"'
    );
  });

  it("refuses the long-lived agent secret, an unknown token and a non-bearer scheme the same way", async () => {
    const { deps } = fakeDeps();
    for (const presented of [SECRET, "pri_at_unknown", "pri_own_abc"]) {
      const result = await authenticateBearer(mcpRequest(presented), deps);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.response.status).toBe(401);
        expect(result.response.headers.get("www-authenticate")).toContain('error="invalid_token"');
        expect(result.response.headers.get("www-authenticate")).toContain("resource_metadata=");
      }
    }
    const basic = new Request("https://portal.test/mcp", {
      method: "POST",
      headers: { host: "portal.test", authorization: "Basic abc" }
    });
    expect((await authenticateBearer(basic, deps)).ok).toBe(false);
  });

  it("refuses a token issued for another audience", async () => {
    const { deps, token } = await issued();
    const elsewhere = new Request("https://other.test/mcp", {
      method: "POST",
      headers: { host: "other.test", authorization: `Bearer ${token}` }
    });
    const result = await authenticateBearer(elsewhere, deps);
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(await result.response.json()).toMatchObject({
        error_description: expect.stringContaining("different resource")
      });
  });

  it("refuses an expired token, and one whose agent token was revoked or expired since", async () => {
    const fakes = fakeDeps();
    const { deps, token, clock } = await issued(fakes);
    clock.now = new Date(NOW.getTime() + 3_600_001);
    const lapsed = await authenticateBearer(mcpRequest(token), deps);
    expect(lapsed.ok).toBe(false);
    if (!lapsed.ok)
      expect(await lapsed.response.json()).toMatchObject({ error_description: "The access token has expired." });

    const second = await issued(fakeDeps());
    const stored = [...second.access.values()][0]!;
    stored.agent = { ...stored.agent, revokedAt: new Date(NOW.getTime() + 1000) };
    const revokedBehind = await authenticateBearer(mcpRequest(second.token), second.deps);
    expect(revokedBehind.ok).toBe(false);
    if (!revokedBehind.ok)
      expect(await revokedBehind.response.json()).toMatchObject({
        error_description: "The agent token behind this access token was revoked."
      });

    const third = await issued(fakeDeps());
    const row = [...third.access.values()][0]!;
    row.agent = { ...row.agent, expiresAt: new Date(NOW.getTime() - 1000) };
    const expiredBehind = await authenticateBearer(mcpRequest(third.token), third.deps);
    expect(expiredBehind.ok).toBe(false);
    if (!expiredBehind.ok)
      expect(await expiredBehind.response.json()).toMatchObject({
        error_description: "The agent token behind this access token has expired."
      });
    const unknown = await authenticateBearer(mcpRequest("pri_at_unknown"), deps);
    if (!unknown.ok)
      expect(await unknown.response.json()).toMatchObject({ error_description: "The access token is not recognised." });
  });

  it("holds the principal to what the agent token holds now, whatever the access token says", async () => {
    const { deps, token, access } = await issued();
    const stored = [...access.values()][0]!;
    stored.agent = { ...stored.agent, scopes: ["read:plan"] };
    const result = await authenticateBearer(mcpRequest(token), deps);
    expect(result).toMatchObject({ ok: true, principal: { scopes: ["read:plan"] } });
  });

  it("throttles repeated guesses", async () => {
    const { deps } = fakeDeps();
    for (let attempt = 0; attempt < 10; attempt += 1)
      await authenticateBearer(mcpRequest(`pri_at_guess${attempt}`), deps);
    const result = await authenticateBearer(mcpRequest("pri_at_guess-next"), deps);
    expect(result.ok === false && result.response.status).toBe(429);
  });
});

describe("Origin and Host checks for /mcp", () => {
  beforeEach(() => {
    process.env.PORTAL_ALLOWED_HOSTS = "portal.test";
  });
  afterEach(() => {
    delete process.env.PORTAL_ALLOWED_HOSTS;
  });
  const request = (headers: Record<string, string>) =>
    new Request("https://portal.test/mcp", { method: "POST", headers });

  it("lets a client with no Origin, or this site's own Origin, through", () => {
    expect(originRefusal(request({ host: "portal.test" }))).toBeNull();
    expect(originRefusal(request({ host: "portal.test", origin: "https://portal.test" }))).toBeNull();
  });

  it("refuses a browser page on another origin, a rebinding host and a mangled Origin", () => {
    expect(originRefusal(request({ host: "portal.test", origin: "https://evil.test" }))?.status).toBe(403);
    expect(originRefusal(request({ host: "evil.test" }))?.status).toBe(403);
    expect(originRefusal(request({ host: "portal.test", origin: "not a url" }))?.status).toBe(403);
    expect(originRefusal(request({ host: "portal.test", origin: "null" }))?.status).toBe(403);
  });
});
