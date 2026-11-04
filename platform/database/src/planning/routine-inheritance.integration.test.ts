import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import { PLAN_FORECAST_CONTRACT_VERSION, type PlanForecastResponse } from "@openrhen/contracts";
import { persistPlanForecastResult } from "./plan-forecast-runtime.js";
import { replaceCommitmentRoutineSteps } from "./routine-inheritance.js";
import { integrationDatabaseName } from "../operations/integration-database.js";

config({ path: resolve(process.cwd(), "../../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
// A database of its own for the same reason the occurrence, retention and queue suites have one:
// these suites truncate, and two of them truncating the same database is an unreproducible flake.
const testDatabaseName = integrationDatabaseName(
  process.env.ROUTINE_INHERITANCE_TEST_DATABASE_NAME,
  "openrhen_routine_inheritance"
);

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("ROUTINE_INHERITANCE_TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

const HOUR = 3_600_000;
const now = new Date();
const futureStart = new Date(now.getTime() + 26 * HOUR);
const futureEnd = new Date(now.getTime() + 27 * HOUR);

let sql: postgres.Sql;
let userId: string;

async function createCommitment(input: {
  id: string;
  routineSource?: string;
  startsAt?: Date;
  endsAt?: Date;
  status?: string;
  recurrenceRuleId?: string | null;
}) {
  await sql`
    INSERT INTO commitments (id,user_id,title,starts_at,ends_at,status,routine_source,recurrence_rule_id)
    VALUES (
      ${input.id},${userId},'Fixture commitment',
      ${input.startsAt ?? futureStart},${input.endsAt ?? new Date((input.startsAt ?? futureStart).getTime() + HOUR)},
      ${input.status ?? "confirmed"},${input.routineSource ?? "inherit"},${input.recurrenceRuleId ?? null}
    )
  `;
}

/** A stored `routine_steps` row, inserted directly — standing in for whatever an earlier persist run
 *  (or a hand edit) left in place, so a test can exercise `syncCommitmentRoutineSteps`'s diff against
 *  it without driving a first persist run just to create it. */
async function addStoredStep(
  commitmentId: string,
  overrides: {
    id: string;
    title?: string;
    sequence?: number;
    durationMinutes?: number;
    status?: string;
    scheduledStartAt?: Date | null;
    scheduledEndAt?: Date | null;
    presetStepId?: string | null;
    waitAfterMinutes?: number;
  }
) {
  await sql`
    INSERT INTO routine_steps
      (id,user_id,commitment_id,anchor_type,anchor_id,title,duration_minutes,sequence,timing_rule,phase,status,scheduled_start_at,scheduled_end_at,preset_step_id,wait_after_minutes)
    VALUES (
      ${overrides.id},${userId},${commitmentId},'commitment',${commitmentId},${overrides.title ?? "Pack towel"},
      ${overrides.durationMinutes ?? 10},${overrides.sequence ?? 0},'contiguous','before',
      ${overrides.status ?? "pending"},${overrides.scheduledStartAt ?? null},${overrides.scheduledEndAt ?? null},
      ${overrides.presetStepId ?? null},${overrides.waitAfterMinutes ?? 0}
    )
  `;
}

async function stepsOf(commitmentId: string) {
  return sql<
    {
      id: string;
      title: string;
      duration_minutes: number;
      status: string;
      sequence: number;
      scheduled_start_at: Date | null;
      scheduled_end_at: Date | null;
      wait_after_minutes: number;
      must_start_by_minutes: number | null;
      preferred_bands: unknown;
    }[]
  >`
    SELECT id,title,duration_minutes,status,sequence,scheduled_start_at,scheduled_end_at,wait_after_minutes,must_start_by_minutes,preferred_bands
    FROM routine_steps WHERE commitment_id=${commitmentId} ORDER BY sequence
  `;
}

/** One commitment-anchored step exactly as the engine's `derivedState.routineSteps` shapes it. */
function derivedStep(overrides: {
  id: string;
  commitmentId: string;
  title?: string;
  sequence?: number;
  durationMinutes?: number;
  status?: string;
  scheduledStartAt?: Date | null;
  scheduledEndAt?: Date | null;
  presetStepId?: string | null;
  dependencyIds?: string[];
  waitAfterMinutes?: number;
  mustStartByMinutes?: number | null;
  preferredBands?: string[];
}): Record<string, unknown> {
  return {
    id: overrides.id,
    commitmentId: overrides.commitmentId,
    anchorType: "commitment",
    anchorId: overrides.commitmentId,
    title: overrides.title ?? "Pack towel",
    durationMinutes: overrides.durationMinutes ?? 10,
    sequence: overrides.sequence ?? 0,
    timingRule: "contiguous",
    energy: "low",
    contexts: [],
    dependencyIds: overrides.dependencyIds ?? [],
    phase: "before",
    presetStepId: overrides.presetStepId ?? null,
    status: overrides.status ?? "pending",
    ...(overrides.scheduledStartAt ? { scheduledStartAt: overrides.scheduledStartAt.toISOString() } : {}),
    ...(overrides.scheduledEndAt ? { scheduledEndAt: overrides.scheduledEndAt.toISOString() } : {}),
    waitAfterMinutes: overrides.waitAfterMinutes ?? 0,
    mustStartByMinutes: overrides.mustStartByMinutes ?? null,
    preferredBands: overrides.preferredBands ?? []
  };
}

/** Runs the persist exactly as `processPlanForecastJob` does, against a hand-built, schema-valid
 *  `PlanForecastResponse` standing in for the engine's own — `platform/database` cannot reach a real
 *  engine (`engine-boundary.test.ts` keeps persistence independent of it), and the harness's own
 *  stand-in engine (`plan-forecast-engine-harness.ts`) always answers with an empty `derivedState`. */
async function persistResult(overrides: {
  routineSteps?: Array<Record<string, unknown>>;
  commitmentRepeats?: Array<Record<string, unknown>>;
}) {
  const result = {
    contractVersion: PLAN_FORECAST_CONTRACT_VERSION,
    requestId: crypto.randomUUID(),
    inputVersion: crypto.randomUUID(),
    engineVersion: "test-engine",
    calculatedAt: now.toISOString(),
    validUntil: new Date(now.getTime() - 60_000).toISOString(),
    derivedState: {
      sleepPlans: [],
      occurrences: [],
      routineSteps: overrides.routineSteps ?? [],
      commitmentRepeats: overrides.commitmentRepeats ?? []
    },
    schedule: {},
    recommendation: {},
    currentDirective: { kind: "none", title: "No suitable action", recommendedMinutes: 0 },
    upcomingDirectives: [],
    continuation: null
  };
  await persistPlanForecastResult(sql, userId, result as unknown as PlanForecastResponse);
}

async function changeLogCount(): Promise<number> {
  const rows = await sql<{ count: string }[]>`SELECT COUNT(*)::text AS count FROM write_rows WHERE user_id=${userId}`;
  return Number(rows[0]!.count);
}

async function jobsCount(): Promise<number> {
  const rows = await sql<{ count: string }[]>`SELECT COUNT(*)::text AS count FROM jobs`;
  return Number(rows[0]!.count);
}

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
  const users = await sql<{ id: string }[]>`INSERT INTO users (display_name) VALUES ('Routine Fixture') RETURNING id`;
  userId = users[0]!.id;
});

afterAll(async () => {
  await sql?.end();
});

describe("syncCommitmentRoutineSteps (the persist's write-back mirror of the engine's own rows)", () => {
  it("inserts a new commitment's preset steps already placed, under the engine's own ids, in the run that first sees them", async () => {
    const commitmentId = crypto.randomUUID();
    await createCommitment({ id: commitmentId });
    const stepId = crypto.randomUUID();
    await persistResult({
      routineSteps: [
        derivedStep({
          id: stepId,
          commitmentId,
          title: "Pack towel",
          scheduledStartAt: new Date(futureStart.getTime() - 15 * 60_000),
          scheduledEndAt: futureStart
        })
      ]
    });
    const steps = await stepsOf(commitmentId);
    expect(steps.map((step) => step.id)).toEqual([stepId]);
    expect(steps[0]!.status).toBe("pending");
    expect(steps[0]!.scheduled_start_at?.getTime()).toBe(futureStart.getTime() - 15 * 60_000);
    expect(steps[0]!.scheduled_end_at?.getTime()).toBe(futureStart.getTime());
  });

  it("materialises a new recurring occurrence and inserts its preset steps already placed in the same run", async () => {
    const ruleId = crypto.randomUUID();
    await sql`
      INSERT INTO commitment_recurrence_rules
        (id,user_id,title,timezone,start_date,interval_days,local_start_time,local_end_time)
      VALUES (${ruleId},${userId},'Evening Workshop','Australia/Sydney','2026-01-01',7,'09:00','17:00')
    `;
    const occurrenceId = crypto.randomUUID();
    const stepId = crypto.randomUUID();
    await persistResult({
      commitmentRepeats: [
        {
          id: occurrenceId,
          recurrenceRuleId: ruleId,
          localDate: "2026-09-30",
          startsAt: futureStart.toISOString(),
          endsAt: futureEnd.toISOString(),
          title: "Evening Workshop"
        }
      ],
      routineSteps: [
        derivedStep({
          id: stepId,
          commitmentId: occurrenceId,
          title: "Pack bag",
          scheduledStartAt: new Date(futureStart.getTime() - 10 * 60_000),
          scheduledEndAt: futureStart
        })
      ]
    });
    const commitmentRows = await sql<{ id: string }[]>`SELECT id FROM commitments WHERE id=${occurrenceId}`;
    expect(commitmentRows).toHaveLength(1);
    const steps = await stepsOf(occurrenceId);
    expect(steps.map((step) => step.id)).toEqual([stepId]);
    expect(steps[0]!.scheduled_start_at).not.toBeNull();
  });

  it("updates a stored pending row's content and placement to the engine's own row, reaching it by id (a preset wait edit)", async () => {
    const commitmentId = crypto.randomUUID();
    await createCommitment({ id: commitmentId });
    const stepId = crypto.randomUUID();
    await addStoredStep(commitmentId, {
      id: stepId,
      title: "Pack towel",
      durationMinutes: 10,
      waitAfterMinutes: 0,
      scheduledStartAt: new Date(futureStart.getTime() - 10 * 60_000),
      scheduledEndAt: futureStart
    });
    // The engine's next run resolved a preset edit: the same step now waits 90 minutes and is placed
    // earlier to make room.
    await persistResult({
      routineSteps: [
        derivedStep({
          id: stepId,
          commitmentId,
          title: "Pack towel",
          waitAfterMinutes: 90,
          scheduledStartAt: new Date(futureStart.getTime() - 100 * 60_000),
          scheduledEndAt: new Date(futureStart.getTime() - 90 * 60_000)
        })
      ]
    });
    const steps = await stepsOf(commitmentId);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.id).toBe(stepId);
    expect(steps[0]!.wait_after_minutes).toBe(90);
    expect(steps[0]!.scheduled_start_at?.getTime()).toBe(futureStart.getTime() - 100 * 60_000);
  });

  it("never rewrites a locked (non-pending) row's content or times, even when the engine's own row for that id differs", async () => {
    const commitmentId = crypto.randomUUID();
    await createCommitment({ id: commitmentId });
    const stepId = crypto.randomUUID();
    const lockedStart = new Date(futureStart.getTime() - 10 * 60_000);
    await addStoredStep(commitmentId, {
      id: stepId,
      title: "Pack towel",
      durationMinutes: 10,
      status: "completed",
      scheduledStartAt: lockedStart,
      scheduledEndAt: futureStart
    });
    // A genuine engine run always echoes a locked row's content back unchanged (it is a record of the
    // day); this asserts the persist's own guard holds even against a row that, hypothetically, did not.
    await persistResult({
      routineSteps: [
        derivedStep({
          id: stepId,
          commitmentId,
          title: "Pack towel (renamed)",
          durationMinutes: 20,
          status: "completed",
          scheduledStartAt: new Date(futureStart.getTime() - 999 * 60_000),
          scheduledEndAt: new Date(futureStart.getTime() - 900 * 60_000)
        })
      ]
    });
    const steps = await stepsOf(commitmentId);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.status).toBe("completed");
    expect(steps[0]!.title).toBe("Pack towel");
    expect(steps[0]!.duration_minutes).toBe(10);
    expect(steps[0]!.scheduled_start_at?.getTime()).toBe(lockedStart.getTime());
  });

  it("reindexes a locked row's sequence to the engine's own, without touching its content", async () => {
    const commitmentId = crypto.randomUUID();
    await createCommitment({ id: commitmentId });
    const lockedId = crypto.randomUUID();
    const pendingId = crypto.randomUUID();
    await addStoredStep(commitmentId, { id: lockedId, title: "Fill water bottle", sequence: 0, status: "completed" });
    await addStoredStep(commitmentId, { id: pendingId, title: "Hang towel", sequence: 1 });
    // The engine's own final order moved the locked step to position 1 (a new step landed ahead of it
    // in the preset — simulated here by simply swapping the two engine rows' sequences).
    await persistResult({
      routineSteps: [
        derivedStep({ id: pendingId, commitmentId, title: "Hang towel", sequence: 0 }),
        derivedStep({ id: lockedId, commitmentId, title: "Fill water bottle", sequence: 1, status: "completed" })
      ]
    });
    const steps = await stepsOf(commitmentId);
    const locked = steps.find((step) => step.id === lockedId)!;
    const pending = steps.find((step) => step.id === pendingId)!;
    expect(locked.sequence).toBe(1);
    expect(locked.title).toBe("Fill water bottle"); // content untouched — only sequence moved
    expect(pending.sequence).toBe(0);
  });

  it("deletes a stored pending row the engine no longer emits for that commitment (a 'none' source)", async () => {
    const commitmentId = crypto.randomUUID();
    await createCommitment({ id: commitmentId, routineSource: "none" });
    const stepId = crypto.randomUUID();
    await addStoredStep(commitmentId, { id: stepId, title: "Left-over prep" });
    // 'none': the engine's reconciliation against an empty template deletes every pending row and
    // emits nothing for this commitment at all.
    await persistResult({ routineSteps: [] });
    expect(await stepsOf(commitmentId)).toEqual([]);
  });

  it("spares a pending row belonging to a commitment the engine did not touch at all (no derived rows, not a candidate)", async () => {
    const commitmentId = crypto.randomUUID();
    // A commitment already underway (starts_at in the past) is not a routine-derivation candidate —
    // the engine still passes its rows through, but nothing in this run mentions it at all.
    await createCommitment({
      id: commitmentId,
      startsAt: new Date(now.getTime() - HOUR),
      endsAt: new Date(now.getTime() + HOUR)
    });
    const stepId = crypto.randomUUID();
    await addStoredStep(commitmentId, { id: stepId, title: "Untouched" });
    await persistResult({ routineSteps: [] });
    const steps = await stepsOf(commitmentId);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.title).toBe("Untouched");
  });

  it("places a pending row for a non-candidate commitment the engine still placed (already started, custom, or tentative)", async () => {
    const commitmentId = crypto.randomUUID();
    await createCommitment({
      id: commitmentId,
      routineSource: "custom",
      startsAt: new Date(now.getTime() + HOUR),
      endsAt: new Date(now.getTime() + 2 * HOUR)
    });
    const stepId = crypto.randomUUID();
    await addStoredStep(commitmentId, { id: stepId, title: "Custom step" });
    const placedStart = new Date(now.getTime() + 30 * 60_000);
    const placedEnd = new Date(now.getTime() + 40 * 60_000);
    // A custom commitment is never a reconciliation candidate (its steps cannot be told apart from
    // hand-added ones), but the engine still placed this pending step — the persist mirrors only its
    // placement, never its existence or content.
    await persistResult({
      routineSteps: [
        derivedStep({
          id: stepId,
          commitmentId,
          title: "Custom step",
          scheduledStartAt: placedStart,
          scheduledEndAt: placedEnd
        })
      ]
    });
    const steps = await stepsOf(commitmentId);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.scheduled_start_at?.getTime()).toBe(placedStart.getTime());
    expect(steps[0]!.scheduled_end_at?.getTime()).toBe(placedEnd.getTime());
  });

  it("writes no write_rows row and enqueues no job — write-back only", async () => {
    const commitmentId = crypto.randomUUID();
    await createCommitment({ id: commitmentId });
    const before = { changeLog: await changeLogCount(), jobs: await jobsCount() };
    await persistResult({
      routineSteps: [
        derivedStep({
          id: crypto.randomUUID(),
          commitmentId,
          scheduledStartAt: new Date(futureStart.getTime() - 10 * 60_000),
          scheduledEndAt: futureStart
        })
      ]
    });
    expect(await changeLogCount()).toBe(before.changeLog);
    expect(await jobsCount()).toBe(before.jobs);
  });
});

describe("replaceCommitmentRoutineSteps (import review's routine stamp)", () => {
  it("anchors every stamped step to its commitment, so the NOT NULL anchor_id holds", async () => {
    const commitmentId = crypto.randomUUID();
    await createCommitment({ id: commitmentId });
    const step = {
      title: "Pack bag",
      durationMinutes: 10,
      timingRule: "flexible",
      maxLeadMinutes: 60,
      energy: "low",
      phase: "before",
      contexts: [],
      actionWindowId: null,
      cadenceActionId: null,
      presetStepId: null,
      dependsOn: [],
      waitAfterMinutes: 0,
      mustStartByMinutes: null,
      preferredBands: []
    };
    await replaceCommitmentRoutineSteps(sql, userId, commitmentId, [
      step,
      { ...step, title: "Fill bottle", dependsOn: [0] }
    ] as never);
    const rows = await sql<
      { title: string; anchor_type: string; anchor_id: string }[]
    >`SELECT title,anchor_type,anchor_id FROM routine_steps WHERE commitment_id=${commitmentId} ORDER BY sequence`;
    expect(rows).toEqual([
      { title: "Pack bag", anchor_type: "commitment", anchor_id: commitmentId },
      { title: "Fill bottle", anchor_type: "commitment", anchor_id: commitmentId }
    ]);
  });
});
