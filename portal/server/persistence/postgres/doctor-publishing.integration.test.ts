import { calendarSinkConnection, registerConnectionManifest } from "@openrhen/contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import { integrationDatabaseName } from "@openrhen/database";
import { ensureUser } from "./ensure-user";
import { readPublishingSlice } from "./doctor-publishing";

/**
 * The publishing slice of the data health check: failing shared-calendar publishing, push and pulse publishing, status only.
 */
config({ path: resolve(process.cwd(), "../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(process.env.TEST_DATABASE_NAME, "openrhen_doctor_publishing");

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let userId: string;

// Any provider id: the column has no default in every tree (the OpenRhen baseline has none), so the tests name one.
// A calendar sink, registered so a build with none still has one to publish to; where a real sink is registered it is
// the one the slice reads.
registerConnectionManifest({
  id: "example_sink",
  label: "Example Sink",
  capabilities: ["calendar_sink"],
  ops: {},
  secrets: { anyOf: [["EXAMPLE_SINK_TOKEN"]] },
  config: {}
});
const SINK = calendarSinkConnection()!;
const PROVIDER = SINK.id;
const NOW = new Date("2026-10-18T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

beforeAll(async () => {
  const admin = postgres(adminUrl, { max: 1, connect_timeout: 10 });
  try {
    const existing = await admin<{ exists: boolean }[]>`
      SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = ${testDatabaseName}) AS exists`;
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
  sql = postgres(testUrl.toString(), { max: 5, connect_timeout: 10, fetch_types: false, prepare: true });
  userId = await ensureUser(sql);
}, 30_000);

beforeEach(async () => {
  await sql.unsafe(
    "TRUNCATE TABLE calendar_publications, commitments, push_subscriptions, pulse_state RESTART IDENTITY CASCADE"
  );
  await sql`DELETE FROM users WHERE id <> ${userId}`;
  await sql`UPDATE user_preferences SET pulse_publish_enabled=false WHERE user_id=${userId}`;
});

afterAll(async () => {
  await sql?.end();
});

async function otherUser(): Promise<string> {
  const rows = await sql<
    { id: string }[]
  >`INSERT INTO users (display_name,timezone) VALUES ('Other','Australia/Sydney') RETURNING id`;
  return rows[0]!.id;
}

async function commitment(uid: string): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO commitments (user_id,title,starts_at,ends_at)
    VALUES (${uid},'Dentist',${new Date(NOW.getTime() + 86_400_000)},${new Date(NOW.getTime() + 90_000_000)})
    RETURNING id`;
  return rows[0]!.id;
}

describe("readPublishingSlice", () => {
  it("is empty on a clean database", async () => {
    expect(await readPublishingSlice(sql as never, userId, NOW)).toEqual({
      calendarSink: null,
      pushDevices: [],
      pulse: null
    });
  });

  it("counts failed and remote-missing sink rows for this user only", async () => {
    const mine = await commitment(userId);
    const mine2 = await commitment(userId);
    const theirUser = await otherUser();
    const theirs = await commitment(theirUser);
    await sql`INSERT INTO calendar_publications (user_id,commitment_id,provider,frame_id,status,attempts,next_attempt_at,last_error,updated_at)
      VALUES (${userId},${mine},${PROVIDER},'f1','failed',4,NULL,'secret publish detail',${hoursAgo(30)}),
             (${userId},${mine2},${PROVIDER},'f1','remote_missing',1,NULL,NULL,${hoursAgo(2)}),
             (${theirUser},${theirs},${PROVIDER},'f1','failed',9,NULL,NULL,${hoursAgo(90)})`;
    const slice = await readPublishingSlice(sql as never, userId, NOW);
    expect(slice.calendarSink).toEqual({
      id: SINK.id,
      label: SINK.label,
      failed: 1,
      failedPermanent: 1,
      remoteMissing: 1,
      maxAttempts: 4,
      failingSince: hoursAgo(30).toISOString(),
      missingSince: hoursAgo(2).toISOString()
    });
    expect(JSON.stringify(slice)).not.toContain("secret publish detail");
  });

  it("returns push devices whose failures post-date their last success, without endpoints or tokens", async () => {
    const theirUser = await otherUser();
    await sql`INSERT INTO push_subscriptions (user_id,endpoint,p256dh,auth,vapid_public_key,last_success_at,last_failure_at,failure_count)
      VALUES (${userId},'https://push.example/bad-endpoint','k','a','v',${hoursAgo(50)},${hoursAgo(1)},3),
             (${userId},'https://push.example/recovered','k','a','v',${hoursAgo(1)},${hoursAgo(5)},2),
             (${theirUser},'https://push.example/theirs','k','a','v',NULL,${hoursAgo(1)},5)`;
    const slice = await readPublishingSlice(sql as never, userId, NOW);
    expect(
      slice.pushDevices.map((d: { kind: string; failureCount: number }) => [d.kind, d.failureCount]).sort()
    ).toEqual([["web_push", 3]]);
    const text = JSON.stringify(slice);
    for (const secret of ["bad-endpoint", "theirs"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("reports a failed pulse publish only while publishing is on, without the error text", async () => {
    await sql`INSERT INTO pulse_state (user_id,last_published_at,last_publish_outcome,last_publish_error)
      VALUES (${userId},${hoursAgo(40)},'failed','secret pulse detail')`;
    expect((await readPublishingSlice(sql as never, userId, NOW)).pulse).toBeNull();
    await sql`UPDATE user_preferences SET pulse_publish_enabled=true WHERE user_id=${userId}`;
    const slice = await readPublishingSlice(sql as never, userId, NOW);
    expect(slice.pulse).toMatchObject({ outcome: "failed", lastPublishedAt: hoursAgo(40).toISOString() });
    expect(JSON.stringify(slice)).not.toContain("secret pulse detail");
    await sql`UPDATE pulse_state SET last_publish_outcome='delivered', last_publish_error=NULL WHERE user_id=${userId}`;
    expect((await readPublishingSlice(sql as never, userId, NOW)).pulse).toBeNull();
  });
});
