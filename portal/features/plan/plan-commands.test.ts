import { saveActionCommandSchema } from "@openrhen/contracts";
import { describe, expect, it } from "vitest";
import { createSeedState, type StoredAction } from "@/state/portal-state";
import { emptyAction, emptyArea, emptyProject, type ActionDraft } from "@/features/plan/plan-drafts";
import { deliverable, step } from "@/features/deliverables/test-fixtures";
import {
  actionCommand,
  areaCommand,
  cadenceCompletionCommand,
  createsDependencyCycle,
  deliverableCommand,
  deliverableUpdateCommand,
  outcomeCommand,
  projectCommand,
  recurrenceGoalEndCommand,
  validateActionDraft,
  validateAreaDraft,
  validateDeliverableDraft,
  validateOutcomeDraft,
  validateProjectDraft
} from "@/features/plan/plan-commands";

const seed = () => createSeedState(new Date("2026-08-18T09:00:00.000Z"));
// `createSeedState` defaults `settings.timezone` to this, so every `seed()`-backed command below
// converts a `datetime-local` draft value against seed-zone, not the machine running the test.
const SEED_ZONE = "Australia/Sydney";
const deliverableDraft = () => ({
  externalDeadlineAt: "",
  internalDeadlineAt: "",
  uncertainty: "some" as const,
  dependencyIds: [] as string[],
  importance: 3,
  consequence: 3,
  private: false
});
const outcomeDraft = () => ({
  id: "",
  areaId: "area-home",
  title: "Calm bedroom",
  definitionOfDone: "Floor clear",
  value: 3,
  status: "active" as const,
  deadlineAt: "",
  reviewOn: ""
});
const recurringDraft = (overrides: Partial<ActionDraft> = {}): ActionDraft => ({
  ...emptyAction(SEED_ZONE),
  projectId: "clean-room",
  title: "Practise scales",
  schedulingMode: "recurring",
  recurrenceStart: "2026-08-01",
  recurrenceEnd: "2026-10-01",
  ...overrides
});

describe("plan command validation", () => {
  it("requires an area name and refuses a name another area already uses", () => {
    const state = seed();
    expect(validateAreaDraft({ ...emptyArea(), name: "  " }, state.areas)).toBe("Area name is required.");
    expect(validateAreaDraft({ ...emptyArea(), name: "study" }, state.areas)).toBe("Area names must be unique.");
    expect(validateAreaDraft({ ...emptyArea(), name: "Music" }, state.areas)).toBeNull();
  });

  it("lets an area keep its own name while being edited", () => {
    const state = seed();
    const existing = state.areas[0]!;
    expect(
      validateAreaDraft(
        { id: existing.id, name: existing.name, description: "", status: "active", private: false },
        state.areas
      )
    ).toBeNull();
  });

  it("asks for the three things an outcome cannot be understood without", () => {
    expect(validateOutcomeDraft({ ...outcomeDraft(), areaId: "" })).toBe(
      "Outcome area, title, and definition of done are required."
    );
    expect(validateOutcomeDraft(outcomeDraft())).toBeNull();
  });

  it("refuses an internal deadline that falls after the external one", () => {
    const draft = {
      ...emptyProject(),
      outcomeId: "outcome-room",
      title: "Tidy",
      internalDeadlineAt: "2026-09-10T09:00",
      externalDeadlineAt: "2026-09-01T09:00"
    };
    expect(validateProjectDraft(draft, SEED_ZONE)).toBe("The internal deadline cannot be after the external deadline.");
    expect(validateProjectDraft({ ...draft, internalDeadlineAt: "2026-08-25T09:00" }, SEED_ZONE)).toBeNull();
  });

  it("holds the effort estimates in order and inside the pessimistic bound", () => {
    const base = { ...emptyAction(SEED_ZONE), projectId: "clean-room", title: "Sweep" };
    expect(validateActionDraft({ ...base, optimisticMinutes: 20 }, [])).toBe(
      "Effort must follow optimistic ≤ expected ≤ pessimistic."
    );
    expect(validateActionDraft({ ...base, remainingMinutes: 999 }, [])).toBe(
      "Remaining effort must be between zero and the pessimistic estimate."
    );
    expect(validateActionDraft({ ...base, minimumSessionMinutes: 60 }, [])).toBe(
      "Minimum session length cannot exceed the maximum."
    );
    expect(validateActionDraft(base, [])).toBeNull();
  });

  it("refuses dependencies that would make an action wait on itself", () => {
    const actions = seed().actions;
    const draft = { ...emptyAction(SEED_ZONE), id: "room-floor", projectId: "clean-room", title: "Sort floor" };
    const cyclic: StoredAction[] = actions.map((item) =>
      item.id === "networking-section-one" ? { ...item, dependencyIds: ["room-floor"] } : item
    );
    expect(validateActionDraft({ ...draft, dependencyIds: ["networking-section-one"] }, cyclic)).toBe(
      "Those dependencies would create a cycle."
    );
    expect(validateActionDraft({ ...draft, dependencyIds: ["networking-section-one"] }, actions)).toBeNull();
  });

  it("needs both a project and a title before a deliverable can be registered", () => {
    expect(validateDeliverableDraft({ ...deliverableDraft(), projectId: "", title: "Assessment" }, SEED_ZONE)).toBe(
      "A deliverable needs a project and a title."
    );
    expect(
      validateDeliverableDraft({ ...deliverableDraft(), projectId: "clean-room", title: "Assessment" }, SEED_ZONE)
    ).toBeNull();
  });
});

describe("plan command payloads", () => {
  it("puts a new area last and saves it against no expected version", () => {
    const state = seed();
    const command = areaCommand({ ...emptyArea(), name: " Music ", description: " Practice " }, state);
    expect(command.expectedVersion).toBeNull();
    expect(command.entity).toMatchObject({ name: "Music", description: "Practice", sortOrder: state.areas.length });
  });

  it("keeps an edited area in its existing position", () => {
    const state = seed();
    const existing = state.areas[1]!;
    const command = areaCommand(
      { id: existing.id, name: "Renamed", description: "", status: "paused", private: false },
      state
    );
    expect(command.entity).toMatchObject({ id: existing.id, sortOrder: existing.sortOrder, status: "paused" });
    expect(command.entity.description).toBeUndefined();
  });

  it("omits an outcome review date rather than sending an empty one", () => {
    const command = outcomeCommand({ ...outcomeDraft(), reviewOn: "" }, seed());
    expect(command.entity.reviewOn).toBeUndefined();
    expect(outcomeCommand({ ...outcomeDraft(), reviewOn: "2026-09-01" }, seed()).entity.reviewOn).toBe("2026-09-01");
  });

  it("sends a project effort override as a number and leaves it out when blank", () => {
    const draft = { ...emptyProject(), outcomeId: "outcome-room", title: "Tidy" };
    expect(projectCommand(draft, seed()).project.remainingEffortOverrideMinutes).toBeUndefined();
    expect(
      projectCommand({ ...draft, remainingEffortOverrideMinutes: "240" }, seed()).project.remainingEffortOverrideMinutes
    ).toBe(240);
  });

  it("always sends private, explicitly, on area/project/action saves", () => {
    expect(areaCommand({ ...emptyArea(), name: "Music" }, seed()).entity.private).toBe(false);
    expect(areaCommand({ ...emptyArea(), name: "Music", private: true }, seed()).entity.private).toBe(true);
    const projectDraft = { ...emptyProject(), outcomeId: "outcome-room", title: "Tidy", private: true };
    expect(projectCommand(projectDraft, seed()).project.private).toBe(true);
    const actionDraft = { ...emptyAction(SEED_ZONE), projectId: "clean-room", title: "Sweep", private: true };
    expect(actionCommand(actionDraft, seed()).action.private).toBe(true);
  });

  it("sends notes explicitly, empty included, since absent now means keep the stored notes", () => {
    const draft = { ...emptyAction(SEED_ZONE), projectId: "clean-room", title: "Sweep" };
    expect(actionCommand({ ...draft, notes: "  Behind the door  " }, seed()).action.notes).toBe("Behind the door");
    expect(actionCommand({ ...draft, notes: "   " }, seed()).action.notes).toBe("");
  });

  it("keeps the flat context list in step with the first pathway", () => {
    const draft = {
      ...emptyAction(SEED_ZONE),
      projectId: "clean-room",
      title: "Sweep",
      pathways: [["home", "quiet"], [], ["outdoors"]]
    };
    const command = actionCommand(draft, seed());
    expect(command.action.contexts).toEqual(["home", "quiet"]);
    expect(command.action.requirementPathways).toEqual([["home", "quiet"], ["outdoors"]]);
  });

  it("gives a recurring action both anchored windows with their fallback times", () => {
    const command = actionCommand(recurringDraft({ morningFallbackStart: "06:30" }), seed());
    const windows = command.action.recurrence?.windows ?? [];
    expect(windows.map((window) => window.name)).toEqual(["Morning", "Bedtime"]);
    expect(windows[0]).toMatchObject({ anchor: "wake", fallback: { startTime: "06:30", endTime: "08:00" } });
    expect(windows[1]).toMatchObject({ anchor: "sleep_start", fallback: { startTime: "20:00", endTime: "21:00" } });
  });

  it("carries an end date only for a series that ends on one", () => {
    expect(actionCommand(recurringDraft(), seed()).action.recurrence?.endDate).toBe("2026-10-01");
    const goal = actionCommand(recurringDraft({ completionMode: "total_minutes", targetTotalMinutes: "600" }), seed())
      .action.recurrence;
    expect(goal?.endDate).toBeUndefined();
    expect(goal?.targetTotalMinutes).toBe(600);
    expect(actionCommand(recurringDraft({ completionMode: "manual" }), seed()).action.recurrence?.endDate).toBe(
      undefined
    );
  });

  it("gives cadence an interval and no windows, ending only when marked complete", () => {
    const command = actionCommand(
      recurringDraft({ schedulingMode: "cadence", intervalDays: "3", completionMode: "manual" }),
      seed()
    );
    expect(command.action.schedulingMode).toBe("cadence");
    expect(command.action.recurrence).toMatchObject({
      startDate: "2026-08-01",
      intervalDays: 3,
      completionMode: "manual",
      windows: []
    });
    expect(command.action.recurrence?.endDate).toBeUndefined();
  });

  it("refuses cadence without a whole number of days between suggestions", () => {
    expect(validateActionDraft(recurringDraft({ schedulingMode: "cadence", intervalDays: "0" }), [])).toMatch(
      /whole number of days/
    );
    expect(validateActionDraft(recurringDraft({ schedulingMode: "cadence", intervalDays: "1.5" }), [])).toMatch(
      /whole number of days/
    );
    expect(validateActionDraft(recurringDraft({ schedulingMode: "cadence", intervalDays: "2" }), [])).toBeNull();
  });

  it("gives a period cadence rule a period, a target, and no plain interval role", () => {
    const command = actionCommand(
      recurringDraft({
        schedulingMode: "cadence",
        completionMode: "manual",
        periodUnit: "days",
        periodLength: "7",
        targetOccurrences: "2",
        minSpacingDays: "3",
        eligibleWeekdays: [1, 3, 5]
      }),
      seed()
    );
    expect(command.action.recurrence).toMatchObject({
      period: { unit: "days", length: 7 },
      targetOccurrences: 2,
      minSpacingDays: 3,
      eligibleWeekdays: [1, 3, 5],
      windows: []
    });
  });

  it("gives a calendar-month cadence rule a month period and no length", () => {
    const command = actionCommand(
      recurringDraft({
        schedulingMode: "cadence",
        completionMode: "manual",
        periodUnit: "month",
        targetOccurrences: "1"
      }),
      seed()
    );
    expect(command.action.recurrence?.period).toEqual({ unit: "month" });
    expect(command.action.recurrence?.targetOccurrences).toBe(1);
  });

  it("leaves period fields off a plain-interval cadence rule, unchanged from before", () => {
    const command = actionCommand(
      recurringDraft({
        schedulingMode: "cadence",
        intervalDays: "3",
        completionMode: "manual",
        periodUnit: "interval"
      }),
      seed()
    );
    expect(command.action.recurrence?.period).toBeUndefined();
    expect(command.action.recurrence?.targetOccurrences).toBeUndefined();
    expect(command.action.recurrence?.intervalDays).toBe(3);
  });

  it("omits minSpacingDays and eligibleWeekdays from a period rule that never set them", () => {
    const command = actionCommand(
      recurringDraft({
        schedulingMode: "cadence",
        completionMode: "manual",
        periodUnit: "days",
        periodLength: "7",
        targetOccurrences: "2"
      }),
      seed()
    );
    expect(command.action.recurrence?.minSpacingDays).toBeUndefined();
    expect(command.action.recurrence?.eligibleWeekdays).toBeUndefined();
  });

  it("refuses a period whose minimum spacing cannot fit the target occurrences", () => {
    expect(
      validateActionDraft(
        recurringDraft({
          schedulingMode: "cadence",
          periodUnit: "days",
          periodLength: "7",
          targetOccurrences: "3",
          minSpacingDays: "3"
        }),
        []
      )
    ).toMatch(/does not fit within the period/);
    expect(
      validateActionDraft(
        recurringDraft({
          schedulingMode: "cadence",
          periodUnit: "days",
          periodLength: "7",
          targetOccurrences: "2",
          minSpacingDays: "3"
        }),
        []
      )
    ).toBeNull();
  });

  it("refuses a period rule without a whole positive target occurrence count", () => {
    expect(
      validateActionDraft(
        recurringDraft({ schedulingMode: "cadence", periodUnit: "days", periodLength: "7", targetOccurrences: "0" }),
        []
      )
    ).toMatch(/whole number/);
  });

  it("leaves recurrence off a one-off action entirely", () => {
    const command = actionCommand({ ...emptyAction(SEED_ZONE), projectId: "clean-room", title: "Sweep" }, seed());
    expect(command.action.recurrence).toBeUndefined();
    expect(command.action.schedulingMode).toBe("one_off");
  });

  it("registers a deliverable as an empty shell that still needs breaking down", () => {
    const state = seed();
    const command = deliverableCommand(
      { ...deliverableDraft(), projectId: "clean-room", title: "Assessment 2" },
      state
    );
    expect(command.entityType).toBe("deliverable");
    expect(command.entity).toMatchObject({
      status: "needs_breakdown",
      steps: [],
      criteria: [],
      sortOrder: state.deliverables.length
    });
    expect(command.entity.externalDeadlineAt).toBeUndefined();
  });

  it("registers the planning metadata the form now carries", () => {
    const command = deliverableCommand(
      {
        ...deliverableDraft(),
        projectId: "clean-room",
        title: "Assessment 2",
        externalDeadlineAt: "2026-09-01T17:00",
        internalDeadlineAt: "2026-08-30T17:00",
        uncertainty: "high",
        dependencyIds: ["assessment-1"]
      },
      seed()
    );
    expect(command.entity).toMatchObject({
      uncertainty: "high",
      dependencyIds: ["assessment-1"],
      // 17:00 local (AEST, +10) in September is 07:00 UTC.
      externalDeadlineAt: "2026-09-01T07:00:00.000Z",
      internalDeadlineAt: "2026-08-30T07:00:00.000Z"
    });
  });

  it("updates only a registered deliverable's planning metadata and carries the rest of the aggregate", () => {
    const stored = deliverable({
      version: 4,
      externalDeadlineAt: "2026-09-01T07:00:00.000Z",
      internalDeadlineAt: "2026-08-30T07:00:00.000Z",
      steps: [step("draft")],
      dependencyIds: ["assessment-1"]
    });
    const command = deliverableUpdateCommand(
      stored,
      {
        ...deliverableDraft(),
        projectId: stored.projectId,
        title: stored.title,
        externalDeadlineAt: "2026-09-05T17:00",
        internalDeadlineAt: "",
        uncertainty: "known",
        dependencyIds: [],
        importance: 4,
        consequence: 2
      },
      SEED_ZONE
    );
    expect(command.expectedVersion).toBe(4);
    expect(command.entity).toMatchObject({
      id: "assessment-2",
      status: "in_progress",
      contractVersion: 1,
      planVersion: 1,
      uncertainty: "known",
      importance: 4,
      consequence: 2,
      dependencyIds: [],
      // 17:00 local (AEST, +10) in September is 07:00 UTC.
      externalDeadlineAt: "2026-09-05T07:00:00.000Z"
    });
    // A cleared date is omitted, not sent as null, and the steps travel untouched.
    expect("internalDeadlineAt" in command.entity).toBe(false);
    expect((command.entity.steps as unknown[]).length).toBe(1);
  });

  it("refuses an internal deadline after the external one, and a deliverable depending on itself", () => {
    expect(
      validateDeliverableDraft(
        {
          ...deliverableDraft(),
          projectId: "clean-room",
          title: "Assessment 2",
          externalDeadlineAt: "2026-09-01T17:00",
          internalDeadlineAt: "2026-09-02T17:00"
        },
        SEED_ZONE
      )
    ).toBe("The internal deadline cannot be after the external deadline.");
    expect(
      validateDeliverableDraft(
        { ...deliverableDraft(), projectId: "clean-room", title: "Assessment 2", dependencyIds: ["self"] },
        SEED_ZONE,
        "self"
      )
    ).toBe("A deliverable cannot depend on itself.");
  });
});

describe("saveActionCommandSchema requirementPathways", () => {
  // commit e361ef7: each route may arrive as a bare string[] or as the read shape's
  // { id, contextIds } object, so a caller that merges a stored action straight back into a write
  // payload does not have to convert.
  const baseAction = {
    id: "action-sweep",
    projectId: "project-clean",
    title: "Sweep",
    status: "planned" as const,
    optimisticMinutes: 10,
    expectedMinutes: 20,
    pessimisticMinutes: 30,
    remainingMinutes: 20,
    energy: "medium" as const,
    minimumSessionMinutes: 10,
    maximumSessionMinutes: 30,
    splittable: true,
    setupMinutes: 0,
    importance: 3,
    consequence: 3,
    contexts: ["home"],
    dependencyIds: [] as string[]
  };
  const command = (requirementPathways: unknown) => ({
    expectedVersion: null,
    action: { ...baseAction, requirementPathways }
  });

  it("accepts routes given as bare string[]", () => {
    const parsed = saveActionCommandSchema.safeParse(command([["home", "quiet"], ["outdoors"]]));
    expect(parsed.success).toBe(true);
  });

  it("accepts routes given as the read shape's { id, contextIds }", () => {
    const parsed = saveActionCommandSchema.safeParse(
      command([
        { id: "p1", contextIds: ["home", "quiet"] },
        { id: "p2", contextIds: ["outdoors"] }
      ])
    );
    expect(parsed.success).toBe(true);
  });

  it("accepts a mix of both shapes in the same route list", () => {
    const parsed = saveActionCommandSchema.safeParse(command([["home"], { id: "p1", contextIds: ["outdoors"] }]));
    expect(parsed.success).toBe(true);
  });

  it("rejects an empty route in either shape", () => {
    expect(saveActionCommandSchema.safeParse(command([[]])).success).toBe(false);
    expect(saveActionCommandSchema.safeParse(command([{ id: "p1", contextIds: [] }])).success).toBe(false);
  });

  it("accepts an empty pathway list, and omitting the field entirely", () => {
    expect(saveActionCommandSchema.safeParse(command([])).success).toBe(true);
    expect(saveActionCommandSchema.safeParse({ expectedVersion: null, action: baseAction }).success).toBe(true);
  });
});

describe("dependency cycles", () => {
  it("finds a cycle that only exists because of the proposed dependency", () => {
    const actions: StoredAction[] = seed().actions.map((item) =>
      item.id === "networking-section-one" ? { ...item, dependencyIds: ["room-floor"] } : item
    );
    expect(createsDependencyCycle("room-floor", ["networking-section-one"], actions)).toBe(true);
    expect(createsDependencyCycle("room-floor", [], actions)).toBe(false);
  });
});

describe("recurrenceGoalEndCommand", () => {
  it("claims the action's own version and names the action id", () => {
    const state = seed();
    const action = { ...state.actions[0]!, version: 5 };
    const command = recurrenceGoalEndCommand(action);
    expect(command.expectedVersion).toBe(5);
    expect(command.type).toBe("end_recurrence_goal");
    expect(command.actionId).toBe(action.id);
  });

  it("saves against no expected version when the action has never been stored", () => {
    const state = seed();
    const action = { ...state.actions[0]!, version: undefined };
    const command = recurrenceGoalEndCommand(action);
    expect(command.expectedVersion).toBeNull();
  });
});

describe("cadenceCompletionCommand", () => {
  it("claims the action's own version and names the action id", () => {
    const state = seed();
    const action = { ...state.actions[0]!, version: 7 };
    const command = cadenceCompletionCommand(action);
    expect(command.expectedVersion).toBe(7);
    expect(command.type).toBe("record_cadence_completion");
    expect(command.actionId).toBe(action.id);
  });

  it("saves against no expected version when the action has never been stored", () => {
    const state = seed();
    const action = { ...state.actions[0]!, version: undefined };
    const command = cadenceCompletionCommand(action);
    expect(command.expectedVersion).toBeNull();
  });
});
