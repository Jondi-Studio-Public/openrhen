import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { fileURLToPath } from "node:url";
import { integrationDatabaseName } from "@openrhen/database";
import { allDirectWritesOn } from "@openrhen/contracts";
import { createAgentToken } from "./agent-token-store";
import {
  AUTHORIZATION_CODE_PREFIX,
  MAX_OAUTH_CLIENTS,
  OauthStoreFull,
  REFRESH_TOKEN_PREFIX,
  consumeAuthorizationCode,
  createAuthorizationCode,
  findClient,
  grantClient,
  hashAuthorizationCode,
  hashRefreshToken,
  issueRefreshToken,
  registerClient,
  useRefreshToken
} from "./mcp-oauth-store";

/** OAuth client, code and refresh token storage, against a real `_test` database. */
config({ path: fileURLToPath(new URL("../../.env", import.meta.url)), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(
  process.env.MCP_OAUTH_STORE_TEST_DATABASE_NAME,
  "openrhen_mcp_oauth_store"
);

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("MCP_OAUTH_STORE_TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;

const register = (name = "OpenClaw") =>
  registerClient(sql, { clientName: name, redirectUris: ["http://127.0.0.1:8123/callback"] });

const scopes = ["read:plan"];

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
  await sql.unsafe(
    "TRUNCATE TABLE oauth_authorization_codes, oauth_refresh_tokens, oauth_clients, agent_access_tokens, agent_tokens RESTART IDENTITY CASCADE"
  );
});

afterAll(async () => {
  await sql?.end();
});

describe("clients", () => {
  it("registers and finds a client", async () => {
    const client = await register();
    expect(client.clientId.startsWith("pri_client_")).toBe(true);
    expect(await findClient(sql, client.clientId)).toEqual(client);
    expect(client.redirectUris).toEqual(["http://127.0.0.1:8123/callback"]);
    expect(await findClient(sql, "pri_client_nope")).toBeNull();
  });

  it("evicts the oldest client without a live grant past the cap, and keeps granted ones", async () => {
    const granted = await register("granted");
    const agent = await grantClient(sql, { client: granted, scopes });
    await createAuthorizationCode(sql, {
      clientId: granted.clientId,
      agent,
      redirectUri: "http://127.0.0.1:8123/callback",
      codeChallenge: "c".repeat(43),
      resource: "r",
      scopes
    });
    const second = await register("second");
    for (let i = 2; i < MAX_OAUTH_CLIENTS; i += 1) await register(`filler-${i}`);
    const extra = await register("extra");
    expect(await findClient(sql, granted.clientId)).not.toBeNull();
    expect(await findClient(sql, second.clientId)).toBeNull();
    expect(await findClient(sql, extra.clientId)).not.toBeNull();
    expect((await sql`SELECT 1 FROM oauth_clients`).length).toBe(MAX_OAUTH_CLIENTS);
  }, 30_000);

  it("throws OauthStoreFull when every client at the cap holds a live grant", async () => {
    for (let i = 0; i < MAX_OAUTH_CLIENTS; i += 1) {
      const client = await register(`c${i}`);
      const agent = await grantClient(sql, { client, scopes });
      await issueRefreshToken(sql, { clientId: client.clientId, agent, resource: "r", scopes });
    }
    await expect(register("one-too-many")).rejects.toBeInstanceOf(OauthStoreFull);
    expect((await sql`SELECT 1 FROM oauth_clients`).length).toBe(MAX_OAUTH_CLIENTS);
  }, 60_000);

  it("frees a client whose agent token was revoked", async () => {
    const client = await register("revoked");
    const agent = await grantClient(sql, { client, scopes });
    await issueRefreshToken(sql, { clientId: client.clientId, agent, resource: "r", scopes });
    await sql`UPDATE agent_tokens SET revoked_at = now() WHERE id = ${agent.id}`;
    for (let i = 1; i < MAX_OAUTH_CLIENTS; i += 1) await register(`filler-${i}`);
    await register("extra");
    expect(await findClient(sql, client.clientId)).toBeNull();
  }, 30_000);
});

describe("grantClient", () => {
  it("creates a scoped agent token named for the client, with direct writes on for every class", async () => {
    const client = await register("My Client!");
    const now = new Date("2026-10-26T00:00:00Z");
    const agent = await grantClient(sql, { client, scopes }, now);
    expect(agent.name).toBe("oauth-my-client");
    expect(agent.scopes).toEqual(scopes);
    expect(agent.directWrites).toEqual(allDirectWritesOn());
    expect(agent.revokedAt).toBeNull();
    expect(agent.expiresAt).toEqual(new Date("2027-01-24T00:00:00Z"));
  });

  it("adds a suffix when a live token holds the name, and keeps names within 32 characters", async () => {
    const client = await register("x".repeat(64));
    const first = await grantClient(sql, { client, scopes });
    const second = await grantClient(sql, { client, scopes });
    expect(first.name.length).toBeLessThanOrEqual(32);
    expect(second.name).not.toBe(first.name);
    expect(second.name).toMatch(/^[a-z0-9_-]{1,32}$/);
    const other = await createAgentToken(sql, {
      name: "oauth-taken",
      scopes,
      directWrites: {},
      expiresInDays: 1
    });
    expect(other.summary.name).toBe("oauth-taken");
    const taken = await grantClient(sql, { client: { ...client, clientName: "taken" }, scopes });
    expect(taken.name).toMatch(/^oauth-taken-[0-9a-f]{6}$/);
  });
});

describe("authorization codes", () => {
  const setup = async () => {
    const client = await register();
    const agent = await grantClient(sql, { client, scopes });
    return { client, agent };
  };

  it("stores only the hash and expires in 120 seconds", async () => {
    const { client, agent } = await setup();
    const now = new Date("2026-10-26T00:00:00Z");
    const { code, expiresAt } = await createAuthorizationCode(
      sql,
      {
        clientId: client.clientId,
        agent,
        redirectUri: "http://127.0.0.1:8123/callback",
        codeChallenge: "c".repeat(43),
        resource: "r",
        scopes
      },
      now
    );
    expect(code.startsWith(AUTHORIZATION_CODE_PREFIX)).toBe(true);
    expect(expiresAt).toEqual(new Date("2026-10-26T00:02:00Z"));
    const [row] = await sql<{ code_hash: string }[]>`SELECT code_hash FROM oauth_authorization_codes`;
    expect(row!.code_hash).toBe(hashAuthorizationCode(code));
    expect(JSON.stringify(row)).not.toContain(code);
  });

  it("consumes once; a replay sees the earlier consumption; an unknown hash is null", async () => {
    const { client, agent } = await setup();
    const { code } = await createAuthorizationCode(sql, {
      clientId: client.clientId,
      agent,
      redirectUri: "http://127.0.0.1:8123/callback",
      codeChallenge: "c".repeat(43),
      resource: "r",
      scopes
    });
    const t1 = new Date("2026-10-26T00:00:10Z");
    const first = await consumeAuthorizationCode(sql, hashAuthorizationCode(code), t1);
    expect(first).toMatchObject({
      clientId: client.clientId,
      agentTokenId: agent.id,
      redirectUri: "http://127.0.0.1:8123/callback",
      resource: "r",
      scopes,
      consumedAt: null
    });
    expect(first?.agent.name).toBe(agent.name);
    const replay = await consumeAuthorizationCode(sql, hashAuthorizationCode(code), new Date("2026-10-26T00:00:20Z"));
    expect(replay?.consumedAt).toEqual(t1);
    expect(await consumeAuthorizationCode(sql, hashAuthorizationCode("pri_code_unknown"))).toBeNull();
  });

  it("lets exactly one of several concurrent exchanges consume it", async () => {
    const { client, agent } = await setup();
    const { code } = await createAuthorizationCode(sql, {
      clientId: client.clientId,
      agent,
      redirectUri: "u",
      codeChallenge: "c".repeat(43),
      resource: "r",
      scopes
    });
    const results = await Promise.all(
      Array.from({ length: 4 }, () => consumeAuthorizationCode(sql, hashAuthorizationCode(code)))
    );
    expect(results.filter((r) => r?.consumedAt === null)).toHaveLength(1);
  });

  it("reports expiry through expiresAt and sweeps rows expired over a day ago", async () => {
    const { client, agent } = await setup();
    const old = await createAuthorizationCode(
      sql,
      { clientId: client.clientId, agent, redirectUri: "u", codeChallenge: "c".repeat(43), resource: "r", scopes },
      new Date(Date.now() - 3 * 86_400_000)
    );
    expect((await consumeAuthorizationCode(sql, hashAuthorizationCode(old.code)))!.expiresAt.getTime()).toBeLessThan(
      Date.now()
    );
    await createAuthorizationCode(sql, {
      clientId: client.clientId,
      agent,
      redirectUri: "u",
      codeChallenge: "c".repeat(43),
      resource: "r",
      scopes
    });
    expect(await sql`SELECT 1 FROM oauth_authorization_codes`).toHaveLength(1);
  });
});

describe("refresh tokens", () => {
  it("stores only the hash, rotates once, and a replay sees the earlier use", async () => {
    const client = await register();
    const agent = await grantClient(sql, { client, scopes });
    const now = new Date("2026-10-26T00:00:00Z");
    const { token, expiresAt } = await issueRefreshToken(
      sql,
      { clientId: client.clientId, agent, resource: "r", scopes },
      now
    );
    expect(token.startsWith(REFRESH_TOKEN_PREFIX)).toBe(true);
    expect(expiresAt).toEqual(new Date("2026-11-25T00:00:00Z"));
    const [row] = await sql<{ token_hash: string }[]>`SELECT token_hash FROM oauth_refresh_tokens`;
    expect(row!.token_hash).toBe(hashRefreshToken(token));
    const t1 = new Date("2026-10-27T00:00:00Z");
    const first = await useRefreshToken(sql, hashRefreshToken(token), t1);
    expect(first).toMatchObject({
      clientId: client.clientId,
      agentTokenId: agent.id,
      resource: "r",
      scopes,
      usedAt: null
    });
    const replay = await useRefreshToken(sql, hashRefreshToken(token), new Date("2026-10-28T00:00:00Z"));
    expect(replay?.usedAt).toEqual(t1);
    expect(await useRefreshToken(sql, hashRefreshToken("pri_rt_unknown"))).toBeNull();
  });

  it("never outlives its agent token", async () => {
    const client = await register();
    const agent = await grantClient(sql, { client, scopes });
    const now = new Date(agent.expiresAt.getTime() - 86_400_000);
    const { expiresAt } = await issueRefreshToken(
      sql,
      { clientId: client.clientId, agent, resource: "r", scopes },
      now
    );
    expect(expiresAt).toEqual(agent.expiresAt);
  });

  it("sweeps rows expired over a day ago when the next is issued", async () => {
    const client = await register();
    const agent = await grantClient(sql, { client, scopes });
    const old = new Date(Date.now() - 60 * 86_400_000);
    await issueRefreshToken(
      sql,
      {
        clientId: client.clientId,
        agent: { ...agent, expiresAt: new Date(old.getTime() + 86_400_000) },
        resource: "r",
        scopes
      },
      old
    );
    await issueRefreshToken(sql, { clientId: client.clientId, agent, resource: "r", scopes });
    expect(await sql`SELECT 1 FROM oauth_refresh_tokens`).toHaveLength(1);
  });
});
