import { describe, expect, it } from "vitest";
import { createSeedState } from "@/state/portal-state";
import {
  daytimeSeed,
  fixedNow,
  latestContinuationRequest,
  setupStateStoreSuite,
  sql,
  store
} from "./state-store-harness";

/**
 * State-store journeys, part 6 of 12.
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

setupStateStoreSuite("openrhen_state_store_f");

describe("normalized PostgreSQL portal persistence (part 6)", () => {
  it("asks to continue a deliverable for as long as that deliverable needs to be worth resuming", async () => {
    const sessionNow = new Date();
    await store.put(daytimeSeed(sessionNow));
    const project = (await store.get())!.projects[0]!;
    const id = crypto.randomUUID();
    // Both steps need 25 minutes, so the projection's minimum useful session is 25. A flat 15-minute
    // request was refused by the engine for being shorter than the work needs, forever.
    const step = (key: string, title: string) => ({
      id: key,
      title,
      status: "planned",
      optimisticMinutes: 20,
      expectedMinutes: 30,
      pessimisticMinutes: 45,
      remainingMinutes: 30,
      energy: "low",
      minimumSessionMinutes: 25,
      maximumSessionMinutes: 60
    });
    await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      type: "save_entity",
      entityType: "deliverable",
      entity: {
        id,
        projectId: project.id,
        title: "Assessment 5",
        status: "in_progress",
        uncertainty: "some",
        importance: 5,
        consequence: 5,
        contractVersion: 1,
        planVersion: 1,
        contractApprovedAt: sessionNow.toISOString(),
        planApprovedAt: sessionNow.toISOString(),
        steps: [step("step-a", "Draft"), step("step-b", "Revise")],
        criteria: [{ key: "c", title: "Complete", required: true, stepIds: ["step-a", "step-b"] }]
      }
    });
    let state = (await store.get())!;
    expect(state.planning?.result?.currentDirective.kind).toBe("deliverable");
    const directive = state.planning?.result?.currentDirective;
    if (directive?.kind !== "deliverable") throw new Error("expected a deliverable directive");
    const deliverable = state.deliverables.find((item) => item.id === id)!;
    state = await store.runActivityCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: deliverable.version ?? null,
      type: "start_activity",
      targetType: "deliverable",
      targetId: id,
      plannedMinutes: directive.recommendedMinutes,
      stepId: deliverable.steps[0]!.id
    });
    const session = state.activeSession!;
    state = await store.runSessionCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: session.version ?? null,
      type: "request_feedback",
      sessionId: session.id
    });
    expect(state.activeSession?.status).toBe("feedback");
    expect(await latestContinuationRequest(id)).toEqual({ actionId: id, requestedMinutes: 25 });
    // The engine may still refuse on displacement, but never again for a request shorter than the work.
    const answered = (await store.get())!.planning?.result?.continuation as { reason?: string } | null;
    expect(answered?.reason ?? "").not.toContain("shorter than");
  }, 120_000);

  it("opens a deliverable session on a step, keeps that step through resume and continue, and credits it the time", async () => {
    const sessionNow = new Date();
    await store.put(daytimeSeed(sessionNow));
    const project = (await store.get())!.projects[0]!;
    const id = crypto.randomUUID();
    const step = (key: string, title: string) => ({
      id: key,
      title,
      status: "planned",
      optimisticMinutes: 20,
      expectedMinutes: 30,
      pessimisticMinutes: 45,
      remainingMinutes: 30,
      energy: "low",
      minimumSessionMinutes: 15,
      maximumSessionMinutes: 60
    });
    await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      type: "save_entity",
      entityType: "deliverable",
      entity: {
        id,
        projectId: project.id,
        title: "Assessment 6",
        status: "in_progress",
        uncertainty: "some",
        importance: 5,
        consequence: 5,
        contractVersion: 1,
        planVersion: 1,
        contractApprovedAt: sessionNow.toISOString(),
        planApprovedAt: sessionNow.toISOString(),
        steps: [step("step-a", "Draft"), step("step-b", "Revise")],
        criteria: [{ key: "c", title: "Complete", required: true, stepIds: ["step-a", "step-b"] }]
      }
    });
    let state = (await store.get())!;
    const directive = state.planning?.result?.currentDirective;
    if (directive?.kind !== "deliverable") throw new Error("expected a deliverable directive");
    const deliverable = state.deliverables.find((item) => item.id === id)!;
    const draft = deliverable.steps.find((item) => item.title === "Draft")!;
    // Start carries the step, the way the Now page's Start does, so the first segment is already
    // attributed rather than landing on nothing.
    state = await store.runActivityCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: deliverable.version ?? null,
      type: "start_activity",
      targetType: "deliverable",
      targetId: id,
      plannedMinutes: directive.recommendedMinutes,
      stepId: draft.id
    });
    const sessionId = state.activeSession!.id;
    expect(state.activeSession).toMatchObject({ targetType: "deliverable", stepId: draft.id, status: "running" });
    const stepOfOpenSegment = async () =>
      (
        await sql<
          { step_id: string | null }[]
        >`SELECT step_id FROM session_segments WHERE session_id=${sessionId} AND ended_at IS NULL`
      ).map((row) => row.step_id);
    expect(await stepOfOpenSegment()).toEqual([draft.id]);

    // The Now page's automatic checkpoint goes through the session path. Its resume and continue must
    // keep the step on every segment they open, or the minutes after them are credited to nothing.
    state = await store.runSessionCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: state.activeSession?.version ?? null,
      type: "pause",
      sessionId
    });
    state = await store.runSessionCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: state.activeSession?.version ?? null,
      type: "resume",
      sessionId
    });
    expect(await stepOfOpenSegment()).toEqual([draft.id]);
    state = await store.runSessionCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: state.activeSession?.version ?? null,
      type: "request_feedback",
      sessionId
    });
    expect(state.activeSession?.status).toBe("feedback");
    expect(await stepOfOpenSegment()).toEqual([]);
    const continuation = (await store.get())!.planning?.result?.continuation as {
      safe?: boolean;
      recommendedMinutes?: number;
      reason?: string;
    } | null;
    if (continuation?.safe && continuation.recommendedMinutes) {
      state = await store.runSessionCommand({
        commandId: crypto.randomUUID(),
        expectedVersion: state.activeSession?.version ?? null,
        type: "continue",
        sessionId,
        requestedMinutes: continuation.recommendedMinutes
      });
      expect(state.activeSession).toMatchObject({ status: "running", stepId: draft.id });
      expect(await stepOfOpenSegment()).toEqual([draft.id]);
    } else {
      // Displacement is the engine's call; what matters here is that the refusal names its reason.
      await expect(
        store.runSessionCommand({
          commandId: crypto.randomUUID(),
          expectedVersion: state.activeSession?.version ?? null,
          type: "continue",
          sessionId,
          requestedMinutes: 15
        })
      ).rejects.toThrow(continuation?.reason ?? "continuation");
    }

    // The action session path cannot end a deliverable session: it would update `actions WHERE
    // id=NULL` and credit the steps with nothing.
    const refusedFinish = (await store
      .runSessionCommand({
        commandId: crypto.randomUUID(),
        expectedVersion: (await store.get())!.activeSession?.version ?? null,
        type: "finish",
        sessionId,
        outcome: "completed"
      })
      .catch((error: unknown) => error)) as { message: string; nextCall?: { tool: string; arguments: object } };
    expect(refusedFinish.message).toContain("not an action session");
    expect(refusedFinish.message).toContain('rhen_activity {"subcommand":"finish"');
    expect(refusedFinish.nextCall).toMatchObject({ tool: "rhen_activity", arguments: { subcommand: "finish" } });

    // Backdate the latest segment by ten minutes so the credited time is visible in whole minutes.
    await sql`UPDATE session_segments SET started_at=started_at - interval '10 minutes' WHERE id=(SELECT id FROM session_segments WHERE session_id=${sessionId} AND step_id=${draft.id} ORDER BY started_at DESC LIMIT 1)`;
    const before = (await store.get())!;
    state = await store.runActivityCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: before.activeSession?.version ?? null,
      type: "finish_activity",
      sessionId,
      outcome: "stopped",
      note: "Stopped for the day."
    });
    expect(state.activeSession).toBeNull();
    const finished = state.deliverables.find((item) => item.id === id)!;
    const draftAfter = finished.steps.find((item) => item.id === draft.id)!;
    const reviseAfter = finished.steps.find((item) => item.title === "Revise")!;
    // Every minute landed on the step that was open, none on the other, and none was lost.
    expect(draftAfter.remainingMinutes).toBeLessThanOrEqual(20);
    expect(draftAfter.lastWorkedAt).toBeDefined();
    expect(reviseAfter.remainingMinutes).toBe(30);
    const perStep = await sql<
      { step_id: string | null; seconds: number }[]
    >`SELECT step_id, COALESCE(SUM(EXTRACT(EPOCH FROM (ended_at-started_at))),0)::int seconds FROM session_segments WHERE session_id=${sessionId} GROUP BY step_id`;
    expect(perStep.map((row) => row.step_id)).toEqual([draft.id]);
    // What the read-only Deliverables view shows is exactly what the store returns after the session.
    const reread = (await store.get())!.deliverables.find((item) => item.id === id)!;
    expect(reread.steps.map((item) => [item.id, item.remainingMinutes, item.status])).toEqual(
      finished.steps.map((item) => [item.id, item.remainingMinutes, item.status])
    );
    expect(reread.lastWorkedAt).toBe(finished.lastWorkedAt);
  }, 60_000);

  it("still asks for fifteen minutes when the work can usefully resume in less", async () => {
    const sessionNow = new Date();
    const seed = daytimeSeed(sessionNow);
    const floor = seed.actions.find((item) => item.title === "Sort the bedroom floor")!;
    floor.minimumSessionMinutes = 10;
    await store.put(seed);
    let state = (await store.get())!;
    const action = state.actions.find((item) => item.title === "Sort the bedroom floor")!;
    expect(action.minimumSessionMinutes).toBe(10);
    state = await store.runSessionCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: action.version ?? null,
      type: "start",
      actionId: action.id,
      plannedMinutes: 30
    });
    const session = state.activeSession!;
    state = await store.runSessionCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: session.version ?? null,
      type: "request_feedback",
      sessionId: session.id
    });
    expect(state.activeSession?.status).toBe("feedback");
    expect(await latestContinuationRequest(action.id)).toEqual({ actionId: action.id, requestedMinutes: 15 });
  }, 120_000);

  it("refuses a cyclic step graph and a cyclic deliverable dependency", async () => {
    await store.put(createSeedState(fixedNow));
    const project = (await store.get())!.projects[0]!;
    const step = (suffix: string, dependencyIds: string[]) => ({
      id: `step-${suffix}`,
      title: `Step ${suffix}`,
      status: "planned",
      optimisticMinutes: 20,
      expectedMinutes: 30,
      pessimisticMinutes: 45,
      remainingMinutes: 30,
      energy: "high",
      minimumSessionMinutes: 15,
      maximumSessionMinutes: 60,
      dependencyIds
    });
    await expect(
      store.saveEntity({
        commandId: crypto.randomUUID(),
        expectedVersion: null,
        type: "save_entity",
        entityType: "deliverable",
        entity: {
          id: crypto.randomUUID(),
          projectId: project.id,
          title: "Cyclic plan",
          status: "needs_breakdown",
          uncertainty: "some",
          importance: 3,
          consequence: 3,
          steps: [step("a", ["step-b"]), step("b", ["step-a"])]
        }
      })
    ).rejects.toThrow("cycle");
    const first = crypto.randomUUID();
    const second = crypto.randomUUID();
    const base = (id: string, title: string, dependencyIds: string[]) => ({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      type: "save_entity" as const,
      entityType: "deliverable" as const,
      entity: {
        id,
        projectId: project.id,
        title,
        status: "needs_breakdown",
        uncertainty: "some",
        importance: 3,
        consequence: 3,
        dependencyIds
      }
    });
    await store.saveEntity(base(first, "Assessment 1", []));
    const afterSecond = await store.saveEntity(base(second, "Assessment 2", [first]));
    const stored = afterSecond.deliverables.find((item) => item.title === "Assessment 1")!;
    await expect(
      store.saveEntity({ ...base(first, "Assessment 1", [second]), expectedVersion: stored.version ?? null })
    ).rejects.toThrow("cycle");
  });

  it("completes first setup once and creates the seven MVP areas", async () => {
    const initial = (await store.get())!;
    expect(initial.areas).toHaveLength(0);
    const saved = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: initial.settings.version ?? null,
      type: "save_entity",
      entityType: "settings",
      entity: {
        ...initial.settings,
        assertedConditions: ["home", "laptop"],
        horizonEnd: new Date(Date.now() + 5 * 60 * 60_000).toISOString(),
        setupCompleted: true
      }
    });
    expect(saved.settings.setupCompletedAt).toBeDefined();
    expect(saved.areas.map((item) => item.name)).toEqual([
      "Work and income",
      "Study",
      "Career development",
      "Health",
      "Home and administration",
      "Relationships",
      "Recreation and recovery"
    ]);
  });

  it("round-trips a saved wake routine preset and rejects one that does not exist", async () => {
    await store.put(createSeedState(fixedNow));
    let state = (await store.get())!;
    const presetId = crypto.randomUUID();
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      type: "save_entity",
      entityType: "routine_preset",
      entity: {
        id: presetId,
        name: "Morning routine",
        activityName: "Wake up",
        status: "active",
        steps: [
          {
            id: crypto.randomUUID(),
            title: "Stretch",
            durationMinutes: 10,
            sequence: 0,
            timingRule: "contiguous",
            energy: "low",
            contexts: [],
            dependencyIds: []
          }
        ]
      }
    });
    const preset = state.routinePresets.find((item) => item.id === presetId)!;
    expect(preset).toBeDefined();
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: state.settings.version ?? null,
      type: "save_entity",
      entityType: "settings",
      entity: { ...state.settings, wakeRoutinePresetId: preset.id }
    });
    expect(state.settings.wakeRoutinePresetId).toBe(preset.id);
    // A stable-uuid'd unsaved id: never inserted into routine_presets, so the ownership check
    // (entity-commands.ts, mirroring bedtimeRoutinePresetId's own check) has nothing to find.
    await expect(
      store.saveEntity({
        commandId: crypto.randomUUID(),
        expectedVersion: state.settings.version ?? null,
        type: "save_entity",
        entityType: "settings",
        entity: { ...state.settings, wakeRoutinePresetId: crypto.randomUUID() }
      })
    ).rejects.toThrow(/Wake routine ".+" no longer exists/);
    // Clearing it back out is accepted, and is distinct from an empty string being treated as unset.
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: state.settings.version ?? null,
      type: "save_entity",
      entityType: "settings",
      entity: { ...state.settings, wakeRoutinePresetId: "" }
    });
    expect(state.settings.wakeRoutinePresetId).toBeUndefined();
  });

  it("refuses a new place with nowhere to be, and stores the same place once it has coordinates", async () => {
    await store.put(createSeedState(fixedNow));
    const command = (entity: Record<string, unknown>) => ({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      type: "save_entity" as const,
      entityType: "condition_definition" as const,
      entity
    });
    await expect(
      store.saveEntity(command({ id: "harbor-mart", name: "Harbor Mart", kind: "location" }))
    ).rejects.toThrow(/travel can't be measured without it/);
    const saved = await store.saveEntity(
      command({ id: "harbor-mart", name: "Harbor Mart", kind: "location", latitude: -36.1, longitude: 146.9 })
    );
    expect(saved.conditionDefinitions.find((entry) => entry.id === "harbor-mart")).toMatchObject({
      latitude: -36.1,
      longitude: 146.9
    });
  });

  it("keeps a place's address with its coordinates, and only ever with them", async () => {
    await store.put(createSeedState(fixedNow));
    let version: number | null = null;
    const place = async (entity: Record<string, unknown>) => {
      const state = await store.saveEntity({
        commandId: crypto.randomUUID(),
        expectedVersion: version,
        type: "save_entity",
        entityType: "condition_definition",
        entity: { id: "harbor-mart", name: "Harbor Mart", kind: "location", ...entity }
      });
      const saved = state.conditionDefinitions.find((entry) => entry.id === "harbor-mart");
      version = saved?.version ?? null;
      return saved;
    };
    expect(
      await place({ latitude: -36.1, longitude: 146.9, address: "Harbor Mart, Riverside NY 10001" })
    ).toMatchObject({
      address: "Harbor Mart, Riverside NY 10001"
    });
    // Coordinates gone, so the label describing them goes too rather than outliving what it named.
    expect(
      await place({ latitude: null, longitude: null, address: "Harbor Mart, Riverside NY 10001" })
    ).not.toHaveProperty("address");
    // And a save that carries no address at all — every row written before this existed — has none.
    expect(await place({ latitude: -36.1, longitude: 146.9 })).not.toHaveProperty("address");
  });

  it("round-trips a home location and commitment locations, and guards both", async () => {
    await store.put(createSeedState(fixedNow));
    const place = (id: string, name: string, extra: Record<string, unknown> = {}) =>
      store.saveEntity({
        commandId: crypto.randomUUID(),
        expectedVersion: null,
        type: "save_entity",
        entityType: "condition_definition",
        entity: { id, name, kind: "location", latitude: -36.1, longitude: 146.9, ...extra }
      });
    await place("home", "Home");
    let state = await place("campus", "Campus", { travelMinutes: 20 });
    const settings = (homeLocationId: string | undefined) =>
      store.saveEntity({
        commandId: crypto.randomUUID(),
        expectedVersion: state.settings.version ?? null,
        type: "save_entity",
        entityType: "settings",
        entity: { ...state.settings, assertedConditions: state.assertedConditions, homeLocationId }
      });
    await expect(settings("mars")).rejects.toThrow(/Home location \(must be an active place\) "mars" is not valid/);
    state = await settings("home");
    expect(state.settings.homeLocationId).toBe("home");
    // The home cannot quietly stop existing while it is still the home.
    await expect(
      store.saveEntity({
        commandId: crypto.randomUUID(),
        expectedVersion: state.conditionDefinitions.find((entry) => entry.id === "home")?.version ?? null,
        type: "save_entity",
        entityType: "condition_definition",
        entity: { id: "home", name: "Home", kind: "location", status: "archived", latitude: -36.1, longitude: 146.9 }
      })
    ).rejects.toThrow(/owner's home location/);
    const commitment = (locationId: string | undefined) =>
      store.saveEntity({
        commandId: crypto.randomUUID(),
        expectedVersion: null,
        type: "save_entity",
        entityType: "commitment",
        entity: {
          id: "lecture",
          title: "Lecture",
          startsAt: new Date(fixedNow.getTime() + 60 * 60_000).toISOString(),
          endsAt: new Date(fixedNow.getTime() + 120 * 60_000).toISOString(),
          status: "confirmed",
          location: "Room 4",
          locationId,
          setupBeforeMinutes: 10,
          transitionAfterMinutes: 5
        }
      });
    await expect(commitment("mars")).rejects.toThrow(
      /Commitment location \(must be an active place\) "mars" is not valid/
    );
    state = await commitment("campus");
    expect(state.commitments.find((entry) => entry.title === "Lecture")).toMatchObject({
      location: "Room 4",
      locationId: "campus"
    });
    state = await store.saveCommitmentRecurrenceRule({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      rule: {
        id: crypto.randomUUID(),
        title: "Tutorial",
        timezone: state.settings.timezone,
        startDate: fixedNow.toISOString().slice(0, 10),
        repeat: { unit: "days", intervalDays: 7 },
        localStartTime: "14:00",
        localEndTime: "15:00",
        locationId: "campus",
        setupBeforeMinutes: 10,
        transitionAfterMinutes: 15
      }
    });
    expect(state.commitmentRecurrenceRules.find((entry) => entry.title === "Tutorial")?.locationId).toBe("campus");
    // Once another home is chosen the old one may be archived, and settings without a home clear it.
    state = await settings("campus");
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: state.conditionDefinitions.find((entry) => entry.id === "home")?.version ?? null,
      type: "save_entity",
      entityType: "condition_definition",
      entity: { id: "home", name: "Home", kind: "location", status: "archived", latitude: -36.1, longitude: 146.9 }
    });
    expect(state.conditionDefinitions.find((entry) => entry.id === "home")?.status).toBe("archived");
    state = await settings(undefined);
    expect(state.settings.homeLocationId).toBeUndefined();
  });

  it("round-trips a live context, validates exactly-one-of, and rejects an unowned target", async () => {
    await store.put(createSeedState(fixedNow));
    let state = (await store.get())!;
    const rule = await store.saveCommitmentRecurrenceRule({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      rule: {
        id: crypto.randomUUID(),
        title: "College class",
        timezone: state.settings.timezone,
        startDate: fixedNow.toISOString().slice(0, 10),
        repeat: { unit: "days", intervalDays: 7 },
        localStartTime: "14:00",
        localEndTime: "15:00",
        setupBeforeMinutes: 0,
        transitionAfterMinutes: 0
      }
    });
    const ruleId = rule.commitmentRecurrenceRules.find((entry) => entry.title === "College class")!.id;
    const context = (entity: Record<string, unknown>, expectedVersion: number | null = null) =>
      store.saveEntity({
        commandId: crypto.randomUUID(),
        expectedVersion,
        type: "save_entity",
        entityType: "condition_definition",
        entity: { id: "ctx-college", name: "College class", kind: "live", ...entity }
      });
    // Neither id, or both, is refused.
    await expect(context({})).rejects.toThrow("A live context needs exactly one of recurrenceRuleId or commitmentId.");
    await expect(context({ recurrenceRuleId: ruleId, commitmentId: crypto.randomUUID() })).rejects.toThrow(
      "A live context needs exactly one of recurrenceRuleId or commitmentId."
    );
    // A recurrenceRuleId/commitmentId this user does not own — here, simply does not exist — is refused
    // rather than silently stored as a hold nothing will ever lift.
    await expect(context({ recurrenceRuleId: crypto.randomUUID() })).rejects.toThrow(
      /Recurring commitment ".+" no longer exists/
    );
    await expect(context({ commitmentId: crypto.randomUUID() })).rejects.toThrow(/Commitment ".+" no longer exists/);
    // Round trip: a valid recurrenceRuleId is stored and read back.
    state = await context({ recurrenceRuleId: ruleId });
    let saved = state.conditionDefinitions.find((entry) => entry.id === "ctx-college");
    expect(saved).toMatchObject({ kind: "live", recurrenceRuleId: ruleId });
    expect(saved).not.toHaveProperty("commitmentId");
    // Neither field is accepted on any other kind.
    await expect(
      store.saveEntity({
        commandId: crypto.randomUUID(),
        expectedVersion: null,
        type: "save_entity",
        entityType: "condition_definition",
        entity: { id: "not-a-commitment", name: "Desk", kind: "capability", recurrenceRuleId: ruleId }
      })
    ).rejects.toThrow("recurrenceRuleId/commitmentId only apply to a live context.");
    // Switching to commitmentId on the same row clears recurrenceRuleId, not merely adds alongside it.
    const commitment = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      type: "save_entity",
      entityType: "commitment",
      entity: {
        id: "dentist",
        title: "Dentist",
        startsAt: new Date(fixedNow.getTime() + 60 * 60_000).toISOString(),
        endsAt: new Date(fixedNow.getTime() + 90 * 60_000).toISOString(),
        status: "confirmed",
        setupBeforeMinutes: 0,
        transitionAfterMinutes: 0
      }
    });
    const commitmentId = commitment.commitments.find((entry) => entry.title === "Dentist")!.id;
    state = await context({ commitmentId }, saved!.version ?? null);
    saved = state.conditionDefinitions.find((entry) => entry.id === "ctx-college");
    expect(saved).toMatchObject({ kind: "live", commitmentId });
    expect(saved).not.toHaveProperty("recurrenceRuleId");
  });
});
