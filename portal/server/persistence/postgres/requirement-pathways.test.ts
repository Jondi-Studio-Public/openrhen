import { describe, expect, it } from "vitest";
import { normalizeRequirementPathways, pathwaysToStore } from "./requirement-pathways";

describe("normalizeRequirementPathways", () => {
  it("passes bare string[] routes through unchanged", () => {
    expect(normalizeRequirementPathways([["home"], ["laptop", "phone"]])).toEqual([["home"], ["laptop", "phone"]]);
  });

  it("unwraps the read shape's { id, contextIds } object to its contextIds", () => {
    expect(
      normalizeRequirementPathways([
        { id: "p1", contextIds: ["home"] },
        { id: "p2", contextIds: ["laptop", "phone"] }
      ])
    ).toEqual([["home"], ["laptop", "phone"]]);
  });

  it("accepts a mix of both shapes in the same call, preserving order", () => {
    expect(normalizeRequirementPathways([["home"], { id: "p1", contextIds: ["laptop"] }, ["phone"]])).toEqual([
      ["home"],
      ["laptop"],
      ["phone"]
    ]);
  });

  it("drops empty routes of either shape", () => {
    expect(normalizeRequirementPathways([[], { id: "p1", contextIds: [] }, ["home"]])).toEqual([["home"]]);
  });

  it("treats a missing contextIds as an empty route and drops it", () => {
    expect(normalizeRequirementPathways([{ id: "p1" }, ["home"]])).toEqual([["home"]]);
  });

  it("returns an empty array for an empty input", () => {
    expect(normalizeRequirementPathways([])).toEqual([]);
  });
});

describe("pathwaysToStore (action_contexts is retired, so this is what a save now persists)", () => {
  it("uses requirementPathways when the caller sent it, ignoring the legacy contexts entirely", () => {
    expect(pathwaysToStore([["desktop"]], ["home", "laptop"])).toEqual([["desktop"]]);
  });

  it("clears stored pathways when the caller explicitly sends an empty array, even with legacy contexts present", () => {
    expect(pathwaysToStore([], ["home"])).toEqual([]);
  });

  it("folds a legacy contexts-only save into one AND pathway, same as action.contexts always meant", () => {
    expect(pathwaysToStore(undefined, ["home", "laptop"])).toEqual([["home", "laptop"]]);
  });

  it("returns undefined (leave stored pathways alone) when neither field was sent", () => {
    expect(pathwaysToStore(undefined, [])).toBeUndefined();
  });

  it("leaves stored routes alone when contexts merely echoes the stored first route", () => {
    expect(pathwaysToStore(undefined, ["home", "quiet"], ["quiet", "home"])).toBeUndefined();
  });

  it("still folds contexts that differ from the stored first route into one route", () => {
    expect(pathwaysToStore(undefined, ["outdoors"], ["home"])).toEqual([["outdoors"]]);
    expect(pathwaysToStore(undefined, ["home"], [])).toEqual([["home"]]);
  });

  it("lets an explicit requirementPathways win over the stored first route", () => {
    expect(pathwaysToStore([["home"], ["laptop"]], ["home"], ["home"])).toEqual([["home"], ["laptop"]]);
  });
});
