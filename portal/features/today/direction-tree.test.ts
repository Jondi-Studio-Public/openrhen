import { describe, expect, it } from "vitest";
import type { PortalState, StoredAction, StoredArea, StoredOutcome, StoredProject } from "@/state/portal-state";
import {
  directionActionOptions,
  directionActionPath,
  directionOutcomeOptions,
  directionProjectOptions,
  normalizeDirectionScope
} from "./direction-tree";

const area = (id: string, name: string): StoredArea => ({ id, name, status: "active", sortOrder: 0 });
const outcome = (id: string, areaId: string, title: string): StoredOutcome => ({
  id,
  areaId,
  title,
  definitionOfDone: `Finish ${title}`,
  value: 5,
  status: "active"
});
const project = (id: string, outcomeId: string, title: string): StoredProject =>
  ({
    id,
    outcomeId,
    title,
    area: "Study",
    status: "active",
    value: 5,
    effortRemainingMinutes: 60,
    contexts: []
  }) as unknown as StoredProject;
const action = (
  id: string,
  projectId: string,
  title: string,
  status: StoredAction["status"] = "planned"
): StoredAction =>
  ({
    id,
    projectId,
    title,
    status,
    remainingMinutes: 30,
    pessimisticMinutes: 45,
    optimisticMinutes: 20,
    expectedMinutes: 30,
    energy: "medium",
    minimumSessionMinutes: 15,
    maximumSessionMinutes: 60,
    importance: 5,
    consequence: 5,
    contexts: [],
    dependencyIds: [],
    splittable: true,
    setupMinutes: 0,
    requirementPathways: [],
    preferences: []
  }) as unknown as StoredAction;

const state = {
  areas: [area("study", "Study"), area("home", "Home")],
  outcomes: [outcome("degree", "study", "Finish semester"), outcome("tidy", "home", "Calm house")],
  projects: [project("essay", "degree", "History essay"), project("kitchen", "tidy", "Kitchen reset")],
  actions: [
    action("outline", "essay", "Outline the essay"),
    action("draft", "essay", "Draft the essay", "done"),
    action("dishes", "kitchen", "Clear the dishes")
  ]
} as unknown as PortalState;

describe("Today direction folder navigation", () => {
  it("narrows each level to the chosen ancestor", () => {
    const scope = { areaId: "study", outcomeId: "", projectId: "" };
    expect(directionOutcomeOptions(state, scope).map((item) => item.id)).toEqual(["degree"]);
    expect(directionProjectOptions(state, scope).map((item) => item.id)).toEqual(["essay"]);
    expect(directionActionOptions(state, scope).map((item) => item.id)).toEqual(["outline"]);
  });

  it("offers every eligible action when no folder is chosen and hides finished work", () => {
    expect(directionActionOptions(state, { areaId: "", outcomeId: "", projectId: "" }).map((item) => item.id)).toEqual([
      "outline",
      "dishes"
    ]);
  });

  it("clears narrower choices that the new ancestor does not contain", () => {
    expect(normalizeDirectionScope(state, { areaId: "home", outcomeId: "degree", projectId: "essay" })).toEqual({
      areaId: "home",
      outcomeId: "",
      projectId: ""
    });
    expect(normalizeDirectionScope(state, { areaId: "study", outcomeId: "degree", projectId: "essay" })).toEqual({
      areaId: "study",
      outcomeId: "degree",
      projectId: "essay"
    });
    expect(normalizeDirectionScope(state, { areaId: "missing", outcomeId: "", projectId: "" })).toEqual({
      areaId: "",
      outcomeId: "",
      projectId: ""
    });
  });

  it("describes a saved win by its full folder trail", () => {
    expect(directionActionPath(state, "outline")).toEqual([
      "Study",
      "Finish semester",
      "History essay",
      "Outline the essay"
    ]);
    expect(directionActionPath(state, "unknown")).toEqual([]);
  });
});
