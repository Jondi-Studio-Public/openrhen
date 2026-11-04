import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import { runCheckInSchedulerTick } from "./check-in-scheduler.js";
import { STATE_CHANGED_CHANNEL, type StateChangedNotification } from "./state-changed.js";
import { integrationDatabaseName } from "../operations/integration-database.js";

config({ path: resolve(process.cwd(), "../../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
// A database of its own for the same reason every other truncating suite in this directory has one.
const testDatabaseName = integrationDatabaseName(
  process.env.CHECK_IN_SCHEDULER_TEST_DATABASE_NAME,
  "openrhen_check_in_scheduler"
);

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("CHECK_IN_SCHEDULER_TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

const now = new Date();

let sql: postgres.Sql;
let userId: string;

/** Defaults to a fresh assertion (set right now); pass `locationSetAt` to simulate one that has aged
 * past `DEFAULT_LOCATION_STALE_AFTER_MINUTES`. */
async function setLocation(locationId: string | null, locationSetAt: Date | null = now) {
  await sql`
    UPDATE user_preferences
    SET current_situation=${sql.json({ locationId, locationSetAt: locationSetAt?.toISOString(), overrides: {}, carrying: {} } as never)}
    WHERE user_id=${userId}
  `;
}

/** A currently-tracked session (`ended_at IS NULL`), the cooldown's first anchor. Accepts the
 * session's own target (`target_type`/`target_id`/`target_title`) so hypothesis tests can make it
 * disagree with whatever the stored plan run's belief names — the scheduler reads `target_type` for
 * the sleep gate but, per `runCheckInSchedulerTick`'s query, never reads `target_id`/`target_title`
 * at all. */
async function createActiveSession(
  startedAt: Date,
  target: { targetType?: string; targetId?: string | null; targetTitle?: string | null } = {}
) {
  const { targetType = "action", targetId = null, targetTitle = null } = target;
  await sql`
    INSERT INTO sessions (user_id,planned_started_at,planned_end_at,started_at,planned_minutes,remaining_before_minutes,status,target_type,target_id,target_title)
    VALUES (${userId},${startedAt},${new Date(startedAt.getTime() + 30 * 60_000)},${startedAt},30,30,'running',${targetType},${targetId},${targetTitle})
  `;
}

/** An already-finished session, the cooldown's third anchor — distinct from `createActiveSession`
 * because the scheduler reads the two through separate queries (`ended_at IS NULL` vs `IS NOT NULL`). */
async function createEndedSession(endedAt: Date) {
  const startedAt = new Date(endedAt.getTime() - 20 * 60_000);
  await sql`
    INSERT INTO sessions (user_id,planned_started_at,planned_end_at,started_at,ended_at,planned_minutes,remaining_before_minutes,status,target_type)
    VALUES (${userId},${startedAt},${endedAt},${startedAt},${endedAt},20,20,'completed','action')
  `;
}

/** Inserts a `check_in` row directly, standing in for one the scheduler wrote and resolved on an
 * earlier tick — the cooldown tests need to control its `slot_at` (the belief-change anchor, i.e. how
 * long ago its belief was stamped) independently of `resolvedAt` (how long ago the ordinary jittered
 * cadence should count from), which a real row's own lifecycle would otherwise keep close together. */
async function insertCheckIn(fields: {
  slotAt: Date;
  resolvedAt: Date;
  directiveKind: string;
  directiveTargetId: string;
}) {
  await sql`
    INSERT INTO check_in (user_id,slot_at,updated_at,directive_kind,directive_target_id,directive_title,status)
    VALUES (${userId},${fields.slotAt},${fields.resolvedAt},${fields.directiveKind},${fields.directiveTargetId},'Write chapter','unknown')
  `;
}

async function createCommitment(id: string, locationId: string | null, title = "Evening Workshop") {
  await sql`
    INSERT INTO commitments (id,user_id,title,starts_at,ends_at,status,location_id)
    VALUES (${id},${userId},${title},${new Date(now.getTime() - 10 * 60_000)},${new Date(now.getTime() + 50 * 60_000)},'confirmed',${locationId})
  `;
}

async function addStep(commitmentId: string, status = "pending") {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO routine_steps (user_id,commitment_id,anchor_type,anchor_id,title,duration_minutes,sequence,timing_rule,phase,status)
    VALUES (${userId},${commitmentId},'commitment',${commitmentId},'Pack Bag',10,0,'contiguous','before',${status}) RETURNING id
  `;
  return rows[0]!.id;
}

/** A minimal `planning_runs` row naming a `routine_step` directive, the only shape this scheduler's
 * new hygiene check inspects further. */
async function storeRoutineStepDirective(stepId: string) {
  await storePlanningRun({ currentDirective: { kind: "routine_step", targetId: stepId, title: "Pack Bag" } });
}

/** The general form `storeRoutineStepDirective` is a special case of — one `planning_runs` row naming
 * whatever `currentDirective`/`protectedCommitment`/`openAnchor` a test wants the scheduler to read as
 * its belief, for the other kinds finding 41's extended guard now re-validates. */
async function storePlanningRun(fields: {
  currentDirective?: unknown;
  protectedCommitment?: unknown;
  openAnchor?: unknown;
}) {
  await sql`
    INSERT INTO planning_runs (user_id,request_id,input_version,contract_version,engine_version,calculated_at,valid_until,result)
    VALUES (
      ${userId},${crypto.randomUUID()},'v1','v1','v1',${now},${new Date(now.getTime() + 3_600_000)},
      ${sql.json({
        currentDirective: fields.currentDirective ?? null,
        recommendation: {
          ...(fields.protectedCommitment ? { protectedCommitment: fields.protectedCommitment } : {}),
          ...(fields.openAnchor ? { openAnchor: fields.openAnchor } : {})
        }
      } as never)}
    )
  `;
}

async function pendingCheckIns() {
  return sql<{ directive_target_id: string | null }[]>`
    SELECT directive_target_id FROM check_in WHERE user_id=${userId} AND status='pending'
  `;
}

/** Same as `pendingCheckIns` but also carries `directive_kind`/`directive_title`, for the hypothesis
 * tests below that need to see the whole subject the row was written with, not just its target id. */
async function pendingCheckInDetails() {
  return sql<{ directive_kind: string; directive_target_id: string | null; directive_title: string }[]>`
    SELECT directive_kind, directive_target_id, directive_title FROM check_in WHERE user_id=${userId} AND status='pending'
  `;
}

/** An area/outcome/project chain, the ownership path `actions` and `deliverables` reach `user_id`
 * through (they carry no `user_id` column of their own — see check-in-scheduler.ts). */
async function createProject(): Promise<string> {
  const areas = await sql<{ id: string }[]>`
    INSERT INTO areas (user_id,name,sort_order) VALUES (${userId},'Study',1) RETURNING id
  `;
  const outcomes = await sql<{ id: string }[]>`
    INSERT INTO outcomes (area_id,title,definition_of_done) VALUES (${areas[0]!.id},'Graduate','Degree awarded') RETURNING id
  `;
  const projects = await sql<{ id: string }[]>`
    INSERT INTO projects (outcome_id,title) VALUES (${outcomes[0]!.id},'Thesis') RETURNING id
  `;
  return projects[0]!.id;
}

async function addAction(projectId: string, status: string): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO actions (project_id,title,scheduling_mode,status,optimistic_minutes,expected_minutes,pessimistic_minutes,remaining_minutes,energy,minimum_session_minutes,maximum_session_minutes)
    VALUES (${projectId},'Write chapter','one_off',${status},15,25,40,25,'medium',15,60) RETURNING id
  `;
  return rows[0]!.id;
}

async function addDeliverable(projectId: string, status: string): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO deliverables (project_id,title,status) VALUES (${projectId},'Draft chapter',${status}) RETURNING id
  `;
  return rows[0]!.id;
}

/** A sleep-anchored `routine_steps` row — the belief kind it backs is `routine_step`, the
 *  same as a commitment's own preparation step; `status` here mirrors what used to be a whole
 *  `routine_instances` row's own status before this table absorbed it. */
async function addSleepRoutineStep(status: string): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO routine_steps (user_id,anchor_type,anchor_id,purpose,title,duration_minutes,sequence,timing_rule,phase,status)
    VALUES (${userId},'sleep_plan',${crypto.randomUUID()},'wake','Morning',10,0,'contiguous','before',${status}) RETURNING id
  `;
  return rows[0]!.id;
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
  const users = await sql<{ id: string }[]>`
    INSERT INTO users (display_name) VALUES ('Check-in Fixture') RETURNING id
  `;
  userId = users[0]!.id;
  await sql`INSERT INTO user_preferences (user_id) VALUES (${userId})`;
});

afterAll(async () => {
  await sql?.end();
});

describe("runCheckInSchedulerTick re-validates a routine-step belief before creating it", () => {
  it("creates the check-in for an ordinary, still-genuinely-pending step (baseline)", async () => {
    const commitmentId = crypto.randomUUID();
    await createCommitment(commitmentId, "college");
    const stepId = await addStep(commitmentId, "pending");
    await storeRoutineStepDirective(stepId);
    await runCheckInSchedulerTick(sql, userId, now);
    expect((await pendingCheckIns()).map((row) => row.directive_target_id)).toEqual([stepId]);
  });

  it("skips creating it when the step has already been skipped in the database", async () => {
    // The stored plan run is a beat behind: it still names the step because it was calculated before
    // the write-time skip (routine-step-arrival.ts) flipped it. The second check-in row
    // ("Still on Pack Bag?") snapshotted exactly this kind of already-stale belief.
    const commitmentId = crypto.randomUUID();
    await createCommitment(commitmentId, "college");
    const stepId = await addStep(commitmentId, "skipped");
    await storeRoutineStepDirective(stepId);
    await runCheckInSchedulerTick(sql, userId, now);
    expect(await pendingCheckIns()).toEqual([]);
  });

  it("skips creating it when the step has already been completed in the database", async () => {
    const commitmentId = crypto.randomUUID();
    await createCommitment(commitmentId, "college");
    const stepId = await addStep(commitmentId, "completed");
    await storeRoutineStepDirective(stepId);
    await runCheckInSchedulerTick(sql, userId, now);
    expect(await pendingCheckIns()).toEqual([]);
  });

  it("skips creating it when the commitment's location is already the asserted one, even though the step is still pending", async () => {
    // The exact gap the write-time skip's one edge-triggered chance can miss: the
    // person is already there, the step is still `pending` in the database, and nothing about that
    // has changed since the plan run was calculated — but asking "still on Pack Bag?" would still be
    // wrong, so this checks arrival directly rather than trusting the stored status alone.
    const commitmentId = crypto.randomUUID();
    await createCommitment(commitmentId, "college");
    const stepId = await addStep(commitmentId, "pending");
    await storeRoutineStepDirective(stepId);
    await setLocation("college");
    await runCheckInSchedulerTick(sql, userId, now);
    expect(await pendingCheckIns()).toEqual([]);
  });

  it("still creates it when a different, unrelated place is asserted", async () => {
    const commitmentId = crypto.randomUUID();
    await createCommitment(commitmentId, "college");
    const stepId = await addStep(commitmentId, "pending");
    await storeRoutineStepDirective(stepId);
    await setLocation("home");
    await runCheckInSchedulerTick(sql, userId, now);
    expect((await pendingCheckIns()).map((row) => row.directive_target_id)).toEqual([stepId]);
  });

  it("still creates it when the matching assertion has gone stale — a Monday 'at College' must not silently suppress today's check-in", async () => {
    const commitmentId = crypto.randomUUID();
    await createCommitment(commitmentId, "college");
    const stepId = await addStep(commitmentId, "pending");
    await storeRoutineStepDirective(stepId);
    await setLocation("college", new Date(now.getTime() - 500 * 60_000));
    await runCheckInSchedulerTick(sql, userId, now);
    expect((await pendingCheckIns()).map((row) => row.directive_target_id)).toEqual([stepId]);
  });
});

describe("Finding 41: the stale-belief guard extended beyond routine_step", () => {
  it("skips a sleep-anchored routine_step belief once it has already resolved in the database", async () => {
    const stepId = await addSleepRoutineStep("completed");
    await storePlanningRun({ currentDirective: { kind: "routine_step", targetId: stepId, title: "Morning" } });
    await runCheckInSchedulerTick(sql, userId, now);
    expect(await pendingCheckIns()).toEqual([]);
  });

  it("still creates a sleep-anchored routine_step belief that is genuinely still open", async () => {
    const stepId = await addSleepRoutineStep("pending");
    await storePlanningRun({ currentDirective: { kind: "routine_step", targetId: stepId, title: "Morning" } });
    await runCheckInSchedulerTick(sql, userId, now);
    expect((await pendingCheckIns()).map((row) => row.directive_target_id)).toEqual([stepId]);
  });

  it("skips an action belief once it has already been completed", async () => {
    const projectId = await createProject();
    const actionId = await addAction(projectId, "done");
    await storePlanningRun({ currentDirective: { kind: "action", targetId: actionId, title: "Write chapter" } });
    await runCheckInSchedulerTick(sql, userId, now);
    expect(await pendingCheckIns()).toEqual([]);
  });

  it("still creates an action belief that is genuinely still open", async () => {
    const projectId = await createProject();
    const actionId = await addAction(projectId, "active");
    await storePlanningRun({ currentDirective: { kind: "action", targetId: actionId, title: "Write chapter" } });
    await runCheckInSchedulerTick(sql, userId, now);
    expect((await pendingCheckIns()).map((row) => row.directive_target_id)).toEqual([actionId]);
  });

  it("skips a deliverable belief once it has already completed", async () => {
    const projectId = await createProject();
    const deliverableId = await addDeliverable(projectId, "completed");
    await storePlanningRun({
      currentDirective: { kind: "deliverable", targetId: deliverableId, title: "Draft chapter" }
    });
    await runCheckInSchedulerTick(sql, userId, now);
    expect(await pendingCheckIns()).toEqual([]);
  });

  it("still creates a deliverable belief that is genuinely still active", async () => {
    const projectId = await createProject();
    const deliverableId = await addDeliverable(projectId, "in_progress");
    await storePlanningRun({
      currentDirective: { kind: "deliverable", targetId: deliverableId, title: "Draft chapter" }
    });
    await runCheckInSchedulerTick(sql, userId, now);
    expect((await pendingCheckIns()).map((row) => row.directive_target_id)).toEqual([deliverableId]);
  });

  it("skips a travel belief once the person has already arrived at the destination", async () => {
    await storePlanningRun({
      // oxlint-disable-next-line unicorn/no-thenable -- `then` is a domain field of the travel directive, not a promise continuation
      currentDirective: { kind: "travel", title: "Drive to Shed", toLocationId: "shed", then: { targetId: "work-1" } }
    });
    await setLocation("shed");
    await runCheckInSchedulerTick(sql, userId, now);
    expect(await pendingCheckIns()).toEqual([]);
  });

  it("still creates a travel belief when the matching arrival assertion has gone stale", async () => {
    await storePlanningRun({
      // oxlint-disable-next-line unicorn/no-thenable -- `then` is a domain field of the travel directive, not a promise continuation
      currentDirective: { kind: "travel", title: "Drive to Shed", toLocationId: "shed", then: { targetId: "work-1" } }
    });
    await setLocation("shed", new Date(now.getTime() - 500 * 60_000));
    await runCheckInSchedulerTick(sql, userId, now);
    expect((await pendingCheckIns()).map((row) => row.directive_target_id)).toEqual(["work-1"]);
  });

  it("still creates a travel belief when nowhere has been asserted yet", async () => {
    await storePlanningRun({
      // oxlint-disable-next-line unicorn/no-thenable -- `then` is a domain field of the travel directive, not a promise continuation
      currentDirective: { kind: "travel", title: "Drive to Shed", toLocationId: "shed", then: { targetId: "work-1" } }
    });
    await runCheckInSchedulerTick(sql, userId, now);
    expect((await pendingCheckIns()).map((row) => row.directive_target_id)).toEqual(["work-1"]);
  });

  it("skips a protected_commitment belief once the commitment has been cancelled", async () => {
    const commitmentId = crypto.randomUUID();
    await sql`
      INSERT INTO commitments (id,user_id,title,starts_at,ends_at,status)
      VALUES (${commitmentId},${userId},'Doctor',${new Date(now.getTime() - 10 * 60_000)},${new Date(now.getTime() + 50 * 60_000)},'cancelled')
    `;
    await storePlanningRun({
      currentDirective: { kind: "none", title: "Preparing for Doctor" },
      protectedCommitment: { id: commitmentId, title: "Doctor", phase: "setup" }
    });
    await runCheckInSchedulerTick(sql, userId, now);
    expect(await pendingCheckIns()).toEqual([]);
  });

  it("skips a protected_commitment belief once the commitment has already ended", async () => {
    const commitmentId = crypto.randomUUID();
    await sql`
      INSERT INTO commitments (id,user_id,title,starts_at,ends_at,status)
      VALUES (${commitmentId},${userId},'Doctor',${new Date(now.getTime() - 60 * 60_000)},${new Date(now.getTime() - 5 * 60_000)},'confirmed')
    `;
    await storePlanningRun({
      currentDirective: { kind: "none", title: "Preparing for Doctor" },
      protectedCommitment: { id: commitmentId, title: "Doctor", phase: "setup" }
    });
    await runCheckInSchedulerTick(sql, userId, now);
    expect(await pendingCheckIns()).toEqual([]);
  });

  it("still creates a protected_commitment belief while the commitment is genuinely still live", async () => {
    const commitmentId = crypto.randomUUID();
    await sql`
      INSERT INTO commitments (id,user_id,title,starts_at,ends_at,status)
      VALUES (${commitmentId},${userId},'Doctor',${new Date(now.getTime() - 10 * 60_000)},${new Date(now.getTime() + 50 * 60_000)},'confirmed')
    `;
    await storePlanningRun({
      currentDirective: { kind: "none", title: "Preparing for Doctor" },
      protectedCommitment: { id: commitmentId, title: "Doctor", phase: "setup" }
    });
    await runCheckInSchedulerTick(sql, userId, now);
    expect((await pendingCheckIns()).map((row) => row.directive_target_id)).toEqual([commitmentId]);
  });

  it("still creates an open_anchor belief while the anchor commitment is genuinely still live", async () => {
    const commitmentId = crypto.randomUUID();
    await sql`
      INSERT INTO commitments (id,user_id,title,starts_at,ends_at,status)
      VALUES (${commitmentId},${userId},'On duty',${new Date(now.getTime() - 10 * 60_000)},${new Date(now.getTime() + 50 * 60_000)},'confirmed')
    `;
    await storePlanningRun({
      currentDirective: { kind: "recovery", title: "Take deliberate recovery" },
      openAnchor: { id: commitmentId, title: "On duty", phase: "active" }
    });
    await runCheckInSchedulerTick(sql, userId, now);
    expect((await pendingCheckIns()).map((row) => row.directive_target_id)).toEqual([commitmentId]);
  });
});

describe("runCheckInSchedulerTick — five-minute cooldown after starting, switching, or ending a task", () => {
  it("does not sample a slot when the active session started 2 minutes ago", async () => {
    const projectId = await createProject();
    const actionId = await addAction(projectId, "active");
    await storePlanningRun({ currentDirective: { kind: "action", targetId: actionId, title: "Write chapter" } });
    await createActiveSession(new Date(now.getTime() - 2 * 60_000));
    await runCheckInSchedulerTick(sql, userId, now);
    expect(await pendingCheckIns()).toEqual([]);
  });

  it("samples a slot once the active session started 6 minutes ago", async () => {
    const projectId = await createProject();
    const actionId = await addAction(projectId, "active");
    await storePlanningRun({ currentDirective: { kind: "action", targetId: actionId, title: "Write chapter" } });
    await createActiveSession(new Date(now.getTime() - 6 * 60_000));
    await runCheckInSchedulerTick(sql, userId, now);
    expect((await pendingCheckIns()).map((row) => row.directive_target_id)).toEqual([actionId]);
  });

  it("does not sample a slot when the believed directive changed 3 minutes ago", async () => {
    const projectId = await createProject();
    const oldActionId = await addAction(projectId, "active");
    const newActionId = await addAction(projectId, "active");
    // The row's cadence alone is long since clear (resolved 40 minutes ago); only its belief's own
    // 3-minute-old age should still be gating a fresh slot.
    await insertCheckIn({
      slotAt: new Date(now.getTime() - 3 * 60_000),
      resolvedAt: new Date(now.getTime() - 40 * 60_000),
      directiveKind: "action",
      directiveTargetId: oldActionId
    });
    await storePlanningRun({ currentDirective: { kind: "action", targetId: newActionId, title: "Write chapter 2" } });
    await runCheckInSchedulerTick(sql, userId, now);
    expect(await pendingCheckIns()).toEqual([]);
  });

  it("samples a slot once the believed directive changed 6 minutes ago", async () => {
    const projectId = await createProject();
    const oldActionId = await addAction(projectId, "active");
    const newActionId = await addAction(projectId, "active");
    await insertCheckIn({
      slotAt: new Date(now.getTime() - 6 * 60_000),
      resolvedAt: new Date(now.getTime() - 40 * 60_000),
      directiveKind: "action",
      directiveTargetId: oldActionId
    });
    await storePlanningRun({ currentDirective: { kind: "action", targetId: newActionId, title: "Write chapter 2" } });
    await runCheckInSchedulerTick(sql, userId, now);
    expect((await pendingCheckIns()).map((row) => row.directive_target_id)).toEqual([newActionId]);
  });

  it("defers the next slot to at least 5 minutes after a session that ended 2 minutes ago", async () => {
    const projectId = await createProject();
    const actionId = await addAction(projectId, "active");
    await storePlanningRun({ currentDirective: { kind: "action", targetId: actionId, title: "Write chapter" } });
    await createEndedSession(new Date(now.getTime() - 2 * 60_000));
    await runCheckInSchedulerTick(sql, userId, now);
    expect(await pendingCheckIns()).toEqual([]);
    // And it resumes once the 5 minutes have actually passed.
    await runCheckInSchedulerTick(sql, userId, new Date(now.getTime() + 3 * 60_000));
    expect((await pendingCheckIns()).map((row) => row.directive_target_id)).toEqual([actionId]);
  });

  it("samples a slot once 5 minutes have passed since the session ended", async () => {
    const projectId = await createProject();
    const actionId = await addAction(projectId, "active");
    await storePlanningRun({ currentDirective: { kind: "action", targetId: actionId, title: "Write chapter" } });
    await createEndedSession(new Date(now.getTime() - 6 * 60_000));
    await runCheckInSchedulerTick(sql, userId, now);
    expect((await pendingCheckIns()).map((row) => row.directive_target_id)).toEqual([actionId]);
  });

  it("resumes the jittered cadence at its own later due instant rather than firing the moment an already-passed cooldown clears", async () => {
    const projectId = await createProject();
    const actionId = await addAction(projectId, "active");
    // Resolved only 2 minutes ago (via a prior tick's own timeout), so the ordinary 10-25 minute
    // jittered cadence is not yet due, even though the session-ended cooldown (10 minutes ago) is long
    // clear — the later of the two must still govern.
    await insertCheckIn({
      slotAt: new Date(now.getTime() - 2 * 60_000),
      resolvedAt: new Date(now.getTime() - 2 * 60_000),
      directiveKind: "action",
      directiveTargetId: actionId
    });
    await storePlanningRun({ currentDirective: { kind: "action", targetId: actionId, title: "Write chapter" } });
    await createEndedSession(new Date(now.getTime() - 10 * 60_000));
    await runCheckInSchedulerTick(sql, userId, now);
    expect(await pendingCheckIns()).toEqual([]);
  });
});

/**
 * Hypothesis: `runCheckInSchedulerTick`'s active-session query (~line 327) selects only
 * `target_type, started_at` from `sessions` — never `target_id`/`target_title` — and
 * `deriveBeliefSnapshot` (~line 88) builds the belief purely from the stored `planning_runs` row's
 * `currentDirective`/`protectedCommitment`/`openAnchor`. So when a person is actually running a
 * session against one target while the last-stored plan run still names a different one (the plan
 * hasn't been recalculated since they switched, or picked something the plan never anticipated), the
 * "Still on X?" check-in this scheduler writes should name what is actually running — but nothing in
 * this file ever reads the session's own target to compare against or prefer it. These tests encode
 * the desired behaviour (name the session's target) so they go red if that belief is confirmed, and
 * green if `deriveBeliefSnapshot`/`runCheckInSchedulerTick` already reconcile the two some other way.
 */
describe("hypothesis: belief derivation ignores what the running session is actually on", () => {
  it("names the running session's target, not the stored directive, when they disagree (action)", async () => {
    const projectId = await createProject();
    const storedDirectiveActionId = await addAction(projectId, "active");
    const actuallyRunningActionId = await addAction(projectId, "active");
    await storePlanningRun({
      currentDirective: { kind: "action", targetId: storedDirectiveActionId, title: "Write chapter (stored belief)" }
    });
    // Started 6 minutes ago, clearing the 5-minute post-start cooldown (same as the existing "samples
    // a slot once the active session started 6 minutes ago" case above), but against a different action
    // than the one the stored plan run currently names.
    await createActiveSession(new Date(now.getTime() - 6 * 60_000), {
      targetType: "action",
      targetId: actuallyRunningActionId,
      targetTitle: "Write the OTHER chapter (actually running)"
    });
    await runCheckInSchedulerTick(sql, userId, now);
    const rows = await pendingCheckInDetails();
    expect(rows).toHaveLength(1);
    // Desired: the check-in asks about what the person is actually doing right now.
    expect(rows[0]?.directive_target_id).toBe(actuallyRunningActionId);
    expect(rows[0]?.directive_title).toBe("Write the OTHER chapter (actually running)");
  });

  it("names the running session's target, not the stored protected commitment, when they disagree (fixed_commitment)", async () => {
    const storedCommitmentId = crypto.randomUUID();
    const actuallyRunningCommitmentId = crypto.randomUUID();
    await createCommitment(storedCommitmentId, null, "Doctor (stored belief)");
    await createCommitment(actuallyRunningCommitmentId, null, "Dentist (actually running)");
    // currentDirective is a held 'none' (the ordinary shape while a protected commitment blocks the
    // clock — see deriveBeliefSnapshot's own doc comment), so the belief falls through to
    // protectedCommitment, which still names the *other* commitment.
    await storePlanningRun({
      currentDirective: { kind: "none", title: "Preparing for Doctor" },
      protectedCommitment: { id: storedCommitmentId, title: "Doctor (stored belief)", phase: "setup" }
    });
    await createActiveSession(new Date(now.getTime() - 6 * 60_000), {
      targetType: "fixed_commitment",
      targetId: actuallyRunningCommitmentId,
      targetTitle: "Dentist (actually running)"
    });
    await runCheckInSchedulerTick(sql, userId, now);
    const rows = await pendingCheckInDetails();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.directive_target_id).toBe(actuallyRunningCommitmentId);
    expect(rows[0]?.directive_title).toBe("Dentist (actually running)");
  });

  it("honours the running session's commitment prompt policy, not the stored commitment's", async () => {
    const storedCommitmentId = crypto.randomUUID();
    const actuallyRunningCommitmentId = crypto.randomUUID();
    await createCommitment(storedCommitmentId, null, "Doctor (stored belief)");
    await createCommitment(actuallyRunningCommitmentId, null, "Dentist (silenced)");
    await sql`UPDATE commitments SET prompt_policy='silent' WHERE id=${actuallyRunningCommitmentId}`;
    await storePlanningRun({
      currentDirective: { kind: "none", title: "Preparing for Doctor" },
      protectedCommitment: { id: storedCommitmentId, title: "Doctor (stored belief)", phase: "setup" }
    });
    await createActiveSession(new Date(now.getTime() - 6 * 60_000), {
      targetType: "fixed_commitment",
      targetId: actuallyRunningCommitmentId,
      targetTitle: "Dentist (silenced)"
    });
    await runCheckInSchedulerTick(sql, userId, now);
    expect(await pendingCheckInDetails()).toHaveLength(0);
  });
});

/**
 * The live-updates plumbing (`platform/database/src/planning/state-changed.ts`,
 * `portal/server/events/state-events.ts`) end-to-end at the one layer that can actually prove it: a
 * real `LISTEN` on a real Postgres connection, receiving what a genuine write path — this scheduler's
 * own `check_in` insert — actually raises. Everything else about the NOTIFY payload's exact JSON
 * shape is covered by `state-changed.test.ts`'s unit tests against a fake `sql`.
 */
describe("runCheckInSchedulerTick notifies state_changed", () => {
  let listenSql: postgres.Sql;

  /**
   * `sql.listen(...)` (porsager's own API — see `state-events.ts`'s doc comment) opens its own
   * separate dedicated connection under the hood the *first* time it's called on a given `Sql`
   * instance, distinct from `listenSql` itself; its returned promise is what actually confirms the
   * server has processed the `LISTEN` command on that connection. Writing before that promise
   * settles is exactly the race this helper exists to close: a NOTIFY raised before the listener is
   * subscribed is simply never delivered.
   */
  function subscribe(): { ready: Promise<unknown>; notification: Promise<StateChangedNotification> } {
    let resolveNotification!: (value: StateChangedNotification) => void;
    const notification = new Promise<StateChangedNotification>((resolve) => {
      resolveNotification = resolve;
    });
    const ready = listenSql.listen(STATE_CHANGED_CHANNEL, (payload) =>
      resolveNotification(JSON.parse(payload) as StateChangedNotification)
    );
    return { ready, notification };
  }

  beforeEach(() => {
    listenSql = postgres(testUrl.toString(), { max: 1, connect_timeout: 10, fetch_types: false });
  });

  afterAll(async () => {
    await listenSql?.end({ timeout: 0 });
  });

  it("fires a check_in-kind NOTIFY once a fresh check-in row is created", async () => {
    const commitmentId = crypto.randomUUID();
    await createCommitment(commitmentId, "college");
    const stepId = await addStep(commitmentId, "pending");
    await storeRoutineStepDirective(stepId);

    const { ready, notification } = subscribe();
    await ready;
    await runCheckInSchedulerTick(sql, userId, now);

    await expect(notification).resolves.toMatchObject({ userId, kind: "check_in" });
  });

  it("fires a check_in-kind NOTIFY once a timed-out pending row flips to unknown", async () => {
    const commitmentId = crypto.randomUUID();
    await createCommitment(commitmentId, "college");
    const stepId = await addStep(commitmentId, "pending");
    await storeRoutineStepDirective(stepId);
    await runCheckInSchedulerTick(sql, userId, now);
    expect((await pendingCheckIns()).map((row) => row.directive_target_id)).toEqual([stepId]);

    const { ready, notification } = subscribe();
    await ready;
    const timedOutAt = new Date(now.getTime() + (11 + Math.ceil(Math.random() * 5)) * 60_000);
    await runCheckInSchedulerTick(sql, userId, timedOutAt);

    await expect(notification).resolves.toMatchObject({ userId, kind: "check_in" });
    expect(await pendingCheckIns()).toEqual([]);
  });
});

describe("runCheckInSchedulerTick — agent wake when a check-in times out", () => {
  const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000);

  async function insertPending(createdAt: Date): Promise<string> {
    const rows = await sql<{ id: string }[]>`
      INSERT INTO check_in (user_id,slot_at,created_at,updated_at,directive_kind,directive_target_id,directive_title,status)
      VALUES (${userId},${createdAt.toISOString()}::timestamptz,${createdAt.toISOString()}::timestamptz,${createdAt.toISOString()}::timestamptz,'action',${crypto.randomUUID()},'Write chapter','pending')
      RETURNING id`;
    return rows[0]!.id;
  }

  async function wakes() {
    return sql<{ target_id: string; event: string }[]>`
      SELECT target_id, event FROM agent_wakes WHERE user_id=${userId} ORDER BY created_at`;
  }

  it("queues exactly one wake for the timed-out check-in, even if the tick repeats", async () => {
    const id = await insertPending(minutesAgo(11));
    await runCheckInSchedulerTick(sql, userId, now);
    await runCheckInSchedulerTick(sql, userId, now);
    expect(await wakes()).toEqual([{ target_id: id, event: "check_in_unanswered" }]);
  });

  it("queues nothing while the owner is asleep", async () => {
    await insertPending(minutesAgo(11));
    await storePlanningRun({ currentDirective: { kind: "sleep", title: "Sleep" } });
    await runCheckInSchedulerTick(sql, userId, now);
    expect(await wakes()).toEqual([]);
  });

  it("queues nothing under a silent commitment", async () => {
    await insertPending(minutesAgo(11));
    const commitmentId = crypto.randomUUID();
    await sql`
      INSERT INTO commitments (id,user_id,title,starts_at,ends_at,status,prompt_policy)
      VALUES (${commitmentId},${userId},'Exam',${minutesAgo(10).toISOString()}::timestamptz,${new Date(now.getTime() + 50 * 60_000).toISOString()}::timestamptz,'confirmed','silent')`;
    await storePlanningRun({
      currentDirective: { kind: "none", title: "Exam" },
      protectedCommitment: { id: commitmentId, title: "Exam", phase: "setup" }
    });
    await runCheckInSchedulerTick(sql, userId, now);
    expect(await wakes()).toEqual([]);
  });

  it("queues nothing for a check-in still inside its window", async () => {
    await insertPending(minutesAgo(3));
    await runCheckInSchedulerTick(sql, userId, now);
    expect(await wakes()).toEqual([]);
  });

  it("backs off: a second timeout queues nothing while the previous wake has had no answer since", async () => {
    const first = await insertPending(minutesAgo(30));
    await runCheckInSchedulerTick(sql, userId, now);
    expect((await wakes()).map((w) => w.target_id)).toEqual([first]);
    await insertPending(minutesAgo(11));
    await runCheckInSchedulerTick(sql, userId, now);
    expect((await wakes()).map((w) => w.target_id)).toEqual([first]);
  });

  it("allows a new wake once a check-in was answered after the previous wake", async () => {
    const first = await insertPending(minutesAgo(30));
    await runCheckInSchedulerTick(sql, userId, now);
    await sql`
      INSERT INTO check_in (user_id,slot_at,created_at,updated_at,answered_at,directive_kind,directive_target_id,directive_title,status)
      VALUES (${userId},${minutesAgo(5).toISOString()}::timestamptz,${minutesAgo(20).toISOString()}::timestamptz,${minutesAgo(5).toISOString()}::timestamptz,CURRENT_TIMESTAMP + interval '1 minute','action','x','Write chapter','on_track')`;
    const second = await insertPending(minutesAgo(11));
    await runCheckInSchedulerTick(sql, userId, now);
    expect((await wakes()).map((w) => w.target_id)).toEqual([first, second]);
  });
});
