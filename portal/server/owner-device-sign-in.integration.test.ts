import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { fileURLToPath } from "node:url";
import { integrationDatabaseName } from "@openrhen/database";
import {
  createOwnerCredential,
  decideDeviceCode,
  findOwnerCredentialByHash,
  hashOwnerSecret,
  listCredentialEvents,
  listOwnerCredentials,
  lookupDeviceCode,
  MAX_LIVE_BROWSERS,
  MAX_LIVE_PAIRINGS,
  openWebSession,
  pollDeviceCode,
  redeemDevicePairing,
  revokeOwnerCredential,
  startDeviceCode,
  startDevicePairing,
  touchOwnerCredential
} from "./owner-credential-store";

/**
 * Device sign-in against a real database: a QR pairing works once and for ten minutes, a typed code follows RFC
 * 8628's states, the device token is limited and carries its install id, the web-view session is one reused child that
 * dies with its device and sits outside the browser cap, and every pairing, redemption and revoke is recorded.
 * Self-contained `_test` database.
 */
config({ path: fileURLToPath(new URL("../../.env", import.meta.url)), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(
  process.env.OWNER_DEVICE_SIGN_IN_TEST_DATABASE_NAME,
  "openrhen_owner_device_sign_in"
);

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("OWNER_DEVICE_SIGN_IN_TEST_DATABASE_NAME must be an identifier ending in _test");
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
  await sql.unsafe(
    "TRUNCATE TABLE owner_credentials, owner_device_pairings, owner_credential_events RESTART IDENTITY CASCADE"
  );
});

afterAll(async () => {
  await sql?.end();
});

const T0 = new Date("2026-11-10T09:00:00Z");
const minutes = (n: number, from = T0) => new Date(from.getTime() + n * 60_000);
const seconds = (n: number, from = T0) => new Date(from.getTime() + n * 1000);
const PHONE = { installId: "c0ffee00-1234-4abc-8def-0123456789ab", platform: "ios" };
const OTHER = { installId: "deadbeef-1234-4abc-8def-0123456789ab", platform: "ios" };

async function eventNames() {
  return (await listCredentialEvents(sql)).map((event) => event.event).reverse();
}

describe("QR pairing", () => {
  it("is single use: the first redeem makes a limited token with the device, the second finds nothing", async () => {
    const desk = await createOwnerCredential(sql, "token", "Desk", T0);
    const pairing = await startDevicePairing(sql, { actorId: desk.summary.id, address: "203.0.113.1" }, T0);
    expect(pairing.secret).toMatch(/^pri_pair_/);
    expect(pairing.expiresAt.toISOString()).toBe(minutes(10).toISOString());
    const [row] = await sql<{ secret_hash: string }[]>`SELECT secret_hash FROM owner_device_pairings`;
    expect(row!.secret_hash).toBe(hashOwnerSecret(pairing.secret));

    const input = { secret: pairing.secret, name: "Phone", device: PHONE, address: "198.51.100.7" };
    const minted = await redeemDevicePairing(sql, input, minutes(2));
    expect(minted!.secret).toMatch(/^pri_own_/);
    expect(minted!.summary).toMatchObject({
      kind: "token",
      label: "Phone",
      limited: true,
      device: PHONE,
      lastUsedFrom: "198.51.100.7",
      parentCredentialId: null
    });
    expect(await redeemDevicePairing(sql, input, minutes(3))).toBeNull();
    expect(await findOwnerCredentialByHash(sql, hashOwnerSecret(minted!.secret))).toMatchObject({
      kind: "token",
      limited: true,
      device: PHONE
    });
  });

  it("is refused after ten minutes, and for a secret that was never issued", async () => {
    const pairing = await startDevicePairing(sql, {}, T0);
    expect(
      await redeemDevicePairing(
        sql,
        { secret: pairing.secret, name: "Phone", device: PHONE, address: null },
        minutes(10)
      )
    ).toBeNull();
    expect(
      await redeemDevicePairing(sql, { secret: "pri_pair_nope", name: "Phone", device: PHONE, address: null }, T0)
    ).toBeNull();
    expect(await listOwnerCredentials(sql)).toEqual([]);
  });

  it("a device code is not a pairing secret, and a pairing secret is not a device code", async () => {
    const pairing = await startDevicePairing(sql, {}, T0);
    const code = await startDeviceCode(sql, { name: "Phone", device: PHONE, address: null }, T0);
    expect(await pollDeviceCode(sql, pairing.secret, null, minutes(1))).toEqual({
      kind: "error",
      error: "expired_token"
    });
    expect(
      await redeemDevicePairing(sql, { secret: code.deviceCode, name: "x", device: PHONE, address: null }, minutes(1))
    ).toBeNull();
  });

  it("a second redeem for the same install replaces the first token, so one phone holds one live token", async () => {
    const first = await startDevicePairing(sql, {}, T0);
    const one = await redeemDevicePairing(
      sql,
      { secret: first.secret, name: "Phone", device: PHONE, address: null },
      minutes(1)
    );
    const second = await startDevicePairing(sql, {}, minutes(2));
    const two = await redeemDevicePairing(
      sql,
      { secret: second.secret, name: "Phone", device: PHONE, address: null },
      minutes(3)
    );
    const stored = await findOwnerCredentialByHash(sql, hashOwnerSecret(one!.secret));
    expect(stored!.revokedAt).not.toBeNull();
    expect((await findOwnerCredentialByHash(sql, hashOwnerSecret(two!.secret)))!.revokedAt).toBeNull();
  });

  it("caps the pairings that can wait at once", async () => {
    for (let i = 0; i < MAX_LIVE_PAIRINGS; i += 1) await startDevicePairing(sql, {}, T0);
    await expect(startDevicePairing(sql, {}, T0)).rejects.toMatchObject({ status: 429 });
    // Ten minutes later they have expired and room is made.
    await expect(startDevicePairing(sql, {}, minutes(11))).resolves.toBeTruthy();
  });
});

describe("device code", () => {
  const ask = (now = T0) => startDeviceCode(sql, { name: "Phone", device: PHONE, address: "198.51.100.7" }, now);

  it("walks authorization_pending, slow_down, then approval, and hands over the token exactly once", async () => {
    const started = await ask();
    expect(started.userCode).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    expect(started.interval).toBe(5);
    expect(await pollDeviceCode(sql, started.deviceCode, null, seconds(5))).toEqual({
      kind: "error",
      error: "authorization_pending"
    });
    // Too soon: slow down, and the interval grows by five seconds.
    expect(await pollDeviceCode(sql, started.deviceCode, null, seconds(7))).toEqual({
      kind: "error",
      error: "slow_down"
    });
    expect(await pollDeviceCode(sql, started.deviceCode, null, seconds(12))).toEqual({
      kind: "error",
      error: "slow_down"
    });
    const waiting = await lookupDeviceCode(sql, started.userCode.toLowerCase().replace("-", " "), seconds(13));
    expect(waiting).toMatchObject({ name: "Phone", device: PHONE, from: "198.51.100.7" });
    const desk = await createOwnerCredential(sql, "token", "Desk", T0);
    expect(
      await decideDeviceCode(sql, started.userCode, "approve", { actorId: desk.summary.id }, seconds(14))
    ).toMatchObject({
      name: "Phone"
    });
    const polled = await pollDeviceCode(sql, started.deviceCode, "198.51.100.7", seconds(40));
    expect(polled.kind).toBe("token");
    if (polled.kind === "token") {
      expect(polled.summary).toMatchObject({ kind: "token", limited: true, device: PHONE, label: "Phone" });
      expect(polled.secret).toMatch(/^pri_own_/);
    }
    expect(await pollDeviceCode(sql, started.deviceCode, null, seconds(80))).toEqual({
      kind: "error",
      error: "expired_token"
    });
    // The typed code cannot be approved twice, or looked up once used.
    expect(await decideDeviceCode(sql, started.userCode, "approve", {}, seconds(90))).toBeNull();
    expect(await lookupDeviceCode(sql, started.userCode, seconds(90))).toBeNull();
  });

  it("answers access_denied after a deny, and mints nothing", async () => {
    const started = await ask();
    await decideDeviceCode(sql, started.userCode, "deny", {}, seconds(2));
    expect(await pollDeviceCode(sql, started.deviceCode, null, seconds(10))).toEqual({
      kind: "error",
      error: "access_denied"
    });
    expect(await listOwnerCredentials(sql)).toEqual([]);
  });

  it("answers expired_token after ten minutes, for an unknown code, and refuses to approve an expired one", async () => {
    const started = await ask();
    expect(await pollDeviceCode(sql, started.deviceCode, null, minutes(10))).toEqual({
      kind: "error",
      error: "expired_token"
    });
    expect(await decideDeviceCode(sql, started.userCode, "approve", {}, minutes(10))).toBeNull();
    expect(await pollDeviceCode(sql, "pri_dcode_unknown", null, T0)).toEqual({ kind: "error", error: "expired_token" });
    expect(await decideDeviceCode(sql, "not a code", "approve", {}, T0)).toBeNull();
    expect(await lookupDeviceCode(sql, "AAAA-AAAA", T0)).toBeNull();
  });

  it("an approved code that is never collected makes no credential", async () => {
    const started = await ask();
    await decideDeviceCode(sql, started.userCode, "approve", {}, seconds(1));
    expect(await listOwnerCredentials(sql)).toEqual([]);
  });
});

describe("web-view session", () => {
  const device = async () => {
    const pairing = await startDevicePairing(sql, {}, T0);
    return (await redeemDevicePairing(
      sql,
      { secret: pairing.secret, name: "Phone", device: PHONE, address: null },
      T0
    ))!;
  };

  it("makes one browser-kind child that inherits limited, and reuses it on every launch by rotating its secret", async () => {
    const phone = await device();
    const first = await openWebSession(sql, phone.summary.id, minutes(1));
    expect(first!.secret).toMatch(/^pri_ses_/);
    expect(first!.summary).toMatchObject({
      kind: "browser",
      limited: true,
      parentCredentialId: phone.summary.id,
      device: PHONE,
      expiresAt: minutes(1 + 30 * 24 * 60).toISOString()
    });
    const second = await openWebSession(sql, phone.summary.id, minutes(5));
    expect(second!.summary.id).toBe(first!.summary.id);
    expect(second!.secret).not.toBe(first!.secret);
    // The old cookie no longer matches anything; the new one does.
    expect(await findOwnerCredentialByHash(sql, hashOwnerSecret(first!.secret))).toBeNull();
    expect(await findOwnerCredentialByHash(sql, hashOwnerSecret(second!.secret))).toMatchObject({
      kind: "browser",
      limited: true,
      parentId: phone.summary.id
    });
    const children = await sql<
      { count: number }[]
    >`SELECT count(*)::int AS count FROM owner_credentials WHERE parent_credential_id IS NOT NULL`;
    expect(children[0]?.count).toBe(1);
  });

  it("does not count toward the browser cap, and is not blocked by it", async () => {
    const phone = await device();
    for (let i = 0; i < MAX_LIVE_BROWSERS; i += 1) await createOwnerCredential(sql, "browser", `b${i}`, new Date());
    await expect(createOwnerCredential(sql, "browser", "one too many", new Date())).rejects.toMatchObject({
      status: 409
    });
    expect(await openWebSession(sql, phone.summary.id, new Date())).not.toBeNull();
    // The child did not use up a place either: the cap is still exactly the browsers.
    await expect(createOwnerCredential(sql, "browser", "still one too many", new Date())).rejects.toMatchObject({
      status: 409
    });
  });

  it("is revoked with its device, and the revoke is recorded for both", async () => {
    const phone = await device();
    const view = (await openWebSession(sql, phone.summary.id, minutes(1)))!;
    await revokeOwnerCredential(sql, phone.summary.id, minutes(2), { actorId: null, address: "203.0.113.9" });
    const child = await findOwnerCredentialByHash(sql, hashOwnerSecret(view.secret));
    expect(child!.revokedAt?.toISOString()).toBe(minutes(2).toISOString());
    const revokes = (await listCredentialEvents(sql)).filter((event) => event.event === "revoked");
    expect(revokes).toHaveLength(2);
    expect(revokes[0]).toMatchObject({ address: "203.0.113.9" });
    // A revoked device opens no new web view.
    expect(await openWebSession(sql, phone.summary.id, minutes(3))).toBeNull();
    // Revoking again is idempotent and records nothing more.
    await revokeOwnerCredential(sql, phone.summary.id, minutes(4));
    expect((await listCredentialEvents(sql)).filter((event) => event.event === "revoked")).toHaveLength(2);
  });

  it("is made only for a live token", async () => {
    const browser = await createOwnerCredential(sql, "browser", "Laptop", T0);
    expect(await openWebSession(sql, browser.summary.id, T0)).toBeNull();
    expect(await openWebSession(sql, "11111111-1111-4111-8111-111111111111", T0)).toBeNull();
  });

  it("a revoked child can be replaced: a new launch after the web view was signed out makes a fresh child", async () => {
    const phone = await device();
    const view = (await openWebSession(sql, phone.summary.id, minutes(1)))!;
    await revokeOwnerCredential(sql, view.summary.id, minutes(2));
    const again = await openWebSession(sql, phone.summary.id, minutes(3));
    expect(again!.summary.id).not.toBe(view.summary.id);
  });
});

describe("the record and last_used_from", () => {
  it("records every pairing, redemption, approval and revoke in order, with no secret in any row", async () => {
    const pairing = await startDevicePairing(sql, { address: "203.0.113.1" }, T0);
    const minted = await redeemDevicePairing(
      sql,
      { secret: pairing.secret, name: "Phone", device: PHONE, address: "198.51.100.7" },
      minutes(1)
    );
    const code = await startDeviceCode(sql, { name: "Tablet", device: OTHER, address: null }, minutes(2));
    await decideDeviceCode(sql, code.userCode, "deny", { address: "203.0.113.1" }, minutes(3));
    await revokeOwnerCredential(sql, minted!.summary.id, minutes(4));
    expect(await eventNames()).toEqual(["pairing_started", "redeemed", "code_started", "code_denied", "revoked"]);
    const text = JSON.stringify(await sql`SELECT * FROM owner_credential_events`);
    for (const secret of [pairing.secret, minted!.secret, code.deviceCode, code.userCode])
      expect(text).not.toContain(secret);
    const listed = await listCredentialEvents(sql);
    expect(listed.find((event) => event.event === "redeemed")).toMatchObject({ label: "Phone", device: PHONE });
  });

  it("stores the address a credential was last used from, beside last_used_at", async () => {
    const pairing = await startDevicePairing(sql, {}, T0);
    const minted = await redeemDevicePairing(
      sql,
      { secret: pairing.secret, name: "Phone", device: PHONE, address: "198.51.100.7" },
      new Date(Date.now() - 3_600_000)
    );
    await touchOwnerCredential(sql, minted!.summary.id, "token", "203.0.113.50");
    const [row] = await sql<
      { last_used_from: string; last_used_at: Date }[]
    >`SELECT last_used_from, last_used_at FROM owner_credentials WHERE id=${minted!.summary.id}`;
    expect(row!.last_used_from).toBe("203.0.113.50");
    expect(row!.last_used_at).toBeTruthy();
    // Within a minute the use is not written again.
    await touchOwnerCredential(sql, minted!.summary.id, "token", "203.0.113.99");
    const [again] = await sql<
      { last_used_from: string }[]
    >`SELECT last_used_from FROM owner_credentials WHERE id=${minted!.summary.id}`;
    expect(again!.last_used_from).toBe("203.0.113.50");
  });

  it("refuses an install id or platform the database would not accept", async () => {
    await createOwnerCredential(sql, "token", "makes the user", T0);
    await expect(
      sql`INSERT INTO owner_credentials (user_id, kind, label, secret_hash, device_install_id, platform)
          SELECT id, 'token', 'x', ${hashOwnerSecret("a")}, 'UPPER', 'ios' FROM users LIMIT 1`
    ).rejects.toBeTruthy();
  });
});
