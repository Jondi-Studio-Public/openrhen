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
// A database of its own for the same reason every other suite in this folder has one: these suites
// truncate, and two of them truncating the same database is an unreproducible flake.
const testDatabaseName = integrationDatabaseName(
  process.env.PLAN_FORECAST_EVIDENCE_TEST_DATABASE_NAME,
  "openrhen_plan_forecast_evidence"
);

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("PLAN_FORECAST_EVIDENCE_TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
// Fixed relative to the real clock (rather than a hardcoded past date) because the commitments
// DELETE below compares against the database's own CURRENT_TIMESTAMP, not this value.
const now = new Date(Date.now() + 24 * HOUR);

let sql: postgres.Sql;
let userId: string;

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
  const users = await sql<{ id: string }[]>`INSERT INTO users (display_name) VALUES ('Evidence Fixture') RETURNING id`;
  userId = users[0]!.id;
  await sql`INSERT INTO user_preferences (user_id) VALUES (${userId})`;
});

afterAll(async () => {
  await sql?.end();
});

/** A minimal PlanForecastResponse `persistDerivedState` reads only `derivedState`, `inputVersion`
 * and `calculatedAt` from — the rest of the (much larger) contract shape is irrelevant to it. */
function resultWith(
  derived: Partial<{
    sleepPlans: Array<Record<string, unknown>>;
    routineSteps: Array<Record<string, unknown>>;
    commitmentRepeats: Array<Record<string, unknown>>;
  }>,
  calculatedAt: Date,
  inputVersion = "v1"
): PlanForecastResponse {
  return {
    inputVersion,
    calculatedAt: calculatedAt.toISOString(),
    derivedState: {
      sleepPlans: derived.sleepPlans ?? [],
      occurrences: [],
      routineSteps: derived.routineSteps ?? [],
      commitmentRepeats: derived.commitmentRepeats ?? []
    }
  } as unknown as PlanForecastResponse;
}

// ---------------------------------------------------------------------------------------------
// routine_steps (sleep-anchored): a decided step's own record must not shift once it has moved
// past 'pending' (the one routine storage design note — the same freeze invariant
// a commitment's own steps already carry, now proven for the sleep anchor too).
// ---------------------------------------------------------------------------------------------
describe("persistDerivedState — sleep-anchored routine_steps freeze", () => {
  let anchorId: string;
  let presetStepId: string;
  let stepId: string;

  beforeEach(async () => {
    const presets = await sql<
      { id: string }[]
    >`INSERT INTO routine_presets (user_id,name,activity_name) VALUES (${userId},'Bedtime routine','Wind down') RETURNING id`;
    const presetSteps = await sql<{ id: string }[]>`
      INSERT INTO routine_preset_steps (preset_id,title,duration_minutes,sequence,timing_rule,phase)
      VALUES (${presets[0]!.id},'Wind down',10,0,'contiguous','before') RETURNING id
    `;
    presetStepId = presetSteps[0]!.id;
    anchorId = crypto.randomUUID();
    stepId = crypto.randomUUID();
  });

  const stepRow = async () =>
    (
      await sql<
        {
          title: string;
          duration_minutes: number;
          status: string;
          scheduled_start_at: Date | null;
          scheduled_end_at: Date | null;
        }[]
      >`SELECT title,duration_minutes,status,scheduled_start_at,scheduled_end_at FROM routine_steps WHERE id=${stepId}`
    )[0]!;

  // Report-class bug the commitment path already guards against: a non-pending row is a
  // record of the day and must not be rewritten just because a later run resolves the same anchor
  // differently (a different title, duration or schedule).
  it("leaves a 'doing' step's own record alone", async () => {
    const startsAt = new Date(now.getTime() - 20 * MINUTE);
    const endsAt = new Date(now.getTime() + 40 * MINUTE);
    await sql`
      INSERT INTO routine_steps (id,user_id,anchor_type,anchor_id,purpose,preset_step_id,title,duration_minutes,sequence,timing_rule,phase,status,scheduled_start_at,scheduled_end_at)
      VALUES (${stepId},${userId},'sleep_plan',${anchorId},'bedtime',${presetStepId},'Wind down',10,0,'contiguous','before','doing',${startsAt},${endsAt})
    `;

    const drift = 2 * HOUR + 15 * MINUTE;
    await persistDerivedState(
      sql,
      userId,
      resultWith(
        {
          routineSteps: [
            {
              id: crypto.randomUUID(), // a fresh derivation's own guess — must not take hold either
              anchorType: "sleep_plan",
              anchorId,
              purpose: "bedtime",
              presetStepId,
              title: "Renamed step",
              durationMinutes: 25,
              sequence: 0,
              timingRule: "contiguous",
              phase: "before",
              energy: "low",
              contexts: [],
              status: "pending",
              scheduledStartAt: new Date(startsAt.getTime() + drift).toISOString(),
              scheduledEndAt: new Date(endsAt.getTime() + drift).toISOString()
            }
          ]
        },
        new Date(now.getTime() + HOUR)
      )
    );

    const row = await stepRow();
    expect(row.title).toBe("Wind down");
    expect(row.duration_minutes).toBe(10);
    expect(row.status).toBe("doing");
    expect(row.scheduled_start_at!.toISOString()).toBe(startsAt.toISOString());
    expect(row.scheduled_end_at!.toISOString()).toBe(endsAt.toISOString());
  });

  it("still re-anchors a pending step when the run resolves it differently", async () => {
    const startsAt = new Date(now.getTime() + HOUR);
    const endsAt = new Date(now.getTime() + HOUR + 10 * MINUTE);
    await sql`
      INSERT INTO routine_steps (id,user_id,anchor_type,anchor_id,purpose,preset_step_id,title,duration_minutes,sequence,timing_rule,phase,status,scheduled_start_at,scheduled_end_at)
      VALUES (${stepId},${userId},'sleep_plan',${anchorId},'bedtime',${presetStepId},'Wind down',10,0,'contiguous','before','pending',${startsAt},${endsAt})
    `;

    const moved = new Date(startsAt.getTime() + 3 * HOUR);
    await persistDerivedState(
      sql,
      userId,
      resultWith(
        {
          routineSteps: [
            {
              id: crypto.randomUUID(),
              anchorType: "sleep_plan",
              anchorId,
              purpose: "bedtime",
              presetStepId,
              title: "Wind down",
              durationMinutes: 10,
              sequence: 0,
              timingRule: "contiguous",
              phase: "before",
              energy: "low",
              contexts: [],
              status: "pending",
              scheduledStartAt: moved.toISOString(),
              scheduledEndAt: new Date(moved.getTime() + 10 * MINUTE).toISOString()
            }
          ]
        },
        new Date(now.getTime() + HOUR)
      )
    );

    const row = await stepRow();
    expect(row.scheduled_start_at!.toISOString()).toBe(moved.toISOString());
  });
});

// ---------------------------------------------------------------------------------------------
// commitments: a materialised commitment already carrying acted-upon prep must survive
// falling out of a run's resolved set, since it cascade-deletes routine_steps.
// ---------------------------------------------------------------------------------------------
describe("persistDerivedState — protected materialised commitments", () => {
  let ruleId: string;

  beforeEach(async () => {
    const rules = await sql<{ id: string }[]>`
      INSERT INTO commitment_recurrence_rules (user_id,title,timezone,start_date,interval_days,local_start_time,local_end_time,presence,status)
      VALUES (${userId},'Evening Workshop','Australia/Sydney','2026-08-26',7,'18:00','20:30','blocking','ended') RETURNING id
    `;
    // 'ended': this run resolves no occurrences for it at all, exactly the case that emptied
    // commitmentOccurrenceIds and drove the bulk DELETE branch below.
    ruleId = rules[0]!.id;
  });

  async function seedCommitment(id: string, stepStatus: string) {
    await sql`
      INSERT INTO commitments (id,user_id,title,starts_at,ends_at,status,recurrence_rule_id,local_date)
      VALUES (${id},${userId},'Evening Workshop',${new Date(now.getTime() + HOUR)},${new Date(now.getTime() + 2 * HOUR)},'confirmed',${ruleId},'2026-09-08')
    `;
    await sql`
      INSERT INTO routine_steps (user_id,commitment_id,anchor_type,anchor_id,title,duration_minutes,sequence,timing_rule,status)
      VALUES (${userId},${id},'commitment',${id},'Pack bag',10,0,'contiguous',${stepStatus})
    `;
  }

  const commitmentExists = async (id: string) =>
    (await sql<{ id: string }[]>`SELECT id FROM commitments WHERE id=${id}`).length > 0;

  it("keeps a commitment whose prep step has already been acted on", async () => {
    const id = crypto.randomUUID();
    await seedCommitment(id, "doing");
    await persistDerivedState(sql, userId, resultWith({ commitmentRepeats: [] }, now));
    expect(await commitmentExists(id)).toBe(true);
  });

  it("still drops a commitment whose prep is untouched, once its rule no longer resolves it", async () => {
    const id = crypto.randomUUID();
    await seedCommitment(id, "pending");
    await persistDerivedState(sql, userId, resultWith({ commitmentRepeats: [] }, now));
    expect(await commitmentExists(id)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// sleep_plans: an 'override' latch must release once its own night has lapsed unslept, so a
// later recalculation is not permanently blinded to a stale desired_minutes.
// ---------------------------------------------------------------------------------------------
describe("persistDerivedState — sleep override latch (finding 24)", () => {
  const plannedStartAt = new Date(now.getTime() - 8 * HOUR);
  const plannedWakeAt = now; // "tonight's" wake instant, relative to the fixture `now`

  async function seedOverriddenPlan(id: string) {
    await sql`
      INSERT INTO sleep_plans (id,user_id,planned_start_at,planned_wake_at,desired_minutes,allowed_minutes,sleep_deficit_minutes,anchor_deviation_minutes,hard_errors,explanation,status,input_version,score_components)
      VALUES (${id},${userId},${plannedStartAt},${plannedWakeAt},480,510,0,0,'[]','Manually extended.','planned','override','{}')
    `;
  }

  const rowOf = async (id: string) =>
    (
      await sql<{ input_version: string | null; desired_minutes: number }[]>`
        SELECT input_version,desired_minutes FROM sleep_plans WHERE id=${id}
      `
    )[0];

  it("keeps 'override' while the overridden night is still live", async () => {
    const id = crypto.randomUUID();
    await seedOverriddenPlan(id);
    // Same night, still in its own window — a run an hour before the (unchanged) wake instant.
    await persistDerivedState(
      sql,
      userId,
      resultWith(
        {
          sleepPlans: [
            {
              id,
              plannedStartAt: plannedStartAt.toISOString(),
              plannedWakeAt: plannedWakeAt.toISOString(),
              desiredMinutes: 480,
              allowedMinutes: 510,
              sleepDeficitMinutes: 0,
              anchorDeviationMinutes: 0,
              hardErrors: [],
              explanation: "Manually extended.",
              status: "planned",
              overridden: true
            }
          ]
        },
        new Date(plannedWakeAt.getTime() - HOUR)
      )
    );
    expect((await rowOf(id))?.input_version).toBe("override");
  });

  it("releases 'override' once the overridden night has passed unslept, letting the next run replace it", async () => {
    const id = crypto.randomUUID();
    await seedOverriddenPlan(id);
    // The engine still echoes the stored, overridden row verbatim (its own retention has no time
    // bound) — but this run happens well after planned_wake_at, with the plan never having reached
    // 'sleeping'. The DB layer is the one place left that can tell the window has lapsed.
    const lapsedAt = new Date(plannedWakeAt.getTime() + 9 * HOUR);
    await persistDerivedState(
      sql,
      userId,
      resultWith(
        {
          sleepPlans: [
            {
              id,
              plannedStartAt: plannedStartAt.toISOString(),
              plannedWakeAt: plannedWakeAt.toISOString(),
              desiredMinutes: 480,
              allowedMinutes: 510,
              sleepDeficitMinutes: 0,
              anchorDeviationMinutes: 0,
              hardErrors: [],
              explanation: "Manually extended.",
              status: "planned",
              overridden: true
            }
          ]
        },
        lapsedAt,
        "fresh-input-version"
      )
    );
    expect((await rowOf(id))?.input_version).toBe("fresh-input-version");

    // With the latch released, the very next run's own pre-loop sweep (`status='planned' AND
    // input_version<>'override'`) is free to clear the stale row and let a genuinely fresh
    // candidate — a different id, a different desired_minutes — take its place.
    const freshId = crypto.randomUUID();
    await persistDerivedState(
      sql,
      userId,
      resultWith(
        {
          sleepPlans: [
            {
              id: freshId,
              plannedStartAt: new Date(lapsedAt.getTime() + 14 * HOUR).toISOString(),
              plannedWakeAt: new Date(lapsedAt.getTime() + 22 * HOUR).toISOString(),
              desiredMinutes: 500,
              allowedMinutes: 500,
              sleepDeficitMinutes: 0,
              anchorDeviationMinutes: 0,
              hardErrors: [],
              explanation: "Freshly calculated.",
              status: "planned"
            }
          ]
        },
        new Date(lapsedAt.getTime() + HOUR),
        "fresh-input-version"
      )
    );
    expect(await rowOf(id)).toBeUndefined();
    expect((await rowOf(freshId))?.desired_minutes).toBe(500);
  });
});
