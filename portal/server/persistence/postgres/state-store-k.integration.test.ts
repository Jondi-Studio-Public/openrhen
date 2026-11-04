import { describe, expect, it } from "vitest";
import { createSeedState } from "@/state/portal-state";
import { daytimeSeed, pinClockToSeedZoneHour, setupStateStoreSuite, store } from "./state-store-harness";

/**
 * State-store journeys, part 11 of 12.
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

setupStateStoreSuite("openrhen_state_store_k");

describe("normalized PostgreSQL portal persistence (part 11)", () => {
  it("inherits a place's default routine, follows preset edits, and detaches only on a real tweak", async () => {
    const now = new Date();
    await store.put(createSeedState(now));
    let state = (await store.get())!;
    const presetStep = (id: string, title: string, minutes: number, sequence: number) => ({
      id,
      title,
      durationMinutes: minutes,
      sequence,
      timingRule: "contiguous",
      energy: "low",
      contexts: ["home"],
      dependencyIds: sequence === 0 ? [] : undefined
    });
    const presetId = crypto.randomUUID();
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      type: "save_entity",
      entityType: "routine_preset",
      entity: {
        id: presetId,
        name: "Pool kit",
        activityName: "Swim",
        status: "active",
        steps: [presetStep("pack", "Pack towel", 10, 0), presetStep("fill", "Fill bottle", 5, 1)]
      }
    });
    const preset = state.routinePresets.find((item) => item.name === "Pool kit")!;
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      type: "save_entity",
      entityType: "condition_definition",
      entity: {
        id: "pool",
        name: "Pool",
        kind: "location",
        latitude: -36.08,
        longitude: 146.92,
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
        title: "Swim squad",
        startsAt: new Date(now.getTime() + 26 * 60 * 60_000).toISOString(),
        endsAt: new Date(now.getTime() + 27 * 60 * 60_000).toISOString(),
        status: "confirmed",
        locationId: "pool",
        setupBeforeMinutes: 0,
        transitionAfterMinutes: 0
      }
    });
    const commitment = state.commitments.find((item) => item.title === "Swim squad")!;
    expect(commitment.routineSource).toBe("inherit");
    let steps = state.routineSteps.filter((item) => item.commitmentId === commitment.id);
    expect(steps.map((item) => item.title)).toEqual(["Pack towel", "Fill bottle"]);
    expect(steps.every((item) => item.scheduledStartAt)).toBe(true);
    // Editing the preset flows into the inherited steps on the very next replan.
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: preset.version ?? null,
      type: "save_entity",
      entityType: "routine_preset",
      entity: {
        id: presetId,
        name: "Pool kit",
        activityName: "Swim",
        status: "active",
        steps: [presetStep("pack", "Pack towel", 15, 0), presetStep("fill", "Fill bottle", 5, 1)]
      }
    });
    steps = state.routineSteps.filter((item) => item.commitmentId === commitment.id);
    expect(steps.find((item) => item.title === "Pack towel")?.durationMinutes).toBe(15);
    // Marking a step done is progress against the same routine, not a tweak: no detach, and the
    // finished step pins the whole routine against any later rewrite.
    const done = steps.find((item) => item.title === "Fill bottle")!;
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: done.version ?? null,
      type: "save_entity",
      entityType: "routine_step",
      entity: {
        id: done.id,
        commitmentId: commitment.id,
        title: done.title,
        durationMinutes: done.durationMinutes,
        sequence: done.sequence,
        timingRule: done.timingRule,
        energy: done.energy,
        contexts: done.contexts,
        dependencyIds: done.dependencyIds,
        phase: done.phase,
        status: "completed"
      }
    });
    expect(state.commitments.find((item) => item.id === commitment.id)?.routineSource).toBe("inherit");
    state = await store.recalculate({
      commandId: crypto.randomUUID(),
      type: "recalculate",
      now: new Date().toISOString()
    });
    expect(state.routineSteps.find((item) => item.id === done.id)?.status).toBe("completed");
    // A real tweak — changing a step's duration — detaches the commitment to 'custom', and the
    // tweak survives every later replan.
    const keep = state.routineSteps.find((item) => item.commitmentId === commitment.id && item.title === "Pack towel")!;
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: keep.version ?? null,
      type: "save_entity",
      entityType: "routine_step",
      entity: {
        id: keep.id,
        commitmentId: commitment.id,
        title: keep.title,
        durationMinutes: 25,
        sequence: keep.sequence,
        timingRule: keep.timingRule,
        energy: keep.energy,
        contexts: keep.contexts,
        dependencyIds: keep.dependencyIds,
        phase: keep.phase,
        status: "pending"
      }
    });
    expect(state.commitments.find((item) => item.id === commitment.id)?.routineSource).toBe("custom");
    state = await store.recalculate({
      commandId: crypto.randomUUID(),
      type: "recalculate",
      now: new Date().toISOString()
    });
    expect(state.routineSteps.find((item) => item.id === keep.id)?.durationMinutes).toBe(25);
  }, 60_000);

  // Pinned to a mid-morning zone (`daytimeSeed`): the rule's window starts four hours from now, and
  // from 19:00 to 20:00 local that hour crosses midnight, so its local end came before its start and
  // `commitment_recurrence_time_check` refused the rule.
  it("copies the rule's routine source onto materialised occurrences and keeps a per-occurrence override through replans", async () => {
    const now = pinClockToSeedZoneHour();
    await store.put(daytimeSeed(now));
    let state = (await store.get())!;
    const presetId = crypto.randomUUID();
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      type: "save_entity",
      entityType: "routine_preset",
      entity: {
        id: presetId,
        name: "Pool kit",
        activityName: "Swim",
        status: "active",
        steps: [
          {
            id: "pack",
            title: "Pack towel",
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
    const preset = state.routinePresets.find((item) => item.name === "Pool kit")!;
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      type: "save_entity",
      entityType: "condition_definition",
      entity: {
        id: "pool",
        name: "Pool",
        kind: "location",
        latitude: -36.08,
        longitude: 146.92,
        defaultRoutinePresetId: preset.id
      }
    });
    // The rule's first occurrence must materialise with routine steps, and
    // `candidateRoutineCommitments`/`syncInheritedRoutineSteps` only ever generate those for a
    // commitment whose `startsAt` is still ahead of the engine's clock (a past occurrence needs no
    // more preparation). A fixed "07:00" start pinned to today's date used to pass only while the
    // suite happened to run before 7am local — anchoring it a safe margin ahead of the actual `now`
    // instead keeps the assertion clock-independent without changing what it means to test.
    const timezone = state.settings.timezone;
    const futureStart = new Date(now.getTime() + 4 * 60 * 60 * 1000);
    const futureEnd = new Date(futureStart.getTime() + 60 * 60 * 1000);
    const localTime = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    });
    state = await store.saveCommitmentRecurrenceRule({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      rule: {
        id: crypto.randomUUID(),
        title: "Squad",
        timezone,
        startDate: new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(futureStart),
        repeat: { unit: "days", intervalDays: 45 },
        localStartTime: localTime.format(futureStart),
        localEndTime: localTime.format(futureEnd),
        locationId: "pool",
        setupBeforeMinutes: 0,
        transitionAfterMinutes: 0
      }
    });
    const rule = state.commitmentRecurrenceRules.find((item) => item.title === "Squad")!;
    expect(rule.routineSource).toBe("inherit");
    const occurrences = state.commitments.filter((item) => item.recurrenceRuleId === rule.id);
    expect(occurrences.length).toBeGreaterThan(0);
    for (const occurrence of occurrences) {
      expect(occurrence.routineSource).toBe("inherit");
      expect(state.routineSteps.some((step) => step.commitmentId === occurrence.id)).toBe(true);
    }
    // One occurrence needs no preparation: the override belongs to that day alone, and a replan
    // that re-materialises the occurrence must not reclaim it for the rule.
    const override = occurrences[0]!;
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: override.version ?? null,
      type: "save_entity",
      entityType: "commitment",
      entity: { ...override, routineSource: "none" }
    });
    expect(state.commitments.find((item) => item.id === override.id)?.routineSource).toBe("none");
    expect(state.routineSteps.some((step) => step.commitmentId === override.id)).toBe(false);
    state = await store.recalculate({
      commandId: crypto.randomUUID(),
      type: "recalculate",
      now: new Date().toISOString()
    });
    expect(state.commitments.find((item) => item.id === override.id)?.routineSource).toBe("none");
    expect(state.routineSteps.some((step) => step.commitmentId === override.id)).toBe(false);
    const sibling = state.commitments.find((item) => item.recurrenceRuleId === rule.id && item.id !== override.id);
    expect(sibling).toBeDefined();
    expect(state.routineSteps.some((step) => step.commitmentId === sibling!.id)).toBe(true);
  }, 60_000);

  it("clears a removed routine on recalculation and brings the place default back when it is restored", async () => {
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
    let commitment = state.commitments.find((item) => item.title === "Tennis")!;
    expect(commitment.routineSource).toBe("inherit");
    expect(state.routineSteps.filter((item) => item.commitmentId === commitment.id).map((item) => item.title)).toEqual([
      "Find racquet"
    ]);
    // The override controls send the stored commitment back with one field changed, which is what
    // the detail page does; nothing else about the record may move as a side effect.
    const entityOf = (item: typeof commitment) => ({
      id: item.id,
      title: item.title,
      startsAt: item.startsAt,
      endsAt: item.endsAt,
      status: item.status,
      setupBeforeMinutes: item.setupBeforeMinutes,
      transitionAfterMinutes: item.transitionAfterMinutes,
      ...(item.locationId ? { locationId: item.locationId } : {})
    });
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: commitment.version ?? null,
      type: "save_entity",
      entityType: "commitment",
      entity: { ...entityOf(commitment), routineSource: "none" }
    });
    state = await store.recalculate({
      commandId: crypto.randomUUID(),
      type: "recalculate",
      now: new Date().toISOString()
    });
    commitment = state.commitments.find((item) => item.id === commitment.id)!;
    expect(commitment.routineSource).toBe("none");
    expect(state.routineSteps.some((item) => item.commitmentId === commitment.id)).toBe(false);
    expect(commitment.locationId).toBe("court");
    // Back to the place default: the steps are rewritten from the preset the place points at.
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: commitment.version ?? null,
      type: "save_entity",
      entityType: "commitment",
      entity: { ...entityOf(commitment), routineSource: "inherit" }
    });
    state = await store.recalculate({
      commandId: crypto.randomUUID(),
      type: "recalculate",
      now: new Date().toISOString()
    });
    commitment = state.commitments.find((item) => item.id === commitment.id)!;
    expect(commitment.routineSource).toBe("inherit");
    expect(state.routineSteps.filter((item) => item.commitmentId === commitment.id).map((item) => item.title)).toEqual([
      "Find racquet"
    ]);
  }, 60_000);
});
