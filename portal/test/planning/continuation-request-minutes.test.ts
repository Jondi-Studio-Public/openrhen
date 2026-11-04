import { describe, expect, it } from "vitest";
import { CONTINUATION_FLOOR_MINUTES, continuationRequestMinutes } from "@openrhen/database";

const facts = {
  actions: [
    { id: "action-short", minimumSessionMinutes: 10 },
    { id: "action-long", minimumSessionMinutes: 40 },
    { id: "action-recurring", minimumSessionMinutes: 20 }
  ],
  occurrences: [{ id: "occurrence-today", actionId: "action-recurring" }],
  deliverables: [
    { id: "deliverable-25", minimumUsefulSessionMinutes: 25 },
    { id: "deliverable-5", minimumUsefulSessionMinutes: 5 },
    { id: "deliverable-unknown", minimumUsefulSessionMinutes: null }
  ]
};

describe("continuationRequestMinutes", () => {
  it("keeps the familiar 15-minute step for work that can resume in less", () => {
    expect(CONTINUATION_FLOOR_MINUTES).toBe(15);
    expect(continuationRequestMinutes("action-short", facts)).toBe(15);
    expect(continuationRequestMinutes("deliverable-5", facts)).toBe(15);
  });

  it("asks for the target's own minimum when that is longer, which is the only request that can succeed", () => {
    expect(continuationRequestMinutes("action-long", facts)).toBe(40);
    expect(continuationRequestMinutes("deliverable-25", facts)).toBe(25);
  });

  it("reads a recurring session's limits from the template action, not the occurrence", () => {
    expect(continuationRequestMinutes("occurrence-today", facts)).toBe(20);
  });

  it("falls back to 15 for a deliverable with no measured minimum and for an unknown target", () => {
    expect(continuationRequestMinutes("deliverable-unknown", facts)).toBe(15);
    expect(continuationRequestMinutes("nothing-here", facts)).toBe(15);
  });
});
