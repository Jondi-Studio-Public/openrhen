import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { fileURLToPath } from "node:url";
import { integrationDatabaseName } from "@openrhen/database";
import { createAgentTokenSchema } from "@openrhen/contracts";
import { createAgentToken, findAgentTokenByHash, hashAgentToken, revokeAgentToken } from "./agent-token-store";
import { createFailureThrottle } from "./agent-token-throttle";
import {
  ACCESS_TOKEN_PREFIX,
  MAX_LIVE_ACCESS_TOKENS,
  createAccessToken,
  findAccessTokenByHash,
  hashAccessToken
} from "./mcp-access-tokens";
import { authenticateBearer, handleTokenRequest, type OauthDeps } from "./mcp-oauth";
import {
  consumeAuthorizationCode,
  findClient,
  issueRefreshToken,
  registerClient,
  useRefreshToken
} from "./mcp-oauth-store";

/**
 * Access tokens for the remote `/mcp` endpoint: only a hash is
 * stored, a token never outlives its agent token, revoking the agent token ends it, and the token endpoint and
 * the bearer check work end to end against the real table. Self-contained `_test` database, the same pattern as
 * the agent token store's test.
 */
config({ path: fileURLToPath(new URL("../../.env", import.meta.url)), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(
  process.env.MCP_ACCESS_TOKENS_TEST_DATABASE_NAME,
  "openrhen_mcp_access_tokens"
);

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("MCP_ACCESS_TOKENS_TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;

const issue = (name: string, extra: Record<string, unknown> = {}) =>
  createAgentToken(sql, createAgentTokenSchema.parse({ name, scopes: ["read:plan", "read:changes"], ...extra }));

const deps = (now: () => Date = () => new Date()): OauthDeps => ({
  findAgentToken: (hash) => findAgentTokenByHash(sql, hash),
  mintAccessToken: (input) => createAccessToken(sql, input),
  findAccessToken: (hash) => findAccessTokenByHash(sql, hash),
  findClient: (clientId) => findClient(sql, clientId),
  registerClient: (input) => registerClient(sql, input),
  consumeAuthorizationCode: (hash) => consumeAuthorizationCode(sql, hash),
  issueRefreshToken: (input) => issueRefreshToken(sql, input),
  useRefreshToken: (hash) => useRefreshToken(sql, hash),
  revokeAgentToken: async (id) => {
    await revokeAgentToken(sql, id);
  },
  throttle: createFailureThrottle(),
  now
});

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
  await sql.unsafe("TRUNCATE TABLE agent_access_tokens, agent_tokens RESTART IDENTITY CASCADE");
});

afterAll(async () => {
  await sql?.end();
});

describe("the access token table", () => {
  it("stores only the hash and finds the token with its agent token", async () => {
    const { token: secret, summary } = await issue("companion");
    const agent = (await findAgentTokenByHash(sql, hashAgentToken(secret)))!;
    const issued = await createAccessToken(sql, {
      agent,
      resource: "https://portal.test/mcp",
      scopes: ["read:plan"]
    });
    expect(issued.token.startsWith(ACCESS_TOKEN_PREFIX)).toBe(true);
    const [row] = await sql<{ token_hash: string }[]>`SELECT token_hash FROM agent_access_tokens`;
    expect(row!.token_hash).toBe(hashAccessToken(issued.token));
    expect(JSON.stringify(row)).not.toContain(issued.token);
    const found = await findAccessTokenByHash(sql, hashAccessToken(issued.token));
    expect(found).toMatchObject({
      agentTokenId: summary.id,
      resource: "https://portal.test/mcp",
      scopes: ["read:plan"]
    });
    expect(found?.agent.name).toBe("companion");
    expect(await findAccessTokenByHash(sql, hashAccessToken("pri_at_other"))).toBeNull();
  });

  it("lasts an hour, but never past its agent token", async () => {
    const now = new Date("2026-10-19T00:00:00Z");
    const { token: secret } = await issue("long", { expiresInDays: 30 });
    const long = (await findAgentTokenByHash(sql, hashAgentToken(secret)))!;
    expect((await createAccessToken(sql, { agent: long, resource: "r", scopes: [], now })).expiresAt).toEqual(
      new Date("2026-10-19T01:00:00Z")
    );
    const { token: shortSecret } = await issue("short", { expiresInDays: 1 });
    const short = (await findAgentTokenByHash(sql, hashAgentToken(shortSecret)))!;
    const early = new Date(short.expiresAt.getTime() - 60_000);
    expect((await createAccessToken(sql, { agent: short, resource: "r", scopes: [], now: early })).expiresAt).toEqual(
      short.expiresAt
    );
  });

  it("sweeps tokens that expired more than a day ago when the next one is minted", async () => {
    const { token: secret } = await issue("sweeper");
    const agent = (await findAgentTokenByHash(sql, hashAgentToken(secret)))!;
    const old = await createAccessToken(sql, {
      agent,
      resource: "r",
      scopes: [],
      now: new Date(Date.now() - 3 * 86_400_000)
    });
    await createAccessToken(sql, { agent, resource: "r", scopes: [] });
    expect(await findAccessTokenByHash(sql, hashAccessToken(old.token))).toBeNull();
    expect(await sql`SELECT 1 FROM agent_access_tokens`).toHaveLength(1);
  });
});

describe("the live token cap", () => {
  it("keeps an agent's newest tokens, drops its oldest, and leaves other agents alone", async () => {
    const { token: secret } = await issue("capped");
    const { token: otherSecret } = await issue("other");
    const agent = (await findAgentTokenByHash(sql, hashAgentToken(secret)))!;
    const other = (await findAgentTokenByHash(sql, hashAgentToken(otherSecret)))!;
    const start = Date.now() - 10 * 60_000;
    const issued: string[] = [];
    for (let i = 0; i < MAX_LIVE_ACCESS_TOKENS + 3; i++)
      issued.push(
        (await createAccessToken(sql, { agent, resource: "r", scopes: [], now: new Date(start + i * 1000) })).token
      );
    const kept = await createAccessToken(sql, { agent: other, resource: "r", scopes: [], now: new Date(start) });
    const live = await sql`SELECT 1 FROM agent_access_tokens WHERE agent_token_id = ${agent.id}`;
    expect(live).toHaveLength(MAX_LIVE_ACCESS_TOKENS);
    for (const token of issued.slice(0, 3)) expect(await findAccessTokenByHash(sql, hashAccessToken(token))).toBeNull();
    expect(await findAccessTokenByHash(sql, hashAccessToken(issued.at(-1)!))).not.toBeNull();
    expect(await findAccessTokenByHash(sql, hashAccessToken(kept.token))).not.toBeNull();
  });
});

describe("the token endpoint and the bearer check against the table", () => {
  const tokenRequest = (secret: string, extra: Record<string, string> = {}) =>
    new Request("https://portal.test/oauth/token", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        host: "portal.test",
        "x-forwarded-proto": "https"
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: "companion",
        client_secret: secret,
        resource: "https://portal.test/mcp",
        ...extra
      })
    });
  const mcpRequest = (token: string) =>
    new Request("https://portal.test/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, host: "portal.test", "x-forwarded-proto": "https" }
    });

  it("trades the secret for an access token that /mcp accepts, and stops at once when the agent token is revoked", async () => {
    const { token: secret, summary } = await issue("companion");
    const response = await handleTokenRequest(tokenRequest(secret, { scope: "read:plan write:entity:action" }), deps());
    expect(response.status).toBe(200);
    const body = (await response.json()) as { access_token: string; scope: string; expires_in: number };
    expect(body.scope).toBe("read:plan");
    expect(body.expires_in).toBeLessThanOrEqual(3600);
    const accepted = await authenticateBearer(mcpRequest(body.access_token), deps());
    expect(accepted).toMatchObject({
      ok: true,
      principal: { name: "companion", scopes: ["read:plan"], tokenId: summary.id }
    });
    // The long-lived secret is no key to /mcp.
    expect((await authenticateBearer(mcpRequest(secret), deps())).ok).toBe(false);
    await revokeAgentToken(sql, summary.id);
    expect((await authenticateBearer(mcpRequest(body.access_token), deps())).ok).toBe(false);
    expect((await handleTokenRequest(tokenRequest(secret), deps())).status).toBe(401);
  });

  it("refuses an access token past its hour", async () => {
    const { token: secret } = await issue("companion");
    const body = (await (await handleTokenRequest(tokenRequest(secret), deps())).json()) as { access_token: string };
    const later = () => new Date(Date.now() + 2 * 3_600_000);
    expect((await authenticateBearer(mcpRequest(body.access_token), deps(later))).ok).toBe(false);
  });
});
