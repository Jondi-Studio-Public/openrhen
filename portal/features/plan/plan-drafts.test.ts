import { describe, expect, it } from "vitest";
import { createSeedState, type StoredAction } from "@/state/portal-state";
import {
  actionDraftFrom,
  areaDraftFrom,
  deliverableDraftFrom,
  emptyAction,
  outcomeDraftFrom,
  projectDraftFrom
} from "@/features/plan/plan-drafts";

const seed = () => createSeedState(new Date("2026-08-18T09:00:00.000Z"));
const SEED_ZONE = "Australia/Sydney";

describe("plan drafts", () => {
  it("offers a fresh action a default way of doing it and a bounded default series", () => {
    const draft = emptyAction(SEED_ZONE);
    expect(draft.pathways).toEqual([["home"]]);
    expect(draft.schedulingMode).toBe("one_off");
    const days = (Date.parse(draft.recurrenceEnd!) - Date.parse(draft.recurrenceStart!)) / 86_400_000;
    expect(days).toBe(56);
  });

  it("keeps the stored description and status when an area is loaded for editing", () => {
    const area = { ...seed().areas[0]!, description: undefined };
    expect(areaDraftFrom(area)).toMatchObject({ id: area.id, name: area.name, description: "", status: "active" });
  });

  it("shows an outcome without a review date as an empty review field", () => {
    const outcome = seed().outcomes[0]!;
    expect(outcomeDraftFrom(outcome, SEED_ZONE).reviewOn).toBe("");
    expect(outcomeDraftFrom(outcome, SEED_ZONE).definitionOfDone).toBe(outcome.definitionOfDone);
  });

  it("presents a missing effort override as an empty box rather than a zero", () => {
    const project = seed().projects[1]!;
    expect(projectDraftFrom(project, SEED_ZONE).remainingEffortOverrideMinutes).toBe("");
    expect(
      projectDraftFrom({ ...project, remainingEffortOverrideMinutes: 240 }, SEED_ZONE).remainingEffortOverrideMinutes
    ).toBe("240");
  });

  it("falls back to the flat context list when an action has no requirement pathways", () => {
    const action = seed().actions[0]!;
    expect(actionDraftFrom(action, SEED_ZONE).pathways).toEqual([action.contexts]);
  });

  it("prefers the stored requirement pathways over the flat list", () => {
    const action: StoredAction = {
      ...seed().actions[0]!,
      contexts: ["laptop"],
      requirementPathways: [
        { id: "route-one", contextIds: ["laptop", "quiet"] },
        { id: "route-two", contextIds: ["library"] }
      ]
    };
    expect(actionDraftFrom(action, SEED_ZONE).pathways).toEqual([["laptop", "quiet"], ["library"]]);
  });

  it("reads the fallback clock times back out of the named recurrence windows", () => {
    const action: StoredAction = {
      ...seed().actions[0]!,
      schedulingMode: "recurring",
      recurrence: {
        id: "rule",
        actionId: "networking-section-one",
        timezone: "Australia/Sydney",
        startDate: "2026-08-01",
        intervalDays: 1,
        completionMode: "total_minutes",
        targetTotalMinutes: 600,
        accumulatedMinutes: 30,
        windows: [
          { id: "m", name: "Morning", anchor: "wake", fallback: { startTime: "06:00", endTime: "09:00" } },
          { id: "b", name: "Bedtime", anchor: "sleep_start", fallback: { startTime: "21:00", endTime: "22:00" } }
        ]
      }
    };
    const draft = actionDraftFrom(action, SEED_ZONE);
    expect(draft.morningFallbackStart).toBe("06:00");
    expect(draft.bedtimeFallbackEnd).toBe("22:00");
    expect(draft.completionMode).toBe("total_minutes");
    expect(draft.targetTotalMinutes).toBe("600");
  });

  it("reads a registered deliverable out of its uncontrolled form, trimming the title", () => {
    const form = new FormData();
    form.set("projectId", "clean-room");
    form.set("title", "  Assessment 2  ");
    form.set("externalDeadlineAt", "2026-09-01T17:00");
    expect(deliverableDraftFrom(form)).toEqual({
      projectId: "clean-room",
      title: "Assessment 2",
      externalDeadlineAt: "2026-09-01T17:00",
      internalDeadlineAt: "",
      uncertainty: "some",
      dependencyIds: [],
      prerequisites: [],
      importance: 3,
      consequence: 3,
      private: false
    });
    form.set("internalDeadlineAt", "2026-08-30T17:00");
    form.set("uncertainty", "high");
    form.append("dependencyIds", "assessment-1");
    form.append("dependencyIds", "");
    form.append("dependencyIds", "reading");
    expect(deliverableDraftFrom(form)).toMatchObject({
      internalDeadlineAt: "2026-08-30T17:00",
      uncertainty: "high",
      dependencyIds: ["assessment-1", "reading"]
    });
    form.set("uncertainty", "nonsense");
    expect(deliverableDraftFrom(form).uncertainty).toBe("some");
  });
});
