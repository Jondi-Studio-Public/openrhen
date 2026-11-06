import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { integrationDatabaseName } from "@openrhen/database";
import { ensureUser } from "./ensure-user";
import { deleteSecret, putSecret, secretStatuses } from "./app-secrets-store";
import { readSecret } from "@/server/secrets/read-secret";
import { loadMasterKey, SECRETS_KEY_ENV, type MasterKey } from "@/server/secrets/secrets-crypto";

config({ path: resolve(process.cwd(), "../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(process.env.TEST_DATABASE_NAME, "openrhen_app_secrets");

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let userId: string;

beforeAll(async () => {
  const admin = postgres(adminUrl, { max: 1, connect_timeout: 10 });
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
    await migrate(drizzle(migrationSql), { migrationsFolder: resolve(process.cwd(), "../platform/database/drizzle") });
  } finally {
    await migrationSql.end();
  }
  sql = postgres(testUrl.toString(), { max: 5, connect_timeout: 10, fetch_types: false });
}, 60_000);

beforeEach(async () => {
  await sql.unsafe("TRUNCATE TABLE users, video_info RESTART IDENTITY CASCADE");
  userId = await ensureUser(sql);
});

afterAll(async () => {
  await sql?.end();
});

const keyOf = (bytes = randomBytes(32)) => {
  const loaded = loadMasterKey({ [SECRETS_KEY_ENV]: bytes.toString("base64") });
  if (loaded.status !== "ok") throw new Error("test key");
  return { master: loaded, env: { [SECRETS_KEY_ENV]: bytes.toString("base64") } };
};
const VALUE = "AIzaSy-INTEGRATION-VALUE-1";

describe("the encrypted secret store", () => {
  it("stores only sealed text, reports status without the value, and reads it back for the proxy helper", async () => {
    const { master, env } = keyOf();
    expect((await secretStatuses(sql, userId, master))[0]).toEqual({
      name: "youtube_data_api_key",
      isSet: false,
      updatedAt: null,
      state: "unset"
    });
    await putSecret(sql, userId, "youtube_data_api_key", VALUE, master);
    const [row] = await sql<{ ciphertext: string; nonce: string; key_version: number }[]>`SELECT * FROM app_secrets`;
    expect(JSON.stringify(row)).not.toContain(VALUE);
    expect(row!.key_version).toBe(1);
    const [status] = await secretStatuses(sql, userId, master);
    expect(status).toMatchObject({ name: "youtube_data_api_key", isSet: true, state: "set" });
    expect(JSON.stringify(status)).not.toContain(VALUE);
    expect(await readSecret(sql, userId, "youtube_data_api_key", env)).toEqual({ kind: "ok", value: VALUE });
  });

  it("replaces the value in place, keeping one row", async () => {
    const { master, env } = keyOf();
    await putSecret(sql, userId, "youtube_data_api_key", VALUE, master);
    await putSecret(sql, userId, "youtube_data_api_key", "second-value", master);
    expect((await sql`SELECT 1 FROM app_secrets`).length).toBe(1);
    expect(await readSecret(sql, userId, "youtube_data_api_key", env)).toEqual({ kind: "ok", value: "second-value" });
  });

  it("is saved but unreadable under a different master key, and when no master key is configured", async () => {
    const original = keyOf();
    await putSecret(sql, userId, "youtube_data_api_key", VALUE, original.master);
    const other = keyOf();
    expect((await secretStatuses(sql, userId, other.master))[0]).toMatchObject({ isSet: true, state: "unreadable" });
    expect(await readSecret(sql, userId, "youtube_data_api_key", other.env)).toEqual({ kind: "unreadable" });
    const missing: MasterKey = { status: "missing" };
    expect((await secretStatuses(sql, userId, missing))[0]).toMatchObject({ isSet: true, state: "unreadable" });
    expect(await readSecret(sql, userId, "youtube_data_api_key", {})).toEqual({ kind: "unreadable" });
  });

  it("is unreadable when the stored row was altered or copied under another name", async () => {
    const { master, env } = keyOf();
    await putSecret(sql, userId, "youtube_data_api_key", VALUE, master);
    await sql`UPDATE app_secrets SET key_version = 2`;
    expect(await readSecret(sql, userId, "youtube_data_api_key", env)).toEqual({ kind: "unreadable" });
    await sql`UPDATE app_secrets SET key_version = 1, ciphertext = 'AAAA' || substr(ciphertext, 5)`;
    expect(await readSecret(sql, userId, "youtube_data_api_key", env)).toEqual({ kind: "unreadable" });
  });

  it("removes a key, says so when there was none, and is never read for another user", async () => {
    const { master, env } = keyOf();
    await putSecret(sql, userId, "youtube_data_api_key", VALUE, master);
    const [other] = await sql<{ id: string }[]>`INSERT INTO users (display_name) VALUES ('Other') RETURNING id`;
    expect(await readSecret(sql, other!.id, "youtube_data_api_key", env)).toEqual({ kind: "unset" });
    expect(await deleteSecret(sql, userId, "youtube_data_api_key")).toBe(true);
    expect(await deleteSecret(sql, userId, "youtube_data_api_key")).toBe(false);
    expect(await readSecret(sql, userId, "youtube_data_api_key", env)).toEqual({ kind: "unset" });
  });

  it("goes with the user", async () => {
    const { master } = keyOf();
    await putSecret(sql, userId, "youtube_data_api_key", VALUE, master);
    await sql`DELETE FROM users WHERE id = ${userId}`;
    expect((await sql`SELECT 1 FROM app_secrets`).length).toBe(0);
  });
});
