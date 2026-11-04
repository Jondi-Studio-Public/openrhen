import { describe, expect, it } from "vitest";
import type { PrerequisiteRef } from "@openrhen/contracts";
import { createSeedState } from "@/state/portal-state";
import { setupStateStoreSuite, sql, fixedNow, unplannedStore as store } from "./state-store-harness";

/**
 * Extra prerequisites: every edge from or to a project, and any
 * edge between different kinds, stored in `entity_prerequisites`.
 */
setupStateStoreSuite("openrhen_prerequisites");

type Project = NonNullable<Awaited<ReturnType<typeof store.get>>>["projects"][number];

async function seed() {
  await store.put(createSeedState(fixedNow));
  return (await store.get())!;
}

const saveProject = async (project: Project, prerequisites?: PrerequisiteRef[], overrides: Partial<Project> = {}) =>
  store.saveProject({
    expectedVersion: project.version!,
    project: {
      id: project.id,
      outcomeId: project.outcomeId,
      title: project.title,
      status: project.status,
      uncertainty: project.uncertainty,
      consequence: project.consequence,
      ...(prerequisites ? { prerequisites } : {}),
      ...overrides
    } as never
  });

async function addProject(title: string) {
  const state = (await store.get())!;
  const outcome = state.projects[0]!;
  const saved = await store.saveProject({
    expectedVersion: null,
    project: {
      id: crypto.randomUUID(),
      outcomeId: outcome.outcomeId,
      title,
      status: "active",
      uncertainty: "some",
      consequence: 3
    } as never
  });
  return saved.projects.find((project) => project.title === title)!;
}

async function addDeliverable(projectId: string, title: string, extra: Record<string, unknown> = {}) {
  const id = crypto.randomUUID();
  const saved = await store.saveEntity({
    commandId: crypto.randomUUID(),
    expectedVersion: null,
    type: "save_entity",
    entityType: "deliverable",
    entity: {
      id,
      projectId,
      title,
      status: "needs_breakdown",
      uncertainty: "some",
      importance: 3,
      consequence: 3,
      steps: [],
      criteria: [],
      blockers: [],
      ...extra
    }
  });
  return saved.deliverables.find((item) => item.id === id)!;
}

const actionCommand = (action: Record<string, unknown>, expectedVersion: number | null) => ({
  expectedVersion,
  action: {
    projectId: "",
    title: "Action",
    status: "active",
    optimisticMinutes: 10,
    expectedMinutes: 20,
    pessimisticMinutes: 30,
    remainingMinutes: 20,
    energy: "medium",
    minimumSessionMinutes: 10,
    maximumSessionMinutes: 30,
    splittable: true,
    setupMinutes: 0,
    importance: 3,
    consequence: 3,
    contexts: [],
    dependencyIds: [],
    ...action
  } as never
});

describe("entity prerequisites", () => {
  it("sets, replaces, clears and round-trips a project's prerequisites across kinds", async () => {
    const state = await seed();
    const a = state.projects[0]!;
    const b = await addProject("B");
    const deliverable = await addDeliverable(a.id, "D");
    const action = state.actions[0]!;
    const refs: PrerequisiteRef[] = [
      { kind: "project", id: a.id },
      { kind: "deliverable", id: deliverable.id },
      { kind: "action", id: action.id }
    ];
    const withAll = await saveProject(b, refs);
    expect(withAll.projects.find((project) => project.id === b.id)!.prerequisites).toEqual(
      expect.arrayContaining(refs)
    );
    expect((await store.get())!.projects.find((project) => project.id === b.id)!.prerequisites).toHaveLength(3);
    // Absent leaves the stored edges alone.
    const untouched = await saveProject(withAll.projects.find((p) => p.id === b.id)!);
    expect(untouched.projects.find((p) => p.id === b.id)!.prerequisites).toHaveLength(3);
    const replaced = await saveProject(
      untouched.projects.find((p) => p.id === b.id)!,
      [{ kind: "project", id: a.id }]
    );
    expect(replaced.projects.find((p) => p.id === b.id)!.prerequisites).toEqual([{ kind: "project", id: a.id }]);
    const cleared = await saveProject(
      replaced.projects.find((p) => p.id === b.id)!,
      []
    );
    expect(cleared.projects.find((p) => p.id === b.id)!.prerequisites).toEqual([]);
  });

  it("lets a deliverable wait on another project, and a project wait on a deliverable", async () => {
    const state = await seed();
    const a = state.projects[0]!;
    const b = await addProject("B");
    const first = await addDeliverable(a.id, "First");
    const second = await addDeliverable(b.id, "Second", { prerequisites: [{ kind: "project", id: a.id }] });
    expect(second.prerequisites).toEqual([{ kind: "project", id: a.id }]);
    const waiting = await saveProject(b, [{ kind: "deliverable", id: first.id }]);
    expect(waiting.projects.find((p) => p.id === b.id)!.prerequisites).toEqual([{ kind: "deliverable", id: first.id }]);
  });

  it("lets an action wait on a deliverable and rejects a same-kind reference", async () => {
    const state = await seed();
    const action = state.actions[0]!;
    const deliverable = await addDeliverable(action.projectId, "D");
    const saved = await store.saveAction(
      actionCommand({ ...action, prerequisites: [{ kind: "deliverable", id: deliverable.id }] }, action.version!)
    );
    expect(saved.actions.find((item) => item.id === action.id)!.prerequisites).toEqual([
      { kind: "deliverable", id: deliverable.id }
    ]);
    await expect(
      store.saveEntity({
        commandId: crypto.randomUUID(),
        expectedVersion: deliverable.version ?? null,
        type: "save_entity",
        entityType: "deliverable",
        entity: { ...deliverable, prerequisites: [{ kind: "deliverable", id: deliverable.id }] }
      })
    ).rejects.toThrow(/dependencyIds|own prerequisite/);
  });

  it("rejects a cycle, a child depending on its own project, and another user's entity", async () => {
    const state = await seed();
    const a = state.projects[0]!;
    const b = await addProject("B");
    const withEdge = await saveProject(b, [{ kind: "project", id: a.id }]);
    await expect(saveProject(a, [{ kind: "project", id: b.id }])).rejects.toThrow(/cycle/);
    const deliverable = await addDeliverable(a.id, "D");
    await expect(
      store.saveEntity({
        commandId: crypto.randomUUID(),
        expectedVersion: deliverable.version ?? null,
        type: "save_entity",
        entityType: "deliverable",
        entity: { ...deliverable, prerequisites: [{ kind: "project", id: a.id }] }
      })
    ).rejects.toThrow(/cycle/);
    // A project may not wait on its own deliverable either.
    await expect(
      saveProject(
        withEdge.projects.find((p) => p.id === a.id)!,
        [{ kind: "deliverable", id: deliverable.id }]
      )
    ).rejects.toThrow(/cycle/);
    const otherUser = await sql<
      { id: string }[]
    >`INSERT INTO users (display_name,timezone) VALUES ('Other','UTC') RETURNING id`;
    const area = await sql<
      { id: string }[]
    >`INSERT INTO areas (user_id,name,status,sort_order) VALUES (${otherUser[0]!.id},'Other','active',0) RETURNING id`;
    const outcome = await sql<
      { id: string }[]
    >`INSERT INTO outcomes (area_id,title,definition_of_done,status) VALUES (${area[0]!.id},'O','Done','active') RETURNING id`;
    const foreign = await sql<
      { id: string }[]
    >`INSERT INTO projects (outcome_id,title,status) VALUES (${outcome[0]!.id},'Foreign','active') RETURNING id`;
    await expect(
      saveProject(
        withEdge.projects.find((p) => p.id === b.id)!,
        [{ kind: "project", id: foreign[0]!.id }]
      )
    ).rejects.toThrow(/no longer exists/);
  });

  it("drops a dangling row on read and removes rows in both directions when an entity is replaced away", async () => {
    const state = await seed();
    const a = state.projects[0]!;
    const b = await addProject("B");
    await saveProject(b, [{ kind: "project", id: a.id }]);
    await sql`INSERT INTO entity_prerequisites (entity_kind,entity_id,requires_kind,requires_id) VALUES ('project',${b.id},'action',${crypto.randomUUID()})`;
    expect((await store.get())!.projects.find((p) => p.id === b.id)!.prerequisites).toEqual([
      { kind: "project", id: a.id }
    ]);
    // A deliverable's dropped step takes its rows with it.
    const withStep = await addDeliverable(a.id, "WithStep", {
      steps: [
        {
          id: "s1",
          title: "S",
          status: "planned",
          optimisticMinutes: 10,
          expectedMinutes: 20,
          pessimisticMinutes: 30,
          remainingMinutes: 20,
          energy: "medium",
          minimumSessionMinutes: 10,
          maximumSessionMinutes: 30
        }
      ]
    });
    const stepId = withStep.steps[0]!.id;
    await sql`INSERT INTO entity_prerequisites (entity_kind,entity_id,requires_kind,requires_id) VALUES ('project',${b.id},'action',${stepId}),('action',${stepId},'project',${a.id})`;
    await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: withStep.version ?? null,
      type: "save_entity",
      entityType: "deliverable",
      entity: { ...withStep, steps: [] }
    });
    const left = await sql`SELECT 1 FROM entity_prerequisites WHERE entity_id=${stepId} OR requires_id=${stepId}`;
    expect(left).toHaveLength(0);
    // Whole-state replacement clears the rows of everything it replaces.
    await store.put(createSeedState(fixedNow));
    const afterPut = await sql`SELECT 1 FROM entity_prerequisites WHERE entity_id=${b.id} OR requires_id=${b.id}`;
    expect(afterPut).toHaveLength(0);
  });
});
