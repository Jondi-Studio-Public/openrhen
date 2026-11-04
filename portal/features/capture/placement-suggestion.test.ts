import { describe, expect, it } from "vitest";
import { placementSuggestion } from "./placement-suggestion";

const state = { projects: [{ id: "p1", title: "Garden shed" }] } as never;
const item = (placementSuggestion: unknown, status = "pending") =>
  ({ status, proposedFields: { placementSuggestion } }) as never;

describe("placementSuggestion", () => {
  it("names the project, the reason and who suggested it", () => {
    expect(
      placementSuggestion(item({ projectId: "p1", proposer: "rule:capture-words", reason: "Shared words." }), state)
    ).toEqual({
      projectId: "p1",
      projectTitle: "Garden shed",
      reason: "Shared words.",
      by: "rules"
    });
    expect(
      placementSuggestion(item({ projectId: "p1", proposer: "model:capture-placement", reason: "r" }), state)?.by
    ).toBe("local model");
  });

  it("has nothing for a missing, unknown or already decided suggestion", () => {
    expect(placementSuggestion(item(undefined), state)).toBeNull();
    expect(placementSuggestion(item({ projectId: "gone", reason: "r" }), state)).toBeNull();
    expect(placementSuggestion(item({ projectId: "p1", reason: "r" }, "confirmed"), state)).toBeNull();
    expect(placementSuggestion(null, state)).toBeNull();
  });
});
