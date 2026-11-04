import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import {
  buildPlanForecastRequest,
  enqueuePlanForecastJob,
  processPlanForecastJob,
  recoverAbandonedPlanForecastJobs
} from "@openrhen/database";
import { createSeedState, type PortalState } from "@/state/portal-state";
import { HISTORY_WINDOW_DAYS } from "@/shared/history-window";
import { ensureUser } from "./ensure-user";
import { recalculate } from "./planning-evidence";
import { readPlanningStatus, readPortalState } from "./state-read";
import { replaceState } from "./state-replace";
import {
  daytimeSeed,
  engineToken,
  engineUrl,
  fixedNow,
  refreshPlanning,
  setupStateStoreSuite,
  sql,
  store
} from "./state-store-harness";

/**
 * State-store journeys, part 12 of 12.
 *
 * One 6,800-line file until 2026-09-10, when it was the integration gate's wall clock: about ten
 * minutes of a fourteen-minute run, so every other file finished long before it and their workers
 * idled. The tests are unchanged and still run in the order they were written; only the file they
 * live in changed. The fixture they share is `./state-store-harness`, and the base name below is
 * what gives this file its own database — no two of these files may share one, or they would
 * truncate each other in `beforeEach`.
 *
 * Split again on 2026-10-30, from four files into twelve, for the same reason: two of the four were
 * the gate's wall clock at about 130 seconds each, and vitest parallelises by file only.
 */

setupStateStoreSuite("openrhen_state_store_l");

describe("normalized PostgreSQL portal persistence (part 12)", () => {
  it("rejects a hand-supplied scheduledStartAt on an inherited routine step, but keeps accepting an unchanged round-trip and a custom routine's own edit", async () => {
    // Guard for the CLI reviewer's report: `save routine-step` always re-sends the stored record's own
    // `scheduledStartAt` back (the CLI merges the existing row under `--set`), so the guard must only
    // reject an actual attempted change, not the routine round-trip — and it must apply only to
    // inherit/preset commitments, whose step schedule is the engine's placer to compute, not the
    // caller's.
    const now = new Date();
    await store.put(createSeedState(now));
    let state = (await store.get())!;
    const presetId = crypto.randomUUID();
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      type: "save_entity",
      entityType: "routine_preset",
      entity: {
        id: presetId,
        name: "Court kit",
        activityName: "Tennis",
        status: "active",
        steps: [
          {
            id: "racquet",
            title: "Find racquet",
            durationMinutes: 10,
            sequence: 0,
            timingRule: "contiguous",
            energy: "low",
            contexts: ["home"],
            dependencyIds: []
          }
        ]
      }
    });
    const preset = state.routinePresets.find((item) => item.name === "Court kit")!;
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      type: "save_entity",
      entityType: "condition_definition",
      entity: {
        id: "court",
        name: "Court",
        kind: "location",
        latitude: -36.1,
        longitude: 146.9,
        defaultRoutinePresetId: preset.id
      }
    });
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      type: "save_entity",
      entityType: "commitment",
      entity: {
        id: crypto.randomUUID(),
        title: "Tennis",
        startsAt: new Date(now.getTime() + 26 * 60 * 60_000).toISOString(),
        endsAt: new Date(now.getTime() + 27 * 60 * 60_000).toISOString(),
        status: "confirmed",
        locationId: "court",
        setupBeforeMinutes: 0,
        transitionAfterMinutes: 0
      }
    });
    const commitment = state.commitments.find((item) => item.title === "Tennis")!;
    expect(commitment.routineSource).toBe("inherit");
    const step = state.routineSteps.find((item) => item.commitmentId === commitment.id)!;
    expect(step.title).toBe("Find racquet");
    expect(step.scheduledStartAt).toBeDefined();

    const entityOf = (item: typeof step) => ({
      id: item.id,
      commitmentId: item.commitmentId,
      title: item.title,
      durationMinutes: item.durationMinutes,
      sequence: item.sequence,
      timingRule: item.timingRule,
      energy: item.energy,
      contexts: item.contexts,
      phase: item.phase,
      status: item.status,
      scheduledStartAt: item.scheduledStartAt,
      scheduledEndAt: item.scheduledEndAt
    });

    // An actual attempted change is rejected, naming why and what to do instead.
    await expect(
      store.saveEntity({
        commandId: crypto.randomUUID(),
        expectedVersion: step.version ?? null,
        type: "save_entity",
        entityType: "routine_step",
        entity: {
          ...entityOf(step),
          scheduledStartAt: new Date(new Date(step.scheduledStartAt!).getTime() - 5 * 60000).toISOString()
        }
      })
    ).rejects.toThrow("derived from the commitment");

    // The exact stored record round-tripping unchanged (the CLI's own merge-over-stored shape for an
    // otherwise no-op save) still saves cleanly, and — being a true no-op — does not detach the
    // commitment from its inherited routine either.
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: step.version ?? null,
      type: "save_entity",
      entityType: "routine_step",
      entity: entityOf(step)
    });
    const resaved = state.routineSteps.find((item) => item.id === step.id)!;
    expect(resaved.title).toBe("Find racquet");
    expect(state.commitments.find((item) => item.id === commitment.id)?.routineSource).toBe("inherit");

    // Detached to a custom routine: the same explicit-time edit is no longer rejected (a custom
    // commitment's steps are never placed by the engine — this only checks that saving does not throw).
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: commitment.version ?? null,
      type: "save_entity",
      entityType: "commitment",
      entity: {
        id: commitment.id,
        title: commitment.title,
        startsAt: commitment.startsAt,
        endsAt: commitment.endsAt,
        status: commitment.status,
        setupBeforeMinutes: commitment.setupBeforeMinutes,
        transitionAfterMinutes: commitment.transitionAfterMinutes,
        locationId: commitment.locationId,
        routineSource: "custom"
      }
    });
    const customStep = state.routineSteps.find((item) => item.id === step.id)!;
    await expect(
      store.saveEntity({
        commandId: crypto.randomUUID(),
        expectedVersion: customStep.version ?? null,
        type: "save_entity",
        entityType: "routine_step",
        entity: {
          ...entityOf(customStep),
          scheduledStartAt: new Date(new Date(customStep.scheduledStartAt!).getTime() - 5 * 60000).toISOString()
        }
      })
    ).resolves.toBeDefined();
  }, 60_000);

  it("starts and finishes a time-tracking session against a fixed commitment without changing its own status", async () => {
    const now = new Date();
    await store.put(createSeedState(now));
    let state = (await store.get())!;
    const project = state.projects[0]!;
    let commitment = state.commitments[0]!;
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: commitment.version ?? null,
      type: "save_entity",
      entityType: "commitment",
      entity: {
        ...commitment,
        startsAt: new Date(now.getTime() - 5 * 60000).toISOString(),
        endsAt: new Date(now.getTime() + 55 * 60000).toISOString(),
        projectId: project.id
      }
    });
    commitment = state.commitments.find((item) => item.id === commitment.id)!;
    expect(commitment.projectId).toBe(project.id);
    state = await store.runActivityCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: commitment.version ?? null,
      type: "start_activity",
      targetType: "fixed_commitment",
      targetId: commitment.id,
      phase: "active",
      plannedMinutes: 55
    });
    expect(state.activeSession).toMatchObject({ targetType: "fixed_commitment", targetTitle: commitment.title });
    state = await store.runActivityCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: state.activeSession?.version ?? null,
      type: "finish_activity",
      sessionId: state.activeSession!.id,
      outcome: "completed"
    });
    expect(state.activeSession).toBeNull();
    expect(state.completedToday.at(-1)).toMatchObject({ targetType: "fixed_commitment", result: "completed" });
    expect(state.commitments.find((item) => item.id === commitment.id)?.status).toBe("confirmed");
  }, 30_000);

  it("keeps an overrunning commitment session pausable instead of parking it in feedback", async () => {
    const now = new Date();
    await store.put(createSeedState(now));
    let state = (await store.get())!;
    let commitment = state.commitments[0]!;
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: commitment.version ?? null,
      type: "save_entity",
      entityType: "commitment",
      entity: {
        ...commitment,
        startsAt: new Date(now.getTime() - 5 * 60000).toISOString(),
        endsAt: new Date(now.getTime() + 55 * 60000).toISOString()
      }
    });
    commitment = state.commitments.find((item) => item.id === commitment.id)!;
    state = await store.runActivityCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: commitment.version ?? null,
      type: "start_activity",
      targetType: "fixed_commitment",
      targetId: commitment.id,
      phase: "active",
      plannedMinutes: 55
    });
    const session = state.activeSession!;
    // Drive the clock past the planned end rather than waiting it out — this is the "plus time" the
    // Now page shows as a counting-up remainder.
    await sql`UPDATE sessions SET planned_end_at=${new Date(Date.now() - 60_000)} WHERE id=${session.id}`;
    // An activity has no feedback surface, so nothing may push it out of `running`.
    await expect(
      store.runSessionCommand({
        commandId: crypto.randomUUID(),
        expectedVersion: session.version ?? null,
        type: "request_feedback",
        sessionId: session.id
      })
    ).rejects.toThrow("action and deliverable sessions");
    expect((await store.get())?.activeSession?.status).toBe("running");
    const paused = await store.runActivityCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: session.version ?? null,
      type: "pause_activity",
      sessionId: session.id
    });
    expect(paused.activeSession?.status).toBe("paused");
    const resumed = await store.runActivityCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: paused.activeSession?.version ?? null,
      type: "resume_activity",
      sessionId: session.id
    });
    expect(resumed.activeSession?.status).toBe("running");
  }, 30_000);

  it("schedules a before-step backward and an after-step forward from the same commitment", async () => {
    await store.put(createSeedState(fixedNow));
    let state = (await store.get())!;
    let commitment = state.commitments[0]!;
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: commitment.version ?? null,
      type: "save_entity",
      entityType: "commitment",
      entity: { ...commitment, setupBeforeMinutes: 10 }
    });
    commitment = state.commitments[0]!;
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      type: "save_entity",
      entityType: "routine_step",
      entity: {
        id: crypto.randomUUID(),
        commitmentId: commitment.id,
        title: "Get ready",
        durationMinutes: 20,
        sequence: 0,
        timingRule: "contiguous",
        energy: "low",
        contexts: ["home"],
        phase: "before",
        status: "pending"
      }
    });
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      type: "save_entity",
      entityType: "routine_step",
      entity: {
        id: crypto.randomUUID(),
        commitmentId: commitment.id,
        title: "Debrief",
        durationMinutes: 15,
        sequence: 1,
        timingRule: "contiguous",
        energy: "low",
        contexts: ["home"],
        phase: "after",
        status: "pending"
      }
    });
    const before = state.routineSteps.find((item) => item.title === "Get ready")!;
    const after = state.routineSteps.find((item) => item.title === "Debrief")!;
    const setupStartsAt = new Date(new Date(commitment.startsAt).getTime() - 10 * 60000).toISOString();
    const beforeStartsAt = new Date(new Date(commitment.startsAt).getTime() - 30 * 60000).toISOString();
    expect(before.scheduledEndAt).toBe(setupStartsAt);
    expect(before.scheduledStartAt).toBe(beforeStartsAt);
    // The seed commitment carries a 10-minute transitionAfterMinutes; the after-step chains from
    // beyond it (endsAt + transition), not from endsAt itself — the transition always counts, even
    // with no return leg (the bug this test used to encode as expected behaviour).
    const afterStartsAt = new Date(new Date(commitment.endsAt).getTime() + 10 * 60000).toISOString();
    const afterEndsAt = new Date(new Date(commitment.endsAt).getTime() + 10 * 60000 + 15 * 60000).toISOString();
    expect(after.scheduledStartAt).toBe(afterStartsAt);
    expect(after.scheduledEndAt).toBe(afterEndsAt);
  });

  it("round-trips routine graphs and blocks a dependent step until prerequisites finish", async () => {
    await store.put(createSeedState(fixedNow));
    let state = (await store.get())!;
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      type: "save_entity",
      entityType: "routine_preset",
      entity: {
        id: "campus-routine",
        name: "Campus routine",
        activityName: "Attend class",
        status: "active",
        steps: [
          {
            id: "pack",
            title: "Pack bag",
            durationMinutes: 10,
            sequence: 0,
            timingRule: "flexible",
            maxLeadMinutes: 120,
            energy: "low",
            contexts: ["home"],
            dependencyIds: []
          },
          {
            id: "drive",
            title: "Drive",
            durationMinutes: 25,
            sequence: 1,
            timingRule: "contiguous",
            energy: "medium",
            contexts: ["car"],
            dependencyIds: ["pack"]
          }
        ]
      }
    });
    const preset = state.routinePresets.find((item) => item.name === "Campus routine")!;
    expect(preset.activityName).toBe("Attend class");
    expect(preset.steps[1]?.dependencyIds).toEqual([preset.steps[0]?.id]);
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: preset.version ?? null,
      type: "save_entity",
      entityType: "routine_preset",
      entity: { ...preset, activityName: "Attend morning class" }
    });
    expect(state.routinePresets.find((item) => item.id === preset.id)?.activityName).toBe("Attend morning class");
    await expect(
      store.saveEntity({
        commandId: crypto.randomUUID(),
        expectedVersion: null,
        type: "save_entity",
        entityType: "routine_preset",
        entity: { ...preset, id: crypto.randomUUID(), version: undefined }
      })
    ).rejects.toThrow("already exists");
    const commitment = state.commitments[0]!;
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      type: "save_entity",
      entityType: "routine_step",
      entity: {
        id: "prerequisite",
        commitmentId: commitment.id,
        title: "Pack bag",
        durationMinutes: 10,
        sequence: 0,
        timingRule: "contiguous",
        energy: "low",
        contexts: ["home"],
        dependencyIds: [],
        status: "pending"
      }
    });
    const prerequisite = state.routineSteps.find((item) => item.title === "Pack bag")!;
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      type: "save_entity",
      entityType: "routine_step",
      entity: {
        id: "dependent",
        commitmentId: commitment.id,
        title: "Drive",
        durationMinutes: 25,
        sequence: 1,
        timingRule: "contiguous",
        energy: "medium",
        contexts: ["car"],
        dependencyIds: [prerequisite.id],
        status: "pending"
      }
    });
    const dependent = state.routineSteps.find((item) => item.title === "Drive")!;
    expect(dependent.dependencyIds).toEqual([prerequisite.id]);
    await expect(
      store.runActivityCommand({
        commandId: crypto.randomUUID(),
        expectedVersion: dependent.version ?? null,
        type: "start_activity",
        targetType: "routine_step",
        targetId: dependent.id,
        plannedMinutes: dependent.durationMinutes
      })
    ).rejects.toThrow(/Complete/);
  });

  it("persists live energy and current contexts", async () => {
    await store.put(createSeedState(fixedNow));
    let state = (await store.get())!;
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: state.settings.version ?? null,
      type: "save_entity",
      entityType: "current_availability",
      entity: { currentEnergy: "low", assertedConditions: ["home"] }
    });
    expect(state.currentEnergy).toBe("low");
    expect(state.assertedConditions).toEqual(["home"]);
  });

  it("dates a recalculation from the server's clock, not the browser's", async () => {
    await store.put(createSeedState(fixedNow));
    const before = Date.now();
    // A browser whose clock runs an hour behind.
    const skewed = new Date(before - 60 * 60_000).toISOString();
    await store.recalculate({ commandId: crypto.randomUUID(), type: "recalculate", now: skewed });
    const [job] = await sql<{ captured: string; calculated: string }[]>`
      SELECT payload->>'stateCapturedAt' AS captured, payload->'request'->>'calculatedAt' AS calculated FROM jobs
      WHERE type='plan_forecast.recalculate.v1' AND payload->>'cause'<>'validity_boundary'
      ORDER BY created_at DESC LIMIT 1
    `;
    expect(job).toBeDefined();
    expect(new Date(job!.captured).getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(new Date(job!.calculated).getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  it("dates a recalculation from when its transaction opens, not from before it waited for a connection", async () => {
    await store.put(createSeedState(fixedNow));
    const before = Date.now();
    // A pool that makes the command wait before `begin` hands it a connection, as a busy one does. The
    // wait starts only once the command's own receipt lookup has run, so `ensureUser`'s earlier
    // transaction is not delayed instead.
    let armed = false;
    const slowPool = new Proxy(sql, {
      apply(target, thisArg, args) {
        const strings = args[0] as TemplateStringsArray | undefined;
        if (strings?.join("?").includes("FROM writes")) armed = true;
        return Reflect.apply(target, thisArg, args);
      },
      get(target, property, receiver) {
        if (property !== "begin") return Reflect.get(target, property, receiver);
        return async (...args: unknown[]) => {
          if (armed) await new Promise((done) => setTimeout(done, 400));
          return (target.begin as (...rest: unknown[]) => Promise<unknown>)(...args);
        };
      }
    });
    await recalculate(slowPool, { commandId: crypto.randomUUID(), type: "recalculate", now: new Date().toISOString() });
    const [job] = await sql<{ captured: string; calculated: string }[]>`
      SELECT payload->>'stateCapturedAt' AS captured, payload->'request'->>'calculatedAt' AS calculated FROM jobs
      WHERE type='plan_forecast.recalculate.v1' AND payload->>'cause'<>'validity_boundary'
      ORDER BY created_at DESC LIMIT 1
    `;
    expect(new Date(job!.captured).getTime()).toBeGreaterThanOrEqual(before + 300);
    expect(new Date(job!.calculated).getTime()).toBeGreaterThanOrEqual(before + 300);
  });

  it("runs the chained validity-boundary refresh instead of superseding it", async () => {
    await store.put(createSeedState(fixedNow));
    await store.recalculate({ commandId: crypto.randomUUID(), type: "recalculate", now: new Date().toISOString() });
    const [boundary] = await sql<{ id: string; captured: string }[]>`
      SELECT id, payload->>'stateCapturedAt' AS captured FROM jobs
      WHERE type='plan_forecast.recalculate.v1' AND payload->>'cause'='validity_boundary'
      ORDER BY created_at DESC LIMIT 1
    `;
    expect(boundary).toBeDefined();
    // The originating command writes its audit row after the snapshot timestamp. Dating the chained
    // job from that snapshot made every boundary job supersede itself and the plan never refreshed.
    const [audit] = await sql<
      { newer: boolean }[]
    >`SELECT EXISTS(SELECT 1 FROM write_rows WHERE created_at>${new Date(boundary!.captured)}) AS newer`;
    expect(audit!.newer).toBe(false);
    await sql`UPDATE jobs SET available_at=CURRENT_TIMESTAMP WHERE id=${boundary!.id}`;
    const reported: { outcome: string; durationMs: number }[] = [];
    const outcome = await processPlanForecastJob(
      sql,
      { url: engineUrl, token: engineToken, timeoutMs: 10_000 },
      "integration-worker",
      boundary!.id,
      (record) => reported.push(record)
    );
    expect(outcome).toBe("completed");
    // Finishing clears `locked_at`, so the elapsed time has to be written down as the job ends or it
    // is lost. The worker logs the same number it stores.
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({ outcome: "completed" });
    expect(reported[0]!.durationMs).toBeGreaterThanOrEqual(0);
    const [recorded] = await sql<{ duration_ms: number | null }[]>`
      SELECT duration_ms FROM jobs WHERE id=${boundary!.id}
    `;
    expect(recorded!.duration_ms).toBe(reported[0]!.durationMs);
    // Completing chained exactly one new boundary job, and nothing else is left waiting for one.
    const waiting = await sql<{ id: string }[]>`
      SELECT id FROM jobs WHERE type='plan_forecast.recalculate.v1'
        AND payload->>'cause'='validity_boundary' AND status IN ('pending','retrying')
    `;
    expect(waiting).toHaveLength(1);
  }, 30_000);

  it("keeps retrying, and says so with the engine error, when the service is unreachable", async () => {
    await store.put(createSeedState(fixedNow));
    const current = (await store.get())!;
    const [user] = await sql<{ id: string }[]>`SELECT id FROM users LIMIT 1`;
    const request = await buildPlanForecastRequest(current, new Date());
    const jobId = await enqueuePlanForecastJob(sql, user!.id, request, "planning_state_changed");
    // Past the whole retry schedule: an engine that cannot answer never exhausts the job, so even the
    // attempt that would have been terminal for any other failure only schedules the next one.
    await sql`UPDATE jobs SET attempts=5 WHERE id=${jobId}`;
    const outcome = await processPlanForecastJob(
      sql,
      { url: "http://127.0.0.1:9", token: engineToken, timeoutMs: 1_000 },
      "integration-worker",
      jobId
    );
    expect(outcome).toBe("retrying");
    const [job] = await sql<{ status: string; last_error_code: string | null }[]>`
      SELECT status,last_error_code FROM jobs WHERE id=${jobId}
    `;
    expect(job).toEqual({ status: "retrying", last_error_code: "plan_forecast_unavailable" });
    await sql`UPDATE planning_runs SET valid_until=CURRENT_TIMESTAMP-INTERVAL '1 hour'`;
    const degraded = (await store.get())!;
    // Not "failed": the job is still queued and will run again once the engine is back.
    expect(degraded.planning?.status).not.toBe("failed");
    expect(degraded.planning?.message).toMatch(/unreachable/);
    const status = await readPlanningStatus(sql);
    expect(status.latestJobFailed).toBe(false);
    expect(status.openJob?.status).toBe("retrying");
  }, 30_000);

  it("reports a failed calculation with the engine error when the engine rejects the request", async () => {
    await store.put(createSeedState(fixedNow));
    const current = (await store.get())!;
    const [user] = await sql<{ id: string }[]>`SELECT id FROM users LIMIT 1`;
    const request = await buildPlanForecastRequest(current, new Date());
    const jobId = await enqueuePlanForecastJob(sql, user!.id, request, "planning_state_changed");
    const rejecting = createServer((_request, response) => {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "invalid_request", message: "x" } }));
    });
    await new Promise<void>((done) => rejecting.listen(0, "127.0.0.1", done));
    try {
      const { port } = rejecting.address() as AddressInfo;
      const outcome = await processPlanForecastJob(
        sql,
        { url: `http://127.0.0.1:${port}`, token: engineToken, timeoutMs: 1_000 },
        "integration-worker",
        jobId
      );
      expect(outcome).toBe("failed");
    } finally {
      await new Promise<void>((done) => rejecting.close(() => done()));
    }
    await sql`UPDATE planning_runs SET valid_until=CURRENT_TIMESTAMP-INTERVAL '1 hour'`;
    const degraded = (await store.get())!;
    expect(degraded.planning?.status).toBe("failed");
    expect(degraded.planning?.message).toBeTruthy();
    const status = await readPlanningStatus(sql);
    expect(status).toMatchObject({ latestJobFailed: true, lastErrorCode: "plan_forecast_rejected" });
  }, 30_000);

  it("reports a pending update from the newest open job, not the oldest queue entry", async () => {
    await store.put(createSeedState(fixedNow));
    await refreshPlanning();
    const [user] = await sql<{ id: string }[]>`SELECT id FROM users LIMIT 1`;
    const [run] = await sql<{ calculated_at: Date }[]>`
      SELECT calculated_at FROM planning_runs WHERE superseded_at IS NULL ORDER BY calculated_at DESC LIMIT 1
    `;
    await sql`DELETE FROM jobs WHERE type='plan_forecast.recalculate.v1' AND status IN ('pending','running','retrying')`;
    const insertOpen = (key: string, status: string, availableAt: Date, capturedAt: Date) => sql`
      INSERT INTO jobs (type,payload,idempotency_key,status,available_at)
      VALUES ('plan_forecast.recalculate.v1',
        ${sql.json({ userId: user!.id, cause: "planning_state_changed", stateCapturedAt: capturedAt.toISOString(), request: { inputVersion: key } } as never)},
        ${key},${status},${availableAt})
    `;
    // Worker 1 is still on an old job whose snapshot the current run already covers; it is the oldest
    // queue entry. Worker 2 published the run; a newer job, on state the run has not seen, is due.
    await insertOpen("old-running", "running", new Date(0), new Date(run!.calculated_at.getTime() - 10 * 60_000));
    expect((await readPlanningStatus(sql)).awaitingRecalculation).toBe(false);
    await insertOpen("newer-due", "pending", new Date(1000), new Date(run!.calculated_at.getTime() + 5 * 60_000));
    const status = await readPlanningStatus(sql);
    expect(status.awaitingRecalculation).toBe(true);
    // The oldest entry still describes what is next in the queue.
    expect(status.openJob?.status).toBe("running");
    expect((await store.get())!.planning?.awaitingRecalculation).toBe(true);
  }, 30_000);

  it("revives a permanently failed job when the worker restarts", async () => {
    await store.put(createSeedState(fixedNow));
    const current = (await store.get())!;
    const [user] = await sql<{ id: string }[]>`SELECT id FROM users LIMIT 1`;
    const request = await buildPlanForecastRequest(current, new Date());
    const jobId = await enqueuePlanForecastJob(sql, user!.id, request, "planning_state_changed");
    await sql`UPDATE jobs SET status='failed',attempts=6,failed_at=CURRENT_TIMESTAMP,last_error_code='plan_forecast_unavailable' WHERE id=${jobId}`;
    // Older queued work must not keep the failure buried; drop it so this is the latest job.
    await sql`DELETE FROM jobs WHERE type='plan_forecast.recalculate.v1' AND id<>${jobId}`;
    await recoverAbandonedPlanForecastJobs(sql);
    const [revived] = await sql<
      { status: string; attempts: number }[]
    >`SELECT status,attempts FROM jobs WHERE id=${jobId}`;
    expect(revived).toMatchObject({ status: "retrying", attempts: 0 });
    const outcome = await processPlanForecastJob(
      sql,
      { url: engineUrl, token: engineToken, timeoutMs: 10_000 },
      "integration-worker",
      jobId
    );
    expect(outcome).toBe("completed");
  }, 30_000);

  it("leaves a closed session outside the history window untouched by a GET→PUT round trip", async () => {
    // `readPortalState` only ever hands back sessions inside HISTORY_WINDOW_DAYS (plus whatever is
    // still active) — see `portal/shared/history-window.ts`. Before `replaceState` scoped its delete
    // to the same boundary, it deleted every session for the user unconditionally, so a plain
    // GET→PUT round trip silently erased every closed session the bounded document never carried.
    //
    // This drives `readPortalState`/`replaceState` directly rather than through
    // `NormalizedPostgresStateStore.put`, which wraps the write in a transaction and re-reads state
    // inside it — unrelated to this fix, and not what this test is about.
    const now = new Date();
    const userId = await ensureUser(sql);
    await replaceState(sql, userId, daytimeSeed(now));
    // `replaceState` only reinserts a `completedToday` entry it can attach to an action already in the
    // document (falling back to a title match), so the in-window fixture below needs a real action id
    // — not a bare `action_id` — to survive its own round trip.
    const seededActionId = (await readPortalState(sql))!.actions[0]!.id;
    const oldEndedAt = new Date(now.getTime() - (HISTORY_WINDOW_DAYS + 10) * 24 * 60 * 60_000);
    const oldSessionId = crypto.randomUUID();
    await sql`
      INSERT INTO sessions (id, user_id, action_id, status, planned_started_at, planned_end_at, started_at, ended_at, planned_minutes, remaining_before_minutes, result_note)
      VALUES (${oldSessionId}, ${userId}, ${seededActionId}, 'completed', ${oldEndedAt}, ${oldEndedAt}, ${oldEndedAt}, ${oldEndedAt}, 30, 0, 'outside the history window')
    `;
    const recentEndedAt = new Date(now.getTime() - 5 * 24 * 60 * 60_000);
    const recentSessionId = crypto.randomUUID();
    await sql`
      INSERT INTO sessions (id, user_id, action_id, status, planned_started_at, planned_end_at, started_at, ended_at, planned_minutes, remaining_before_minutes, result_note)
      VALUES (${recentSessionId}, ${userId}, ${seededActionId}, 'completed', ${recentEndedAt}, ${recentEndedAt}, ${recentEndedAt}, ${recentEndedAt}, 20, 0, 'inside the history window')
    `;

    const beforePut = (await readPortalState(sql))!;
    // Read-side confirmation that the fixture is set up the way `24a5861` intends: the bounded read
    // never surfaces the old row, and does surface the recent one.
    expect(beforePut.completedToday.some((item) => item.resultNote === "outside the history window")).toBe(false);
    expect(beforePut.completedToday.some((item) => item.resultNote === "inside the history window")).toBe(true);

    // The round trip this test is really about: GET the (bounded) document, then PUT it straight back,
    // exactly as the whole-state import endpoint does.
    await replaceState(sql, userId, beforePut);

    const oldRow = await sql<{ id: string }[]>`SELECT id FROM sessions WHERE id = ${oldSessionId}`;
    expect(oldRow).toHaveLength(1);

    // The in-window session round-trips too, even though `replaceState` gives it a fresh id derived
    // from the one the document carried rather than reusing the row it deleted.
    const afterPut = (await readPortalState(sql))!;
    expect(afterPut.completedToday.some((item) => item.resultNote === "inside the history window")).toBe(true);
  }, 30_000);

  it("round-trips share_to_calendar/share_source on a whole-state replace (example_shared-publish task 004)", async () => {
    // `state-replace.ts` deletes every `commitments` row for the user and reinserts with a
    // fixed, explicit column list. If that list doesn't carry `share_to_calendar`/`share_source`,
    // every reinsert silently defaults them to false/'inherit', which the (not-yet-built) Example Shared
    // sweep reads as "no longer shared" and deletes every one of the family's calendar events on the
    // next replan. See the publish design note ("Deletion detection").
    const now = new Date();
    const userId = await ensureUser(sql);
    const seed = createSeedState(now) as PortalState & {
      commitments: (PortalState["commitments"][number] & { shareToCalendar?: boolean; shareSource?: string })[];
    };
    seed.commitments[0]!.shareToCalendar = true;
    seed.commitments[0]!.shareSource = "custom";

    await replaceState(sql, userId, seed);

    // `commitment_recurrence_rules` is never deleted or reinserted by `replaceState` (only its
    // `source_id` is cleared) — its own `share_to_calendar` column should survive untouched by
    // construction, but assert it directly rather than assuming it, since a future change to this
    // function could start rewriting the table.
    const [ruleId] = await sql<{ id: string }[]>`
      INSERT INTO commitment_recurrence_rules (
        user_id, title, timezone, start_date, interval_days, local_start_time, local_end_time, share_to_calendar
      ) VALUES (
        ${userId}, 'College class', 'Australia/Sydney', CURRENT_DATE, 7, '09:00', '11:00', true
      ) RETURNING id
    `;

    await replaceState(sql, userId, seed);

    const [commitmentRow] = await sql<
      { share_to_calendar: boolean; share_source: string }[]
    >`SELECT share_to_calendar, share_source FROM commitments WHERE user_id = ${userId} AND title = ${seed.commitments[0]!.title}`;
    expect(commitmentRow).toMatchObject({ share_to_calendar: true, share_source: "custom" });

    const [ruleRow] = await sql<
      { share_to_calendar: boolean }[]
    >`SELECT share_to_calendar FROM commitment_recurrence_rules WHERE id = ${ruleId!.id}`;
    expect(ruleRow).toMatchObject({ share_to_calendar: true });
  }, 30_000);

  // The pulse criteria and publish design note ("Private"): the flag round-trips through save and
  // read for every entity it was added to, and absent on an update leaves the stored value alone.
  it("saves and reads back the private flag on an area, project, action, deliverable and commitment", async () => {
    await store.put(createSeedState(fixedNow));
    let state = (await store.get())!;

    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: state.areas[0]!.version ?? null,
      type: "save_entity",
      entityType: "area",
      entity: { ...state.areas[0]!, private: true }
    });
    expect(state.areas[0]!.private).toBe(true);

    state = await store.saveProject({
      expectedVersion: state.projects[0]!.version ?? null,
      project: {
        id: state.projects[0]!.id,
        outcomeId: state.projects[0]!.outcomeId,
        title: state.projects[0]!.title,
        status: state.projects[0]!.status,
        uncertainty: state.projects[0]!.uncertainty,
        consequence: state.projects[0]!.consequence,
        private: true
      }
    });
    expect(state.projects[0]!.private).toBe(true);

    const action = state.actions[0]!;
    state = await store.saveAction({
      expectedVersion: action.version ?? null,
      action: {
        id: action.id,
        projectId: action.projectId,
        title: action.title,
        status: action.status,
        optimisticMinutes: action.optimisticMinutes,
        expectedMinutes: action.expectedMinutes,
        pessimisticMinutes: action.pessimisticMinutes,
        remainingMinutes: action.remainingMinutes,
        energy: action.energy,
        minimumSessionMinutes: action.minimumSessionMinutes,
        maximumSessionMinutes: action.maximumSessionMinutes,
        splittable: action.splittable,
        setupMinutes: action.setupMinutes,
        importance: action.importance,
        consequence: action.consequence,
        contexts: action.contexts,
        dependencyIds: action.dependencyIds,
        private: true
      }
    });
    expect(state.actions.find((item) => item.id === action.id)?.private).toBe(true);

    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: state.commitments[0]!.version ?? null,
      type: "save_entity",
      entityType: "commitment",
      entity: { ...state.commitments[0]!, private: true }
    });
    expect(state.commitments[0]!.private).toBe(true);

    // A save silent about the flag leaves it untouched (COALESCE), same as every other absence-
    // means-no-opinion field in these writers.
    const { private: _drop, ...withoutPrivate } = state.commitments[0]!;
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: state.commitments[0]!.version ?? null,
      type: "save_entity",
      entityType: "commitment",
      entity: withoutPrivate
    });
    expect(state.commitments[0]!.private).toBe(true);
  });

  // Finding L2: the Now page's Blocked / Waiting button (and the series and cancel-prep restatements)
  // send a partial `save_action`. Absent notes keep the stored ones, `contexts` that only echoes the
  // stored first route keeps every alternative route, and the editor's explicit "" still clears notes.
  it("keeps an action's notes and alternative routes on a partial save, and clears notes only on an explicit empty string", async () => {
    await store.put(createSeedState(fixedNow));
    let state = (await store.get())!;
    const seeded = state.actions[0]!;
    const base = {
      id: seeded.id,
      projectId: seeded.projectId,
      title: seeded.title,
      status: seeded.status,
      optimisticMinutes: seeded.optimisticMinutes,
      expectedMinutes: seeded.expectedMinutes,
      pessimisticMinutes: seeded.pessimisticMinutes,
      remainingMinutes: seeded.remainingMinutes,
      energy: seeded.energy,
      minimumSessionMinutes: seeded.minimumSessionMinutes,
      maximumSessionMinutes: seeded.maximumSessionMinutes,
      splittable: seeded.splittable,
      setupMinutes: seeded.setupMinutes,
      importance: seeded.importance,
      consequence: seeded.consequence,
      dependencyIds: seeded.dependencyIds
    };
    const find = () => state.actions.find((item) => item.id === seeded.id)!;

    state = await store.saveAction({
      expectedVersion: seeded.version ?? null,
      action: {
        ...base,
        contexts: ["home"],
        requirementPathways: [["home"], ["laptop", "quiet"]],
        notes: "Rubric is in the shared folder."
      }
    });
    expect(find().notes).toBe("Rubric is in the shared folder.");
    expect(find().requirementPathways.map((route) => route.contextIds)).toEqual([["home"], ["laptop", "quiet"]]);

    // The Blocked button's old payload: contexts only (the first route), no notes, no pathways.
    state = await store.saveAction({
      expectedVersion: find().version ?? null,
      blockingReason: "waiting_on_someone",
      action: { ...base, status: "waiting", contexts: ["home"] }
    });
    expect(find().status).toBe("waiting");
    expect(find().notes).toBe("Rubric is in the shared folder.");
    expect(find().requirementPathways.map((route) => route.contextIds)).toEqual([["home"], ["laptop", "quiet"]]);

    // A caller that genuinely changes `contexts` still replaces the routes with that one route.
    state = await store.saveAction({
      expectedVersion: find().version ?? null,
      action: { ...base, status: "waiting", contexts: ["outdoors"] }
    });
    expect(find().requirementPathways.map((route) => route.contextIds)).toEqual([["outdoors"]]);
    expect(find().notes).toBe("Rubric is in the shared folder.");

    // An empty string is the explicit clear (the editor's emptied notes box).
    state = await store.saveAction({
      expectedVersion: find().version ?? null,
      action: { ...base, status: "waiting", contexts: ["outdoors"], notes: "" }
    });
    expect(find().notes).toBeUndefined();
  });
});
