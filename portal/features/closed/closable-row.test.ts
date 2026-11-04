import { describe, expect, it } from "vitest";
import { createSeedState } from "@/state/portal-state";
import { closableRowIn, noun } from "./closable-row";

/** Finds the row a button acts on in portal state, with the title and version the close command needs. */
describe("closableRowIn", () => {
  const state = createSeedState();
  state.areas = [{ id: "a1", name: "Finance", status: "active", version: 3 } as never];
  state.outcomes = [{ id: "o1", title: "Tidy books", status: "paused", version: 2 } as never];
  state.projects = [{ id: "p1", title: "Quarterly report", status: "archived", version: 7 } as never];
  state.actions = [{ id: "x1", title: "Draft", status: "planned", version: 5 } as never];
  state.deliverables = [{ id: "d1", title: "Report", status: "completed", version: 4 } as never];
  state.commitments = [{ id: "c1", title: "Dentist", status: "confirmed", version: 6 } as never];
  state.routinePresets = [{ id: "r1", name: "Morning", status: "active", version: 2 } as never];
  state.conditionDefinitions = [{ id: "office", name: "Office", status: "active", version: 9 } as never];

  it.each([
    ["area", "a1", "Finance", "active", 3],
    ["outcome", "o1", "Tidy books", "paused", 2],
    ["project", "p1", "Quarterly report", "archived", 7],
    ["action", "x1", "Draft", "planned", 5],
    ["deliverable", "d1", "Report", "completed", 4],
    ["commitment", "c1", "Dentist", "confirmed", 6],
    ["routine_preset", "r1", "Morning", "active", 2],
    ["condition_definition", "office", "Office", "active", 9]
  ] as const)("finds %s %s", (type, id, title, status, version) => {
    expect(closableRowIn(state, type, id)).toEqual({ type, id, title, status, version });
  });

  it("is null for a missing id or an empty one (a record not saved yet has nothing to close)", () => {
    expect(closableRowIn(state, "area", "nope")).toBeNull();
    expect(closableRowIn(state, "area", "")).toBeNull();
  });
  it("names each type in the words a person uses", () => {
    expect(noun("routine_preset")).toBe("routine");
    expect(noun("condition_definition")).toBe("context");
    expect(noun("action")).toBe("action");
  });
});
