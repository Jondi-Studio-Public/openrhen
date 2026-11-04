import { describe, expect, it } from "vitest";
import { PREVIOUS_STEP, omittedStoredFields, recordInState } from "./record-in-state";

const keys = (kind: string, stored: Record<string, unknown>, sent: Record<string, unknown> = {}) =>
  omittedStoredFields(kind, stored, sent).map((omitted) => omitted.key);

describe("omittedStoredFields", () => {
  it("clears a project's deadline but keeps private and prerequisites", () => {
    const stored = {
      internalDeadlineAt: "2026-11-20T00:00:00.000Z",
      private: true,
      prerequisites: [{ kind: "action", id: "a" }]
    };
    expect(omittedStoredFields("project", stored, {})).toEqual([{ key: "internalDeadlineAt", becomes: null }]);
  });

  it("keeps an action's notes, private and prepForCommitmentId, and clears its dates", () => {
    const stored = {
      notes: "call first",
      private: true,
      prepForCommitmentId: "c1",
      completedAt: "2026-10-01T00:00:00.000Z",
      deadlineAt: "2026-11-01T00:00:00.000Z",
      schedulingMode: "recurring"
    };
    expect(omittedStoredFields("action", stored, {})).toEqual([
      { key: "deadlineAt", becomes: null },
      { key: "schedulingMode", becomes: "one_off" }
    ]);
  });

  it("keeps a commitment's presence and shareToCalendar, and clears its location", () => {
    const stored = {
      presence: "anchor",
      shareToCalendar: true,
      promptPolicy: "silent",
      contactId: "k",
      location: "Cafe"
    };
    expect(omittedStoredFields("commitment", stored, {})).toEqual([{ key: "location", becomes: null }]);
  });

  it("clears an area's description but keeps private", () => {
    expect(omittedStoredFields("area", { description: "d", private: true }, {})).toEqual([
      { key: "description", becomes: null }
    ]);
  });

  it("clears an outcome's deadline and review date", () => {
    expect(keys("outcome", { deadlineAt: "2026-11-01T00:00:00.000Z", reviewOn: "2026-12-01" })).toEqual([
      "deadlineAt",
      "reviewOn"
    ]);
  });

  it("resets a deliverable's defaults, skipping one already at its default, and keeps private", () => {
    const stored = {
      status: "ready",
      uncertainty: "some",
      importance: 5,
      private: true,
      details: "x",
      steps: [{ id: "s" }]
    };
    expect(omittedStoredFields("deliverable", stored, {})).toEqual([
      { key: "details", becomes: null },
      { key: "status", becomes: "needs_breakdown" },
      { key: "importance", becomes: 3 },
      { key: "steps", becomes: null }
    ]);
  });

  it("resets a routine step's defaults and clears its links", () => {
    const stored = {
      status: "completed",
      phase: "after",
      contexts: ["desk"],
      scheduledStartAt: "2026-10-01T00:00:00.000Z"
    };
    expect(omittedStoredFields("routine_step", stored, {})).toEqual([
      { key: "status", becomes: "pending" },
      { key: "contexts", becomes: null },
      { key: "phase", becomes: "before" }
    ]);
  });

  it("resets a routine preset's activity name to the sent name", () => {
    const stored = { activityName: "Gym", status: "archived", replacesWakeRoutine: true };
    expect(omittedStoredFields("routine_preset", stored, { name: "Workout" })).toEqual([
      { key: "activityName", becomes: "Workout" },
      { key: "status", becomes: "active" },
      { key: "replacesWakeRoutine", becomes: false }
    ]);
  });

  it("clears a span's window and project", () => {
    expect(keys("span", { window: { localStartTime: "09:00", localEndTime: "10:00" }, projectId: "p" })).toEqual([
      "window",
      "projectId"
    ]);
  });

  it("resets a condition definition's defaults, clears its place, and keeps oneOff", () => {
    const stored = { status: "archived", portability: "portable", latitude: 1, oneOff: true, setupBeforeMinutes: 5 };
    expect(omittedStoredFields("condition_definition", stored, {})).toEqual([
      { key: "status", becomes: "active" },
      { key: "portability", becomes: "fixed" },
      { key: "latitude", becomes: null },
      { key: "setupBeforeMinutes", becomes: 0 }
    ]);
  });

  it("resets a capture's proposed fields and clears reviewedAt", () => {
    expect(
      omittedStoredFields("capture", { proposedFields: { text: "x" }, reviewedAt: "2026-10-01T00:00:00.000Z" }, {})
    ).toEqual([
      { key: "proposedFields", becomes: {} },
      { key: "reviewedAt", becomes: null }
    ]);
    expect(keys("capture", { proposedFields: {} })).toEqual([]);
  });

  it("clears a planning focus's projects, a daily plan's lists and an availability's conditions", () => {
    expect(keys("planning_focus", { projectIds: ["p"] })).toEqual(["projectIds"]);
    expect(
      keys("daily_plan", { desiredActionIds: ["a"], deferredItems: [{ actionId: "b" }], recoverySkipped: true })
    ).toEqual(["desiredActionIds", "deferredItems"]);
    expect(keys("current_availability", { assertedConditions: ["desk"], currentEnergy: "high" })).toEqual([
      "assertedConditions"
    ]);
  });

  it("changes nothing for singleton, append-only and review kinds", () => {
    for (const kind of ["settings", "sleep_plan", "sleep_log_entry", "capture_review", "deliverable_contract_review"])
      expect(keys(kind, { timezone: "x", plannedStartAt: "y", sleepAt: "z", draft: "d", decision: "confirm" })).toEqual(
        []
      );
  });

  it("ignores a field the request sends and a kind it does not know", () => {
    expect(keys("project", { internalDeadlineAt: "2026-11-20T00:00:00.000Z" }, { internalDeadlineAt: null })).toEqual(
      []
    );
    expect(keys("nonsense", { a: 1 })).toEqual([]);
  });

  it("keeps a cadence action's deadline and latest start when the save omits them", () => {
    const stored = { id: "a1", deadlineAt: "2026-11-01T00:00:00.000Z", latestStartAt: "2026-10-31T00:00:00.000Z" };
    const keys = omittedStoredFields("action", stored, { id: "a1", schedulingMode: "cadence" }).map((item) => item.key);
    expect(keys).not.toContain("deadlineAt");
    expect(keys).not.toContain("latestStartAt");
  });

  it("clears a commitment's preferred place when it is not remote, and its preset when the source is not preset", () => {
    const stored = {
      attendance: "remote",
      preferredLocationId: "loc-1",
      routineSource: "preset",
      routinePresetId: "p1"
    };
    expect(keys("commitment", stored, { attendance: "remote" })).toEqual([]);
    expect(omittedStoredFields("commitment", stored, { attendance: "in_person", routineSource: "none" })).toEqual([
      { key: "preferredLocationId", becomes: null },
      { key: "routinePresetId", becomes: null }
    ]);
    expect(keys("commitment", stored, { routineSource: "preset" })).toEqual([]);
    // Restating the stored values while switching does not keep them: the save clears them anyway.
    expect(keys("commitment", stored, { ...stored, attendance: "in_person", routineSource: "custom" })).toEqual([
      "preferredLocationId",
      "routinePresetId"
    ]);
    // Attendance left out falls back to the stored one, so a remote commitment keeps its place.
    expect(keys("commitment", stored, {})).toEqual([]);
  });
});

describe("recordInState", () => {
  it("finds a planning focus by its kind and period start, not its id", () => {
    const weekly = { id: "f1", kind: "weekly", periodStart: "2026-10-26", projectIds: ["p1"] };
    const state = { planningFocus: [{ id: "f0", kind: "monthly", periodStart: "2026-10-26" }, weekly] };
    expect(
      recordInState(state, "planning_focus", "anything", { kind: "weekly", periodStart: "2026-10-26T00:00:00Z" })
    ).toBe(weekly);
    expect(recordInState(state, "planning_focus", "f1", { kind: "weekly", periodStart: "2026-11-02" })).toBeUndefined();
  });

  it("finds a logged night as its sleep plan, with the times the log save names", () => {
    const night = {
      id: "n1",
      status: "completed",
      actualStartAt: "2026-10-27T13:00:00Z",
      actualWakeAt: "2026-10-27T21:00:00Z"
    };
    const found = recordInState({ sleepPlans: [night] }, "sleep_log_entry", "n1");
    expect(found).toMatchObject({ sleepAt: night.actualStartAt, wakeAt: night.actualWakeAt });
  });

  it("works out the dependency a routine step save writes when it leaves dependencyIds out", () => {
    const steps = [
      { id: "s0", commitmentId: "c1", phase: "before", sequence: 0, dependencyIds: [] },
      { id: "s1", commitmentId: "c1", phase: "before", sequence: 1, dependencyIds: ["s0"] },
      { id: "s2", commitmentId: "c1", phase: "before", sequence: 2, dependencyIds: [] },
      { id: "a0", commitmentId: "c1", phase: "after", sequence: 0, dependencyIds: [] },
      { id: "x1", commitmentId: "c2", phase: "before", sequence: 1, dependencyIds: [] }
    ];
    const sent = { id: "s2", commitmentId: "c1", sequence: 2, title: "Pack" };
    const stored = recordInState({ routineSteps: steps }, "routine_step", "s2", sent)!;
    expect((stored as Record<symbol, unknown>)[PREVIOUS_STEP]).toEqual(["s1"]);
    // Stored with none, the save gives it the step before: shown as that, not as cleared or unchanged.
    expect(omittedStoredFields("routine_step", stored, sent)).toContainEqual({ key: "dependencyIds", becomes: ["s1"] });
    // Already on the step before: no change.
    const s1 = recordInState({ routineSteps: steps }, "routine_step", "s1", { ...steps[1], dependencyIds: undefined })!;
    const sentS1 = { id: "s1", commitmentId: "c1", sequence: 1 };
    expect(keys("routine_step", s1, sentS1)).not.toContain("dependencyIds");
    // The first step is cleared; without the other steps the derived value is named, not guessed.
    expect(omittedStoredFields("routine_step", steps[1]!, { ...sentS1, sequence: 0 })).toContainEqual({
      key: "dependencyIds",
      becomes: null
    });
    expect(omittedStoredFields("routine_step", { dependencyIds: ["s0"] }, { sequence: 3 })).toContainEqual({
      key: "dependencyIds",
      becomes: "the step before it"
    });
  });
});
