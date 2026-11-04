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
// A database of its own for the same reason the occurrence, retention, routine-inheritance and
// routine-mootness suites have one: these suites truncate, and two of them truncating the same
// database is an unreproducible flake.
const testDatabaseName = integrationDatabaseName(
  process.env.COMMITMENT_PRESENCE_TEST_DATABASE_NAME,
  "openrhen_commitment_presence"
);

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("COMMITMENT_PRESENCE_TEST_DATABASE_NAME must be an identifier ending in _test");
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
    INSERT INTO users (display_name) VALUES ('Presence Fixture') RETURNING id
  `;
  userId = users[0]!.id;
  await sql`INSERT INTO user_preferences (user_id) VALUES (${userId})`;
  const rules = await sql<{ id: string }[]>`
    INSERT INTO commitment_recurrence_rules (user_id,title,timezone,start_date,interval_days,local_start_time,local_end_time,presence)
    VALUES (${userId},'Evening Workshop','Australia/Sydney','2026-08-26',7,'18:00','20:30','blocking') RETURNING id
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

function occurrence(id: string, presence: string, startsAt: Date) {
  return {
    id,
    recurrenceRuleId: ruleId,
    localDate: startsAt.toISOString().slice(0, 10),
    startsAt: startsAt.toISOString(),
    endsAt: new Date(startsAt.getTime() + 8 * HOUR).toISOString(),
    title: "Evening Workshop",
    status: "confirmed",
    presence
  };
}

async function presenceRowOf(id: string) {
  const rows = await sql<
    { presence: string; presence_source: string }[]
  >`SELECT presence,presence_source FROM commitments WHERE id=${id}`;
  return rows[0];
}

// A single occurrence's engagement-level edit never survived the next replan,
// because the materialiser's ON CONFLICT branch wrote `presence` from the rule-derived value
// unconditionally. presence_source is what lets an 'inherit' row keep healing from the rule (the
// "whole series" edit this loop was built to propagate) while a 'custom' row — one an occurrence-
// level save pinned directly, exactly as entity-commands.ts now marks it — is left alone.
describe("persistDerivedState — commitment repeat presence", () => {
  it("materialises a fresh occurrence as 'inherit', tracking whatever the rule says", async () => {
    const id = crypto.randomUUID();
    await persistDerivedState(sql, userId, resultWith([occurrence(id, "blocking", now)]));
    expect(await presenceRowOf(id)).toEqual({ presence: "blocking", presence_source: "inherit" });
  });

  it("heals an 'inherit' occurrence's presence when the rule (still) says something else", async () => {
    const id = crypto.randomUUID();
    await persistDerivedState(sql, userId, resultWith([occurrence(id, "blocking", now)]));
    // The rule changed to 'anchor'; the next replan re-derives every occurrence from it.
    await persistDerivedState(sql, userId, resultWith([occurrence(id, "anchor", now)], new Date(now.getTime() + HOUR)));
    expect(await presenceRowOf(id)).toEqual({ presence: "anchor", presence_source: "inherit" });
  });

  it("does not clobber a 'custom' occurrence's presence on the next replan", async () => {
    const id = crypto.randomUUID();
    await persistDerivedState(sql, userId, resultWith([occurrence(id, "blocking", now)]));
    // The per-occurrence edit entity-commands.ts makes for a genuine tweak: presence written, and
    // presence_source flipped to 'custom' in the same statement.
    await sql`UPDATE commitments SET presence='anchor',presence_source='custom' WHERE id=${id}`;
    expect(await presenceRowOf(id)).toEqual({ presence: "anchor", presence_source: "custom" });
    // A replan runs next (exactly what `saveEntity`'s own post-save refresh does in the portal), and
    // the engine still derives this occurrence from the rule as 'blocking' — the rule was never
    // touched. Before the fix this INSERT ... ON CONFLICT unconditionally wrote presence=EXCLUDED,
    // reverting the edit within moments of it being saved.
    await persistDerivedState(
      sql,
      userId,
      resultWith([occurrence(id, "blocking", now)], new Date(now.getTime() + HOUR))
    );
    expect(await presenceRowOf(id)).toEqual({ presence: "anchor", presence_source: "custom" });
    // A second, later replan changes nothing further: the detach is permanent until someone edits
    // the occurrence back by hand, the same one-way rule routine_source already follows.
    await persistDerivedState(
      sql,
      userId,
      resultWith([occurrence(id, "blocking", now)], new Date(now.getTime() + 2 * HOUR))
    );
    expect(await presenceRowOf(id)).toEqual({ presence: "anchor", presence_source: "custom" });
  });

  it("keeps a detached occurrence's presence separate from its still-inherited siblings", async () => {
    const editedId = crypto.randomUUID();
    const siblingId = crypto.randomUUID();
    await persistDerivedState(
      sql,
      userId,
      resultWith([
        occurrence(editedId, "blocking", now),
        occurrence(siblingId, "blocking", new Date(now.getTime() + 7 * 86_400_000))
      ])
    );
    await sql`UPDATE commitments SET presence='anchor',presence_source='custom' WHERE id=${editedId}`;
    // The rule (and therefore every still-inherited occurrence, including the sibling) switches to
    // 'anchor' on the next replan.
    await persistDerivedState(
      sql,
      userId,
      resultWith(
        [
          occurrence(editedId, "anchor", now),
          occurrence(siblingId, "anchor", new Date(now.getTime() + 7 * 86_400_000))
        ],
        new Date(now.getTime() + HOUR)
      )
    );
    expect(await presenceRowOf(siblingId)).toEqual({ presence: "anchor", presence_source: "inherit" });
    // The edited occurrence already read 'anchor', so this alone would not prove the detach; the
    // "does not clobber" test above proves it holds when the rule disagrees.
    expect(await presenceRowOf(editedId)).toEqual({ presence: "anchor", presence_source: "custom" });
  });
});

// The empty-list guard on the future prune (`persistDerivedState`) reads the real rule columns: an empty
// derived list is only suspicious while some rule can place an occurrence inside the 180-day horizon.
describe("persistDerivedState — empty derived list and the future prune", () => {
  const futureCount = async () => {
    const rows = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM commitments WHERE user_id=${userId}`;
    return rows[0]!.count;
  };
  const insertStale = async () => {
    const startsAt = new Date(now.getTime() + 14 * 86_400_000);
    await sql`INSERT INTO commitments (id,user_id,title,starts_at,ends_at,recurrence_rule_id,local_date)
      VALUES (${crypto.randomUUID()},${userId},'Evening Workshop',${startsAt},${new Date(startsAt.getTime() + 8 * HOUR)},${ruleId},${startsAt.toISOString().slice(0, 10)})`;
  };

  it("skips the prune while the rule yields inside the horizon", async () => {
    await insertStale();
    await persistDerivedState(sql, userId, resultWith([]));
    expect(await futureCount()).toBe(1);
  });

  it("prunes when an edit pushed the only active rule's start past the horizon", async () => {
    await insertStale();
    await sql`UPDATE commitment_recurrence_rules SET start_date='2027-06-01' WHERE id=${ruleId}`;
    await persistDerivedState(sql, userId, resultWith([]));
    expect(await futureCount()).toBe(0);
  });

  it("prunes when the rule's interval carries its next occurrence past the horizon", async () => {
    await insertStale();
    await sql`UPDATE commitment_recurrence_rules SET start_date='2026-08-26', interval_days=400 WHERE id=${ruleId}`;
    await persistDerivedState(sql, userId, resultWith([]));
    expect(await futureCount()).toBe(0);
  });

  it("keeps the guard for a rule whose only landing is the engine's extra day past the horizon", async () => {
    // Horizon's last local day is 2027-03-01 (seed-zone); the engine also scans 2027-03-02 for a moved occurrence.
    await insertStale();
    await sql`UPDATE commitment_recurrence_rules SET start_date='2027-03-02', interval_days=400 WHERE id=${ruleId}`;
    await persistDerivedState(sql, userId, resultWith([]));
    expect(await futureCount()).toBe(1);
    await sql`UPDATE commitment_recurrence_rules SET start_date='2027-03-03' WHERE id=${ruleId}`;
    await persistDerivedState(sql, userId, resultWith([]));
    expect(await futureCount()).toBe(0);
  });

  it("keeps the guard for a rule that ended yesterday, whose last day the engine still scans", async () => {
    // Today is 2026-09-02 in the seed zone; the rule's last occurrence (every 6 days from 08-26) is 09-01.
    await insertStale();
    await sql`UPDATE commitment_recurrence_rules SET interval_days=6, end_date='2026-09-01' WHERE id=${ruleId}`;
    await persistDerivedState(sql, userId, resultWith([]));
    expect(await futureCount()).toBe(1);
    await sql`UPDATE commitment_recurrence_rules SET end_date='2026-08-31' WHERE id=${ruleId}`;
    await persistDerivedState(sql, userId, resultWith([]));
    expect(await futureCount()).toBe(0);
  });

  it("reads a weekly rule's weekdays and keeps the guard", async () => {
    await insertStale();
    await sql`UPDATE commitment_recurrence_rules SET interval_unit='weeks', interval_days=NULL, interval_weeks=1, weekdays='[1,3]'::jsonb WHERE id=${ruleId}`;
    await persistDerivedState(sql, userId, resultWith([]));
    expect(await futureCount()).toBe(1);
  });
});
