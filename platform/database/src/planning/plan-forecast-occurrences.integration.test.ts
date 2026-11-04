import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import { dropSupersededOccurrences, upsertActionOccurrence } from "./plan-forecast-runtime.js";
import { integrationDatabaseName } from "../operations/integration-database.js";

config({ path: resolve(process.cwd(), "../../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
// A database of its own for the same reason the retention and queue suites have one: these
// suites truncate, and two of them truncating the same database is a flake nobody can reproduce.
const testDatabaseName = integrationDatabaseName(
  process.env.PLAN_OCCURRENCE_TEST_DATABASE_NAME,
  "openrhen_plan_occurrence"
);

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("PLAN_OCCURRENCE_TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

let sql: postgres.Sql;
let userId: string;
let actionId: string;
let ruleId: string;
let windowId: string;

const calculatedAt = new Date("2026-08-10T05:00:00Z");

async function insertOccurrence(input: {
  id: string;
  windowStartsAt: Date;
  windowEndsAt: Date;
  status?: string;
  anchorSource?: string;
}) {
  await sql`
    INSERT INTO action_occurrences (id,action_id,rule_id,window_id,local_date,window_starts_at,window_ends_at,anchor_source,status)
    VALUES (${input.id},${actionId},${ruleId},${windowId},'2026-08-10',${input.windowStartsAt},${input.windowEndsAt},
      ${input.anchorSource ?? "fallback"},${input.status ?? "pending"})
  `;
}

const survivingIds = async () =>
  (await sql<{ id: string }[]>`SELECT id FROM action_occurrences ORDER BY id`).map((row) => row.id);

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
  sql = postgres(testUrl.toString(), { max: 5, connect_timeout: 10, fetch_types: false });
}, 60_000);

beforeEach(async () => {
  // This suite is allowed to clear only a database whose validated name ends in _test.
  await sql.unsafe("TRUNCATE TABLE users RESTART IDENTITY CASCADE");
  const users = await sql<{ id: string }[]>`INSERT INTO users (display_name) VALUES ('Window Fixture') RETURNING id`;
  userId = users[0]!.id;
  const areas = await sql<
    { id: string }[]
  >`INSERT INTO areas (user_id,name,sort_order) VALUES (${userId},'Health',1) RETURNING id`;
  const outcomes = await sql<{ id: string }[]>`
    INSERT INTO outcomes (area_id,title,definition_of_done) VALUES (${areas[0]!.id},'Healthy teeth','No decay') RETURNING id
  `;
  const projects = await sql<
    { id: string }[]
  >`INSERT INTO projects (outcome_id,title) VALUES (${outcomes[0]!.id},'Daily care') RETURNING id`;
  const actions = await sql<{ id: string }[]>`
    INSERT INTO actions (project_id,title,scheduling_mode,optimistic_minutes,expected_minutes,pessimistic_minutes,remaining_minutes,energy,minimum_session_minutes,maximum_session_minutes)
    VALUES (${projects[0]!.id},'Brush','recurring',5,5,10,5,'low',5,10) RETURNING id
  `;
  actionId = actions[0]!.id;
  const rules = await sql<{ id: string }[]>`
    INSERT INTO action_recurrence_rules (action_id,timezone,start_date,end_date) VALUES (${actionId},'Australia/Sydney','2026-08-01','2026-12-01') RETURNING id
  `;
  ruleId = rules[0]!.id;
  const windows = await sql<{ id: string }[]>`
    INSERT INTO action_recurrence_windows (rule_id,name,anchor,start_offset_minutes,end_offset_minutes,fallback_start_time,fallback_end_time)
    VALUES (${ruleId},'Bedtime','sleep_start',-180,0,'20:00','21:00') RETURNING id
  `;
  windowId = windows[0]!.id;
});

afterAll(async () => {
  await sql?.end();
});

describe("superseded occurrence rows", () => {
  it("drops a still-open pending window the run no longer resolves", async () => {
    await insertOccurrence({
      id: "stale",
      windowStartsAt: new Date(calculatedAt.getTime() + 4 * HOUR),
      windowEndsAt: new Date(calculatedAt.getTime() + 7 * HOUR)
    });
    await dropSupersededOccurrences(sql, userId, [], calculatedAt);
    expect(await survivingIds()).toEqual([]);
  });

  it("keeps the windows the run did resolve", async () => {
    await insertOccurrence({
      id: "resolved",
      windowStartsAt: new Date(calculatedAt.getTime() + 4 * HOUR),
      windowEndsAt: new Date(calculatedAt.getTime() + 7 * HOUR)
    });
    await insertOccurrence({
      id: "stale",
      windowStartsAt: new Date(calculatedAt.getTime() + 5 * HOUR),
      windowEndsAt: new Date(calculatedAt.getTime() + 8 * HOUR)
    });
    await dropSupersededOccurrences(sql, userId, ["resolved"], calculatedAt);
    expect(await survivingIds()).toEqual(["resolved"]);
  });

  it("never touches an outcome already recorded against a window", async () => {
    for (const status of ["completed", "missed", "cancelled"])
      await insertOccurrence({
        id: status,
        status,
        windowStartsAt: new Date(calculatedAt.getTime() + 4 * HOUR),
        windowEndsAt: new Date(calculatedAt.getTime() + 7 * HOUR)
      });
    await dropSupersededOccurrences(sql, userId, [], calculatedAt);
    expect(await survivingIds()).toEqual(["cancelled", "completed", "missed"]);
  });

  it("leaves alone what this run was never asked to resolve", async () => {
    await insertOccurrence({
      id: "already-passed",
      windowStartsAt: new Date(calculatedAt.getTime() - 5 * HOUR),
      windowEndsAt: new Date(calculatedAt.getTime() - 2 * HOUR)
    });
    await insertOccurrence({
      id: "beyond-the-horizon",
      windowStartsAt: new Date(calculatedAt.getTime() + 15 * DAY),
      windowEndsAt: new Date(calculatedAt.getTime() + 15 * DAY + 3 * HOUR)
    });
    await dropSupersededOccurrences(sql, userId, [], calculatedAt);
    expect(await survivingIds()).toEqual(["already-passed", "beyond-the-horizon"]);
  });

  it("keeps a window whose time is already being spent", async () => {
    await insertOccurrence({
      id: "in-progress",
      windowStartsAt: new Date(calculatedAt.getTime() - 10 * MINUTE),
      windowEndsAt: new Date(calculatedAt.getTime() + 2 * HOUR)
    });
    await sql`
      INSERT INTO sessions (user_id,occurrence_id,planned_started_at,planned_end_at,started_at,planned_minutes,remaining_before_minutes,status)
      VALUES (${userId},'in-progress',${calculatedAt},${new Date(calculatedAt.getTime() + 30 * MINUTE)},${calculatedAt},30,5,'running')
    `;
    await dropSupersededOccurrences(sql, userId, [], calculatedAt);
    expect(await survivingIds()).toEqual(["in-progress"]);
  });

  it("keeps an occurrence a live recommendation's candidate row still cites, then drops it once that ranking is superseded and pruned", async () => {
    await insertOccurrence({
      id: "cited-by-ranking",
      windowStartsAt: new Date(calculatedAt.getTime() + 4 * HOUR),
      windowEndsAt: new Date(calculatedAt.getTime() + 7 * HOUR)
    });
    const recommendations = await sql<{ id: string }[]>`
      INSERT INTO recommendations (user_id,calculated_at,input_version,kind,target_type,target_id,headline,explanation)
      VALUES (${userId},${calculatedAt},'v1','next_action','action',${actionId},'Brush your teeth','Because it is bedtime')
      RETURNING id
    `;
    const recommendationId = recommendations[0]!.id;
    await sql`
      INSERT INTO recommendation_candidates
        (recommendation_id,occurrence_id,target_type,target_id,rank,total_score,score_components,eligible)
      VALUES (${recommendationId},'cited-by-ranking','action',${actionId},1,10,${sql.json({})},true)
    `;

    // A run that no longer resolves this occurrence must not fail the whole job with an FK violation
    // against recommendation_candidates_occurrence_id_fkey — the still-live ranking keeps the row alive.
    await expect(dropSupersededOccurrences(sql, userId, [], calculatedAt)).resolves.not.toThrow();
    expect(await survivingIds()).toEqual(["cited-by-ranking"]);

    // Once the recommendation is superseded and pruneSupersededRecommendationCandidates has cleared its
    // candidate rows (replicated here rather than importing that unexported helper), nothing cites the
    // occurrence any more and the next cleanup is free to drop it.
    await sql`UPDATE recommendations SET superseded_at=${calculatedAt} WHERE id=${recommendationId}`;
    await sql`
      DELETE FROM recommendation_candidates
      WHERE recommendation_id IN (SELECT id FROM recommendations WHERE user_id=${userId} AND superseded_at IS NOT NULL)
    `;
    await dropSupersededOccurrences(sql, userId, [], calculatedAt);
    expect(await survivingIds()).toEqual([]);
  });
});

describe("re-anchoring a materialised window", () => {
  const reResolve = (id: string, status: string, startsAt: Date, endsAt: Date) =>
    upsertActionOccurrence(sql, {
      id,
      actionId,
      ruleId,
      windowId,
      localDate: "2026-08-10",
      windowStartsAt: startsAt,
      windowEndsAt: endsAt,
      anchorSource: "actual_wake",
      status,
      routineCovered: true
    });

  const timesOf = async (id: string) =>
    (
      await sql<{ window_starts_at: Date; window_ends_at: Date; anchor_source: string; routine_covered: boolean }[]>`
        SELECT window_starts_at,window_ends_at,anchor_source,routine_covered FROM action_occurrences WHERE id=${id}
      `
    )[0]!;

  it("moves a pending window when the anchor moves", async () => {
    const startsAt = new Date("2026-08-10T09:00:00Z");
    const endsAt = new Date("2026-08-10T10:00:00Z");
    await insertOccurrence({ id: "pending-window", windowStartsAt: startsAt, windowEndsAt: endsAt });
    const moved = new Date(startsAt.getTime() + 2 * HOUR);
    await reResolve("pending-window", "pending", moved, new Date(endsAt.getTime() + 2 * HOUR));
    const row = await timesOf("pending-window");
    expect(row.window_starts_at.toISOString()).toBe(moved.toISOString());
    expect(row.anchor_source).toBe("actual_wake");
  });

  // Waking later re-anchors the morning window, and a run that re-resolves an occurrence already
  // completed must not drag its recorded times along: those times are the evidence of when the work
  // was actually done. Completing the row also deliberately clears routine_covered, so healing that
  // back from the rule would undo a user action too.
  it("leaves a completed window's recorded times and coverage alone", async () => {
    const startsAt = new Date("2026-08-10T09:00:00Z");
    const endsAt = new Date("2026-08-10T10:00:00Z");
    await insertOccurrence({ id: "done-window", windowStartsAt: startsAt, windowEndsAt: endsAt, status: "completed" });
    await sql`UPDATE action_occurrences SET routine_covered=false WHERE id='done-window'`;
    const drift = 2 * HOUR + 45 * MINUTE;
    await reResolve(
      "done-window",
      "completed",
      new Date(startsAt.getTime() + drift),
      new Date(endsAt.getTime() + drift)
    );
    const row = await timesOf("done-window");
    expect(row.window_starts_at.toISOString()).toBe(startsAt.toISOString());
    expect(row.window_ends_at.toISOString()).toBe(endsAt.toISOString());
    expect(row.anchor_source).toBe("fallback");
    expect(row.routine_covered).toBe(false);
  });

  it("leaves a missed window alone for the same reason", async () => {
    const startsAt = new Date("2026-08-10T09:00:00Z");
    const endsAt = new Date("2026-08-10T10:00:00Z");
    await insertOccurrence({ id: "missed-window", windowStartsAt: startsAt, windowEndsAt: endsAt, status: "missed" });
    await reResolve(
      "missed-window",
      "missed",
      new Date(startsAt.getTime() + 3 * HOUR),
      new Date(endsAt.getTime() + 3 * HOUR)
    );
    expect((await timesOf("missed-window")).window_starts_at.toISOString()).toBe(startsAt.toISOString());
  });
});
