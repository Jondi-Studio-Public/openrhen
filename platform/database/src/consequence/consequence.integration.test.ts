import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import { integrationDatabaseName } from "../operations/integration-database.js";
import { ConsequenceComparisonError, issueNextConsequenceGroup, recordComparison } from "./comparisons.js";
import { refitConsequence, refitConsequenceIfStale } from "./refit.js";
import { loadPoolRows } from "./pool-load.js";

/**
 * The comparison log, the groups handed out, and the refit that turns them into `consequence_refined*` on projects and
 * actions (comparison-consequence-ranking design, 3.3 to 3.6), against a real database.
 */
config({ path: resolve(process.cwd(), "../../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(process.env.CONSEQUENCE_TEST_DATABASE_NAME, "openrhen_consequence");
if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("CONSEQUENCE_TEST_DATABASE_NAME must be an identifier ending in _test");
}
const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let userId: string;
let areaId: string;
let outcomeId: string;

const NOW = new Date("2026-11-09T02:00:00Z");
const DAY = "2026-11-09";

beforeAll(async () => {
  const admin = postgres(adminUrl!, { max: 1, connect_timeout: 10 });
  try {
    const existing = await admin<
      { exists: boolean }[]
    >`SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = ${testDatabaseName}) AS exists`;
    if (!existing[0]?.exists) await admin.unsafe(`CREATE DATABASE "${testDatabaseName}"`);
  } finally {
    await admin.end();
  }
  const migrationSql = postgres(testUrl.toString(), { max: 1, connect_timeout: 10 });
  try {
    await migrate(drizzle(migrationSql), { migrationsFolder: resolve(process.cwd(), "drizzle") });
  } finally {
    await migrationSql.end();
  }
  // No `fetch_types`, like the engine worker and the restore tool: arrays must not be relied on to arrive as arrays.
  sql = postgres(testUrl.toString(), { max: 5, connect_timeout: 10, fetch_types: false, onnotice: () => undefined });
}, 60_000);

beforeEach(async () => {
  await sql.unsafe("TRUNCATE TABLE users RESTART IDENTITY CASCADE");
  await sql.unsafe("TRUNCATE TABLE areas CASCADE");
  userId = (
    await sql<{ id: string }[]>`INSERT INTO users (display_name, timezone) VALUES ('Fixture', 'UTC') RETURNING id`
  )[0]!.id;
  areaId = (
    await sql<
      { id: string }[]
    >`INSERT INTO areas (user_id, name, sort_order) VALUES (${userId}, 'Life', 0) RETURNING id`
  )[0]!.id;
  outcomeId = (
    await sql<
      { id: string }[]
    >`INSERT INTO outcomes (area_id, title, definition_of_done) VALUES (${areaId}, 'Outcome', 'Done when done') RETURNING id`
  )[0]!.id;
});

afterAll(async () => {
  await sql?.end();
});

async function addProject(title: string, stars = 3): Promise<string> {
  return (
    await sql<
      { id: string }[]
    >`INSERT INTO projects (outcome_id, title, consequence) VALUES (${outcomeId}, ${title}, ${stars}) RETURNING id`
  )[0]!.id;
}
async function addAction(projectId: string, title: string, stars = 3): Promise<string> {
  return (
    await sql<
      { id: string }[]
    >`INSERT INTO actions (project_id, title, optimistic_minutes, expected_minutes, pessimistic_minutes, remaining_minutes, energy, minimum_session_minutes, maximum_session_minutes, consequence)
      VALUES (${projectId}, ${title}, 10, 20, 30, 20, 'medium', 10, 30, ${stars}) RETURNING id`
  )[0]!.id;
}
async function fourProjects(): Promise<string[]> {
  return [await addProject("Alpha"), await addProject("Bravo"), await addProject("Charlie"), await addProject("Delta")];
}
const refinedOf = async (table: "projects" | "actions", id: string) =>
  (
    await sql<
      { v: number | null; s: number | null; d: string | null }[]
    >`SELECT consequence_refined AS v, consequence_refined_for_stars AS s, to_char(consequence_refined_as_of, 'YYYY-MM-DD') AS d FROM ${sql(table)} WHERE id = ${id}`
  )[0]!;

/** Issues the next group for a pool and answers it with `rankedIds` (or a tie), as the person. */
async function answer(
  pool: "project" | "action",
  rank: (ids: string[]) => string[],
  options: {
    key?: string;
    basis?: "stated" | "observed" | "inferred";
    by?: "person" | "agent";
    evidence?: string;
    now?: Date;
    tie?: boolean;
  } = {}
) {
  const now = options.now ?? NOW;
  const group = await issueNextConsequenceGroup(sql, userId, pool, { now });
  expect(group).not.toBeNull();
  const recorded = await recordComparison(sql, userId, {
    groupId: group!.groupId,
    ...(options.tie ? { tie: true } : { rankedIds: rank(group!.itemIds) }),
    answeredBy: options.by ?? "person",
    basis: options.basis ?? "stated",
    ...(options.evidence ? { evidence: options.evidence } : {}),
    idempotencyKey: options.key ?? crypto.randomUUID(),
    now
  });
  return { group: group!, recorded };
}

describe("migration 0150", () => {
  it("adds the refined columns to projects and actions and not to deliverables", async () => {
    const columns = await sql<{ table_name: string; column_name: string }[]>`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name LIKE 'consequence_refined%' ORDER BY table_name, column_name`;
    expect(columns.map((c) => `${c.table_name}.${c.column_name}`)).toEqual([
      "actions.consequence_refined",
      "actions.consequence_refined_as_of",
      "actions.consequence_refined_for_stars",
      "projects.consequence_refined",
      "projects.consequence_refined_as_of",
      "projects.consequence_refined_for_stars"
    ]);
  });

  it("refuses a non-finite, out-of-range or half-filled refined value", async () => {
    const id = await addProject("P");
    const set = (v: string, s: string, d: string) =>
      sql.unsafe(
        `UPDATE projects SET consequence_refined = ${v}, consequence_refined_for_stars = ${s}, consequence_refined_as_of = ${d} WHERE id = '${id}'`
      );
    await expect(set("'NaN'", "3", "'2026-11-09'")).rejects.toThrow(/projects_consequence_refined_check/);
    await expect(set("'Infinity'", "3", "'2026-11-09'")).rejects.toThrow(/projects_consequence_refined_check/);
    await expect(set("6.5", "3", "'2026-11-09'")).rejects.toThrow(/projects_consequence_refined_check/);
    await expect(set("-0.1", "3", "'2026-11-09'")).rejects.toThrow(/projects_consequence_refined_check/);
    await expect(set("3.2", "6", "'2026-11-09'")).rejects.toThrow(/projects_consequence_refined_check/);
    await expect(set("3.2", "3", "NULL")).rejects.toThrow(/projects_consequence_refined_check/);
    await expect(set("3.2", "NULL", "'2026-11-09'")).rejects.toThrow(/projects_consequence_refined_check/);
    await expect(set("0", "1", "'2026-11-09'")).resolves.toBeDefined();
    await expect(set("6", "5", "'2026-11-09'")).resolves.toBeDefined();
    await expect(set("NULL", "NULL", "NULL")).resolves.toBeDefined();
    const actionId = await addAction(id, "A");
    await expect(
      sql.unsafe(
        `UPDATE actions SET consequence_refined = 7, consequence_refined_for_stars = 3, consequence_refined_as_of = '2026-11-09' WHERE id = '${actionId}'`
      )
    ).rejects.toThrow(/actions_consequence_refined_check/);
  });

  it("keeps item ids in the log free of any foreign key to projects or actions", async () => {
    const references = await sql<{ source: string; target: string }[]>`
      SELECT conrelid::regclass::text AS source, confrelid::regclass::text AS target FROM pg_constraint
      WHERE contype = 'f' AND conrelid::regclass::text IN ('consequence_comparisons', 'consequence_groups_issued')
      ORDER BY 1, 2`;
    expect(references).toEqual([
      { source: "consequence_comparisons", target: "consequence_groups_issued" },
      { source: "consequence_comparisons", target: "users" },
      { source: "consequence_groups_issued", target: "users" }
    ]);
  });
});

describe("recording a comparison", () => {
  it("stores the stars and material hash at answer time, and refits in the same transaction", async () => {
    const ids = await fourProjects();
    const { group, recorded } = await answer("project", (g) => [...g]);
    expect(group.itemIds).toEqual([...ids].sort());
    expect(recorded.replayed).toBe(false);
    const stored = (
      await sql<
        { stars: number[]; hashes: string[]; ranking: string[]; basis: string; wording: string; asked: Date }[]
      >`SELECT to_jsonb(item_stars) AS stars, to_jsonb(item_hashes) AS hashes, to_jsonb(ranking) AS ranking, basis, question_wording AS wording, asked_at AS asked FROM consequence_comparisons`
    )[0]!;
    expect(stored.stars).toEqual([3, 3, 3, 3]);
    expect(stored.hashes).toHaveLength(4);
    expect(stored.hashes.every((h) => /^[0-9a-f]{64}$/.test(h))).toBe(true);
    expect(stored.ranking).toEqual(group.itemIds);
    expect(stored.wording).toBe("only_finish_one");
    expect(stored.asked.toISOString()).toBe(NOW.toISOString());
    const rows = await loadPoolRows(sql, userId, "project");
    const first = rows.find((r) => r.id === group.itemIds[0])!;
    const last = rows.find((r) => r.id === group.itemIds[3])!;
    expect(first.refined).toBeGreaterThan(3);
    expect(last.refined).toBeLessThan(3);
    expect(first.refinedForStars).toBe(3);
    expect(first.refinedAsOf).toBe(DAY);
    // the group is marked answered
    const issued = await sql<
      { answered_comparison_id: string }[]
    >`SELECT answered_comparison_id::text FROM consequence_groups_issued`;
    expect(issued[0]!.answered_comparison_id).toBe(recorded.comparisonId);
  });

  it("is idempotent: the same key and answer is a replay, a different answer on the key is refused", async () => {
    await fourProjects();
    const { group, recorded } = await answer("project", (g) => [...g], { key: "k-1" });
    const again = await recordComparison(sql, userId, {
      groupId: group.groupId,
      rankedIds: group.itemIds,
      answeredBy: "person",
      basis: "stated",
      idempotencyKey: "k-1",
      now: NOW
    });
    expect(again).toEqual({ comparisonId: recorded.comparisonId, groupId: group.groupId, replayed: true });
    await expect(
      recordComparison(sql, userId, {
        groupId: group.groupId,
        rankedIds: [...group.itemIds].reverse(),
        answeredBy: "person",
        basis: "stated",
        idempotencyKey: "k-1",
        now: NOW
      })
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(Number((await sql`SELECT count(*)::int AS n FROM consequence_comparisons`)[0]!.n)).toBe(1);
  });

  it("answers a group once: a second answer under a new key is refused naming the group and the next step", async () => {
    await fourProjects();
    const { group } = await answer("project", (g) => [...g]);
    const error = await recordComparison(sql, userId, {
      groupId: group.groupId,
      rankedIds: group.itemIds,
      answeredBy: "person",
      basis: "stated",
      idempotencyKey: "another-key",
      now: NOW
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConsequenceComparisonError);
    expect((error as ConsequenceComparisonError).code).toBe("group_already_answered");
    expect((error as Error).message).toContain(group.groupId);
    expect((error as Error).message).toMatch(/ask for the next group/);
  });

  it("refuses a ranking that does not match the issued group, naming the correct ids", async () => {
    const ids = await fourProjects();
    const group = (await issueNextConsequenceGroup(sql, userId, "project", { now: NOW }))!;
    const call = (rankedIds: string[], extra: object = {}) =>
      recordComparison(sql, userId, {
        groupId: group.groupId,
        rankedIds,
        answeredBy: "person",
        basis: "stated",
        idempotencyKey: crypto.randomUUID(),
        now: NOW,
        ...extra
      });
    for (const wrong of [
      group.itemIds.slice(0, 3),
      [...group.itemIds.slice(0, 3), crypto.randomUUID()],
      [group.itemIds[0]!, ...group.itemIds]
    ]) {
      const error = (await call(wrong).catch((e: unknown) => e)) as ConsequenceComparisonError;
      expect(error.code).toBe("ranking_mismatch");
      for (const id of group.itemIds) expect(error.message).toContain(id);
      expect(error.message).toContain(group.groupId);
      expect(error.message).toMatch(/tie: true/);
    }
    expect(ids).toHaveLength(4);
    expect(Number((await sql`SELECT count(*)::int AS n FROM consequence_comparisons`)[0]!.n)).toBe(0);
    await expect(call([])).rejects.toMatchObject({ code: "bad_input" });
    await expect(call(group.itemIds, { tie: true })).rejects.toMatchObject({ code: "bad_input" });
  });

  it("refuses a group that was never issued, naming the one waiting", async () => {
    await fourProjects();
    const waiting = (await issueNextConsequenceGroup(sql, userId, "project", { now: NOW }))!;
    const error = (await recordComparison(sql, userId, {
      groupId: crypto.randomUUID(),
      rankedIds: waiting.itemIds,
      answeredBy: "person",
      basis: "stated",
      idempotencyKey: "k",
      now: NOW
    }).catch((e: unknown) => e)) as ConsequenceComparisonError;
    expect(error.code).toBe("group_not_found");
    expect(error.message).toContain(waiting.groupId);
    for (const id of waiting.itemIds) expect(error.message).toContain(id);
  });

  it("applies the basis rules: a person states, an agent's stated answer needs the owner's words", async () => {
    await fourProjects();
    const group = (await issueNextConsequenceGroup(sql, userId, "project", { now: NOW }))!;
    const call = (answeredBy: "person" | "agent", basis: "stated" | "observed" | "inferred", evidence?: string) =>
      recordComparison(sql, userId, {
        groupId: group.groupId,
        rankedIds: group.itemIds,
        answeredBy,
        basis,
        ...(evidence ? { evidence } : {}),
        idempotencyKey: crypto.randomUUID(),
        now: NOW
      });
    await expect(call("person", "inferred")).rejects.toMatchObject({ code: "basis_not_allowed" });
    await expect(call("agent", "stated")).rejects.toMatchObject({ code: "basis_not_allowed" });
    await expect(call("agent", "observed")).rejects.toMatchObject({ code: "basis_not_allowed" });
    await expect(call("agent", "inferred")).resolves.toMatchObject({ replayed: false });
    const row = (
      await sql<{ basis: string; answered_by: string }[]>`SELECT basis, answered_by FROM consequence_comparisons`
    )[0]!;
    expect(row).toEqual({ basis: "inferred", answered_by: "agent" });
  });

  it("refuses an answer once one of its items has been closed", async () => {
    const ids = await fourProjects();
    const group = (await issueNextConsequenceGroup(sql, userId, "project", { now: NOW }))!;
    await sql`UPDATE projects SET status = 'done' WHERE id = ${ids[0]!}`;
    await expect(
      recordComparison(sql, userId, {
        groupId: group.groupId,
        rankedIds: group.itemIds,
        answeredBy: "person",
        basis: "stated",
        idempotencyKey: "k",
        now: NOW
      })
    ).rejects.toMatchObject({ code: "items_changed" });
  });

  it("records a tie, which cools the group and moves nothing", async () => {
    await fourProjects();
    const { group } = await answer("project", () => [], { tie: true });
    expect((await sql`SELECT tie FROM consequence_comparisons`)[0]!.tie).toBe(true);
    for (const row of await loadPoolRows(sql, userId, "project")) expect(row.refined).toBeNull();
    // every pair of that group is cooling, so the next group cannot be the same four
    const next = await issueNextConsequenceGroup(sql, userId, "project", { now: NOW });
    expect(next).toBeNull();
    expect(group.itemIds).toHaveLength(4);
  });

  it("answers a log row at most once per group even under a race", async () => {
    await fourProjects();
    const group = (await issueNextConsequenceGroup(sql, userId, "project", { now: NOW }))!;
    const results = await Promise.allSettled(
      ["k1", "k2", "k3"].map((key) =>
        recordComparison(sql, userId, {
          groupId: group.groupId,
          rankedIds: group.itemIds,
          answeredBy: "person",
          basis: "stated",
          idempotencyKey: key,
          now: NOW
        })
      )
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(Number((await sql`SELECT count(*)::int AS n FROM consequence_comparisons`)[0]!.n)).toBe(1);
  });
});

describe("issuing groups", () => {
  it("hands out the waiting group again rather than a new one, and never mixes pools or projects", async () => {
    const p1 = await addProject("P1");
    const p2 = await addProject("P2");
    const a1 = await addAction(p1, "a1");
    const a2 = await addAction(p1, "a2");
    await addAction(p2, "b1");
    const first = (await issueNextConsequenceGroup(sql, userId, "action", { now: NOW }))!;
    expect(first.itemIds).toEqual([a1, a2].sort());
    const again = (await issueNextConsequenceGroup(sql, userId, "action", { now: NOW }))!;
    expect(again.groupId).toBe(first.groupId);
    expect(again.reissued).toBe(true);
    // Projects: only two exist, in the project pool.
    const projects = (await issueNextConsequenceGroup(sql, userId, "project", { now: NOW }))!;
    expect(projects.itemIds).toEqual([p1, p2].sort());
  });

  it("flags private items, and leaves them out of an agent-facing group", async () => {
    const [a, b, c] = [await addProject("A"), await addProject("B"), await addProject("C")];
    await sql`UPDATE projects SET private = true WHERE id = ${a}`;
    const agent = (await issueNextConsequenceGroup(sql, userId, "project", { now: NOW, agentFacing: true }))!;
    expect(agent.itemIds).toEqual([b, c].sort());
    expect(agent.containsPrivate).toBe(false);
    await sql`DELETE FROM consequence_groups_issued`;
    const person = (await issueNextConsequenceGroup(sql, userId, "project", { now: NOW }))!;
    expect(person.itemIds).toEqual([a, b, c].sort());
    expect(person.containsPrivate).toBe(true);
  });

  it("treats an area's privacy as the privacy of everything under it", async () => {
    await fourProjects();
    await sql`UPDATE areas SET private = true`;
    expect(await issueNextConsequenceGroup(sql, userId, "project", { now: NOW, agentFacing: true })).toBeNull();
    expect((await issueNextConsequenceGroup(sql, userId, "project", { now: NOW }))!.containsPrivate).toBe(true);
  });
});

describe("refit", () => {
  it("overwrites for_stars with the current stars on every fit and clears an item whose stars changed", async () => {
    const ids = await fourProjects();
    const { group } = await answer("project", (g) => [...g]);
    const top = group.itemIds[0]!;
    expect((await refinedOf("projects", top)).s).toBe(3);

    // An explicit star edit: the answer holds the old stars, so the whole answer is dropped and every item is cleared.
    await sql`UPDATE projects SET consequence = 4 WHERE id = ${ids[0]!}`;
    const outcome = await refitConsequence(sql, userId, DAY);
    expect(outcome.ok).toBe(true);
    for (const id of ids) expect(await refinedOf("projects", id)).toEqual({ v: null, s: null, d: null });
  });

  it("drops an answer when a material field changed, and keeps it when the same data is rewritten", async () => {
    const ids = await fourProjects();
    await answer("project", (g) => [...g]);
    await sql`UPDATE projects SET title = ${"  Alpha  "} WHERE id = ${ids[0]!}`; // trimmed text: same hash
    await refitConsequence(sql, userId, DAY);
    expect((await refinedOf("projects", ids[1]!)).v).not.toBeNull();
    await sql`UPDATE projects SET external_deadline_at = '2027-01-01T00:00:00Z' WHERE id = ${ids[0]!}`;
    await refitConsequence(sql, userId, DAY);
    expect((await refinedOf("projects", ids[1]!)).v).toBeNull();
    await sql`UPDATE projects SET external_deadline_at = NULL WHERE id = ${ids[0]!}`;
    await refitConsequence(sql, userId, DAY);
    expect((await refinedOf("projects", ids[1]!)).v).not.toBeNull();
    // A project's definition of done is its outcome's.
    await sql`UPDATE outcomes SET definition_of_done = 'Something else' WHERE id = ${outcomeId}`;
    await refitConsequence(sql, userId, DAY);
    expect((await refinedOf("projects", ids[1]!)).v).toBeNull();
  });

  it("lets a closed item leave its answer, clearing it and moving its siblings only slightly", async () => {
    const ids = await fourProjects();
    const { group } = await answer("project", (g) => [...g]);
    const [best, second, third, worst] = group.itemIds as [string, string, string, string];
    const before = (await refinedOf("projects", second)).v!;
    await sql`UPDATE projects SET status = 'cancelled' WHERE id = ${worst}`;
    await refitConsequence(sql, userId, DAY);
    expect(await refinedOf("projects", worst)).toEqual({ v: null, s: null, d: null });
    const after = (await refinedOf("projects", second)).v!;
    expect(Math.abs(after - before)).toBeLessThan(0.5);
    expect((await refinedOf("projects", best)).v).toBeGreaterThan(3);
    expect(third).toBeDefined();
    expect(ids).toHaveLength(4);
  });

  it("ages answers by local calendar day and refits on a new day only when something is stale", async () => {
    await fourProjects();
    const { group } = await answer("project", (g) => [...g]);
    const top = group.itemIds[0]!;
    const fresh = (await refinedOf("projects", top)).v!;
    expect(await refitConsequenceIfStale(sql, userId, NOW, "UTC")).toBeNull();
    const later = new Date("2027-05-08T02:00:00Z"); // 180 days on
    const outcome = await refitConsequenceIfStale(sql, userId, later, "UTC");
    expect(outcome?.ok).toBe(true);
    const aged = await refinedOf("projects", top);
    expect(aged.d).toBe("2027-05-08");
    expect(aged.v!).toBeGreaterThan(3);
    expect(aged.v!).toBeLessThan(fresh);
    expect(outcome!.changed.get(top)).toMatchObject({ forStars: 3 });
    expect(await refitConsequenceIfStale(sql, userId, later, "UTC")).toBeNull();
  });

  it("fits actions only among their siblings, and leaves deliverable actions alone", async () => {
    const p1 = await addProject("P1");
    const p2 = await addProject("P2");
    const actions = [
      await addAction(p1, "a1"),
      await addAction(p1, "a2"),
      await addAction(p1, "a3"),
      await addAction(p1, "a4")
    ];
    const other = await addAction(p2, "b1");
    const { group } = await answer("action", (g) => [...g]);
    expect(group.itemIds).toEqual([...actions].sort());
    expect((await refinedOf("actions", group.itemIds[0]!)).v).toBeGreaterThan(3);
    expect(await refinedOf("actions", other)).toEqual({ v: null, s: null, d: null });
    // projects are untouched by an action answer
    expect((await refinedOf("projects", p1)).v).toBeNull();
  });

  it("keeps the previous values when the refit fails, and reports it", async () => {
    const ids = await fourProjects();
    const { group } = await answer("project", (g) => [...g]);
    const top = group.itemIds[0]!;
    const before = await refinedOf("projects", top);
    await sql`UPDATE projects SET consequence = 5 WHERE id = ${ids[0]!}`; // would clear everything on the next fit
    await sql.unsafe(
      `CREATE FUNCTION fail_refit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'refit blocked'; END $$`
    );
    await sql.unsafe(
      `CREATE TRIGGER fail_refit BEFORE UPDATE OF consequence_refined ON projects FOR EACH ROW EXECUTE FUNCTION fail_refit()`
    );
    try {
      const silent = console.error;
      console.error = () => undefined;
      const outcome = await refitConsequence(sql, userId, DAY).finally(() => (console.error = silent));
      expect(outcome.ok).toBe(false);
      expect(outcome.error).toMatch(/refit blocked/);
      expect(await refinedOf("projects", top)).toEqual(before);
    } finally {
      await sql.unsafe("DROP TRIGGER fail_refit ON projects");
      await sql.unsafe("DROP FUNCTION fail_refit()");
    }
  });

  it("inside a caller's transaction a failed refit undoes only itself", async () => {
    const ids = await fourProjects();
    await answer("project", (g) => [...g]);
    await sql`UPDATE projects SET consequence = 5 WHERE id = ${ids[0]!}`;
    await sql.unsafe(
      `CREATE FUNCTION fail_refit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'refit blocked'; END $$`
    );
    await sql.unsafe(
      `CREATE TRIGGER fail_refit BEFORE UPDATE OF consequence_refined ON projects FOR EACH ROW EXECUTE FUNCTION fail_refit()`
    );
    const silent = console.error;
    console.error = () => undefined;
    try {
      await sql.begin(async (tx) => {
        await tx`UPDATE projects SET title = 'Edited in the same transaction' WHERE id = ${ids[1]!}`;
        const outcome = await refitConsequence(tx, userId, DAY);
        expect(outcome.ok).toBe(false);
      });
    } finally {
      console.error = silent;
      await sql.unsafe("DROP TRIGGER fail_refit ON projects");
      await sql.unsafe("DROP FUNCTION fail_refit()");
    }
    expect((await sql`SELECT title FROM projects WHERE id = ${ids[1]!}`)[0]!.title).toBe(
      "Edited in the same transaction"
    );
  });

  it("keeps inferred answers from reaching the bound however many an agent files", async () => {
    await fourProjects();
    for (let index = 0; index < 12; index += 1) {
      const now = new Date(NOW.getTime() - (11 - index) * 86_400_000);
      const group = (await issueNextConsequenceGroup(sql, userId, "project", { now }))!;
      await recordComparison(sql, userId, {
        groupId: group.groupId,
        rankedIds: group.itemIds,
        answeredBy: "agent",
        basis: "inferred",
        idempotencyKey: `inf-${index}`,
        now
      });
      // Move the pair history out of the 30-day window so the same four can be asked again.
      await sql`UPDATE consequence_groups_issued SET issued_at = issued_at - interval '40 days'`;
    }
    expect(Number((await sql`SELECT count(*)::int AS n FROM consequence_comparisons`)[0]!.n)).toBe(12);
    const rows = await loadPoolRows(sql, userId, "project");
    for (const row of rows) {
      expect(row.refined).not.toBeNull();
      expect(Math.abs(row.refined! - 3)).toBeLessThan(0.8);
    }
  });
});

describe("the log outlives the rows it describes", () => {
  it("survives the projects being deleted and written again with the same ids, and the refit comes straight back", async () => {
    const ids = await fourProjects();
    const { group } = await answer("project", (g) => [...g]);
    const before = await refinedOf("projects", group.itemIds[0]!);
    // What a state replace does to the rows: delete them and write them again (the refined columns do not come back).
    const snapshot = await sql`SELECT * FROM projects WHERE id = ANY(${`{${ids.join(",")}}`}::uuid[])`;
    await sql`DELETE FROM projects WHERE id = ANY(${`{${ids.join(",")}}`}::uuid[])`;
    expect(Number((await sql`SELECT count(*)::int AS n FROM consequence_comparisons`)[0]!.n)).toBe(1);
    for (const row of snapshot)
      await sql`INSERT INTO projects (id, outcome_id, title, consequence) VALUES (${row.id}, ${row.outcome_id}, ${row.title}, ${row.consequence})`;
    expect(await refinedOf("projects", group.itemIds[0]!)).toEqual({ v: null, s: null, d: null });
    await refitConsequence(sql, userId, DAY);
    expect(await refinedOf("projects", group.itemIds[0]!)).toEqual(before);
  });

  it("ignores ids that no longer exist, and is removed only with its user", async () => {
    const ids = await fourProjects();
    await answer("project", (g) => [...g]);
    await sql`DELETE FROM projects WHERE id = ${ids[0]!}`;
    const outcome = await refitConsequence(sql, userId, DAY);
    expect(outcome.ok).toBe(true);
    expect(Number((await sql`SELECT count(*)::int AS n FROM consequence_comparisons`)[0]!.n)).toBe(1);
    await sql.unsafe("TRUNCATE TABLE users CASCADE");
    expect(Number((await sql`SELECT count(*)::int AS n FROM consequence_comparisons`)[0]!.n)).toBe(0);
    expect(Number((await sql`SELECT count(*)::int AS n FROM consequence_groups_issued`)[0]!.n)).toBe(0);
  });

  it("keeps one user's answers out of another's pool", async () => {
    await fourProjects();
    await answer("project", (g) => [...g]);
    const otherUser = (await sql<{ id: string }[]>`INSERT INTO users (display_name) VALUES ('Other') RETURNING id`)[0]!
      .id;
    expect(await issueNextConsequenceGroup(sql, otherUser, "project", { now: NOW })).toBeNull();
    expect((await refitConsequence(sql, otherUser, DAY)).ok).toBe(true);
    const rows = await loadPoolRows(sql, userId, "project");
    expect(rows.every((row) => row.refined !== null)).toBe(true);
  });
});

describe("concurrent answers in both pools", () => {
  it("never deadlock: every refit completes and nothing is logged as failed", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      // Several independent users, so a lock-order race that fires only some of the time still shows.
      for (let round = 0; round < 6; round++) {
        const uid = (
          await sql<{ id: string }[]>`INSERT INTO users (display_name, timezone) VALUES ('Race', 'UTC') RETURNING id`
        )[0]!.id;
        const area = (
          await sql<
            { id: string }[]
          >`INSERT INTO areas (user_id, name, sort_order) VALUES (${uid}, 'Life', 0) RETURNING id`
        )[0]!.id;
        const outcome = (
          await sql<
            { id: string }[]
          >`INSERT INTO outcomes (area_id, title, definition_of_done) VALUES (${area}, 'O', 'Done') RETURNING id`
        )[0]!.id;
        const projectIds: string[] = [];
        for (const title of ["A", "B", "C", "D"])
          projectIds.push(
            (
              await sql<
                { id: string }[]
              >`INSERT INTO projects (outcome_id, title, consequence) VALUES (${outcome}, ${title}, 3) RETURNING id`
            )[0]!.id
          );
        for (const title of ["a", "b", "c", "d"])
          await sql`INSERT INTO actions (project_id, title, optimistic_minutes, expected_minutes, pessimistic_minutes, remaining_minutes, energy, minimum_session_minutes, maximum_session_minutes, consequence)
            VALUES (${projectIds[0]!}, ${title}, 10, 20, 30, 20, 'medium', 10, 30, 3)`;
        const projectGroup = (await issueNextConsequenceGroup(sql, uid, "project", { now: NOW }))!;
        const actionGroup = (await issueNextConsequenceGroup(sql, uid, "action", { now: NOW }))!;
        const answerGroup = (group: typeof projectGroup) =>
          recordComparison(sql, uid, {
            groupId: group.groupId,
            rankedIds: group.itemIds,
            answeredBy: "person",
            basis: "stated",
            idempotencyKey: crypto.randomUUID(),
            now: NOW
          });
        await Promise.all([answerGroup(projectGroup), answerGroup(actionGroup)]);
        const projects =
          await sql`SELECT 1 FROM projects p JOIN outcomes o ON o.id = p.outcome_id JOIN areas a ON a.id = o.area_id WHERE a.user_id = ${uid} AND p.consequence_refined IS NOT NULL`;
        const actions =
          await sql`SELECT 1 FROM actions x JOIN projects p ON p.id = x.project_id JOIN outcomes o ON o.id = p.outcome_id JOIN areas a ON a.id = o.area_id WHERE a.user_id = ${uid} AND x.consequence_refined IS NOT NULL`;
        expect(projects, `round ${round} project refit`).toHaveLength(4);
        expect(actions, `round ${round} action refit`).toHaveLength(4);
      }
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });
});
