import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { fileURLToPath } from "node:url";
import { integrationDatabaseName } from "@openrhen/database";
import {
  createOwnerCredential,
  findOwnerCredentialByHash,
  hashOwnerSecret,
  listOwnerCredentials,
  MAX_LIVE_BROWSERS,
  OwnerCredentialError,
  revokeOwnerCredential,
  touchOwnerCredential
} from "./owner-credential-store";

/**
 * The owner credential table (the design notes, decision D2): only a hash is stored,
 * a listing never carries a secret, a browser session lasts 30 days and an owner token does not expire, revocation
 * is immediate and idempotent, and use is recorded at most once a minute. Self-contained `_test` database.
 */
config({ path: fileURLToPath(new URL("../../.env", import.meta.url)), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(
  process.env.OWNER_CREDENTIALS_TEST_DATABASE_NAME,
  "openrhen_owner_credentials"
);

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("OWNER_CREDENTIALS_TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;

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
  await sql.unsafe("TRUNCATE TABLE owner_credentials RESTART IDENTITY CASCADE");
});

afterAll(async () => {
  await sql?.end();
});

describe("owner credentials", () => {
  const now = new Date("2026-10-19T00:00:00Z");

  it("returns the secret once, stores only its hash, and never lists it", async () => {
    const { secret, summary } = await createOwnerCredential(sql, "token", "Owner laptop", now);
    expect(secret).toMatch(/^pri_own_[A-Za-z0-9_-]{43}$/);
    expect(summary).toMatchObject({ kind: "token", label: "Owner laptop", expiresAt: null, revokedAt: null });
    const [row] = await sql<{ secret_hash: string }[]>`SELECT secret_hash FROM owner_credentials`;
    expect(row!.secret_hash).toBe(hashOwnerSecret(secret));
    expect(JSON.stringify(await listOwnerCredentials(sql))).not.toContain(secret);
    expect(await findOwnerCredentialByHash(sql, hashOwnerSecret(secret))).toMatchObject({
      kind: "token",
      revokedAt: null
    });
    expect(await findOwnerCredentialByHash(sql, hashOwnerSecret("nope"))).toBeNull();
  });

  it("gives a browser session 30 days and caps the live browsers", async () => {
    const { secret, summary } = await createOwnerCredential(sql, "browser", "This browser", now);
    expect(secret).toMatch(/^pri_ses_/);
    expect(summary.expiresAt).toBe("2026-11-18T00:00:00.000Z");
    for (let i = 1; i < MAX_LIVE_BROWSERS; i += 1) await createOwnerCredential(sql, "browser", `b${i}`, new Date());
    await expect(createOwnerCredential(sql, "browser", "one too many", new Date())).rejects.toBeInstanceOf(
      OwnerCredentialError
    );
  });

  it("revokes at once, idempotently, and refuses an unknown id", async () => {
    const { summary } = await createOwnerCredential(sql, "token", "t", now);
    const first = await revokeOwnerCredential(sql, summary.id, now);
    expect(first.revokedAt).toBe(now.toISOString());
    const again = await revokeOwnerCredential(sql, summary.id, new Date("2026-10-20T00:00:00Z"));
    expect(again.revokedAt).toBe(now.toISOString());
    await expect(revokeOwnerCredential(sql, "11111111-1111-4111-8111-111111111111")).rejects.toMatchObject({
      status: 404
    });
  });

  it("records a use at most once a minute, and slides a browser only after it has lost a day", async () => {
    const token = await createOwnerCredential(sql, "token", "t", new Date());
    expect(await touchOwnerCredential(sql, token.summary.id, "token")).toBe(false);
    const [used] = await sql<
      { last_used_at: Date | null }[]
    >`SELECT last_used_at FROM owner_credentials WHERE id=${token.summary.id}`;
    expect(used!.last_used_at).not.toBeNull();

    const fresh = await createOwnerCredential(sql, "browser", "fresh", new Date());
    expect(await touchOwnerCredential(sql, fresh.summary.id, "browser")).toBe(false);
    const old = await createOwnerCredential(sql, "browser", "old", new Date(Date.now() - 5 * 86_400_000));
    expect(await touchOwnerCredential(sql, old.summary.id, "browser")).toBe(true);
    const [slid] = await sql<
      { expires_at: Date }[]
    >`SELECT expires_at FROM owner_credentials WHERE id=${old.summary.id}`;
    expect(slid!.expires_at.getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000);
  });
});
