import { beforeEach, describe, expect, it } from "vitest";
import { processPlanForecastJob } from "@openrhen/database";
import { ensureUser } from "./ensure-user";
import { runActivityCommand } from "./activity-commands";
import { engineToken, engineUrl, setupStateStoreSuite, sql } from "./state-store-harness";

/**
 * Finishing a session tracked against a fixed commitment later than its scheduled
 * `ends_at` left the commitment's after-phase routine steps windowed against the stale scheduled end
 * — so an after step's window could already have closed before the person even stopped the timer.
 *
 * The routine step timing design note ("Placement after a write"): finishing the session no longer
 * reschedules the after-chain inline. `runActivityCommand`'s `finish_activity` branch only records the
 * session's actual end (`trackedEndedAt`, read back by `readers/routine-read.ts` from the finished session) and
 * enqueues a recalculation through the one-write-path (`recordStateChange`); the engine's placer
 * (`engine/core/src/scheduling/routine-placement.ts`) re-anchors the after-chain from the commitment
 * timeline's `effectiveEndsAt` (the later of `endsAt` and `trackedEndedAt`) on that run, and the
 * persist's routine sync mirrors the placed times onto the still-pending rows. These tests drive that
 * whole path — session finish, then draining the real plan-forecast queue against the real engine
 * service, the same way `state-store-harness.ts` does for the other portal integration suites — rather
 * than asserting on an inline write that no longer happens.
 *
 * `sql`/`engineUrl`/`engineToken` and the database/engine bootstrap come from `state-store-harness.ts`
 * (`setupStateStoreSuite`), the one portal file (besides `issue-snapshot-store.integration.test.ts`)
 * `corepack pnpm structure:check` allows to reach across into `engine/service` by relative path — every
 * other portal test that needs the real engine goes through it rather than opening its own.
 */

let userId: string;

setupStateStoreSuite("openrhen_activity_overtime");

/** Drains the plan-forecast queue against the real engine service — the same loop
 *  `state-store-harness.ts`'s own `refreshPlanning` runs, kept local since that export is not the one
 *  this file's commands are proxied through (`withPlanningRefresh` wraps `NormalizedPostgresStateStore`
 *  methods; this file drives `runActivityCommand` directly against raw SQL fixtures instead). */
async function refreshPlanning(): Promise<void> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  for (let index = 0; index < 20; index += 1) {
    const result = await processPlanForecastJob(
      sql,
      { url: engineUrl, token: engineToken, timeoutMs: 10_000 },
      "integration-worker"
    );
    if (result === "idle" || result === "retrying" || result === "failed") return;
  }
  throw new Error("Integration planning queue did not drain.");
}

/** A commitment whose scheduled `ends_at` is already a little in the past, so finishing a session
 *  against it "now" (the command handler's own `new Date()`) always lands after it — deterministic
 *  overtime without depending on real wall-clock delay during the test run. */
async function createOvertimeCommitment(
  transitionAfterMinutes: number
): Promise<{ id: string; startsAt: Date; endsAt: Date }> {
  const id = crypto.randomUUID();
  const startsAt = new Date(Date.now() - 3_600_000);
  const endsAt = new Date(Date.now() - 60_000);
  await sql`
    INSERT INTO commitments (id,user_id,title,starts_at,ends_at,status,transition_after_minutes)
    VALUES (${id},${userId},'Work',${startsAt},${endsAt},'confirmed',${transitionAfterMinutes})
  `;
  return { id, startsAt, endsAt };
}

async function createRoutineStep(args: {
  commitmentId: string;
  phase: "before" | "after";
  status: string;
  sequence: number;
}): Promise<string> {
  const id = crypto.randomUUID();
  await sql`
    INSERT INTO routine_steps (id,user_id,commitment_id,anchor_type,anchor_id,title,duration_minutes,sequence,timing_rule,phase,status,scheduled_start_at,scheduled_end_at)
    VALUES (${id},${userId},${args.commitmentId},'commitment',${args.commitmentId},${"Step " + args.sequence},15,${args.sequence},'contiguous',${args.phase},${args.status},${new Date(0)},${new Date(0)})
  `;
  return id;
}

async function createRunningCommitmentSession(
  commitmentId: string,
  startedAt = new Date(Date.now() - 3_600_000)
): Promise<{ id: string; version: number }> {
  const id = crypto.randomUUID();
  const plannedEnd = new Date(Date.now() + 60_000);
  await sql`
    INSERT INTO sessions (id,user_id,target_type,target_id,target_title,status,planned_started_at,planned_end_at,started_at,planned_minutes,remaining_before_minutes)
    VALUES (${id},${userId},'fixed_commitment',${commitmentId},'Fixture session','running',${startedAt},${plannedEnd},${startedAt},60,0)
  `;
  await sql`INSERT INTO session_segments (session_id,started_at) VALUES (${id},${startedAt})`;
  const rows = await sql<{ version: number }[]>`SELECT version FROM sessions WHERE id=${id}`;
  return { id, version: rows[0]!.version };
}

async function stepRow(
  stepId: string
): Promise<{ scheduled_start_at: Date | null; scheduled_end_at: Date | null; status: string }> {
  const rows = await sql<{ scheduled_start_at: Date | null; scheduled_end_at: Date | null; status: string }[]>`
    SELECT scheduled_start_at,scheduled_end_at,status FROM routine_steps WHERE id=${stepId}
  `;
  return rows[0]!;
}

// `setupStateStoreSuite`'s own `beforeEach` truncates `users` (`RESTART IDENTITY CASCADE`) before every
// test, which cascades to every table carrying a `user_id` foreign key — `commitments`,
// `routine_steps`, `sessions`, `session_segments`, `writes`, `jobs` and `write_rows` among
// them — so a fresh user each time is enough to leave every test with none of the previous one's
// fixtures. Registered after `setupStateStoreSuite`'s own `beforeEach` (called above), so it runs after
// that truncation, not before it.
beforeEach(async () => {
  userId = await ensureUser(sql);
});

describe("finishing an overtime fixed_commitment session re-anchors its after-phase routine steps", () => {
  it("moves a pending after-phase step's window to the actual finish time plus the transition buffer, once the recalculation runs", async () => {
    const commitment = await createOvertimeCommitment(20);
    const afterStepId = await createRoutineStep({
      commitmentId: commitment.id,
      phase: "after",
      status: "pending",
      sequence: 0
    });
    const session = await createRunningCommitmentSession(commitment.id);
    await runActivityCommand(sql, {
      commandId: crypto.randomUUID(),
      expectedVersion: session.version,
      type: "finish_activity",
      sessionId: session.id,
      outcome: "completed"
    });
    const sessionRows = await sql<{ ended_at: Date }[]>`SELECT ended_at FROM sessions WHERE id=${session.id}`;
    const endedAt = sessionRows[0]!.ended_at;
    expect(endedAt.getTime()).toBeGreaterThan(commitment.endsAt.getTime());
    // Not moved inline by the command itself.
    const beforeRecalculation = await stepRow(afterStepId);
    expect(beforeRecalculation.scheduled_start_at?.getTime()).toBe(new Date(0).getTime());
    await refreshPlanning();
    const step = await stepRow(afterStepId);
    expect(step.scheduled_start_at?.getTime()).toBe(endedAt.getTime() + 20 * 60_000);
    expect(step.scheduled_end_at?.getTime()).toBe(endedAt.getTime() + 35 * 60_000);
    // The commitment's own scheduling facts never move for an ordinary finish — only the routine steps do.
    const commitmentRows = await sql<{ ends_at: Date }[]>`SELECT ends_at FROM commitments WHERE id=${commitment.id}`;
    expect(commitmentRows[0]!.ends_at.getTime()).toBe(commitment.endsAt.getTime());
  });

  it("does not count a session begun after the scheduled end (the transition being tracked) as overtime", async () => {
    const commitment = await createOvertimeCommitment(20);
    const afterStepId = await createRoutineStep({
      commitmentId: commitment.id,
      phase: "after",
      status: "pending",
      sequence: 0
    });
    const session = await createRunningCommitmentSession(commitment.id, new Date(commitment.endsAt.getTime() + 10_000));
    await runActivityCommand(sql, {
      commandId: crypto.randomUUID(),
      expectedVersion: session.version,
      type: "finish_activity",
      sessionId: session.id,
      outcome: "completed"
    });
    await refreshPlanning();
    const step = await stepRow(afterStepId);
    expect(step.scheduled_start_at?.getTime()).toBe(commitment.endsAt.getTime() + 20 * 60_000);
  });

  it("leaves a pending before-phase step's window untouched by the same overtime finish", async () => {
    const commitment = await createOvertimeCommitment(20);
    const beforeStepId = await createRoutineStep({
      commitmentId: commitment.id,
      phase: "before",
      status: "pending",
      sequence: 0
    });
    const session = await createRunningCommitmentSession(commitment.id);
    await runActivityCommand(sql, {
      commandId: crypto.randomUUID(),
      expectedVersion: session.version,
      type: "finish_activity",
      sessionId: session.id,
      outcome: "completed"
    });
    await refreshPlanning();
    const after = await stepRow(beforeStepId);
    // The before-chain anchors on the commitment's own `setupStartsAt` (here, with no setup buffer,
    // its own `startsAt`), never on the tracked end — so this step's placement, even though this
    // recalculation is the first ever to reach this fixture's raw-inserted row (the fixture's epoch
    // sentinel is not itself a placement to stay "untouched" from — this plan's placer is the only
    // author of a pending step's placement, and a freshly-created row is unplaced until it runs), is
    // exactly the same latest-start-backward-from-startsAt slot an overtime finish must never move.
    expect(after.scheduled_start_at?.getTime()).toBe(commitment.startsAt.getTime() - 15 * 60_000);
    expect(after.scheduled_end_at?.getTime()).toBe(commitment.startsAt.getTime());
  });

  it("leaves an already-completed after-phase step's window untouched (status lock preserved)", async () => {
    const commitment = await createOvertimeCommitment(20);
    const doneStepId = await createRoutineStep({
      commitmentId: commitment.id,
      phase: "after",
      status: "completed",
      sequence: 0
    });
    const before = await stepRow(doneStepId);
    const session = await createRunningCommitmentSession(commitment.id);
    await runActivityCommand(sql, {
      commandId: crypto.randomUUID(),
      expectedVersion: session.version,
      type: "finish_activity",
      sessionId: session.id,
      outcome: "completed"
    });
    await refreshPlanning();
    const after = await stepRow(doneStepId);
    expect(after.scheduled_start_at?.getTime()).toBe(before.scheduled_start_at?.getTime());
    expect(after.scheduled_end_at?.getTime()).toBe(before.scheduled_end_at?.getTime());
    expect(after.status).toBe("completed");
  });

  it("is a no-op on the after step's window when the session finishes before the scheduled end", async () => {
    const id = crypto.randomUUID();
    const startsAt = new Date(Date.now() - 3_600_000);
    const endsAt = new Date(Date.now() + 3_600_000); // ends an hour from now: this finish is not overtime.
    await sql`
      INSERT INTO commitments (id,user_id,title,starts_at,ends_at,status,transition_after_minutes)
      VALUES (${id},${userId},'Work',${startsAt},${endsAt},'confirmed',20)
    `;
    const afterStepId = await createRoutineStep({ commitmentId: id, phase: "after", status: "pending", sequence: 0 });
    const session = await createRunningCommitmentSession(id);
    await runActivityCommand(sql, {
      commandId: crypto.randomUUID(),
      expectedVersion: session.version,
      type: "finish_activity",
      sessionId: session.id,
      outcome: "completed"
    });
    await refreshPlanning();
    const step = await stepRow(afterStepId);
    // Anchored to the scheduled endsAt + transition, exactly as the recalculation's ordinary
    // (non-overtime) placement produces — not to the (earlier) actual finish time.
    expect(step.scheduled_start_at?.getTime()).toBe(endsAt.getTime() + 20 * 60_000);
    expect(step.scheduled_end_at?.getTime()).toBe(endsAt.getTime() + 35 * 60_000);
  });
});
