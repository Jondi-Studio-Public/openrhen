import { describe, expect, it } from "vitest";
import {
  firstPrerequisiteCycle,
  prerequisiteNodes,
  unmetPrerequisiteReason,
  unmetPrerequisites
} from "./prerequisites.js";

const state = (overrides: { projects?: object[]; deliverables?: object[]; actions?: object[] } = {}) =>
  prerequisiteNodes({
    projects: [
      { id: "p1", title: "Project one", status: "active" },
      { id: "p2", title: "Project two", status: "active" }
    ],
    deliverables: [{ id: "d1", title: "Deliverable one", projectId: "p1", status: "ready", dependencyIds: [] }],
    actions: [{ id: "a1", title: "Action one", projectId: "p1", status: "active", dependencyIds: [] }],
    ...overrides
  } as never);

describe("unmetPrerequisites", () => {
  it("reports nothing when no prerequisite is set", () => {
    expect(unmetPrerequisites(state()).size).toBe(0);
  });

  it("lets a deliverable wait on a project and clears when the project is done", () => {
    const waiting = {
      id: "d1",
      title: "Deliverable one",
      projectId: "p1",
      status: "ready",
      dependencyIds: [],
      prerequisites: [{ kind: "project", id: "p2" }]
    };
    expect(unmetPrerequisites(state({ deliverables: [waiting] })).get("deliverable:d1")).toEqual([
      { kind: "project", id: "p2", title: "Project two" }
    ]);
    const done = [
      { id: "p1", title: "Project one", status: "active" },
      { id: "p2", title: "Project two", status: "done" }
    ];
    expect(unmetPrerequisites(state({ deliverables: [waiting], projects: done })).size).toBe(0);
  });

  it("passes a project's prerequisites down to its deliverables and actions", () => {
    const projects = [
      { id: "p1", title: "Project one", status: "active", prerequisites: [{ kind: "deliverable", id: "d9" }] },
      { id: "p2", title: "Project two", status: "active" }
    ];
    const deliverables = [
      { id: "d1", title: "Deliverable one", projectId: "p1", status: "ready", dependencyIds: [] },
      { id: "d9", title: "Other deliverable", projectId: "p2", status: "ready", dependencyIds: [] }
    ];
    const unmet = unmetPrerequisites(state({ projects, deliverables }));
    expect(unmet.get("deliverable:d1")?.map((ref) => ref.id)).toEqual(["d9"]);
    expect(unmet.get("action:a1")?.map((ref) => ref.id)).toEqual(["d9"]);
    expect(unmet.has("deliverable:d9")).toBe(false);
  });

  it("counts a missing target as unmet", () => {
    const actions = [
      {
        id: "a1",
        title: "Action one",
        projectId: "p1",
        status: "active",
        dependencyIds: [],
        prerequisites: [{ kind: "action", id: "gone" }]
      }
    ];
    expect(unmetPrerequisites(state({ actions })).get("action:a1")).toEqual([
      { kind: "action", id: "gone", title: "gone" }
    ]);
  });
});

describe("firstPrerequisiteCycle", () => {
  it("is null for an acyclic mix", () => {
    const actions = [
      {
        id: "a1",
        title: "Action one",
        projectId: "p1",
        status: "active",
        dependencyIds: [],
        prerequisites: [{ kind: "project", id: "p2" }]
      }
    ];
    expect(firstPrerequisiteCycle(state({ actions }))).toBeNull();
  });

  it("finds a loop across kinds", () => {
    const projects = [
      { id: "p1", title: "Project one", status: "active", prerequisites: [{ kind: "project", id: "p2" }] },
      { id: "p2", title: "Project two", status: "active", prerequisites: [{ kind: "deliverable", id: "d1" }] }
    ];
    const deliverables = [{ id: "d1", title: "Deliverable one", projectId: "p1", status: "ready", dependencyIds: [] }];
    expect(firstPrerequisiteCycle(state({ projects, deliverables }))).not.toBeNull();
  });

  it("refuses a project waiting on its own deliverable, and a child waiting on its own project", () => {
    const own = [
      { id: "p1", title: "Project one", status: "active", prerequisites: [{ kind: "deliverable", id: "d1" }] }
    ];
    expect(firstPrerequisiteCycle(state({ projects: own }))).not.toBeNull();
    const child = [
      {
        id: "d1",
        title: "Deliverable one",
        projectId: "p1",
        status: "ready",
        dependencyIds: [],
        prerequisites: [{ kind: "project", id: "p1" }]
      }
    ];
    expect(firstPrerequisiteCycle(state({ deliverables: child }))).not.toBeNull();
  });
});

describe("a loop through a project's children", () => {
  it("is found when a project waits on another whose action waits on work held by the first", () => {
    const projects = [
      { id: "p1", title: "Project one", status: "active", prerequisites: [{ kind: "project", id: "p2" }] },
      { id: "p2", title: "Project two", status: "active" }
    ];
    const actions = [
      { id: "a1", title: "Action one", projectId: "p1", status: "active", dependencyIds: [] },
      {
        id: "a2",
        title: "Action two",
        projectId: "p2",
        status: "active",
        dependencyIds: [],
        prerequisites: [{ kind: "action", id: "a1" }]
      }
    ];
    expect(firstPrerequisiteCycle(state({ projects, actions }))).not.toBeNull();
  });

  it("is not reported for ordinary project ordering", () => {
    const projects = [
      { id: "p1", title: "Project one", status: "active", prerequisites: [{ kind: "project", id: "p2" }] },
      { id: "p2", title: "Project two", status: "active" }
    ];
    const actions = [
      { id: "a1", title: "Action one", projectId: "p1", status: "active", dependencyIds: [] },
      { id: "a2", title: "Action two", projectId: "p2", status: "active", dependencyIds: [] }
    ];
    expect(firstPrerequisiteCycle(state({ projects, actions }))).toBeNull();
  });
});

describe("unmetPrerequisiteReason", () => {
  it("names one or several", () => {
    expect(unmetPrerequisiteReason("Draft", [{ kind: "project", id: "p", title: "Lab" }])).toBe(
      "Draft is waiting on project Lab."
    );
    expect(
      unmetPrerequisiteReason("Draft", [
        { kind: "action", id: "a", title: "A" },
        { kind: "action", id: "b", title: "B" }
      ])
    ).toBe("Draft is waiting on 2 prerequisites: A, B.");
  });
});
