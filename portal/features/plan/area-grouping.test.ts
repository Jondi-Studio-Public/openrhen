import { describe, expect, it } from "vitest";
import { createSeedState } from "@/state/portal-state";
import {
  UNASSIGNED_AREA_ID,
  projectsForArea,
  selectableProjects,
  resolveProjectAreaId,
  sortedAreas
} from "./area-grouping";

const seed = () => createSeedState(new Date("2026-08-18T09:00:00.000Z"));

describe("resolveProjectAreaId", () => {
  it("resolves through the project's outcome first", () => {
    const state = seed();
    const project = state.projects[0]!; // networking-assignment -> outcome-networking -> area-study
    expect(resolveProjectAreaId(project, state.outcomes, state.areas)).toBe("area-study");
  });

  it("falls back to the legacy area name when the outcome does not resolve", () => {
    const state = seed();
    const project = { ...state.projects[0]!, outcomeId: "gone" };
    expect(resolveProjectAreaId(project, state.outcomes, state.areas)).toBe("area-study");
  });

  it("falls back to the legacy area name when the outcome's own area is missing", () => {
    const state = seed();
    const outcomes = state.outcomes.map((item) =>
      item.id === "outcome-networking" ? { ...item, areaId: "gone" } : item
    );
    const project = state.projects[0]!;
    expect(resolveProjectAreaId(project, outcomes, state.areas)).toBe("area-study");
  });

  it("is unassigned when neither the outcome nor the legacy name resolves", () => {
    const state = seed();
    const project = { ...state.projects[0]!, outcomeId: "gone", area: "Nowhere" };
    expect(resolveProjectAreaId(project, state.outcomes, state.areas)).toBe(UNASSIGNED_AREA_ID);
  });
});

describe("projectsForArea", () => {
  it("filters projects down to the ones that resolve to the given area", () => {
    const state = seed();
    expect(projectsForArea("area-study", state.projects, state.outcomes, state.areas)).toEqual([state.projects[0]]);
    expect(projectsForArea("area-home", state.projects, state.outcomes, state.areas)).toEqual([state.projects[1]]);
  });

  it("collects unassigned projects under the reserved id", () => {
    const state = seed();
    const projects = [...state.projects, { ...state.projects[0]!, id: "orphan", outcomeId: "gone", area: "Nowhere" }];
    expect(projectsForArea(UNASSIGNED_AREA_ID, projects, state.outcomes, state.areas).map((item) => item.id)).toEqual([
      "orphan"
    ]);
  });
});

describe("sortedAreas", () => {
  it("orders by sortOrder, then by name for ties", () => {
    const areas = [
      { id: "b", name: "Bravo", status: "active" as const, sortOrder: 1 },
      { id: "z", name: "Zulu", status: "active" as const, sortOrder: 0 },
      { id: "a", name: "Alpha", status: "active" as const, sortOrder: 0 }
    ];
    expect(sortedAreas(areas).map((item) => item.id)).toEqual(["a", "z", "b"]);
  });
});

describe("selectableProjects", () => {
  it("leaves closed projects out of a picker, but keeps the one already chosen", () => {
    const base = seed().projects[0]!;
    const projects = [
      { ...base, id: "open", status: "active" as const },
      { ...base, id: "paused", status: "paused" as const },
      { ...base, id: "done", status: "done" as const },
      { ...base, id: "archived", status: "archived" as const },
      { ...base, id: "cancelled", status: "cancelled" as const }
    ];
    expect(selectableProjects(projects, "").map((item) => item.id)).toEqual(["open", "paused", "done"]);
    expect(selectableProjects(projects, "archived").map((item) => item.id)).toEqual([
      "open",
      "paused",
      "done",
      "archived"
    ]);
  });
});
