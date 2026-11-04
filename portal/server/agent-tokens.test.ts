import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createFailureThrottle } from "./agent-token-throttle";
import {
  AGENT_TOKEN_HEADER,
  identifyRequest,
  parseAgentTokens,
  writeAllowed,
  type DbTokenRecord,
  type IdentifyDeps
} from "./agent-tokens";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const table = parseAgentTokens(
  JSON.stringify([
    { name: "scribe", sha256: sha("scribe-token"), writes: ["/api/commands/capture", "/api/commands/session/*"] },
    { name: "reader", sha256: sha("reader-token") },
    { name: "boss", sha256: sha("boss-token"), writes: "all" }
  ])
);
const request = (method: string, token?: string) =>
  new Request("http://portal.test/api/x", { method, ...(token ? { headers: { [AGENT_TOKEN_HEADER]: token } } : {}) });
const none = async () => null;
const identify = (
  method: string,
  route: string,
  token?: string,
  declared?: string,
  mode: "off" | "require" = "off",
  deps: IdentifyDeps = {}
) => identifyRequest(request(method, token), route, declared, table, mode, { lookup: none, ...deps });

describe("parseAgentTokens", () => {
  it("treats unset as an empty table and rejects malformed ones", () => {
    expect(parseAgentTokens(undefined)).toEqual({ ok: true, entries: [] });
    for (const raw of [
      "nope",
      "{}",
      '[{"name":"system","sha256":"' + sha("a") + '"}]',
      '[{"name":"a","sha256":"short"}]',
      '[{"name":"a","sha256":"' + sha("a") + '","writes":["/other"]}]',
      '[{"name":"a","sha256":"' + sha("a") + '"},{"name":"a","sha256":"' + sha("b") + '"}]'
    ])
      expect(parseAgentTokens(raw).ok).toBe(false);
  });
});

describe("writeAllowed", () => {
  it("matches exact routes, trailing-star prefixes, all and none", () => {
    expect(writeAllowed(["/api/a/*"], "/api/a/b")).toBe(true);
    expect(writeAllowed(["/api/a"], "/api/a/b")).toBe(false);
    expect(writeAllowed("all", "/api/z")).toBe(true);
    expect(writeAllowed("none", "/api/z")).toBe(false);
  });
});

describe("identifyRequest", () => {
  it("names the actor from a valid token and ignores a self-declared name", async () => {
    expect((await identify("POST", "/api/commands/capture", "scribe-token", "someone-else")).actor).toBe("scribe");
  });
  it("refuses a wrong token with 401, never anonymous", async () => {
    const result = await identify("GET", "/api/state", "wrong", "scribe");
    expect(result.refusal?.status).toBe(401);
  });
  it("lets an environment token read anywhere but write only within its route list", async () => {
    expect((await identify("GET", "/api/state", "reader-token")).refusal).toBeUndefined();
    expect((await identify("POST", "/api/commands/capture", "reader-token")).refusal?.status).toBe(403);
    expect((await identify("POST", "/api/commands/session/start", "scribe-token")).refusal).toBeUndefined();
    expect((await identify("POST", "/api/commands/project", "scribe-token")).refusal?.status).toBe(403);
    expect((await identify("POST", "/api/anything", "boss-token")).refusal).toBeUndefined();
  });
  it("accepts a self-declared name only while the switch is off", async () => {
    expect((await identify("POST", "/api/x", undefined, "scribe")).actor).toBe("scribe");
    expect((await identify("POST", "/api/x", undefined, "scribe", "require")).refusal?.status).toBe(401);
    expect(await identify("POST", "/api/x", undefined, undefined, "require")).toEqual({ actor: undefined });
  });
  it("answers 503 for a presented token when the table is misconfigured", async () => {
    const bad = parseAgentTokens("nope");
    const result = await identifyRequest(request("GET", "t"), "/api/x", undefined, bad, "off", { lookup: none });
    expect(result.refusal?.status).toBe(503);
  });
});

describe("identifyRequest with database tokens", () => {
  const now = new Date("2026-10-18T00:00:00Z");
  const stored = (token: string, extra: Partial<DbTokenRecord> = {}): DbTokenRecord => ({
    id: "11111111-1111-4111-8111-111111111111",
    name: "companion",
    tokenHash: sha(token),
    scopes: ["read:plan", "write:entity:action"],
    directWrites: { action: "shadow" },
    expiresAt: new Date("2026-12-01T00:00:00Z"),
    revokedAt: null,
    ...extra
  });
  const lookupOf = (record: DbTokenRecord | null) => {
    const seen: string[] = [];
    return {
      seen,
      lookup: async (hash: string) => {
        seen.push(hash);
        return record;
      }
    };
  };

  it("resolves a database token to a principal with its scopes and directWrites, and touches it", async () => {
    const touched: string[] = [];
    const { lookup, seen } = lookupOf(stored("db-token"));
    const result = await identify("POST", "/api/commands/action", "db-token", "someone-else", "off", {
      lookup,
      touch: (id) => touched.push(id),
      now: () => now
    });
    expect(result.actor).toBe("companion");
    expect(result.principal).toEqual({
      name: "companion",
      source: "db",
      tokenId: "11111111-1111-4111-8111-111111111111",
      scopes: ["read:plan", "write:entity:action"],
      directWrites: { action: "shadow" }
    });
    expect(seen).toEqual([sha("db-token")]);
    expect(touched).toEqual(["11111111-1111-4111-8111-111111111111"]);
  });

  it("lets a database token win over an environment token with the same secret", async () => {
    const { lookup } = lookupOf(stored("scribe-token", { name: "from-db" }));
    const result = await identify("GET", "/api/state", "scribe-token", undefined, "off", { lookup, now: () => now });
    expect(result.principal?.source).toBe("db");
    expect(result.actor).toBe("from-db");
  });

  it("falls back to the environment table when the database has no such token", async () => {
    const result = await identify("GET", "/api/state", "reader-token", undefined, "off", { lookup: none });
    expect(result.principal).toEqual({ name: "reader", source: "env", directWrites: {} });
  });

  it("refuses a revoked or expired token with 401 and says which", async () => {
    const revoked = await identify("GET", "/api/state", "t", undefined, "off", {
      lookup: lookupOf(stored("t", { revokedAt: now })).lookup,
      now: () => now
    });
    expect(revoked.refusal?.status).toBe(401);
    expect(await revoked.refusal?.json()).toEqual({
      error:
        'The agent token "companion" was revoked, so nothing was done. Do not retry. Tell the owner it was revoked and ask whether they want it replaced. If the owner is not in this conversation, put that in your next report.'
    });
    const expired = await identify("GET", "/api/state", "t", undefined, "off", {
      lookup: lookupOf(stored("t", { expiresAt: now })).lookup,
      now: () => now
    });
    expect(expired.refusal?.status).toBe(401);
    expect(await expired.refusal?.json()).toEqual({
      error:
        'The agent token "companion" expired on 2026-10-18, so nothing was done. Do not retry. Tell the owner: "This agent\'s token has expired; please issue a replacement (in a terminal: `rhen agent-token create --name companion --scopes read:plan,write:entity:action`)." If the owner is not in this conversation, put that in your next report.'
    });
  });

  it("never puts the token, id or hash in the revoked or expired text", async () => {
    for (const extra of [{ revokedAt: now }, { expiresAt: now }]) {
      const result = await identify("GET", "/api/state", "t", undefined, "off", {
        lookup: lookupOf(stored("t", extra)).lookup,
        now: () => now
      });
      const text = JSON.stringify(await result.refusal?.json());
      for (const secret of ["t", sha("t"), "11111111-1111-4111-8111-111111111111"])
        expect(text.split(`"${secret}"`).length).toBe(1);
      expect(text).not.toContain(sha("t"));
      expect(text).not.toContain("11111111-1111");
    }
  });

  it("does not count a revoked or expired token toward the throttle", async () => {
    const throttle = createFailureThrottle(2, 60_000);
    const { lookup } = lookupOf(stored("t", { revokedAt: now }));
    for (let i = 0; i < 5; i += 1)
      expect(
        (await identify("GET", "/api/state", "t", undefined, "off", { lookup, throttle, now: () => now })).refusal
          ?.status
      ).toBe(401);
    expect(throttle.retryAfter("direct")).toBe(0);
  });

  it("does not trust a row whose stored hash differs from the presented one", async () => {
    const result = await identify("GET", "/api/state", "t", undefined, "off", {
      lookup: lookupOf(stored("other")).lookup,
      now: () => now
    });
    expect(result.refusal?.status).toBe(401);
  });

  it("keeps working for environment tokens when the table cannot be read, and says 503 for an unknown one", async () => {
    const broken = async () => {
      throw new Error("relation agent_tokens does not exist");
    };
    expect((await identify("GET", "/api/state", "reader-token", undefined, "off", { lookup: broken })).actor).toBe(
      "reader"
    );
    expect((await identify("GET", "/api/state", "unknown", undefined, "off", { lookup: broken })).refusal?.status).toBe(
      503
    );
  });

  it("answers 429 with Retry-After after ten unrecognised tokens from one address, but not other addresses", async () => {
    const throttle = createFailureThrottle(10, 60_000);
    const from = (address: string, token: string) =>
      identifyRequest(
        new Request("http://portal.test/api/x", {
          headers: { [AGENT_TOKEN_HEADER]: token, "x-forwarded-for": `203.0.113.9, ${address}` }
        }),
        "/api/x",
        undefined,
        table,
        "off",
        { lookup: none, throttle }
      );
    for (let attempt = 0; attempt < 10; attempt += 1)
      expect((await from("198.51.100.1", "bad")).refusal?.status).toBe(401);
    const blocked = await from("198.51.100.1", "bad");
    expect(blocked.refusal?.status).toBe(429);
    expect(Number(blocked.refusal?.headers.get("retry-after"))).toBeGreaterThan(0);
    const body = (await blocked.refusal!.clone().json()) as { error: string; retryAfterSeconds: number };
    expect(body.error).toContain(`Wait ${blocked.refusal?.headers.get("retry-after")} seconds`);
    expect(body.retryAfterSeconds).toBe(Number(blocked.refusal?.headers.get("retry-after")));
    expect((await from("198.51.100.2", "bad")).refusal?.status).toBe(401);
    expect((await from("198.51.100.2", "reader-token")).actor).toBe("reader");
  });
});
