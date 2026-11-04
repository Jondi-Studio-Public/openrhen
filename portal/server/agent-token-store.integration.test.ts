import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { fileURLToPath } from "node:url";
import { integrationDatabaseName } from "@openrhen/database";
import { allDirectWritesOn, createAgentTokenSchema } from "@openrhen/contracts";
import {
  AgentTokenError,
  createAgentToken,
  findAgentTokenByHash,
  hashAgentToken,
  listAgentTokens,
  revokeAgentToken,
  setAgentTokenDirectWrites,
  touchAgentToken
} from "./agent-token-store";
import { identifyRequest, AGENT_TOKEN_HEADER } from "./agent-tokens";
import { createFailureThrottle } from "./agent-token-throttle";

/**
 * The agent token table: only a hash is stored, a listing never
 * carries a secret, a live name is unique, revocation and expiry end a token at once, and last use is recorded
 * at most once a minute. Self-contained `_test` database, the same pattern as the proposal store's test.
 */
config({ path: fileURLToPath(new URL("../../.env", import.meta.url)), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(process.env.AGENT_TOKENS_TEST_DATABASE_NAME, "openrhen_agent_tokens");

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("AGENT_TOKENS_TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;

const input = (name: string, extra: Record<string, unknown> = {}) =>
  createAgentTokenSchema.parse({ name, scopes: ["read:plan", "write:entity:action"], ...extra });

const refusal = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AgentTokenError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
};

beforeAll(async () => {
  const admin = postgres(adminUrl!, { max: 1, connect_timeout: 10 });
  try {
    const existing = await admin<{ exists: boolean }[]>`
      SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = ${testDatabaseName}) AS exists
    `;
    if (!existing[0]?.exists) await admin.unsafe(`CREATE DATABASE "${testDatabaseName}"`);
  } finally {
    await admin.end();
  }
  const migrationSql = postgres(testUrl.toString(), { max: 1, connect_timeout: 10 });
  try {
    await migrate(drizzle(migrationSql), {
      migrationsFolder: fileURLToPath(new URL("../../platform/database/drizzle", import.meta.url))
    });
  } finally {
    await migrationSql.end();
  }
  sql = postgres(testUrl.toString(), { max: 5, connect_timeout: 10, fetch_types: false, prepare: true });
}, 30_000);

beforeEach(async () => {
  await sql.unsafe("TRUNCATE TABLE agent_tokens RESTART IDENTITY CASCADE");
});

afterAll(async () => {
  await sql?.end();
});

describe("createAgentToken", () => {
  it("returns the token once, stores only its hash, and defaults to 90 days and no direct writes", async () => {
    const now = new Date("2026-10-18T00:00:00Z");
    const { token, summary } = await createAgentToken(sql, input("companion"), now);
    expect(token).toMatch(/^pri_[A-Za-z0-9_-]{43}$/);
    expect(summary).toMatchObject({
      name: "companion",
      scopes: ["read:plan", "write:entity:action"],
      directWrites: {},
      expiresAt: "2027-01-16T00:00:00.000Z",
      lastUsedAt: null,
      revokedAt: null
    });
    const [row] = await sql<{ token_hash: string }[]>`SELECT token_hash FROM agent_tokens`;
    expect(row!.token_hash).toBe(hashAgentToken(token));
    expect(JSON.stringify(await listAgentTokens(sql))).not.toContain(token);
    expect(JSON.stringify(await listAgentTokens(sql))).not.toContain(row!.token_hash);
  });

  it("refuses a second live token with the same name, and allows the name again once the first is revoked", async () => {
    const first = await createAgentToken(sql, input("companion"));
    expect((await refusal(createAgentToken(sql, input("companion")))).status).toBe(409);
    await revokeAgentToken(sql, first.summary.id);
    await createAgentToken(sql, input("companion"));
    expect(await listAgentTokens(sql)).toHaveLength(2);
  });

  it("keeps the direct-write modes it was given", async () => {
    const { summary } = await createAgentToken(sql, input("companion", { directWrites: { action: "shadow" } }));
    expect(summary.directWrites).toEqual({ action: "shadow" });
  });
});

describe("setAgentTokenDirectWrites", () => {
  it("replaces the whole map, turns every class on or off, and the lookup sees it", async () => {
    const { token, summary } = await createAgentToken(sql, input("companion", { directWrites: { action: "shadow" } }));
    const on = await setAgentTokenDirectWrites(sql, summary.id, allDirectWritesOn());
    expect(on.directWrites).toEqual(allDirectWritesOn());
    expect((await findAgentTokenByHash(sql, hashAgentToken(token)))?.directWrites).toEqual(allDirectWritesOn());
    expect((await setAgentTokenDirectWrites(sql, summary.id, {})).directWrites).toEqual({});
  });

  it("refuses an unknown class with 400, and a revoked, expired or unknown token with 404", async () => {
    const { summary } = await createAgentToken(sql, input("companion"));
    expect((await refusal(setAgentTokenDirectWrites(sql, summary.id, { settings: "on" }))).status).toBe(400);
    expect((await refusal(setAgentTokenDirectWrites(sql, summary.id, { action: "maybe" }))).status).toBe(400);
    expect((await refusal(setAgentTokenDirectWrites(sql, "22222222-2222-4222-8222-222222222222", {}))).status).toBe(
      404
    );
    expect(
      (await refusal(setAgentTokenDirectWrites(sql, summary.id, {}, new Date(Date.now() + 400 * 86_400_000)))).status
    ).toBe(404);
    await revokeAgentToken(sql, summary.id);
    expect((await refusal(setAgentTokenDirectWrites(sql, summary.id, allDirectWritesOn()))).status).toBe(404);
  });
});

describe("lookup, revoke and last use", () => {
  it("finds a token by the hash of what was presented and nothing else", async () => {
    const { token, summary } = await createAgentToken(sql, input("companion"));
    expect((await findAgentTokenByHash(sql, hashAgentToken(token)))?.id).toBe(summary.id);
    expect(await findAgentTokenByHash(sql, hashAgentToken("pri_other"))).toBeNull();
  });

  it("revokes at once, idempotently, and answers 404 for an unknown id", async () => {
    const { token, summary } = await createAgentToken(sql, input("companion"));
    const revoked = await revokeAgentToken(sql, summary.id, new Date("2026-10-18T01:00:00Z"));
    expect(revoked.revokedAt).toBe("2026-10-18T01:00:00.000Z");
    expect((await findAgentTokenByHash(sql, hashAgentToken(token)))?.revokedAt).toBeInstanceOf(Date);
    expect((await revokeAgentToken(sql, summary.id)).revokedAt).toBe("2026-10-18T01:00:00.000Z");
    expect((await refusal(revokeAgentToken(sql, "22222222-2222-4222-8222-222222222222"))).status).toBe(404);
  });

  it("records last use at most once a minute", async () => {
    const { summary } = await createAgentToken(sql, input("companion"));
    await touchAgentToken(sql, summary.id);
    const [first] = await sql<{ last_used_at: Date }[]>`SELECT last_used_at FROM agent_tokens WHERE id=${summary.id}`;
    expect(first!.last_used_at).toBeInstanceOf(Date);
    await touchAgentToken(sql, summary.id);
    const [second] = await sql<{ last_used_at: Date }[]>`SELECT last_used_at FROM agent_tokens WHERE id=${summary.id}`;
    expect(second!.last_used_at.getTime()).toBe(first!.last_used_at.getTime());
    await sql`UPDATE agent_tokens SET last_used_at = last_used_at - interval '2 minutes' WHERE id=${summary.id}`;
    await touchAgentToken(sql, summary.id);
    const [third] = await sql<{ last_used_at: Date }[]>`SELECT last_used_at FROM agent_tokens WHERE id=${summary.id}`;
    expect(third!.last_used_at.getTime()).toBeGreaterThan(first!.last_used_at.getTime() - 1);
  });
});

describe("identifyRequest against the table", () => {
  const identify = (token: string, now = new Date()) =>
    identifyRequest(
      new Request("http://portal.test/api/state", { headers: { [AGENT_TOKEN_HEADER]: token } }),
      "/api/state",
      undefined,
      { ok: true, entries: [] },
      "off",
      {
        lookup: (hash) => findAgentTokenByHash(sql, hash),
        touch: () => {},
        throttle: createFailureThrottle(),
        now: () => now
      }
    );

  it("accepts a live token, then refuses it once revoked or expired", async () => {
    const { token, summary } = await createAgentToken(sql, input("companion", { expiresInDays: 1 }));
    expect((await identify(token)).principal).toMatchObject({ name: "companion", source: "db", tokenId: summary.id });
    expect((await identify(token, new Date(Date.now() + 2 * 86_400_000))).refusal?.status).toBe(401);
    await revokeAgentToken(sql, summary.id);
    expect((await identify(token)).refusal?.status).toBe(401);
    expect((await identify("pri_wrong")).refusal?.status).toBe(401);
  });
});
