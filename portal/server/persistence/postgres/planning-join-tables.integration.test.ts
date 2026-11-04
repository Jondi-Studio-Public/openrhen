import { describe, expect, it } from "vitest";
import { createSeedState } from "@/state/portal-state";
import { InvalidCommandError } from "./command-errors";
import { fixedNow, setupStateStoreSuite, sql, store } from "./state-store-harness";

/**
 * Migration 0119: a day's desired and deferred actions and a focus period's projects are join rows, not
 * jsonb arrays. Saving writes them in the same transaction as their parent, reading assembles the arrays the
 * contract has always carried, and deleting the action or project takes it out of the plan.
 */
setupStateStoreSuite("openrhen_planning_join_tables");

const localDate = "2026-08-18";

const savePlan = (entity: Record<string, unknown>, expectedVersion: number | null = null) =>
  store.saveEntity({
    commandId: crypto.randomUUID(),
    expectedVersion,
    type: "save_entity",
    entityType: "daily_plan",
    entity: { localDate, desiredActionIds: [], deferredItems: [], ...entity }
  });

const saveFocus = (entity: Record<string, unknown>, expectedVersion: number | null = null) =>
  store.saveEntity({
    commandId: crypto.randomUUID(),
    expectedVersion,
    type: "save_entity",
    entityType: "planning_focus",
    entity: { kind: "weekly", periodStart: "2026-08-17", periodEnd: "2026-08-23", ...entity }
  });

/** The seeded user's id; the seed holds one user. */
async function userId(): Promise<string> {
  return (await sql<{ id: string }[]>`SELECT id FROM users ORDER BY created_at LIMIT 1`)[0]!.id;
}

async function newProject(owner: string): Promise<string> {
  const area = await sql<
    { id: string }[]
  >`INSERT INTO areas (user_id,name,status,sort_order) VALUES (${owner},${"Area " + crypto.randomUUID()},'active',0) RETURNING id`;
  const outcome = await sql<
    { id: string }[]
  >`INSERT INTO outcomes (area_id,title,definition_of_done,status) VALUES (${area[0]!.id},'Outcome','Done','active') RETURNING id`;
  const project = await sql<
    { id: string }[]
  >`INSERT INTO projects (outcome_id,title,status) VALUES (${outcome[0]!.id},'Project','active') RETURNING id`;
  return project[0]!.id;
}

async function newAction(projectId: string): Promise<string> {
  const action = await sql<{ id: string }[]>`
    INSERT INTO actions (project_id,title,scheduling_mode,status,optimistic_minutes,expected_minutes,pessimistic_minutes,remaining_minutes,energy,minimum_session_minutes,maximum_session_minutes)
    VALUES (${projectId},'Draft citations','one_off','planned',30,60,90,60,'medium',15,90)
    RETURNING id`;
  return action[0]!.id;
}

/** Deletes the way the delete commands do, clearing the planning output that points at the rows first. */
async function removeAction(actionId: string) {
  await sql`DELETE FROM recommendation_candidates WHERE action_id = ${actionId}`;
  await sql`DELETE FROM recommendations WHERE primary_action_id = ${actionId}`;
  await sql`DELETE FROM actions WHERE id = ${actionId}`;
}

async function removeProject(projectId: string) {
  for (const row of await sql<{ id: string }[]>`SELECT id FROM actions WHERE project_id = ${projectId}`)
    await removeAction(row.id);
  await sql`DELETE FROM forecast_snapshots WHERE project_id = ${projectId}`;
  await sql`DELETE FROM projects WHERE id = ${projectId}`;
}

async function seed() {
  await store.put(createSeedState(fixedNow));
  const owner = await userId();
  const home = await newProject(owner);
  const other = await newProject(owner);
  const actions = [await newAction(home), await newAction(home), await newAction(home), await newAction(other)];
  return { owner, actions, projects: [home, other] };
}

describe("daily plan desired and deferred actions", () => {
  it("round-trips desired ids in order and deferred items with their reasons", async () => {
    const { actions } = await seed();
    const [a, b, c, d] = actions as [string, string, string, string];
    let state = await savePlan({
      desiredActionIds: [c, a],
      deferredItems: [
        { actionId: d, reason: "waiting on a reply" },
        { actionId: b, reason: "" }
      ]
    });
    expect(state.dailyPlan?.desiredActionIds).toEqual([c, a]);
    expect(state.dailyPlan?.deferredItems).toEqual([
      { actionId: d, reason: "waiting on a reply" },
      { actionId: b, reason: "" }
    ]);
    const rows = await sql<{ action_id: string; position: number }[]>`
      SELECT action_id, position FROM daily_plan_desired_actions ORDER BY position`;
    expect(rows).toEqual([
      { action_id: c, position: 0 },
      { action_id: a, position: 1 }
    ]);

    // A second save replaces the rows rather than adding to them.
    state = await savePlan({ desiredActionIds: [b], deferredItems: [] }, state.dailyPlan!.version ?? null);
    expect(state.dailyPlan?.desiredActionIds).toEqual([b]);
    expect(state.dailyPlan?.deferredItems).toEqual([]);
    expect(await sql`SELECT 1 FROM daily_plan_desired_actions`).toHaveLength(1);
    expect(await sql`SELECT 1 FROM daily_plan_deferred_actions`).toHaveLength(0);
  });

  it("collapses a repeated id instead of failing on the primary key", async () => {
    const { actions } = await seed();
    const [a] = actions as [string];
    const state = await savePlan({
      desiredActionIds: [a, a],
      deferredItems: [
        { actionId: a, reason: "first" },
        { actionId: a, reason: "second" }
      ]
    });
    expect(state.dailyPlan?.desiredActionIds).toEqual([a]);
    expect(state.dailyPlan?.deferredItems).toEqual([{ actionId: a, reason: "first" }]);
  });

  it("drops a deleted action from the plan", async () => {
    const { actions } = await seed();
    const [a, b] = actions as [string, string];
    await savePlan({ desiredActionIds: [a, b], deferredItems: [{ actionId: a, reason: "later" }] });
    await removeAction(a);
    const state = (await store.get())!;
    expect(state.dailyPlan?.desiredActionIds).toEqual([b]);
    expect(state.dailyPlan?.deferredItems).toEqual([]);
  });

  it("refuses an action that does not exist, is not a uuid, or makes more than three wins", async () => {
    const { actions } = await seed();
    await expect(savePlan({ desiredActionIds: [crypto.randomUUID()] })).rejects.toThrow(InvalidCommandError);
    await expect(savePlan({ desiredActionIds: ["not-a-uuid"] })).rejects.toThrow(InvalidCommandError);
    await expect(savePlan({ deferredItems: [{ actionId: crypto.randomUUID(), reason: "x" }] })).rejects.toThrow(
      /no longer exists/
    );
    await expect(savePlan({ desiredActionIds: actions })).rejects.toThrow(/three/);
    // A refused save leaves no plan behind.
    expect(await sql`SELECT 1 FROM daily_plans`).toHaveLength(0);
  });

  it("refuses another user's action", async () => {
    await seed();
    const stranger = (
      await sql<{ id: string }[]>`INSERT INTO users (display_name) VALUES ('Someone else') RETURNING id`
    )[0]!.id;
    const theirs = await newAction(await newProject(stranger));
    await expect(savePlan({ desiredActionIds: [theirs] })).rejects.toThrow(InvalidCommandError);
  });
});

describe("planning focus projects", () => {
  it("round-trips a period's projects and replaces them on the next save", async () => {
    const { projects } = await seed();
    const [p1, p2] = projects as [string, string];
    let state = await saveFocus({ projectIds: [p1, p2] });
    expect(state.planningFocus[0]?.projectIds.sort()).toEqual([p1, p2].sort());
    state = await saveFocus({ projectIds: [p2] }, state.planningFocus[0]!.version ?? null);
    expect(state.planningFocus).toHaveLength(1);
    expect(state.planningFocus[0]?.projectIds).toEqual([p2]);
    expect(await sql`SELECT 1 FROM planning_focus_projects`).toHaveLength(1);
  });

  it("stores the review's reviewed-on date, keeps it when it is left out, and clears it with null", async () => {
    const { projects } = await seed();
    const [p1] = projects as [string];
    let state = await saveFocus({ projectIds: [p1], reviewedOn: "2026-08-20" });
    expect(state.planningFocus[0]?.reviewedOn).toBe("2026-08-20");
    // A later focus save that does not mention the date leaves it alone.
    state = await saveFocus({ projectIds: [] }, state.planningFocus[0]!.version ?? null);
    expect(state.planningFocus[0]?.reviewedOn).toBe("2026-08-20");
    expect(state.planningFocus[0]?.projectIds).toEqual([]);
    state = await saveFocus({ projectIds: [], reviewedOn: null }, state.planningFocus[0]!.version ?? null);
    expect(state.planningFocus[0]?.reviewedOn).toBeUndefined();
  });

  it("drops a deleted project from the period and refuses a missing or malformed one", async () => {
    const { projects } = await seed();
    const [p1] = projects as [string];
    await saveFocus({ projectIds: [p1] });
    await removeProject(p1);
    expect((await store.get())!.planningFocus[0]?.projectIds).toEqual([]);
    await expect(saveFocus({ projectIds: [crypto.randomUUID()] })).rejects.toThrow(/no longer exists/);
    await expect(saveFocus({ projectIds: ["nope"] })).rejects.toThrow(InvalidCommandError);
  });
});
