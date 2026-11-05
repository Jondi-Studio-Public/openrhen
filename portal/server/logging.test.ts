import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mcpManifestTool, validateToolArguments } from "@openrhen/contracts";
import {
  CommandConflictError,
  CommandIdReusedError,
  CommittedReadFailedError,
  ForbiddenCommandError,
  InvalidCommandError,
  NotFoundCommandError
} from "@/server/persistence/postgres/command-errors";
import { redact, withRoute } from "./logging";

/**
 * The portal's only CSRF defence lives entirely inside `withRoute`, ahead of the handler — see the
 * comment on `crossSiteRefusal` in logging.ts for the reasoning. These tests exercise it the same way
 * a route test does: through `withRoute` itself, since that is the only thing callers ever see.
 */
const handler = vi.fn(async () => Response.json({ ok: true }));

const route = (method: string, headers?: HeadersInit) =>
  withRoute("/api/test", handler)(
    new Request("http://portal.test/api/test", { method, ...(headers ? { headers } : {}) }),
    {}
  );

beforeEach(() => {
  // The default host allowlist is closed: name the host these tests send.
  vi.stubEnv("PORTAL_PUBLIC_URL", "https://openrhen.example.com");
  handler.mockClear();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("withRoute cross-site guard", () => {
  it("refuses a mutating request with Sec-Fetch-Site: cross-site", async () => {
    const response = await route("POST", { "sec-fetch-site": "cross-site" });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Cross-site requests are not allowed." });
    expect(handler).not.toHaveBeenCalled();
  });

  it.each(["same-site", "same-origin", "none"])(
    "allows a mutating request with Sec-Fetch-Site: %s",
    async (secFetchSite) => {
      const response = await route("POST", { "sec-fetch-site": secFetchSite });
      expect(response.status).toBe(200);
      expect(handler).toHaveBeenCalledTimes(1);
    }
  );

  it("allows a mutating request with no fetch-metadata headers at all (curl, the device, LAN scripts)", async () => {
    const response = await route("POST");
    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("allows a mutating request whose Origin host matches Host", async () => {
    const response = await route("POST", {
      origin: "https://openrhen.example.com",
      host: "openrhen.example.com"
    });
    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("refuses a mutating request whose Origin host does not match Host", async () => {
    const response = await route("POST", { origin: "https://evil.example", host: "openrhen.example.com" });
    expect(response.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });

  it("refuses a mutating request with an unparseable Origin", async () => {
    const response = await route("POST", { origin: "not-a-url", host: "openrhen.example.com" });
    expect(response.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });

  it.each(["GET", "HEAD", "OPTIONS"])("always allows %s, even cross-site", async (method) => {
    const response = await route(method, { "sec-fetch-site": "cross-site" });
    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("still refuses a PUT/DELETE/PATCH the same way as POST", async () => {
    for (const method of ["PUT", "DELETE", "PATCH"]) {
      handler.mockClear();
      const response = await route(method, { "sec-fetch-site": "cross-site" });
      expect(response.status).toBe(403);
      expect(handler).not.toHaveBeenCalled();
    }
  });
});

describe("withRoute host allowlist", () => {
  const request = (host: string, method = "GET") =>
    withRoute("/api/test", handler)(new Request("http://portal.test/api/test", { method, headers: { host } }), {});

  afterEach(() => vi.unstubAllEnvs());

  it("with no allowlist set, refuses a rebound Host and accepts the loopback names, the service name and the public URL host", async () => {
    vi.stubEnv("PORTAL_ALLOWED_HOSTS", "");
    vi.stubEnv("PORTAL_PUBLIC_URL", "");
    for (const host of [
      "evil.example:18787",
      "evil.example",
      "127.0.0.1.evil.example",
      "192.168.0.5:8787",
      "portal:9999"
    ]) {
      expect((await request(host, "POST")).status).toBe(403);
      expect((await request(host)).status).toBe(403);
    }
    for (const host of [
      "localhost",
      "localhost:8787",
      "127.0.0.1:3000",
      "[::1]:8787",
      "LOCALHOST:8787",
      "portal:8787"
    ]) {
      expect((await request(host)).status).toBe(200);
    }
    vi.stubEnv("PORTAL_PUBLIC_URL", "https://portal.example.com");
    expect((await request("portal.example.com")).status).toBe(200);
    expect((await request("other.example.com")).status).toBe(403);
  });

  it("a rebound page cannot mint an owner credential: its Origin and Host match, only the Host check stops it", async () => {
    vi.stubEnv("PORTAL_ALLOWED_HOSTS", "");
    const response = await request("evil.example:18787", "POST");
    expect(response.status).toBe(403);
  });

  it("refuses a Host that is not listed, reads included, and matches listed ones case-insensitively", async () => {
    vi.stubEnv("PORTAL_ALLOWED_HOSTS", "OpenRhen.Example, 127.0.0.1:8787");
    expect((await request("attacker.example:8787")).status).toBe(403);
    expect((await request("openrhen.example:80")).status).toBe(403);
    expect((await request("openrhen.example")).status).toBe(200);
    expect((await request("127.0.0.1:8787", "POST")).status).toBe(200);
  });
});

describe("redact", () => {
  it.each([
    ['{"token":"x1"}', '{"token":"***"}'],
    ['{"refresh_token": "x1", "ok": true}', '{"refresh_token": "***", "ok": true}'],
    ['{"accessToken":"x1"}', '{"accessToken":"***"}'],
    ["{'client_secret': 'x1'}", "{'client_secret': '***'}"],
    ['{"password":"has \\"quote\\" inside"}', '{"password":"***"}'],
    ['{"token":"cut off', '{"token":"***"'],
    ["refresh_token=x1", "refresh_token=***"],
    ["access_token: x1", "access_token: ***"],
    ["client_secret=x1&grant_type=refresh_token", "client_secret=***&grant_type=refresh_token"],
    ["?id_token=x1&state=ok", "?id_token=***&state=ok"],
    ["api_key=x1 apikey: x2 x-api-key: x3", "api_key=*** apikey: *** x-api-key: ***"],
    ["PASSWORD = x1", "PASSWORD = ***"],
    ["Authorization: Basic dXNlcjpwYXNz", "Authorization: ***"],
    ["authorization=Basic dXNlcjpwYXNz", "authorization=***"],
    ["Authorization: Bearer abc.def", "Authorization: ***"],
    ["Authorization: Token x1 was refused", "Authorization: *** was refused"],
    ["authorization=Digest x1", "authorization=***"],
    ["Authorization: Token x1", "Authorization: ***"],
    ["Authorization: Basic x1==", "Authorization: ***"],
    ["password=x1 rejected", "password=*** rejected"],
    ["password=x1x rejected", "password=*** rejected"],
    ["token=x1 expired", "token=*** expired"],
    ["secret=x1 failed to load", "secret=*** failed to load"],
    ["Cookie: sid=x1; theme=x2", "Cookie: ***"],
    ["Set-Cookie: sid=x1; Path=/; HttpOnly\nnext line", "Set-Cookie: ***\nnext line"],
    ['{"cookie":"sid=x1"}', '{"cookie":"***"}'],
    ['{"private_key":"-----BEGIN x1"}', '{"private_key":"***"}'],
    ["credentials=x1 pwd: x2", "credentials=*** pwd: ***"],
    ['body: {\\"token\\":\\"x1\\",\\"ok\\":true}', 'body: {\\"token\\":\\"***\\",\\"ok\\":true}'],
    ['{\\"client_secret\\": \\"x1\\"}', '{\\"client_secret\\": \\"***\\"}'],
    ["failed with Bearer abc.def", "failed with Bearer ***"],
    ["connect postgres://user:pw@db:5432/x failed", "connect postgresql://***@db:5432/x failed"]
  ])("redacts %s", (input, expected) => {
    const output = redact(input);
    expect(output).toBe(expected);
    expect(output).not.toMatch(/\bx[123]\b|dXNlcjpwYXNz|abc\.def|pw@/);
  });

  it.each([
    "plain failure: connection refused",
    "max_tokens=100 tokens: 5",
    "token count: 5 and the tokenizer: gpt",
    "secretary: Jane, passwords are rotated",
    "basic authentication failed",
    "refresh_token_expiry_days",
    "cookies: 3 set, credential store unavailable"
  ])("leaves %s unchanged", (input) => {
    expect(redact(input)).toBe(input);
  });

  it("stays linear on long hostile input", () => {
    const hostile = [
      "token".repeat(20_000),
      `"token":"${"\\".repeat(20_000)}`,
      `${"api_key ".repeat(20_000)}=`,
      "Bearer ".repeat(20_000),
      "authorization:".repeat(20_000),
      "postgres://".repeat(20_000),
      "cookie:".repeat(20_000),
      `${'\\"token\\"'.repeat(20_000)}:`,
      `authorization: ${"a".repeat(20_000)}`
    ];
    const start = performance.now();
    for (const input of hostile) redact(input);
    expect(performance.now() - start).toBeLessThan(1000);
  });
});

describe("withRoute basis and evidence headers", () => {
  it("refuses a bad basis or evidence with a 400 and never reaches the handler", async () => {
    for (const headers of [
      { "x-openrhen-basis": "guess" },
      { "x-openrhen-evidence": "x".repeat(301) },
      { "x-openrhen-agent": "scribe", "x-openrhen-evidence": "%E0%A4%A" }
    ]) {
      const response = await route("POST", headers);
      expect(response.status).toBe(400);
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it("does not put the values in the log", async () => {
    const log = vi.spyOn(console, "log");
    await route("POST", { "x-openrhen-basis": "stated", "x-openrhen-evidence": "my-secret-words" });
    expect(JSON.stringify(log.mock.calls)).not.toContain("my-secret-words");
  });

  it("passes the claim to an agent's handler through the request store", async () => {
    const { requestClaim } = await import("./agent-actor");
    let seen: unknown;
    const spy = vi.fn(async () => {
      seen = requestClaim();
      return Response.json({ ok: true });
    });
    await withRoute("/api/test", spy)(
      new Request("http://portal.test/api/test", {
        method: "POST",
        headers: {
          "x-openrhen-agent": "scribe",
          "x-openrhen-basis": "stated",
          "x-openrhen-evidence": encodeURIComponent("Friday please")
        }
      }),
      {}
    );
    expect(seen).toEqual({ basis: "stated", evidence: "Friday please" });
  });

  it("maps a forbidden command to 403", async () => {
    const { ForbiddenCommandError } = await import("@/server/persistence/postgres/command-errors");
    const response = await withRoute("/api/test", async () => {
      throw new ForbiddenCommandError("Only the owner can change that.");
    })(new Request("http://portal.test/api/test", { method: "POST" }), {});
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Only the owner can change that." });
  });
});

describe("withRoute error mapping", () => {
  const throwing = (error: unknown) =>
    withRoute("/api/test", async () => {
      throw error;
    })(new Request("http://portal.test/api/test", { method: "POST" }), {});

  /** What postgres.js throws: an Error carrying the SQLSTATE in `code`, and the table and values in its text. */
  const databaseError = (code: string, message: string) =>
    Object.assign(new Error(message), { name: "PostgresError", code, detail: "Key (id)=(secret-id) is not present." });

  it.each([
    [new InvalidCommandError("The selected project does not exist."), 400, "The selected project does not exist."],
    [new CommandConflictError("This project was changed elsewhere."), 409, "This project was changed elsewhere."],
    [
      new CommandIdReusedError("This command id was already used for a different write."),
      409,
      "This command id was already used for a different write."
    ],
    [new ForbiddenCommandError("Only the owner can do that."), 403, "Only the owner can do that."],
    [new NotFoundCommandError("There is nothing to undo."), 404, "There is nothing to undo."]
  ])("answers a command refusal with its own status and message", async (error, status, message) => {
    const response = await throwing(error);
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: message });
  });

  it("carries a conflict's current version in the 409 body", async () => {
    const response = await throwing(new CommandConflictError("Changed elsewhere.", { currentVersion: 7 }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Changed elsewhere.", currentVersion: 7 });
  });

  it("carries a refusal's next call and valid values in the body, for a 400 and a 409", async () => {
    const nextCall = { tool: "rhen_list", arguments: { entity: "projects", limit: 20 } };
    const invalid = await throwing(
      new InvalidCommandError('Project "p1" no longer exists.', { nextCall, validValues: { status: ["a"] } })
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({
      error: 'Project "p1" no longer exists.',
      nextCall,
      validValues: { status: ["a"] }
    });
    const conflict = await throwing(new CommandConflictError("Gone.", { nextCall }));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: "Gone.", nextCall });
  });

  it("answers 503 with committed and retryable, never 500, when a saved write could not be read back", async () => {
    const response = await throwing(new CommittedReadFailedError(new Error("connection terminated")));
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("2");
    expect(await response.json()).toEqual({
      error: "Saved, but the plan could not be read back. Repeat with the same command id to read it.",
      committed: true,
      retryable: true
    });
  });

  it.each([
    [new InvalidCommandError("Bad value for token=abc123 here."), 400],
    [new CommandConflictError("Changed; see postgres://user:pw@db/openrhen."), 409]
  ])("redacts credentials that reach a 400 or 409 body", async (error, status) => {
    const response = await throwing(error);
    expect(response.status).toBe(status);
    const body = JSON.stringify(await response.json());
    expect(body).not.toContain("abc123");
    expect(body).not.toContain("user:pw");
  });

  it.each([
    ["23503", 400],
    ["23505", 409],
    ["23514", 400],
    ["23502", 400],
    ["22P02", 400]
  ])("maps SQLSTATE %s to %i with a message that names no SQL", async (code, status) => {
    const response = await throwing(
      databaseError(
        code,
        'insert or update on table "actions" violates foreign key constraint "actions_project_id_fkey"'
      )
    );
    expect(response.status).toBe(status);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("Nothing was changed.");
    expect(JSON.stringify(body)).not.toMatch(/actions|constraint|secret-id|fkey/);
  });

  describe("database refusals tell the agent the field and the next call (F3-03)", () => {
    const withDetail = (code: string, detail: string, extra: Record<string, unknown> = {}) =>
      Object.assign(new Error("violates a constraint"), { name: "PostgresError", code, detail, ...extra });
    const realCall = (call: { tool: string; arguments: Record<string, unknown> } | undefined) => {
      expect(call).toBeDefined();
      const tool = mcpManifestTool(call!.tool);
      expect(tool, call!.tool).toBeDefined();
      expect(validateToolArguments(tool!.inputSchema, call!.arguments, tool!.name).ok).toBe(true);
    };

    it("a reference to a record that is gone names the field and says so", async () => {
      const response = await throwing(
        withDetail("23503", 'Key (project_id)=(secret-id) is not present in table "projects".')
      );
      const body = (await response.json()) as {
        error: string;
        nextCall?: { tool: string; arguments: Record<string, unknown> };
      };
      expect(response.status).toBe(400);
      expect(body.error).toContain("projectId");
      expect(body.error).toContain("no longer exists");
      expect(body.error).toContain("Nothing was changed");
      expect(body.error).toContain("NEW command-id");
      expect(body.error).not.toContain("still in use");
      expect(body.error).toMatch(/rhen_(show|list)/);
      expect(JSON.stringify(body)).not.toMatch(/secret-id|project_id|projects"/);
      realCall(body.nextCall);
    });

    it("a record that is still referenced is the other branch", async () => {
      const response = await throwing(
        withDetail("23503", 'Key (id)=(secret-id) is still referenced from table "actions".')
      );
      const body = (await response.json()) as {
        error: string;
        nextCall?: { tool: string; arguments: Record<string, unknown> };
      };
      expect(body.error).toContain("still in use");
      expect(body.error).not.toContain("no longer exists");
      expect(body.error).toMatch(/rhen_show/);
      expect(JSON.stringify(body)).not.toMatch(/secret-id|actions"/);
      realCall(body.nextCall);
    });

    it("a duplicate names the field that must differ", async () => {
      const response = await throwing(withDetail("23505", "Key (user_id, name)=(u1, Gym) already exists."));
      const body = (await response.json()) as {
        error: string;
        nextCall?: { tool: string; arguments: Record<string, unknown> };
      };
      expect(response.status).toBe(409);
      expect(body.error).toContain("name");
      expect(body.error).toContain("Nothing was changed");
      expect(body.error).toMatch(/rhen_(search|list|show)/);
      expect(JSON.stringify(body)).not.toMatch(/user_id|Gym|u1/);
      realCall(body.nextCall);
    });

    it("a missing required value names its column when the driver gives one", async () => {
      const response = await throwing(withDetail("23502", "Failing row contains (x).", { column_name: "starts_at" }));
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain("startsAt");
      expect(body.error).toContain("Nothing was changed");
    });

    it("the in-use branch does not guess whether an entity has a status", async () => {
      const body = (await (
        await throwing(withDetail("23503", 'Key (id)=(x) is still referenced from table "actions".'))
      ).json()) as { error: string };
      expect(body.error).not.toMatch(/if its entity|if it has/i);
      expect(body.error).toContain("rhen_show");
      expect(body.error).toContain("rhen_guide");
    });

    it("the duplicate text leads with the call nextCall carries", async () => {
      const body = (await (
        await throwing(withDetail("23505", "Key (user_id, name)=(u1, Gym) already exists."))
      ).json()) as {
        error: string;
        nextCall: { tool: string; arguments: Record<string, unknown> };
      };
      expect(`${body.nextCall.tool} ${JSON.stringify(body.nextCall.arguments)}`).toBe("rhen_status {}");
      expect(body.error).toContain("rhen_status {}");
      expect(body.error.indexOf("rhen_status {}")).toBeLessThan(body.error.indexOf("rhen_search"));
    });

    it("an internal column is never shown as a field", async () => {
      const body = (await (
        await throwing(withDetail("23503", 'Key (created_by_token_id)=(t1) is not present in table "agent_tokens".'))
      ).json()) as { error: string };
      expect(body.error).not.toMatch(/created_?by_?token|createdByToken/i);
      expect(body.error).toContain("A record you referenced");
    });

    it("every refusal says nothing changed and what to do next", async () => {
      for (const code of ["23503", "23505", "23514", "23502", "22P02"]) {
        const body = (await (await throwing(withDetail(code, "x"))).json()) as { error: string; nextCall?: unknown };
        expect(body.error, code).toContain("Nothing was changed");
        expect(body.error, code).toContain("rhen_");
        expect(body.nextCall, code).toBeDefined();
      }
    });
  });

  it("logs a database refusal at info with its SQLSTATE and stack, not as a failure", async () => {
    const log = vi.spyOn(console, "log");
    const error = vi.spyOn(console, "error");
    await throwing(databaseError("23503", "violates foreign key constraint"));
    expect(error).not.toHaveBeenCalled();
    const line = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as Record<string, unknown>;
    expect(line).toMatchObject({
      level: "info",
      message: "Portal request refused",
      status: 400,
      errorCode: "23503"
    });
    expect(line.stack).toEqual(expect.any(String));
  });

  it.each(["23514", "23502"])(
    "still answers 400 for SQLSTATE %s but logs it as an error, since it may be a server bug",
    async (code) => {
      const log = vi.spyOn(console, "log");
      const error = vi.spyOn(console, "error");
      const response = await throwing(databaseError(code, "violates a constraint"));
      expect(response.status).toBe(400);
      const line = JSON.parse(String((error.mock.calls.at(-1) ?? log.mock.calls.at(-1))?.[0])) as Record<
        string,
        unknown
      >;
      expect(line).toMatchObject({ level: "error", message: "Portal request refused", status: 400, errorCode: code });
    }
  );

  it("keeps a plain error, and a database error of another kind, a generic 500 logged as a failure", async () => {
    const error = vi.spyOn(console, "error");
    for (const thrown of [new Error("boom"), databaseError("42P01", 'relation "x" does not exist')]) {
      const response = await throwing(thrown);
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "The request failed." });
    }
    expect(error).toHaveBeenCalledTimes(2);
  });

  it("does not treat a non-Error object with a matching code as a database refusal", async () => {
    expect((await throwing({ code: "23505" })).status).toBe(500);
  });
});

describe("withRoute compression", () => {
  const big = { rows: Array.from({ length: 2000 }, (_, index) => ({ index, text: "the same words again and again" })) };
  const compressing = (acceptEncoding?: string, body: unknown = big) =>
    withRoute("/api/test", async () => Response.json(body))(
      new Request("http://portal.test/api/test", {
        method: "GET",
        ...(acceptEncoding ? { headers: { "accept-encoding": acceptEncoding } } : {})
      }),
      {}
    );

  it("gzips a large JSON answer for a client that accepts it, and the body still parses", async () => {
    const { gunzipSync } = await import("node:zlib");
    const response = await compressing("gzip, deflate, br");
    expect(response.headers.get("content-encoding")).toBe("gzip");
    expect(response.headers.get("vary")).toMatch(/Accept-Encoding/i);
    const raw = Buffer.from(await response.arrayBuffer());
    expect(raw.length).toBeLessThan(JSON.stringify(big).length / 4);
    expect(JSON.parse(gunzipSync(raw).toString())).toEqual(big);
  });

  it("leaves the answer alone when the client does not accept gzip or the body is small", async () => {
    expect((await compressing()).headers.get("content-encoding")).toBeNull();
    expect((await compressing("identity")).headers.get("content-encoding")).toBeNull();
    expect((await compressing("gzip", { ok: true })).headers.get("content-encoding")).toBeNull();
  });
});
