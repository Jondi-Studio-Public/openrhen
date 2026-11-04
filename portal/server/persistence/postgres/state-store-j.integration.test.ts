import { describe, expect, it } from "vitest";
import { createSeedState } from "@/state/portal-state";
import {
  daytimeSeed,
  eveningSeed,
  pinClockToSeedZoneHour,
  setupStateStoreSuite,
  sql,
  store
} from "./state-store-harness";

/**
 * State-store journeys, part 10 of 12.
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

setupStateStoreSuite("openrhen_state_store_j");

describe("normalized PostgreSQL portal persistence (part 10)", () => {
  // Pinned to a mid-morning zone. This journey asserts that a second planning run re-resolves exactly
  // the occurrence ids the first one wrote, and its two windows straddle the evening: the bedtime one
  // runs from three hours before tonight's sleep start until that start, and in the evening the sleep
  // plan's start is the current moment, so the window has already ended and the run stops placing it.
  // It stopped between the two runs, which the assertion reads as a materialisation fault. See
  // `daytimeSeed`; on the real seed-zone clock this failed after 20:00 and passed before it.
  it("materializes recurring windows once and completes a routine-linked occurrence by completing its step", async () => {
    const now = new Date();
    await store.put(daytimeSeed(now));
    let state = (await store.get())!;
    const project = state.projects[0]!;
    const actionId = crypto.randomUUID(),
      ruleId = crypto.randomUUID(),
      morningId = crypto.randomUUID(),
      bedtimeId = crypto.randomUUID();
    const local = (value: Date) =>
      new Intl.DateTimeFormat("en-CA", {
        timeZone: state.settings.timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      }).format(value);
    const end = new Date(now.getTime() + 56 * 86_400_000);
    state = await store.saveAction({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      action: {
        id: actionId,
        projectId: project.id,
        title: "Dental care",
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
          id: ruleId,
          timezone: state.settings.timezone,
          startDate: local(now),
          endDate: local(end),
          intervalDays: 1,
          windows: [
            {
              id: morningId,
              name: "Morning",
              anchor: "wake",
              startOffsetMinutes: 0,
              endOffsetMinutes: 180,
              fallback: { startTime: "05:00", endTime: "08:00" }
            },
            {
              id: bedtimeId,
              name: "Bedtime",
              anchor: "sleep_start",
              startOffsetMinutes: -180,
              endOffsetMinutes: 0,
              fallback: { startTime: "20:00", endTime: "21:00" }
            }
          ]
        }
      }
    });
    const action = state.actions.find((item) => item.title === "Dental care")!;
    const bedtime = action.recurrence!.windows.find((item) => item.name === "Bedtime")!;
    const presetId = crypto.randomUUID();
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      type: "save_entity",
      entityType: "routine_preset",
      entity: {
        id: presetId,
        name: "Bedtime routine",
        activityName: "Go to bed",
        status: "active",
        steps: [
          {
            id: crypto.randomUUID(),
            title: "Dental care",
            durationMinutes: 99,
            sequence: 0,
            timingRule: "contiguous",
            energy: "low",
            contexts: ["home"],
            dependencyIds: [],
            actionWindowId: bedtime.id
          }
        ]
      }
    });
    const preset = state.routinePresets.find((item) => item.name === "Bedtime routine")!;
    expect(preset.steps[0]?.durationMinutes).toBe(10);
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: state.settings.version ?? null,
      type: "save_entity",
      entityType: "settings",
      entity: {
        ...state.settings,
        lastWokeAt: new Date(now.getTime() - 60 * 60_000).toISOString(),
        bedtimeRoutinePresetId: preset.id,
        setupCompleted: true
      }
    });
    const firstIds = state.occurrences.filter((item) => item.actionId === action.id).map((item) => item.id);
    expect(firstIds.length).toBeGreaterThan(2);
    expect(new Set(firstIds).size).toBe(firstIds.length);
    state = await store.recalculate({
      commandId: crypto.randomUUID(),
      type: "recalculate",
      now: new Date().toISOString()
    });
    expect(
      state.occurrences
        .filter((item) => item.actionId === action.id)
        .map((item) => item.id)
        .sort()
    ).toEqual(firstIds.sort());
    // a routine's linked window is one of its `routine_steps` rows' `actionWindowId` now, not
    // a `routine_instances` row's `occurrenceIds`; the engine's own `routineCovered` verdict on the
    // occurrence is the fact under test, and completing the step directly (rather than naming which
    // occurrences to check off by hand) is what marks it done — the same mechanism a commitment's own
    // routine step already used. A bedtime step is derived for *every* planned night (`engine.ts`'s
    // `deriveBedtimeSteps` loops `sleepPlans`), so `routine`/`linked` must be pinned to the same night
    // rather than picked independently — otherwise the two `.find()`s can silently resolve to different
    // nights sharing the same recurring `actionWindowId`.
    const tonight = state.sleepPlans
      .filter((item) => item.status === "planned")
      .sort((a, b) => new Date(a.plannedStartAt).getTime() - new Date(b.plannedStartAt).getTime())[0]!;
    const routine = state.routineSteps.find(
      (item) => item.anchorType === "sleep_plan" && item.anchorId === tonight.id && item.actionWindowId
    )!;
    expect(routine).toBeDefined();
    const routineLocalDate = local(new Date(routine.scheduledStartAt!));
    const linked = state.occurrences.find(
      (item) => item.windowId === routine.actionWindowId && item.localDate === routineLocalDate
    )!;
    expect(linked).toBeDefined();
    expect(linked.routineCovered).toBe(true);
    state = await store.runActivityCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: routine.version ?? null,
      type: "start_activity",
      targetType: "routine_step",
      targetId: routine.id,
      plannedMinutes: routine.durationMinutes
    });
    state = await store.runActivityCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: state.activeSession?.version ?? null,
      type: "finish_activity",
      sessionId: state.activeSession!.id,
      outcome: "completed"
    });
    const completed = state.occurrences.find((item) => item.id === linked.id)!;
    expect(completed.status).toBe("completed");
    const sleep = state.sleepPlans.find((item) => item.status === "planned")!;
    state = await store.runActivityCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: sleep.version ?? null,
      type: "start_activity",
      targetType: "sleep",
      targetId: sleep.id,
      plannedMinutes: sleep.allowedMinutes
    });
    state = await store.runActivityCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: state.activeSession?.version ?? null,
      type: "finish_activity",
      sessionId: state.activeSession!.id,
      outcome: "completed"
    });
    expect(state.settings.lastWokeAt).toBeDefined();
    expect(state.occurrences.find((item) => item.id === linked.id)).toMatchObject({
      status: "completed",
      windowStartsAt: completed.windowStartsAt,
      windowEndsAt: completed.windowEndsAt
    });
    expect(
      state.occurrences.some(
        (item) =>
          item.actionId === action.id &&
          item.windowName === "Morning" &&
          item.status === "pending" &&
          item.anchorSource === "actual_wake"
      )
    ).toBe(true);
  }, 30_000);

  // Pinned to a mid-morning zone (`daytimeSeed`). In the evening tonight's sleep plan starts
  // at the current moment, and the replan that finishing step 2 triggers re-creates that plan under a
  // new id, taking step 1's row with it; the skip then finds no step. On the real seed-zone clock this
  // failed from about 18:00 and passed earlier in the day.
  it("tracks bedtime routine steps independently, with no ordering enforcement, and supports skipping", async () => {
    const now = new Date();
    await store.put(daytimeSeed(now));
    let state = (await store.get())!;
    const presetId = crypto.randomUUID();
    const step1Id = crypto.randomUUID();
    const step2Id = crypto.randomUUID();
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      type: "save_entity",
      entityType: "routine_preset",
      entity: {
        id: presetId,
        name: "Wind down",
        activityName: "Sleep",
        status: "active",
        steps: [
          {
            id: step1Id,
            title: "Drink water",
            durationMinutes: 10,
            timingRule: "contiguous",
            energy: "low",
            contexts: []
          },
          {
            id: step2Id,
            title: "Brush teeth",
            durationMinutes: 8,
            timingRule: "contiguous",
            energy: "low",
            contexts: []
          }
        ]
      }
    });
    const preset = state.routinePresets.find((item) => item.name === "Wind down")!;
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: state.settings.version ?? null,
      type: "save_entity",
      entityType: "settings",
      entity: {
        ...state.settings,
        lastWokeAt: new Date(now.getTime() - 60 * 60_000).toISOString(),
        bedtimeRoutinePresetId: preset.id,
        setupCompleted: true
      }
    });
    // one row per step now, not a `routine_instances` row with `completedStepIds`/
    // `skippedStepIds` arrays. `presetStepId` is the derivation's own lineage back to the preset step
    // (`planRoutineStepReconciliation` matches on it first), so it is how the test finds each row.
    // A bedtime step is derived for *every* planned night, so this is scoped to tonight's anchor —
    // otherwise `bedtimeSteps()` holds 2 rows per night across however many nights are planned.
    const tonight = state.sleepPlans
      .filter((item) => item.status === "planned")
      .sort((a, b) => new Date(a.plannedStartAt).getTime() - new Date(b.plannedStartAt).getTime())[0]!;
    const bedtimeSteps = () =>
      state.routineSteps.filter(
        (item) => item.anchorType === "sleep_plan" && item.purpose === "bedtime" && item.anchorId === tonight.id
      );
    expect(bedtimeSteps()).toHaveLength(2);
    const step1 = bedtimeSteps().find((item) => item.presetStepId === step1Id)!;
    const step2 = bedtimeSteps().find((item) => item.presetStepId === step2Id)!;
    expect(step1.status).toBe("pending");
    expect(step2.status).toBe("pending");
    // No dependency chain for a sleep-anchored routine (a deliberate scope decision) — unlike a commitment's own dependency-linked steps, the later step starts freely
    // even though the earlier one is still pending.
    state = await store.runActivityCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: step2.version ?? null,
      type: "start_activity",
      targetType: "routine_step",
      targetId: step2.id,
      plannedMinutes: step2.durationMinutes
    });
    expect(state.activeSession).toMatchObject({ targetType: "routine_step", targetId: step2.id });
    state = await store.runActivityCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: state.activeSession?.version ?? null,
      type: "finish_activity",
      sessionId: state.activeSession!.id,
      outcome: "completed"
    });
    expect(state.activeSession).toBeNull();
    expect(state.routineSteps.find((item) => item.id === step2.id)?.status).toBe("completed");
    // Skipping the other step is independent too — there is no "whole routine" status to roll up into.
    state = await store.runActivityCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: step1.version ?? null,
      type: "skip_routine_step",
      stepId: step1.id
    });
    expect(state.routineSteps.find((item) => item.id === step1.id)?.status).toBe("skipped");
    // A skip made by mistake is undone by reopening, and a step that is not skipped cannot be reopened.
    state = await store.runActivityCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: state.routineSteps.find((item) => item.id === step1.id)?.version ?? null,
      type: "reopen_routine_step",
      stepId: step1.id
    });
    expect(state.routineSteps.find((item) => item.id === step1.id)?.status).toBe("pending");
    await expect(
      store.runActivityCommand({
        commandId: crypto.randomUUID(),
        expectedVersion: state.routineSteps.find((item) => item.id === step1.id)?.version ?? null,
        type: "reopen_routine_step",
        stepId: step1.id
      })
    ).rejects.toThrow(/needs it to be skipped/);
  }, 30_000);

  // The sleep placement design note "Night identity": crossing bedtime or a missed start must never
  // change a night's id. Pinned to 21:30 (`eveningSeed`), inside the bedtime routine's own evening
  // window and close enough to the default 22:00 bedtime that `planSleep` reads tonight as an
  // already-missed start throughout — the exact case that used to key the night's id on `lastWokeAt`
  // (`sleep:missed:<lastWokeAt>`) instead of the cycle's own date, so a replan after finishing one
  // bedtime step recreated the whole cycle under a new id and took the other pending step's row with
  // it (a skip then found nothing). Fixed in `planSleep` by routing a missed start through
  // the same date-keyed `cycleId` as every other night.
  it("keeps a bedtime step findable across the replan a completed step triggers, in the evening window", async () => {
    const now = new Date();
    const seed = eveningSeed(now);
    // Guard the harness: at any UTC hour the seeded local clock must sit in the bedtime window,
    // so a regression in eveningSeed fails here instead of passing without testing anything.
    const [localHour, localMinute] = new Intl.DateTimeFormat("en-GB", {
      timeZone: seed.settings.timezone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    })
      .format(now)
      .split(":")
      .map(Number);
    const localMinutes = localHour! * 60 + localMinute!;
    expect(localMinutes).toBeGreaterThanOrEqual(21 * 60);
    expect(localMinutes).toBeLessThanOrEqual(22 * 60);
    await store.put(seed);
    let state = (await store.get())!;
    const presetId = crypto.randomUUID();
    const step1Id = crypto.randomUUID();
    const step2Id = crypto.randomUUID();
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      type: "save_entity",
      entityType: "routine_preset",
      entity: {
        id: presetId,
        name: "Evening wind down",
        activityName: "Sleep",
        status: "active",
        steps: [
          {
            id: step1Id,
            title: "Drink water",
            durationMinutes: 10,
            timingRule: "contiguous",
            energy: "low",
            contexts: []
          },
          {
            id: step2Id,
            title: "Brush teeth",
            durationMinutes: 8,
            timingRule: "contiguous",
            energy: "low",
            contexts: []
          }
        ]
      }
    });
    const preset = state.routinePresets.find((item) => item.name === "Evening wind down")!;
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: state.settings.version ?? null,
      type: "save_entity",
      entityType: "settings",
      entity: {
        ...state.settings,
        lastWokeAt: new Date(now.getTime() - 14 * 60 * 60_000).toISOString(),
        bedtimeRoutinePresetId: preset.id,
        setupCompleted: true
      }
    });
    const tonight = state.sleepPlans
      .filter((item) => item.status === "planned")
      .sort((a, b) => new Date(a.plannedStartAt).getTime() - new Date(b.plannedStartAt).getTime())[0]!;
    const tonightId = tonight.id;
    const bedtimeSteps = () =>
      state.routineSteps.filter(
        (item) => item.anchorType === "sleep_plan" && item.purpose === "bedtime" && item.anchorId === tonightId
      );
    expect(bedtimeSteps()).toHaveLength(2);
    const step1 = bedtimeSteps().find((item) => item.presetStepId === step1Id)!;
    const step2 = bedtimeSteps().find((item) => item.presetStepId === step2Id)!;
    expect(step1.status).toBe("pending");
    expect(step2.status).toBe("pending");
    // Completing step 2 triggers the replan found unsafe: tonight's plan is recomputed from
    // scratch against whatever "now" is by the time this command runs.
    state = await store.runActivityCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: step2.version ?? null,
      type: "start_activity",
      targetType: "routine_step",
      targetId: step2.id,
      plannedMinutes: step2.durationMinutes
    });
    state = await store.runActivityCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: state.activeSession?.version ?? null,
      type: "finish_activity",
      sessionId: state.activeSession!.id,
      outcome: "completed"
    });
    expect(state.activeSession).toBeNull();
    // Tonight's own id is unchanged by the replan the completion triggered.
    const tonightAfter = state.sleepPlans
      .filter((item) => item.status === "planned" || item.status === "sleeping")
      .sort((a, b) => new Date(a.plannedStartAt).getTime() - new Date(b.plannedStartAt).getTime())[0]!;
    expect(tonightAfter.id).toBe(tonightId);
    // Step 1's own row is still there, under the same id, still pending — not deleted and reinserted
    // under a new anchor the way a changed night id would have made `reconcileSleepRoutineSteps` treat
    // it.
    const step1After = state.routineSteps.find((item) => item.id === step1.id);
    expect(step1After?.status).toBe("pending");
    expect(step1After?.anchorId).toBe(tonightId);
    // The skip finds the pending step, exactly as needed.
    state = await store.runActivityCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: step1After!.version ?? null,
      type: "skip_routine_step",
      stepId: step1.id
    });
    expect(state.routineSteps.find((item) => item.id === step1.id)?.status).toBe("skipped");
  }, 30_000);

  it("materializes recurring commitment repeats fortnightly and re-derives them idempotently", async () => {
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
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      type: "save_entity",
      entityType: "condition_definition",
      entity: { id: "studio", name: "Studio", kind: "location", latitude: -36.1, longitude: 146.9 }
    });
    const ruleId = crypto.randomUUID();
    // Later in this test, saveCommitmentRecurrenceRule flips this rule's presence twice more, each of
    // which checks the real wall clock for an occurrence "in progress" (occurrenceInProgress) — a
    // fixed 14:00-15:00 window would fail whenever the suite happened to run at that hour in
    // state.settings.timezone. Anchor the window twelve hours from whatever hour "now" is instead
    // (clamped off the last hour of the day so it never crosses midnight), which keeps at least an
    // 11-hour margin from "now" no matter the hour, at the cost of no longer being mid-afternoon.
    const nowHour = Number(
      new Intl.DateTimeFormat("en-GB", {
        timeZone: state.settings.timezone,
        hour: "2-digit",
        hourCycle: "h23"
      }).format(now)
    );
    const startHour = Math.min((nowHour + 12) % 24, 22);
    const pad = (value: number) => String(value).padStart(2, "0");
    state = await store.saveCommitmentRecurrenceRule({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      rule: {
        id: ruleId,
        title: "Piano lesson",
        timezone: state.settings.timezone,
        startDate: local(now),
        repeat: { unit: "days", intervalDays: 14 },
        localStartTime: `${pad(startHour)}:00`,
        localEndTime: `${pad(startHour + 1)}:00`,
        locationId: "studio",
        setupBeforeMinutes: 10,
        transitionAfterMinutes: 15,
        presence: "anchor",
        projectId: project.id
      }
    });
    const rule = state.commitmentRecurrenceRules.find((item) => item.title === "Piano lesson")!;
    expect(rule).toBeDefined();
    expect(rule.status).toBe("active");
    expect(rule.projectId).toBe(project.id);
    const first = state.commitments
      .filter((item) => item.recurrenceRuleId === rule.id)
      .map((item) => item.id)
      .sort();
    expect(first.length).toBeGreaterThan(0);
    expect(new Set(first).size).toBe(first.length);
    expect(
      state.commitments
        .filter((item) => item.recurrenceRuleId === rule.id)
        .every((item) => item.projectId === project.id && item.locationId === "studio" && item.presence === "anchor")
    ).toBe(true);
    // A materialized row written before the place link was persisted has location_id NULL; the next
    // replan must heal it rather than leaving the series invisible to location-aware planning.
    await sql`UPDATE commitments SET location_id=NULL WHERE recurrence_rule_id=${rule.id}`;
    state = await store.recalculate({
      commandId: crypto.randomUUID(),
      type: "recalculate",
      now: new Date().toISOString()
    });
    expect(
      state.commitments
        .filter((item) => item.recurrenceRuleId === rule.id)
        .map((item) => item.id)
        .sort()
    ).toEqual(first);
    expect(
      state.commitments
        .filter((item) => item.recurrenceRuleId === rule.id)
        .every((item) => item.locationId === "studio")
    ).toBe(true);
    // Presence is the rule's to decide, so switching it must reach every occurrence still tracking
    // the rule (presence_source 'inherit' — every occurrence here, since none has been edited one at
    // a time yet). See the next test for what happens once one has.
    const anchored = state.commitmentRecurrenceRules.find((item) => item.id === rule.id)!;
    expect(anchored.presence).toBe("anchor");
    state = await store.saveCommitmentRecurrenceRule({
      commandId: crypto.randomUUID(),
      expectedVersion: anchored.version ?? null,
      rule: { ...anchored, presence: "blocking" }
    });
    expect(
      state.commitments
        .filter((item) => item.recurrenceRuleId === rule.id)
        .every((item) => item.presence === "blocking")
    ).toBe(true);
    const blocking = state.commitmentRecurrenceRules.find((item) => item.id === rule.id)!;
    state = await store.saveCommitmentRecurrenceRule({
      commandId: crypto.randomUUID(),
      expectedVersion: blocking.version ?? null,
      rule: { ...blocking, status: "ended" }
    });
    expect(
      state.commitments.filter((item) => item.recurrenceRuleId === rule.id && new Date(item.startsAt) > now)
    ).toHaveLength(0);
  }, 30_000);

  // Changing a whole recurring series' engagement level worked, but changing one
  // occurrence's did not — the very next replan (which `saveEntity` itself triggers, via
  // `withPlanningRefresh`) re-derived every occurrence from the rule and clobbered the edit straight
  // back. Fixed by presence_source: an occurrence a save actually changes presence on detaches
  // ('custom') from that healing, the same one-way way a hand-edited routine step detaches
  // routine_source; every other occurrence keeps tracking the rule ('inherit').
  it("keeps a single occurrence's engagement-level edit through the next replan, without breaking whole-series propagation", async () => {
    const now = new Date();
    await store.put(createSeedState(now));
    const ruleId = crypto.randomUUID();
    const local = (value: Date) =>
      new Intl.DateTimeFormat("en-CA", {
        timeZone: "Australia/Sydney",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      }).format(value);
    // The rule's occurrences must never be "in progress" (occurrenceInProgress, evaluated against the
    // real wall clock by saveCommitmentRecurrenceRule) at whatever real instant this suite happens to
    // run — otherwise the whole-series flip further down hits OCCURRENCE_IN_PROGRESS_MESSAGE. Rather
    // than a time fixed to a wall-clock hour of today (which is "in progress" for 8 of every 24 hours),
    // anchor the occurrence's one-hour window twelve hours away from whatever hour "now" is in
    // Australia/Sydney, clamped off the last hour of the day so the window never crosses midnight —
    // that keeps at least an 11-hour margin from "now" no matter what hour this suite runs at.
    const nowHour = Number(
      new Intl.DateTimeFormat("en-GB", { timeZone: "Australia/Sydney", hour: "2-digit", hourCycle: "h23" }).format(now)
    );
    const startHour = Math.min((nowHour + 12) % 24, 22);
    const pad = (value: number) => String(value).padStart(2, "0");
    let state = await store.saveCommitmentRecurrenceRule({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      rule: {
        id: ruleId,
        title: "College Class",
        timezone: "Australia/Sydney",
        startDate: local(now),
        repeat: { unit: "days", intervalDays: 7 },
        localStartTime: `${pad(startHour)}:00`,
        localEndTime: `${pad(startHour + 1)}:00`,
        setupBeforeMinutes: 0,
        transitionAfterMinutes: 0,
        presence: "blocking"
      }
    });
    const occurrences = state.commitments
      .filter((item) => item.recurrenceRuleId === ruleId)
      .sort((left, right) => new Date(left.startsAt).getTime() - new Date(right.startsAt).getTime());
    // The materialiser looks 14 days ahead of a weekly rule, so there is always a second occurrence
    // to act as the untouched control.
    expect(occurrences.length).toBeGreaterThanOrEqual(2);
    const [first, second] = occurrences;
    expect(first!.presence).toBe("blocking");
    // The one-tap "I'm free between obligations" edit the report describes: a single occurrence,
    // not the rule. This save's own post-refresh replan is exactly what used to revert it.
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: first!.version ?? null,
      type: "save_entity",
      entityType: "commitment",
      entity: { ...first!, presence: "anchor" }
    });
    expect(state.commitments.find((item) => item.id === first!.id)?.presence).toBe("anchor");
    expect(state.commitments.find((item) => item.id === second!.id)?.presence).toBe("blocking");
    const sourceOf = async (id: string) => {
      const rows = await sql<{ presence_source: string }[]>`SELECT presence_source FROM commitments WHERE id=${id}`;
      return rows[0]?.presence_source;
    };
    expect(await sourceOf(first!.id)).toBe("custom");
    expect(await sourceOf(second!.id)).toBe("inherit");
    // Flipping the whole series still reaches every occurrence that never had its own edit...
    const rule = state.commitmentRecurrenceRules.find((item) => item.id === ruleId)!;
    state = await store.saveCommitmentRecurrenceRule({
      commandId: crypto.randomUUID(),
      expectedVersion: rule.version ?? null,
      rule: { ...rule, presence: "anchor" }
    });
    expect(state.commitments.find((item) => item.id === second!.id)?.presence).toBe("anchor");
    const anchoredRule = state.commitmentRecurrenceRules.find((item) => item.id === ruleId)!;
    state = await store.saveCommitmentRecurrenceRule({
      commandId: crypto.randomUUID(),
      expectedVersion: anchoredRule.version ?? null,
      rule: { ...anchoredRule, presence: "blocking" }
    });
    // ...but the occurrence that was edited directly keeps its own value through both flips, the
    // detach the report needed.
    expect(state.commitments.find((item) => item.id === second!.id)?.presence).toBe("blocking");
    expect(state.commitments.find((item) => item.id === first!.id)?.presence).toBe("anchor");
  }, 30_000);

  it("accumulates logged minutes toward a total-time recurring goal and auto-completes it", async () => {
    // Pinned to mid-morning: the window runs 00:00-23:59, so on the real clock a run that crosses 23:59 lost the occurrence mid-test.
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
    const actionId = crypto.randomUUID(),
      ruleId = crypto.randomUUID(),
      windowId = crypto.randomUUID();
    state = await store.saveAction({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      action: {
        id: actionId,
        projectId: project.id,
        title: "Read the manual",
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
          completionMode: "total_minutes",
          targetTotalMinutes: 10,
          windows: [
            { id: windowId, name: "Anytime", anchor: "local_time", localStartTime: "00:00", localEndTime: "23:59" }
          ]
        }
      }
    });
    const action = state.actions.find((item) => item.id === actionId)!;
    expect(action.recurrence?.completionMode).toBe("total_minutes");
    // A next-day occurrence is already materialized alongside today's — completing the goal must cancel it too.
    expect(
      state.occurrences.filter((item) => item.actionId === action.id && item.status === "pending").length
    ).toBeGreaterThan(1);
    const occurrence = state.occurrences.find((item) => item.actionId === action.id && item.status === "pending")!;
    state = await store.runSessionCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: action.version ?? null,
      type: "start",
      actionId: occurrence.id,
      plannedMinutes: 10
    });
    const session = state.activeSession!;
    await sql`UPDATE session_segments SET started_at=${new Date(Date.now() - 10 * 60_000)} WHERE session_id=${session.id} AND ended_at IS NULL`;
    state = await store.runSessionCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: session.version ?? null,
      type: "finish",
      sessionId: session.id,
      outcome: "completed"
    });
    const rule = state.actions.find((item) => item.id === actionId)!.recurrence!;
    expect(rule.accumulatedMinutes).toBeGreaterThanOrEqual(10);
    expect(rule.completedAt).toBeDefined();
    expect(state.actions.find((item) => item.id === actionId)!.status).toBe("done");
    expect(state.occurrences.filter((item) => item.actionId === action.id && item.status === "pending")).toHaveLength(
      0
    );
  }, 30_000);

  // CLI audit L3: a session on the recurring template itself was filed against the series and, finished,
  // marked the template done, which stopped every occurrence. Starts must name an occurrence.
  it("refuses a session on a recurring template and keeps the series open when an occurrence is worked", async () => {
    // Pinned to mid-morning: the window runs 00:00-23:59, so on the real clock a run that crosses 23:59 lost the occurrence mid-test.
    const now = pinClockToSeedZoneHour();
    await store.put(createSeedState(now));
    let state = (await store.get())!;
    const local = (value: Date) =>
      new Intl.DateTimeFormat("en-CA", {
        timeZone: state.settings.timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      }).format(value);
    const actionId = crypto.randomUUID();
    state = await store.saveAction({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      action: {
        id: actionId,
        projectId: state.projects[0]!.id,
        title: "Morning stretch",
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
          id: crypto.randomUUID(),
          timezone: state.settings.timezone,
          startDate: local(now),
          intervalDays: 1,
          completionMode: "manual",
          windows: [
            {
              id: crypto.randomUUID(),
              name: "Anytime",
              anchor: "local_time",
              localStartTime: "00:00",
              localEndTime: "23:59"
            }
          ]
        }
      }
    });
    const template = state.actions.find((item) => item.id === actionId)!;
    await expect(
      store.runSessionCommand({
        commandId: crypto.randomUUID(),
        expectedVersion: template.version ?? null,
        type: "start",
        actionId: template.id,
        plannedMinutes: 10
      })
    ).rejects.toThrow(/recurring action/);
    expect((await store.get())?.activeSession).toBeNull();

    const occurrence = state.occurrences.find((item) => item.actionId === actionId && item.status === "pending")!;
    state = await store.runSessionCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: template.version ?? null,
      type: "start",
      actionId: occurrence.id,
      plannedMinutes: 10
    });
    const session = state.activeSession!;
    state = await store.runSessionCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: session.version ?? null,
      type: "finish",
      sessionId: session.id,
      outcome: "completed"
    });
    expect(state.actions.find((item) => item.id === actionId)!.status).toBe("active");
    expect(state.occurrences.find((item) => item.id === occurrence.id)!.status).toBe("completed");
  }, 30_000);
});
