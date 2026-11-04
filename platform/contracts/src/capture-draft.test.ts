import { describe, expect, it } from "vitest";
import { captureDraftFromSaved, captureDraftIssue } from "./capture-draft.js";

const lookup = {
  areas: [{ id: "area-1" }],
  outcomes: [{ id: "outcome-1" }],
  projects: [{ id: "project-1" }]
};

function draft(overrides: Record<string, unknown> = {}) {
  return { proposalType: "action", ...captureDraftFromSaved({}, "Buy milk"), projectId: "project-1", ...overrides };
}

describe("captureDraftFromSaved", () => {
  it("opens on the capture text and the editor defaults when nothing was saved", () => {
    expect(captureDraftFromSaved({}, "Buy milk")).toEqual({
      title: "Buy milk",
      notes: "",
      areaId: "",
      outcomeId: "",
      projectId: "",
      definitionOfDone: "",
      value: 3,
      internalDeadlineAt: "",
      externalDeadlineAt: "",
      expectedMinutes: 30,
      pessimisticMinutes: 45,
      energy: "medium",
      startsAt: "",
      endsAt: "",
      location: "",
      locationId: ""
    });
  });

  it("keeps saved fields, falls back on a bad energy, and shapes dates with the caller's function", () => {
    const result = captureDraftFromSaved(
      { title: "Saved", value: 5, energy: "sparkly", startsAt: "2026-10-09T15:00:00.000Z", endsAt: 7 },
      "Buy milk",
      (value) => value.slice(0, 16)
    );
    expect(result).toMatchObject({
      title: "Saved",
      value: 5,
      energy: "medium",
      startsAt: "2026-10-09T15:00",
      endsAt: ""
    });
  });
});

describe("captureDraftIssue", () => {
  it("accepts a complete draft", () => {
    expect(captureDraftIssue(lookup, draft())).toBeNull();
  });

  it.each([
    ["unclassified", { proposalType: "unclassified" }],
    ["title_missing", { title: "  " }],
    ["value_out_of_range", { value: 6 }],
    ["outcome_needs_area_and_done", { proposalType: "outcome", areaId: "area-1" }],
    ["project_needs_outcome", { proposalType: "project" }],
    ["action_needs_project", { projectId: "" }],
    ["deliverable_needs_project", { proposalType: "deliverable", projectId: "" }],
    ["commitment_needs_times", { proposalType: "fixed_commitment" }],
    [
      "commitment_ends_before_start",
      { proposalType: "fixed_commitment", startsAt: "2026-10-09T10:00:00Z", endsAt: "2026-10-09T09:00:00Z" }
    ],
    [
      "internal_after_external",
      { internalDeadlineAt: "2026-10-10T00:00:00Z", externalDeadlineAt: "2026-10-09T00:00:00Z" }
    ],
    ["action_estimates_invalid", { expectedMinutes: 30, pessimisticMinutes: 10 }],
    ["area_missing", { areaId: "gone" }],
    ["outcome_missing", { outcomeId: "gone" }],
    ["project_missing", { projectId: "gone" }]
  ])("reports %s", (issue, overrides) => {
    expect(captureDraftIssue(lookup, draft(overrides))).toBe(issue);
  });
});
