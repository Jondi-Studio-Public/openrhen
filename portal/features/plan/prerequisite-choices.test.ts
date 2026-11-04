import { describe, expect, it } from "vitest";
import {
  prerequisiteGroups,
  splitPrerequisites,
  toggleSelection,
  unifiedPrerequisites,
  validatePrerequisiteChoice,
  waitingOn,
  waitingOnMap,
  waitingText,
  type PrerequisitePlan
} from "@/features/plan/prerequisite-choices";
import { deliverableDraftFrom } from "@/features/plan/plan-drafts";
import {
  actionCommand,
  deliverableCommand,
  projectCommand,
  validateActionDraft,
  validateProjectDraft
} from "@/features/plan/plan-commands";
import { emptyAction, emptyProject } from "@/features/plan/plan-drafts";

const plan = (over: Record<string, unknown[]> = {}): PrerequisitePlan =>
  ({
    projects: [
      { id: "p1", title: "Thesis", status: "active" },
      { id: "p2", title: "Garden", status: "active" },
      { id: "p3", title: "Old", status: "archived" }
    ],
    deliverables: [
      { id: "d1", title: "Chapter", projectId: "p1", status: "ready", dependencyIds: [] },
      { id: "d2", title: "Slides", projectId: "p2", status: "ready", dependencyIds: [] }
    ],
    actions: [
      { id: "a1", title: "Draft", projectId: "p1", status: "planned", dependencyIds: [] },
      { id: "a2", title: "Cite", projectId: "p1", status: "planned", dependencyIds: [] }
    ],
    ...over
  }) as unknown as PrerequisitePlan;

describe("prerequisite selection", () => {
  it("splits same-kind edges into dependencyIds and the rest into prerequisites", () => {
    const selection = [
      { kind: "action" as const, id: "a2" },
      { kind: "project" as const, id: "p2" },
      { kind: "action" as const, id: "a2" }
    ];
    const split = splitPrerequisites("action", selection);
    expect(split).toEqual({ dependencyIds: ["a2"], prerequisites: [{ kind: "project", id: "p2" }] });
    expect(unifiedPrerequisites("action", split)).toHaveLength(2);
  });

  it("keeps every project edge in prerequisites", () => {
    expect(splitPrerequisites("project", [{ kind: "project", id: "p2" }])).toEqual({
      dependencyIds: [],
      prerequisites: [{ kind: "project", id: "p2" }]
    });
  });

  it("toggles one ref on and off", () => {
    const on = toggleSelection([], { kind: "deliverable", id: "d1" }, true);
    expect(on).toHaveLength(1);
    expect(toggleSelection(on, { kind: "deliverable", id: "d1" }, false)).toEqual([]);
  });

  it("offers every other entity, grouped, hiding self and closed work unless chosen", () => {
    const groups = prerequisiteGroups(plan(), { kind: "action", id: "a1" });
    expect(groups.map((g) => g.label)).toEqual(["Projects", "Deliverables", "Actions"]);
    expect(groups[0]!.options.map((o) => o.title)).toEqual(["Thesis", "Garden"]);
    expect(groups[2]!.options.map((o) => o.title)).toEqual(["Cite"]);
    const withOld = prerequisiteGroups(plan(), { kind: "action", id: "a1" }, [{ kind: "project", id: "p3" }]);
    expect(withOld[0]!.options.map((o) => o.title)).toContain("Old");
  });
});

describe("validatePrerequisiteChoice", () => {
  it("accepts a mixed-kind edge", () => {
    expect(
      validatePrerequisiteChoice(
        { kind: "action", id: "a1", projectId: "p1" },
        { dependencyIds: [], prerequisites: [{ kind: "deliverable", id: "d2" }] },
        plan()
      )
    ).toBeNull();
  });

  it("refuses a child depending on its own project and a same-kind prerequisite", () => {
    expect(
      validatePrerequisiteChoice(
        { kind: "action", id: "a1", projectId: "p1" },
        { dependencyIds: [], prerequisites: [{ kind: "project", id: "p1" }] },
        plan()
      )
    ).toMatch(/own project/);
    expect(
      validatePrerequisiteChoice(
        { kind: "deliverable", id: "d1", projectId: "p1" },
        { dependencyIds: [], prerequisites: [{ kind: "deliverable", id: "d2" }] },
        plan()
      )
    ).toMatch(/dependencies/);
  });

  it("refuses a loop across kinds, including through a new record", () => {
    const withEdge = plan();
    (withEdge.projects[1] as { prerequisites?: unknown }).prerequisites = [{ kind: "action", id: "a1" }];
    // a1 would wait on d2, which lives in p2, which waits on a1.
    expect(
      validatePrerequisiteChoice(
        { kind: "action", id: "a1", projectId: "p1" },
        { dependencyIds: [], prerequisites: [{ kind: "project", id: "p2" }] },
        withEdge
      )
    ).toMatch(/cycle/);
    expect(
      validatePrerequisiteChoice(
        { kind: "project", id: undefined },
        { dependencyIds: [], prerequisites: [{ kind: "project", id: "p2" }] },
        plan()
      )
    ).toBeNull();
  });
});

describe("waiting on", () => {
  it("names unmet prerequisites per entity", () => {
    const withEdges = plan();
    (withEdges.projects[0] as { prerequisites?: unknown }).prerequisites = [{ kind: "project", id: "p2" }];
    const map = waitingOnMap(withEdges);
    expect(waitingText(waitingOn(map, "project", "p1"))).toBe("waiting on Garden");
    expect(waitingText(waitingOn(map, "action", "a1"))).toBe("waiting on Garden");
    expect(waitingOn(map, "project", "p2")).toEqual([]);
  });
});

describe("drafts and commands carry prerequisites", () => {
  it("reads the picker's hidden inputs from a deliverable form", () => {
    const form = new FormData();
    form.set("projectId", "p1");
    form.set("title", "T");
    form.append("dependencyIds", "d2");
    form.set(
      "prerequisites",
      JSON.stringify([
        { kind: "project", id: "p2" },
        { kind: "bogus", id: "x" }
      ])
    );
    const draft = deliverableDraftFrom(form);
    expect(draft.dependencyIds).toEqual(["d2"]);
    expect(draft.prerequisites).toEqual([{ kind: "project", id: "p2" }]);
    form.set("prerequisites", "not json");
    expect(deliverableDraftFrom(form).prerequisites).toEqual([]);
  });

  it("sends prerequisites on project, action and deliverable commands and validates drafts inline", () => {
    const state = { ...plan(), settings: { timezone: "Australia/Sydney" } } as never;
    const project = {
      ...emptyProject(),
      outcomeId: "o",
      title: "X",
      prerequisites: [{ kind: "action" as const, id: "a1" }]
    };
    expect(projectCommand(project, state).project).toMatchObject({ prerequisites: [{ kind: "action", id: "a1" }] });
    expect(validateProjectDraft(project, "Australia/Sydney", state)).toBeNull();

    const action = {
      ...emptyAction("Australia/Sydney"),
      id: "a1",
      projectId: "p1",
      title: "Draft",
      prerequisites: [{ kind: "project" as const, id: "p1" }]
    };
    expect(actionCommand(action, state).action).toMatchObject({ prerequisites: [{ kind: "project", id: "p1" }] });
    expect(validateActionDraft(action, (state as PrerequisitePlan).actions, state)).toMatch(/own project/);
    expect(actionCommand({ ...action, prerequisites: undefined }, state).action).not.toHaveProperty("prerequisites");

    const draft = deliverableDraftFrom(
      Object.assign(new FormData(), {}) &&
        (() => {
          const f = new FormData();
          f.set("projectId", "p1");
          f.set("title", "T");
          f.set("prerequisites", JSON.stringify([{ kind: "action", id: "a1" }]));
          return f;
        })()
    );
    expect(deliverableCommand(draft, state).entity).toMatchObject({ prerequisites: [{ kind: "action", id: "a1" }] });
  });
});
