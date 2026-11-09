import { describe, expect, it } from "vitest";
import { issueNextConsequenceGroup, recordComparison, refitConsequence, loadPoolRows } from "@openrhen/database";
import { createSeedState, type PortalState } from "@/state/portal-state";
import { ensureUser } from "./ensure-user";
import { refreshPlanning, setupStateStoreSuite, sql, fixedNow, unplannedStore as store } from "./state-store-harness";

/**
 * Comparison-derived consequence through the portal's own paths (comparison-consequence-ranking design, 3.4): the
 * readers map the stored columns into the state fields, a whole-state replace (which deletes and rewrites projects and
 * actions) recomputes them from the log in its transaction and never touches the log, and an ordinary save never nulls
 * them. The fit itself is covered in `platform/database/src/consequence`.
 */
setupStateStoreSuite("openrhen_consequence_portal");

type Project = PortalState["projects"][number];
type Action = PortalState["actions"][number];

async function seedFourProjectsAndActions() {
  await store.put(createSeedState(fixedNow));
  const userId = await ensureUser(sql);
  const first = (await store.get())!.projects[0]!;
  const outcomeId = first.outcomeId!;
  for (const title of ["Third project", "Fourth project"])
    await sql`INSERT INTO projects (outcome_id, title, consequence) VALUES (${outcomeId}, ${title}, 3)`;
  for (const title of ["Sibling one", "Sibling two", "Sibling three", "Sibling four"])
    await sql`INSERT INTO actions (project_id, title, optimistic_minutes, expected_minutes, pessimistic_minutes, remaining_minutes, energy, minimum_session_minutes, maximum_session_minutes, consequence)
      VALUES (${first.id}, ${title}, 10, 20, 30, 20, 'medium', 10, 30, 3)`;
  return { userId, first };
}

async function answerGroup(userId: string, pool: "project" | "action", key: string) {
  const group = (await issueNextConsequenceGroup(sql, userId, pool, { now: new Date() }))!;
  expect(group).not.toBeNull();
  await recordComparison(sql, userId, {
    groupId: group.groupId,
    rankedIds: group.itemIds,
    answeredBy: "person",
    basis: "stated",
    idempotencyKey: key
  });
  return group;
}

const refinedRows = (table: "projects" | "actions") =>
  sql<
    { id: string; v: number | null; s: number | null }[]
  >`SELECT id, consequence_refined AS v, consequence_refined_for_stars AS s FROM ${sql(table)} WHERE consequence_refined IS NOT NULL ORDER BY id`;

describe("comparison-derived consequence in the portal", () => {
  it("reads the stored columns into consequenceRefined and consequenceRefinedForStars", async () => {
    const { userId } = await seedFourProjectsAndActions();
    const group = await answerGroup(userId, "project", "p-1");
    const state = (await store.get())!;
    const best = state.projects.find((p) => p.id === group.itemIds[0])!;
    const worst = state.projects.find((p) => p.id === group.itemIds[3])!;
    expect(best.consequenceRefined).toBeGreaterThan(best.consequence);
    expect(best.consequenceRefinedForStars).toBe(best.consequence);
    expect(worst.consequenceRefined).toBeLessThan(worst.consequence);
    // a project outside the group has neither field
    const stored = new Set((await refinedRows("projects")).map((row) => row.id));
    for (const project of state.projects) expect(project.consequenceRefined !== undefined).toBe(stored.has(project.id));
    await answerGroup(userId, "action", "a-1");
    const actions = (await store.get())!.actions.filter((a) => a.consequenceRefined !== undefined);
    expect(actions).toHaveLength(4);
    expect(actions.every((a) => a.consequenceRefinedForStars === a.consequence)).toBe(true);
  });

  it("reads a value outside 0..6 or without its stars as no value", async () => {
    const { first } = await seedFourProjectsAndActions();
    // The table's CHECK refuses these, so drop it for the moment: a reader must not trust the column alone.
    await sql.unsafe("ALTER TABLE projects DROP CONSTRAINT projects_consequence_refined_check");
    try {
      await sql`UPDATE projects SET consequence_refined = 7.5, consequence_refined_for_stars = 3, consequence_refined_as_of = '2026-11-09' WHERE id = ${first.id}`;
      const bad = (await store.get())!.projects.find((p) => p.id === first.id)!;
      expect(bad.consequenceRefined).toBeUndefined();
      expect(bad.consequenceRefinedForStars).toBeUndefined();
      await sql`UPDATE projects SET consequence_refined = 3.5, consequence_refined_for_stars = NULL WHERE id = ${first.id}`;
      expect((await store.get())!.projects.find((p) => p.id === first.id)!.consequenceRefined).toBeUndefined();
    } finally {
      await sql`UPDATE projects SET consequence_refined = NULL, consequence_refined_for_stars = NULL, consequence_refined_as_of = NULL`;
      await sql.unsafe(
        `ALTER TABLE projects ADD CONSTRAINT projects_consequence_refined_check CHECK ((consequence_refined is null and consequence_refined_for_stars is null and consequence_refined_as_of is null) or (consequence_refined is not null and consequence_refined_for_stars is not null and consequence_refined_as_of is not null and consequence_refined between 0 and 6 and consequence_refined_for_stars between 1 and 5))`
      );
    }
  });

  it("recomputes from the log after a whole-state replace, and the replace does not touch the log", async () => {
    const { userId } = await seedFourProjectsAndActions();
    await answerGroup(userId, "project", "p-1");
    await answerGroup(userId, "action", "a-1");
    const projectsBefore = await refinedRows("projects");
    const actionsBefore = await refinedRows("actions");
    expect(projectsBefore).toHaveLength(4);
    expect(actionsBefore).toHaveLength(4);
    const logBefore = await sql`SELECT id, item_ids, ranking, item_hashes FROM consequence_comparisons ORDER BY id`;

    // A GET-to-PUT round trip: the document carries the refined fields, and the replace rewrites every row.
    const document = (await store.get())!;
    await store.put(document);

    expect(await sql`SELECT id, item_ids, ranking, item_hashes FROM consequence_comparisons ORDER BY id`).toEqual(
      logBefore
    );
    expect(await refinedRows("projects")).toEqual(projectsBefore);
    expect(await refinedRows("actions")).toEqual(actionsBefore);
  });

  it("does not trust refined values the replaced document carries", async () => {
    await seedFourProjectsAndActions();
    const document = (await store.get())!;
    const forged: PortalState = {
      ...document,
      projects: document.projects.map((p) => ({
        ...p,
        consequenceRefined: 5.5,
        consequenceRefinedForStars: p.consequence
      }))
    };
    await store.put(forged);
    expect(await refinedRows("projects")).toEqual([]);
    expect((await store.get())!.projects.every((p) => p.consequenceRefined === undefined)).toBe(true);
  });

  it("drops an answer after a replace that changes what it was about, but keeps the log row", async () => {
    const { userId } = await seedFourProjectsAndActions();
    await answerGroup(userId, "project", "p-1");
    const document = (await store.get())!;
    await store.put({
      ...document,
      projects: document.projects.map((p, index) => (index === 0 ? { ...p, title: `${p.title} (renamed)` } : p))
    });
    expect(await refinedRows("projects")).toEqual([]);
    expect(Number((await sql`SELECT count(*)::int AS n FROM consequence_comparisons`)[0]!.n)).toBe(1);
  });

  it("keeps the material hashes of the same data unchanged across a replace", async () => {
    const { userId } = await seedFourProjectsAndActions();
    const before = (await loadPoolRows(sql, userId, "project")).map((row) => [row.id, row.materialHash]);
    const hashesBefore = (await loadPoolRows(sql, userId, "action")).map((row) => [row.id, row.materialHash]);
    await store.put((await store.get())!);
    expect((await loadPoolRows(sql, userId, "project")).map((row) => [row.id, row.materialHash])).toEqual(before);
    // Actions the document carries keep theirs too (the four added by SQL are in it, so they come back with new ids by
    // title only if the document id maps to the same stored id).
    const after = (await loadPoolRows(sql, userId, "action")).map((row) => [row.id, row.materialHash]);
    expect(after).toEqual(hashesBefore);
  });

  it("never nulls the refined columns on an ordinary project or action save", async () => {
    const { userId } = await seedFourProjectsAndActions();
    await answerGroup(userId, "project", "p-1");
    await answerGroup(userId, "action", "a-1");
    const projectsBefore = await refinedRows("projects");
    const actionsBefore = await refinedRows("actions");
    const state = (await store.get())!;
    const project: Project = state.projects.find((p) => p.consequenceRefined !== undefined)!;
    await store.saveProject({
      expectedVersion: project.version!,
      project: {
        id: project.id,
        outcomeId: project.outcomeId!,
        title: project.title,
        status: project.status,
        uncertainty: project.uncertainty === "high" ? "some" : "high",
        consequence: project.consequence
      } as never
    });
    const action: Action = state.actions.find((a) => a.consequenceRefined !== undefined)!;
    await store.saveAction({
      expectedVersion: action.version!,
      action: {
        id: action.id,
        projectId: action.projectId,
        title: action.title,
        status: action.status,
        optimisticMinutes: action.optimisticMinutes,
        expectedMinutes: action.expectedMinutes,
        pessimisticMinutes: action.pessimisticMinutes,
        remainingMinutes: action.remainingMinutes,
        energy: action.energy,
        minimumSessionMinutes: action.minimumSessionMinutes,
        maximumSessionMinutes: action.maximumSessionMinutes,
        splittable: action.splittable,
        setupMinutes: action.setupMinutes,
        importance: action.importance === 5 ? 4 : 5,
        consequence: action.consequence,
        contexts: [],
        dependencyIds: []
      } as never
    });
    expect(await refinedRows("projects")).toEqual(projectsBefore);
    expect(await refinedRows("actions")).toEqual(actionsBefore);
  });

  it("makes the engine fall back to stars at once when the stars are edited, before any refit", async () => {
    const { userId } = await seedFourProjectsAndActions();
    const group = await answerGroup(userId, "project", "p-1");
    const state = (await store.get())!;
    const project = state.projects.find((p) => p.id === group.itemIds[0])!;
    await store.saveProject({
      expectedVersion: project.version!,
      project: {
        id: project.id,
        outcomeId: project.outcomeId!,
        title: project.title,
        status: project.status,
        uncertainty: project.uncertainty,
        consequence: project.consequence === 5 ? 4 : project.consequence + 1
      } as never
    });
    const edited = (await store.get())!.projects.find((p) => p.id === project.id)!;
    // The stored value still names the stars it was fitted for, which no longer match: the engine ignores it.
    expect(edited.consequenceRefinedForStars).toBe(project.consequence);
    expect(edited.consequenceRefinedForStars).not.toBe(edited.consequence);
    // The next refit drops the stale answer and clears the item's columns.
    await refitConsequence(sql, userId, new Date().toISOString().slice(0, 10));
    expect((await store.get())!.projects.find((p) => p.id === project.id)!.consequenceRefined).toBeUndefined();
  });

  it("refits on the day roll when a plan is built on a later day than the fit", async () => {
    const { userId } = await seedFourProjectsAndActions();
    const group = await answerGroup(userId, "project", "p-1");
    const top = group.itemIds[0]!;
    await sql`UPDATE projects SET consequence_refined_as_of = '2020-01-01' WHERE consequence_refined IS NOT NULL`;
    await refreshPlanning();
    const row = (
      await sql<
        { d: string }[]
      >`SELECT to_char(consequence_refined_as_of, 'YYYY-MM-DD') AS d FROM projects WHERE id = ${top}`
    )[0]!;
    expect(row.d).not.toBe("2020-01-01");
  });
});
