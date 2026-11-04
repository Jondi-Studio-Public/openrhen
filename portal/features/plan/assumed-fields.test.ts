import { describe, expect, it } from "vitest";
import { createSeedState } from "@/state/portal-state";
import { actionDraftFrom } from "@/features/plan/plan-drafts";
import { assumedInDraft, assumedMark, isAssumed } from "@/features/plan/assumed-fields";

const SEED_ZONE = "Australia/Sydney";
const action = {
  ...createSeedState(new Date("2026-08-18T09:00:00.000Z")).actions[0]!,
  expectedMinutes: 60,
  energy: "medium" as const,
  importance: 3
};

describe("isAssumed and assumedMark", () => {
  it("say yes only for a field the action lists", () => {
    const listed = { ...action, assumedFields: ["expectedMinutes"] };
    expect(isAssumed(listed, "expectedMinutes")).toBe(true);
    expect(isAssumed(listed, "energy")).toBe(false);
    expect(isAssumed(action, "expectedMinutes")).toBe(false);
    expect(isAssumed(undefined, "energy")).toBe(false);
  });

  it("add a word after a value the action lists and nothing after the rest", () => {
    const listed = { ...action, assumedFields: ["energy"] };
    expect(assumedMark(listed, "energy")).toBe(" (assumed)");
    expect(assumedMark(listed, "remainingMinutes")).toBe("");
  });
});

describe("assumedInDraft", () => {
  const stored = { ...action, assumedFields: ["expectedMinutes", "energy", "importance", "status"] };

  it("labels a listed field whose value the draft still has", () => {
    const draft = actionDraftFrom(stored, SEED_ZONE);
    expect([...assumedInDraft(stored, draft)].sort()).toEqual(["energy", "expectedMinutes", "importance"]);
  });

  it("stops labelling a field as soon as its value is changed", () => {
    const draft = { ...actionDraftFrom(stored, SEED_ZONE), expectedMinutes: stored.expectedMinutes + 15 };
    expect([...assumedInDraft(stored, draft)].sort()).toEqual(["energy", "importance"]);
  });

  it("labels nothing for a new action or one with nothing listed", () => {
    expect(assumedInDraft(undefined, actionDraftFrom(stored, SEED_ZONE)).size).toBe(0);
    expect(assumedInDraft(action, actionDraftFrom(action, SEED_ZONE)).size).toBe(0);
  });
});
