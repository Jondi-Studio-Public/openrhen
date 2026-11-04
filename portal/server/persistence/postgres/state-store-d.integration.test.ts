import { describe, expect, it } from "vitest";
import { createSeedState } from "@/state/portal-state";
import { ensureUser } from "./ensure-user";
import {
  fixedNow,
  pinClockToSeedZoneHour,
  refreshPlanning,
  setupStateStoreSuite,
  sql,
  store,
  unplannedStore
} from "./state-store-harness";

/**
 * State-store journeys, part 4 of 12.
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

setupStateStoreSuite("openrhen_state_store_d");

describe("normalized PostgreSQL portal persistence (part 4)", () => {
  it("logs a finished cadence session as today's cycle and resets the action for next time", async () => {
    const now = new Date();
    await store.put(createSeedState(now));
    let state = (await store.get())!;
    const project = state.projects[0]!;
    const local = (value: Date) =>
      new Intl.DateTimeFormat("en-CA", {
        timeZone: state.settings.timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      }).format(value);
    const actionId = crypto.randomUUID(),
      ruleId = crypto.randomUUID();
    state = await store.saveAction({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      action: {
        id: actionId,
        projectId: project.id,
        title: "Maths practice",
        status: "active",
        optimisticMinutes: 20,
        expectedMinutes: 30,
        pessimisticMinutes: 45,
        remainingMinutes: 30,
        energy: "medium",
        minimumSessionMinutes: 15,
        maximumSessionMinutes: 45,
        splittable: true,
        setupMinutes: 0,
        importance: 5,
        consequence: 3,
        contexts: ["home"],
        dependencyIds: [],
        schedulingMode: "cadence",
        recurrence: {
          id: ruleId,
          timezone: state.settings.timezone,
          startDate: local(now),
          intervalDays: 1,
          windows: []
        }
      }
    });
    let action = state.actions.find((item) => item.id === actionId)!;
    expect(action.schedulingMode).toBe("cadence");
    expect(action.recurrence).toMatchObject({ intervalDays: 1, completionMode: "manual", windows: [] });
    expect(action.recurrence?.lastCompletedLocalDate).toBeUndefined();
    // A cadence derives no occurrences: it is the action itself that is ranked.
    expect(state.occurrences.filter((item) => item.actionId === actionId)).toHaveLength(0);

    state = await store.runSessionCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: action.version ?? null,
      type: "start",
      actionId,
      plannedMinutes: 30
    });
    const session = state.activeSession!;
    await sql`UPDATE session_segments SET started_at=CURRENT_TIMESTAMP-INTERVAL '25 minutes' WHERE session_id=${session.id} AND ended_at IS NULL`;
    state = await store.runSessionCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: session.version ?? null,
      type: "finish",
      sessionId: session.id,
      outcome: "completed"
    });
    action = state.actions.find((item) => item.id === actionId)!;
    // The cycle is done, the action is not: it waits, reset, for tomorrow.
    expect(action.status).toBe("active");
    expect(action.remainingMinutes).toBe(30);
    expect(action.recurrence?.lastCompletedLocalDate).toBe(local(new Date()));
    expect(action.recurrence?.completionCount).toBe(1);
    const logged = await sql<
      { minutes: number; source: string; session_id: string | null }[]
    >`SELECT minutes, source, session_id FROM action_cadence_completions WHERE action_id=${actionId}`;
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ source: "session", session_id: session.id });
    expect(logged[0]!.minutes).toBeGreaterThanOrEqual(25);

    // Ticking it off by hand the same day is the same completion, not a second one.
    state = await store.recordCadenceCompletion({
      commandId: crypto.randomUUID(),
      expectedVersion: action.version ?? null,
      type: "record_cadence_completion",
      actionId
    });
    action = state.actions.find((item) => item.id === actionId)!;
    expect(action.recurrence?.completionCount).toBe(1);
    expect(
      await sql<
        { count: number }[]
      >`SELECT COUNT(*)::int AS count FROM action_cadence_completions WHERE action_id=${actionId}`
    ).toEqual([{ count: 1 }]);

    // A partial session later leaves the cycle open with the effort the person says remains.
    state = await store.runSessionCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: action.version ?? null,
      type: "start",
      actionId,
      plannedMinutes: 15
    });
    const partial = state.activeSession!;
    state = await store.runSessionCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: partial.version ?? null,
      type: "finish",
      sessionId: partial.id,
      outcome: "progress",
      remainingMinutes: 10
    });
    action = state.actions.find((item) => item.id === actionId)!;
    expect(action.status).toBe("active");
    expect(action.remainingMinutes).toBe(10);
    expect(action.recurrence?.completionCount).toBe(1);
  }, 30_000);

  it("records cadence done away from the app, and closes a total-time goal when it is reached", async () => {
    const now = new Date();
    await store.put(createSeedState(now));
    let state = (await store.get())!;
    const project = state.projects[0]!;
    const local = (value: Date) =>
      new Intl.DateTimeFormat("en-CA", {
        timeZone: state.settings.timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      }).format(value);
    const actionId = crypto.randomUUID(),
      ruleId = crypto.randomUUID();
    state = await store.saveAction({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      action: {
        id: actionId,
        projectId: project.id,
        title: "Run",
        status: "active",
        optimisticMinutes: 30,
        expectedMinutes: 40,
        pessimisticMinutes: 60,
        remainingMinutes: 40,
        energy: "high",
        minimumSessionMinutes: 20,
        maximumSessionMinutes: 60,
        splittable: false,
        setupMinutes: 0,
        importance: 2,
        consequence: 2,
        contexts: ["outdoors"],
        dependencyIds: [],
        schedulingMode: "cadence",
        recurrence: {
          id: ruleId,
          timezone: state.settings.timezone,
          startDate: local(new Date(now.getTime() - 10 * 86_400_000)),
          intervalDays: 3,
          completionMode: "total_minutes",
          targetTotalMinutes: 60,
          windows: []
        }
      }
    });
    let action = state.actions.find((item) => item.id === actionId)!;
    const yesterday = local(new Date(now.getTime() - 86_400_000));
    state = await store.recordCadenceCompletion({
      commandId: crypto.randomUUID(),
      expectedVersion: action.version ?? null,
      type: "record_cadence_completion",
      actionId,
      localDate: yesterday,
      minutes: 35
    });
    action = state.actions.find((item) => item.id === actionId)!;
    expect(action.status).toBe("active");
    expect(action.recurrence?.lastCompletedLocalDate).toBe(yesterday);
    expect(action.recurrence?.accumulatedMinutes).toBe(35);
    expect(action.recurrence?.completedAt).toBeUndefined();

    await expect(
      store.recordCadenceCompletion({
        commandId: crypto.randomUUID(),
        expectedVersion: action.version ?? null,
        type: "record_cadence_completion",
        actionId,
        localDate: local(new Date(now.getTime() + 86_400_000))
      })
    ).rejects.toThrow("has not happened yet");

    state = await store.recordCadenceCompletion({
      commandId: crypto.randomUUID(),
      expectedVersion: action.version ?? null,
      type: "record_cadence_completion",
      actionId,
      minutes: 30
    });
    action = state.actions.find((item) => item.id === actionId)!;
    expect(action.recurrence?.accumulatedMinutes).toBe(65);
    expect(action.recurrence?.completedAt).toBeDefined();
    expect(action.recurrence?.completionCount).toBe(2);
    expect(action.status).toBe("done");
    await expect(
      store.recordCadenceCompletion({
        commandId: crypto.randomUUID(),
        expectedVersion: action.version ?? null,
        type: "record_cadence_completion",
        actionId
      })
    ).rejects.toThrow("already closed");
  }, 30_000);

  it("keeps a manual-completion recurring action open until explicitly ended", async () => {
    const now = new Date();
    await store.put(createSeedState(now));
    let state = (await store.get())!;
    const project = state.projects[0]!;
    const local = (value: Date) =>
      new Intl.DateTimeFormat("en-CA", {
        timeZone: state.settings.timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      }).format(value);
    const actionId = crypto.randomUUID(),
      ruleId = crypto.randomUUID(),
      windowId = crypto.randomUUID();
    state = await store.saveAction({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      action: {
        id: actionId,
        projectId: project.id,
        title: "Practice guitar",
        status: "active",
        optimisticMinutes: 5,
        expectedMinutes: 10,
        pessimisticMinutes: 15,
        remainingMinutes: 10,
        energy: "low",
        minimumSessionMinutes: 5,
        maximumSessionMinutes: 15,
        splittable: false,
        setupMinutes: 0,
        importance: 3,
        consequence: 3,
        contexts: ["home"],
        dependencyIds: [],
        schedulingMode: "recurring",
        recurrence: {
          id: ruleId,
          timezone: state.settings.timezone,
          startDate: local(now),
          intervalDays: 1,
          completionMode: "manual",
          windows: [
            { id: windowId, name: "Anytime", anchor: "local_time", localStartTime: "00:00", localEndTime: "23:59" }
          ]
        }
      }
    });
    let action = state.actions.find((item) => item.id === actionId)!;
    expect(action.recurrence?.completionMode).toBe("manual");
    expect(action.recurrence?.completedAt).toBeUndefined();
    await expect(
      store.endRecurrenceGoal({
        commandId: crypto.randomUUID(),
        expectedVersion: action.version ?? null,
        type: "end_recurrence_goal",
        actionId: "missing-action"
      })
    ).rejects.toThrow("no recurrence");
    state = await store.endRecurrenceGoal({
      commandId: crypto.randomUUID(),
      expectedVersion: action.version ?? null,
      type: "end_recurrence_goal",
      actionId
    });
    action = state.actions.find((item) => item.id === actionId)!;
    expect(action.status).toBe("done");
    expect(action.recurrence?.completedAt).toBeDefined();
    expect(state.occurrences.filter((item) => item.actionId === actionId && item.status === "pending")).toHaveLength(0);
  }, 30_000);

  it("names the id a cadence action is stored under in the change feed, not the one it was sent under", async () => {
    const now = new Date();
    await store.put(createSeedState(now));
    let state = (await store.get())!;
    const project = state.projects[0]!;
    const slug = "action-run-slug";
    state = await store.saveAction({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      action: {
        id: slug,
        projectId: project.id,
        title: "Run by slug",
        status: "active",
        optimisticMinutes: 30,
        expectedMinutes: 40,
        pessimisticMinutes: 60,
        remainingMinutes: 40,
        energy: "high",
        minimumSessionMinutes: 20,
        maximumSessionMinutes: 60,
        splittable: false,
        setupMinutes: 0,
        importance: 2,
        consequence: 2,
        contexts: ["outdoors"],
        dependencyIds: [],
        schedulingMode: "cadence",
        recurrence: {
          id: "rule-run-slug",
          timezone: state.settings.timezone,
          startDate: now.toISOString().slice(0, 10),
          intervalDays: 3,
          completionMode: "total_minutes",
          targetTotalMinutes: 600,
          windows: []
        }
      }
    });
    const action = state.actions.find((item) => item.title === "Run by slug")!;
    expect(action.id).not.toBe(slug);
    await store.recordCadenceCompletion({
      commandId: crypto.randomUUID(),
      expectedVersion: action.version ?? null,
      type: "record_cadence_completion",
      actionId: slug
    });
    await store.endRecurrenceGoal({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      type: "end_recurrence_goal",
      actionId: slug
    });
    const feed = await sql<
      { operation: string; entity_id: string }[]
    >`SELECT operation, entity_id FROM write_rows WHERE entity_type='action' ORDER BY created_at, id`;
    expect(feed).toEqual([
      { operation: "save", entity_id: action.id },
      { operation: "record_cadence_completion", entity_id: action.id },
      { operation: "end_recurrence_goal", entity_id: action.id }
    ]);
  }, 30_000);

  it("clears a recurring action's dates on save, keeps a cadence action's, and leaves a once action's alone", async () => {
    const now = new Date();
    await store.put(createSeedState(now));
    let state = (await store.get())!;
    const project = state.projects[0]!;
    const staleDeadline = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();

    const recurringId = crypto.randomUUID();
    state = await store.saveAction({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      action: {
        id: recurringId,
        projectId: project.id,
        title: "Brush teeth",
        status: "active",
        optimisticMinutes: 5,
        expectedMinutes: 10,
        pessimisticMinutes: 15,
        remainingMinutes: 10,
        energy: "low",
        minimumSessionMinutes: 5,
        maximumSessionMinutes: 15,
        splittable: false,
        setupMinutes: 0,
        importance: 3,
        consequence: 3,
        contexts: [],
        dependencyIds: [],
        deadlineAt: staleDeadline,
        latestStartAt: staleDeadline,
        schedulingMode: "recurring",
        recurrence: {
          id: crypto.randomUUID(),
          timezone: state.settings.timezone,
          startDate: new Intl.DateTimeFormat("en-CA", { timeZone: state.settings.timezone }).format(now),
          intervalDays: 1,
          completionMode: "manual",
          windows: [
            {
              id: crypto.randomUUID(),
              name: "Morning",
              anchor: "local_time",
              localStartTime: "07:00",
              localEndTime: "08:00"
            }
          ]
        }
      }
    });
    let recurring = state.actions.find((item) => item.id === recurringId)!;
    expect(recurring.deadlineAt).toBeUndefined();
    expect(recurring.latestStartAt).toBeUndefined();

    const cadenceId = crypto.randomUUID();
    state = await store.saveAction({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      action: {
        id: cadenceId,
        projectId: project.id,
        title: "Stretch",
        status: "active",
        optimisticMinutes: 5,
        expectedMinutes: 10,
        pessimisticMinutes: 15,
        remainingMinutes: 10,
        energy: "low",
        minimumSessionMinutes: 5,
        maximumSessionMinutes: 15,
        splittable: false,
        setupMinutes: 0,
        importance: 3,
        consequence: 3,
        contexts: [],
        dependencyIds: [],
        deadlineAt: staleDeadline,
        schedulingMode: "cadence",
        recurrence: {
          id: crypto.randomUUID(),
          timezone: state.settings.timezone,
          startDate: new Intl.DateTimeFormat("en-CA", { timeZone: state.settings.timezone }).format(now),
          intervalDays: 3,
          completionMode: "manual",
          windows: []
        }
      }
    });
    const cadence = state.actions.find((item) => item.id === cadenceId)!;
    // Decided 2026-09-13: a cadence action keeps its own due date. `effectiveDeadline` reads
    // `deadlineAt` whatever the scheduling mode, so clearing one moves that action's tier —
    // which is why migration 0079 spares cadence rows, and why the write path must not undo that.
    expect(cadence.deadlineAt).toBe(staleDeadline);

    // The editor hides the date fields outside `once`, so an ordinary cadence save carries no
    // date at all. Absence is no opinion: the stored date survives it.
    state = await store.saveAction({
      commandId: crypto.randomUUID(),
      expectedVersion: cadence.version ?? null,
      action: {
        ...cadence,
        deadlineAt: undefined,
        latestStartAt: undefined,
        assumedFields: undefined,
        title: "Stretch, retitled"
      }
    });
    const cadenceAgain = state.actions.find((item) => item.id === cadenceId)!;
    expect(cadenceAgain.title).toBe("Stretch, retitled");
    expect(cadenceAgain.deadlineAt).toBe(staleDeadline);

    const onceId = crypto.randomUUID();
    state = await store.saveAction({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      action: {
        id: onceId,
        projectId: project.id,
        title: "File the form",
        status: "active",
        optimisticMinutes: 5,
        expectedMinutes: 10,
        pessimisticMinutes: 15,
        remainingMinutes: 10,
        energy: "low",
        minimumSessionMinutes: 5,
        maximumSessionMinutes: 15,
        splittable: false,
        setupMinutes: 0,
        importance: 3,
        consequence: 3,
        contexts: [],
        dependencyIds: [],
        deadlineAt: staleDeadline,
        schedulingMode: "one_off"
      }
    });
    const once = state.actions.find((item) => item.id === onceId)!;
    expect(once.deadlineAt).toBe(staleDeadline);
  }, 30_000);

  it("lets a commitment routine step stand in for a recurring window and close it when done", async () => {
    const now = pinClockToSeedZoneHour();
    await store.put(createSeedState(now));
    let state = (await store.get())!;
    const project = state.projects[0]!;
    const local = (value: Date) =>
      new Intl.DateTimeFormat("en-CA", {
        timeZone: state.settings.timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      }).format(value);
    const windowId = crypto.randomUUID();
    state = await store.saveAction({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      action: {
        id: crypto.randomUUID(),
        projectId: project.id,
        title: "Brush and floss twice daily",
        status: "active",
        optimisticMinutes: 5,
        expectedMinutes: 10,
        pessimisticMinutes: 15,
        remainingMinutes: 10,
        energy: "low",
        minimumSessionMinutes: 5,
        maximumSessionMinutes: 15,
        splittable: false,
        setupMinutes: 0,
        importance: 4,
        consequence: 4,
        contexts: ["home"],
        dependencyIds: [],
        schedulingMode: "recurring",
        recurrence: {
          id: crypto.randomUUID(),
          timezone: state.settings.timezone,
          startDate: local(now),
          endDate: local(new Date(now.getTime() + 56 * 86_400_000)),
          intervalDays: 1,
          // A wide local-time window, so the occurrence exists on the day whatever the hour is.
          windows: [
            { id: windowId, name: "Morning", anchor: "local_time", localStartTime: "09:00", localEndTime: "21:00" }
          ]
        }
      }
    });
    const action = state.actions.find((item) => item.title === "Brush and floss twice daily")!;
    const morning = action.recurrence!.windows[0]!;
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      type: "save_entity",
      entityType: "commitment",
      entity: {
        id: crypto.randomUUID(),
        title: "Work",
        startsAt: new Date(now.getTime() + 26 * 60 * 60_000).toISOString(),
        endsAt: new Date(now.getTime() + 32 * 60 * 60_000).toISOString(),
        status: "confirmed",
        setupBeforeMinutes: 0,
        transitionAfterMinutes: 0
      }
    });
    const commitment = state.commitments.find((item) => item.title === "Work")!;
    const stepId = crypto.randomUUID();
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      type: "save_entity",
      entityType: "routine_step",
      entity: {
        id: stepId,
        commitmentId: commitment.id,
        title: "Brush Teeth",
        // Overridden by the linked action's own estimate, so the same minutes are never counted twice.
        durationMinutes: 99,
        sequence: 0,
        timingRule: "contiguous",
        energy: "low",
        contexts: ["home"],
        status: "pending",
        actionWindowId: morning.id
      }
    });
    let step = state.routineSteps.find((item) => item.title === "Brush Teeth")!;
    expect(step.actionWindowId).toBe(morning.id);
    expect(step.durationMinutes).toBe(10);
    const stepDay = local(new Date(step.scheduledStartAt!));
    state = await store.recalculate({
      commandId: crypto.randomUUID(),
      type: "recalculate",
      now: new Date().toISOString()
    });
    const covered = state.occurrences.find((item) => item.windowId === morning.id && item.localDate === stepDay)!;
    expect(covered).toBeDefined();
    expect(covered.routineCovered).toBe(true);
    step = state.routineSteps.find((item) => item.id === step.id)!;
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: step.version ?? null,
      type: "save_entity",
      entityType: "routine_step",
      entity: {
        id: step.id,
        commitmentId: commitment.id,
        title: step.title,
        durationMinutes: step.durationMinutes,
        sequence: step.sequence,
        timingRule: step.timingRule,
        energy: step.energy,
        contexts: step.contexts,
        dependencyIds: step.dependencyIds,
        phase: step.phase,
        actionWindowId: step.actionWindowId,
        status: "completed"
      }
    });
    const closed = state.occurrences.find((item) => item.id === covered.id)!;
    expect(closed.status).toBe("completed");
    expect(closed.routineCovered).toBeFalsy();
  }, 30_000);

  it("leaves an arrival-skipped routine step skipped when its stale open session is finished as 'did not start' (finding 19)", async () => {
    // Arrival's own skip (`routine-step-arrival.ts` / the platform/database sweep) can retire a step
    // out from under a session that was already open when the location assertion landed — the two are
    // unrelated writes to the same row. Simulated here with a direct write rather than a real arrival,
    // since the arrival mechanisms themselves now refuse to touch a `doing` step (the other half of
    // this same fix) and so can no longer produce this race through the ordinary application flow —
    // this guard is the belt-and-braces that still has to hold regardless of how a step ended up
    // `skipped` underneath an open session.
    await store.put(createSeedState(fixedNow));
    let state = (await store.get())!;
    const commitment = state.commitments[0]!;
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      type: "save_entity",
      entityType: "routine_step",
      entity: {
        id: crypto.randomUUID(),
        commitmentId: commitment.id,
        title: "Pack Bag",
        durationMinutes: 10,
        sequence: 0,
        timingRule: "contiguous",
        energy: "low",
        contexts: [],
        status: "pending"
      }
    });
    const step = state.routineSteps[0]!;
    state = await store.runActivityCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: step.version ?? null,
      type: "start_activity",
      targetType: "routine_step",
      targetId: step.id,
      plannedMinutes: step.durationMinutes
    });
    expect(state.activeSession?.targetType).toBe("routine_step");
    // The race: arrival retires the step to `skipped` out from under the still-open session.
    await sql`UPDATE routine_steps SET status='skipped', version=version+1 WHERE id=${step.id}`;
    state = await store.runActivityCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: state.activeSession?.version ?? null,
      type: "finish_activity",
      sessionId: state.activeSession!.id,
      outcome: "did_not_start"
    });
    // Stays skipped — not resurrected to `pending`.
    const finished = await sql<{ status: string }[]>`SELECT status FROM routine_steps WHERE id=${step.id}`;
    expect(finished[0]?.status).toBe("skipped");
    // The session itself still finished normally; only the step's own status write was guarded.
    expect(state.activeSession).toBeNull();
  }, 30_000);

  it("schedules and tracks a contiguous commitment routine before its setup buffer", async () => {
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
        title: "Get ready for work",
        durationMinutes: 50,
        sequence: 0,
        timingRule: "contiguous",
        energy: "low",
        contexts: ["home"],
        status: "pending"
      }
    });
    let step = state.routineSteps[0]!;
    const setupStartsAt = new Date(new Date(commitment.startsAt).getTime() - 10 * 60000).toISOString();
    const routineStartsAt = new Date(new Date(commitment.startsAt).getTime() - 60 * 60000).toISOString();
    expect(step.scheduledEndAt).toBe(setupStartsAt);
    expect(step.scheduledStartAt).toBe(routineStartsAt);
    await sql`UPDATE routine_steps SET scheduled_start_at=${new Date(new Date(commitment.startsAt).getTime() - 50 * 60000)},scheduled_end_at=${new Date(commitment.startsAt)} WHERE id=${step.id}`;
    state = await store.recalculate({
      commandId: crypto.randomUUID(),
      type: "recalculate",
      now: new Date().toISOString()
    });
    step = state.routineSteps[0]!;
    expect(step.scheduledEndAt).toBe(setupStartsAt);
    expect(step.scheduledStartAt).toBe(routineStartsAt);
    state = await store.runActivityCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: step.version ?? null,
      type: "start_activity",
      targetType: "routine_step",
      targetId: step.id,
      plannedMinutes: step.durationMinutes
    });
    expect(state.activeSession?.targetType).toBe("routine_step");
    state = await store.runActivityCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: state.activeSession?.version ?? null,
      type: "finish_activity",
      sessionId: state.activeSession!.id,
      outcome: "completed"
    });
    expect(state.routineSteps[0]?.status).toBe("completed");
  });

  it("auto-skips a located commitment's remaining before-phase steps the moment arrival is asserted", async () => {
    const now = new Date();
    await store.put(createSeedState(now));
    let state = (await store.get())!;
    // `loc-other` sits a few minutes from `loc-college` by car, not hundreds of kilometres away: the
    // projected day's own anchor order between `college` and `elsewhere` (both open in the same window,
    // tie-broken by which of the two commitments happens to sort second — effectively a coin flip
    // given how close their `arriveBy` instants are) decides which of the two the placer's leg into
    // `laterCollege` departs from. A real-world distance there attached a genuine multi-hour travel leg
    // to `laterCollege` (the routine step timing design note's placer correctly reads that leg through
    // `commitmentTimeline`), pushing its before-chain's placed start into the past and defeating this
    // test's premise — not a bug in the placer or in the arrival skip, but this fixture asking for a
    // trip no real day could make. Keeping the two places distinct but nearby keeps `elsewhereStep`'s
    // own assertion meaningful while leaving `laterCollege`'s own window untouched by either order.
    // The fixture is thirteen commands whose intermediate plans nothing reads, so they go through the
    // store without the harness's planning drain (an engine run each, ~0.7 s, and this test's whole
    // wall clock before); the fixture is planned once, below, before the arrival write under test.
    for (const [locationId, latitude, longitude] of [
      ["loc-college", -36.08, 146.92],
      ["loc-other", -36.09, 146.93]
    ] as const)
      state = await unplannedStore.saveEntity({
        commandId: crypto.randomUUID(),
        expectedVersion: null,
        type: "save_entity",
        entityType: "condition_definition",
        entity: { id: locationId, name: locationId, kind: "location", latitude, longitude }
      });
    const makeCommitment = async (title: string, locationId: string, startOffsetMs: number, endOffsetMs: number) => {
      state = await unplannedStore.saveEntity({
        commandId: crypto.randomUUID(),
        expectedVersion: null,
        type: "save_entity",
        entityType: "commitment",
        entity: {
          id: crypto.randomUUID(),
          title,
          startsAt: new Date(now.getTime() + startOffsetMs).toISOString(),
          endsAt: new Date(now.getTime() + endOffsetMs).toISOString(),
          status: "confirmed",
          locationId,
          setupBeforeMinutes: 0,
          transitionAfterMinutes: 0
        }
      });
      return state.commitments.find((item) => item.title === title)!;
    };
    // Open now, at the place the assertion is about to name.
    const college = await makeCommitment("College Class", "loc-college", -10 * 60_000, 50 * 60_000);
    // Open now too, but a different place — an open window alone must not be enough.
    const elsewhere = await makeCommitment("Elsewhere", "loc-other", -10 * 60_000, 50 * 60_000);
    // The right place, but its window has not opened yet.
    const laterCollege = await makeCommitment(
      "College Class Tomorrow",
      "loc-college",
      2 * 60 * 60_000,
      3 * 60 * 60_000
    );
    const makeStep = async (
      commitmentId: string,
      title: string,
      sequence: number,
      phase: "before" | "after",
      status: string
    ) => {
      state = await unplannedStore.saveEntity({
        commandId: crypto.randomUUID(),
        expectedVersion: null,
        type: "save_entity",
        entityType: "routine_step",
        entity: {
          id: crypto.randomUUID(),
          commitmentId,
          title,
          durationMinutes: 10,
          sequence,
          timingRule: "contiguous",
          energy: "low",
          contexts: [],
          phase,
          status
        }
      });
      return state.routineSteps.find((item) => item.commitmentId === commitmentId && item.title === title)!;
    };
    const packBag = await makeStep(college.id, "Pack Bag", 0, "before", "pending");
    const brushTeeth = await makeStep(college.id, "Brush Teeth", 1, "before", "doing");
    const layout = await makeStep(college.id, "Layout clothes", 2, "before", "blocked");
    const alreadyDone = await makeStep(college.id, "Already done", 3, "before", "completed");
    const unpack = await makeStep(college.id, "Unpack", 4, "after", "pending");
    const elsewhereStep = await makeStep(elsewhere.id, "Get ready", 0, "before", "pending");
    const laterStep = await makeStep(laterCollege.id, "Get ready", 0, "before", "pending");
    // Plan the finished fixture once, and prove it placed the pending before-phase steps: the arrival
    // skip reads each commitment's window from `scheduled_start_at`, and without a plan it would fall
    // back to `starts_at` and pass for the wrong reason.
    await refreshPlanning();
    state = (await unplannedStore.get())!;
    for (const step of [packBag, elsewhereStep, laterStep])
      expect(state.routineSteps.find((item) => item.id === step.id)?.scheduledStartAt, step.title).toBeTruthy();
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: state.settings.version ?? null,
      type: "save_entity",
      entityType: "current_availability",
      entity: { currentEnergy: "medium", assertedConditions: [], currentSituation: { locationId: "loc-college" } }
    });
    // The manual save path (`nextCurrentSituation`, `entity-commands.ts`) must stamp `locationSetAt`
    // in the same write as `locationId`, never leaving it to a later write — a missing timestamp is
    // read as stale-to-the-point-of-absent by every downstream reader of the assertion
    // (`currentFreshLocationId`), which would silently turn off the sweep backstop and the check-in
    // suppression for this exact row without ever touching the write-time skip this test also proves.
    expect(state.currentSituation.locationId).toBe("loc-college");
    expect(state.currentSituation.locationSetAt).not.toBeNull();
    expect(Number.isNaN(Date.parse(state.currentSituation.locationSetAt!))).toBe(false);
    const statusOf = (id: string) => state.routineSteps.find((item) => item.id === id)?.status;
    // Only the pending before-phase step of the newly-arrived-at, currently-open commitment is
    // skipped. A `doing` step has a live session open on it — finding 19: skipping it out from under
    // that session is what let "did not start" resurrect an arrival-skipped step, so arrival now
    // leaves it alone entirely.
    expect(statusOf(packBag.id)).toBe("skipped");
    expect(statusOf(brushTeeth.id)).toBe("doing");
    // Everything else about that same commitment is untouched: blocked, completed and after-phase.
    expect(statusOf(layout.id)).toBe("blocked");
    expect(statusOf(alreadyDone.id)).toBe("completed");
    expect(statusOf(unpack.id)).toBe("pending");
    // A different commitment, and the same place before its window opens: untouched either way.
    expect(statusOf(elsewhereStep.id)).toBe("pending");
    expect(statusOf(laterStep.id)).toBe("pending");
  }, 30_000);

  it("retitles a session still reading 'Preparing for X' once arrival is asserted", async () => {
    // A session opened during setup or travel is named by the phase it tracks (`phaseSessionTitle`,
    // activity-commands.ts) and never revisited by anything else — pausing/resuming leaves the title
    // exactly as it was. Arrival is meant to catch it (`retitleTrackedSessionsOnArrival`,
    // routine-step-arrival.ts); this proves that write actually lands.
    const now = new Date();
    await store.put(createSeedState(now));
    let state = (await store.get())!;
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      type: "save_entity",
      entityType: "condition_definition",
      entity: { id: "loc-college", name: "loc-college", kind: "location", latitude: -36.08, longitude: 146.92 }
    });
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      type: "save_entity",
      entityType: "commitment",
      entity: {
        id: crypto.randomUUID(),
        title: "College Class",
        startsAt: new Date(now.getTime() - 10 * 60_000).toISOString(),
        endsAt: new Date(now.getTime() + 50 * 60_000).toISOString(),
        status: "confirmed",
        locationId: "loc-college",
        setupBeforeMinutes: 0,
        transitionAfterMinutes: 0
      }
    });
    const college = state.commitments.find((item) => item.title === "College Class")!;
    const userId = await ensureUser(sql);
    // Simulated with a direct write rather than starting the session through the command handler,
    // since that requires a live Plan and Forecast Engine result naming the setup phase — the point
    // here is only what arrival does to an already-open session, not how one gets opened.
    const sessionId = crypto.randomUUID();
    await sql`
      INSERT INTO sessions (id,user_id,target_type,target_id,target_title,status,planned_started_at,planned_end_at,started_at,planned_minutes,remaining_before_minutes)
      VALUES (${sessionId},${userId},'fixed_commitment',${college.id},'Preparing for College Class','running',${now},${new Date(now.getTime() + 60_000)},${now},15,0)
    `;
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: state.settings.version ?? null,
      type: "save_entity",
      entityType: "current_availability",
      entity: { currentEnergy: "medium", assertedConditions: [], currentSituation: { locationId: "loc-college" } }
    });
    expect(state.currentSituation.locationId).toBe("loc-college");
    const session = await sql<
      { target_title: string; version: number }[]
    >`SELECT target_title, version FROM sessions WHERE id=${sessionId}`;
    // The commitment's own `starts_at` was 10 minutes ago, so this is its `active` phase, not `arrival`.
    expect(session[0]?.target_title).toBe("College Class");
    expect(session[0]?.version).toBe(2);
  }, 30_000);
});
