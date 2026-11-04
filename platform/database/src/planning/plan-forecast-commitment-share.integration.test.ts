import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import type { PlanForecastResponse } from "@openrhen/contracts";
import { persistDerivedState } from "./plan-forecast-runtime.js";
import { integrationDatabaseName } from "../operations/integration-database.js";

config({ path: resolve(process.cwd(), "../../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
// A database of its own for the same reason the presence, occurrence, retention and routine
// suites each have one: these suites truncate, and two of them truncating the same database is an
// unreproducible flake.
const testDatabaseName = integrationDatabaseName(
  process.env.COMMITMENT_SHARE_TEST_DATABASE_NAME,
  "openrhen_commitment_share"
);

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("COMMITMENT_SHARE_TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

const HOUR = 3_600_000;
const now = new Date("2026-09-01T22:00:00Z");

let sql: postgres.Sql;
let userId: string;
let ruleId: string;

beforeAll(async () => {
  const admin = postgres(adminUrl!, { max: 1, connect_timeout: 10 });
  try {
    const existing = await admin<
      { exists: boolean }[]
    >`SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = ${testDatabaseName}) AS exists`;
    if (!existing[0]?.exists) await admin.unsafe(`CREATE DATABASE "${testDatabaseName}"`);
  } finally {
    await admin.end();
  }
  const migrationSql = postgres(testUrl.toString(), { max: 1, connect_timeout: 10 });
  try {
    await migrate(drizzle(migrationSql), { migrationsFolder: resolve(process.cwd(), "drizzle") });
  } finally {
    await migrationSql.end();
  }
  sql = postgres(testUrl.toString(), { max: 5, connect_timeout: 10, fetch_types: false });
}, 60_000);

beforeEach(async () => {
  // This suite is allowed to clear only a database whose validated name ends in _test.
  await sql.unsafe("TRUNCATE TABLE users RESTART IDENTITY CASCADE");
  const users = await sql<{ id: string }[]>`
    INSERT INTO users (display_name) VALUES ('Share Fixture') RETURNING id
  `;
  userId = users[0]!.id;
  await sql`INSERT INTO user_preferences (user_id) VALUES (${userId})`;
  const rules = await sql<{ id: string }[]>`
    INSERT INTO commitment_recurrence_rules (user_id,title,timezone,start_date,interval_days,local_start_time,local_end_time,presence,share_to_calendar)
    VALUES (${userId},'Evening Workshop','Australia/Sydney','2026-08-26',7,'18:00','20:30','blocking',true) RETURNING id
  `;
  ruleId = rules[0]!.id;
});

afterAll(async () => {
  await sql?.end();
});

/** A minimal PlanForecastResponse `persistDerivedState` reads only `derivedState`, `inputVersion`
 * and `calculatedAt` from — the rest of the (much larger) contract shape is irrelevant to it. */
function resultWith(commitmentRepeats: Array<Record<string, unknown>>, calculatedAt = now): PlanForecastResponse {
  return {
    inputVersion: "v1",
    calculatedAt: calculatedAt.toISOString(),
    derivedState: {
      sleepPlans: [],
      occurrences: [],
      routineSteps: [],
      commitmentRepeats
    }
  } as unknown as PlanForecastResponse;
}

function occurrence(id: string, startsAt: Date) {
  return {
    id,
    recurrenceRuleId: ruleId,
    localDate: startsAt.toISOString().slice(0, 10),
    startsAt: startsAt.toISOString(),
    endsAt: new Date(startsAt.getTime() + 8 * HOUR).toISOString(),
    title: "Evening Workshop",
    status: "confirmed",
    presence: "blocking"
  };
}

async function shareRowOf(id: string) {
  const rows = await sql<
    { share_to_calendar: boolean; share_source: string }[]
  >`SELECT share_to_calendar,share_source FROM commitments WHERE id=${id}`;
  return rows[0];
}

// The occurrence materialiser must propagate a recurrence rule's `share_to_calendar` flag (Example Shared
// family-calendar sharing) exactly the way it already propagates `presence`: copied on insert,
// re-healed from the rule on every replan while the occurrence stays 'inherit', and left alone once
// an occurrence-level edit has flipped its own `share_source` to 'custom'.
describe("persistDerivedState — commitment repeat share_to_calendar (Example Shared family-calendar sharing)", () => {
  it("materialises a fresh occurrence as 'inherit', tracking whatever the rule says", async () => {
    const id = crypto.randomUUID();
    await persistDerivedState(sql, userId, resultWith([occurrence(id, now)]));
    expect(await shareRowOf(id)).toEqual({ share_to_calendar: true, share_source: "inherit" });
  });

  it("heals an 'inherit' occurrence's flag when the rule (later) says something else", async () => {
    const id = crypto.randomUUID();
    await persistDerivedState(sql, userId, resultWith([occurrence(id, now)]));
    await sql`UPDATE commitment_recurrence_rules SET share_to_calendar=false WHERE id=${ruleId}`;
    await persistDerivedState(sql, userId, resultWith([occurrence(id, now)], new Date(now.getTime() + HOUR)));
    expect(await shareRowOf(id)).toEqual({ share_to_calendar: false, share_source: "inherit" });
  });

  it("does not clobber a 'custom' occurrence's flag on the next replan", async () => {
    const id = crypto.randomUUID();
    await persistDerivedState(sql, userId, resultWith([occurrence(id, now)]));
    // The per-occurrence edit entity-commands.ts makes for a genuine tweak: the flag written, and
    // share_source flipped to 'custom' in the same statement.
    await sql`UPDATE commitments SET share_to_calendar=false,share_source='custom' WHERE id=${id}`;
    expect(await shareRowOf(id)).toEqual({ share_to_calendar: false, share_source: "custom" });
    // A replan runs next and the rule still says `true` — before the fix this INSERT ... ON CONFLICT
    // would have unconditionally reverted the edit within moments of it being saved.
    await persistDerivedState(sql, userId, resultWith([occurrence(id, now)], new Date(now.getTime() + HOUR)));
    expect(await shareRowOf(id)).toEqual({ share_to_calendar: false, share_source: "custom" });
  });

  it("keeps a detached occurrence's flag separate from its still-inherited siblings", async () => {
    const editedId = crypto.randomUUID();
    const siblingId = crypto.randomUUID();
    await persistDerivedState(
      sql,
      userId,
      resultWith([occurrence(editedId, now), occurrence(siblingId, new Date(now.getTime() + 7 * 86_400_000))])
    );
    await sql`UPDATE commitments SET share_to_calendar=false,share_source='custom' WHERE id=${editedId}`;
    // The rule (and therefore every still-inherited occurrence, including the sibling) switches to
    // 'false' on the next replan.
    await sql`UPDATE commitment_recurrence_rules SET share_to_calendar=false WHERE id=${ruleId}`;
    await persistDerivedState(
      sql,
      userId,
      resultWith(
        [occurrence(editedId, now), occurrence(siblingId, new Date(now.getTime() + 7 * 86_400_000))],
        new Date(now.getTime() + HOUR)
      )
    );
    expect(await shareRowOf(siblingId)).toEqual({ share_to_calendar: false, share_source: "inherit" });
    // The edited occurrence already read `false`, so this alone would not prove the detach; the
    // "does not clobber" test above proves it holds when the rule disagrees.
    expect(await shareRowOf(editedId)).toEqual({ share_to_calendar: false, share_source: "custom" });
  });
});
