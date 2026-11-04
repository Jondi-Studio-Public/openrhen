import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import { integrationDatabaseName } from "@openrhen/database";
import { ensureUser } from "./ensure-user";
import { readNudgeSummary, recordNudgeShadow } from "@openrhen/database";
import { createManualLink, setSwitch } from "./plan-map-store";

config({ path: resolve(process.cwd(), "../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(process.env.TEST_DATABASE_NAME, "openrhen_plan_nudge");

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let userId: string;
const NOW = new Date("2026-10-01T00:00:00.000Z");

beforeAll(async () => {
  const admin = postgres(adminUrl, { max: 1, connect_timeout: 10 });
  try {
    const existing = await admin<{ exists: boolean }[]>`
      SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = ${testDatabaseName}) AS exists
    `;
    if (!existing[0]?.exists) await admin.unsafe(`CREATE DATABASE "${testDatabaseName}"`);
  } finally {
    await admin.end();
  }
  const migrationSql = postgres(testUrl.toString(), { max: 1, connect_timeout: 10 });
  try {
    await migrate(drizzle(migrationSql), { migrationsFolder: resolve(process.cwd(), "../platform/database/drizzle") });
  } finally {
    await migrationSql.end();
  }
  sql = postgres(testUrl.toString(), { max: 4, connect_timeout: 10, fetch_types: false, prepare: true });
}, 30_000);

beforeEach(async () => {
  await sql.unsafe("TRUNCATE TABLE users, user_preferences, portal_state CASCADE");
  userId = await ensureUser(sql);
});

afterAll(async () => {
  await sql?.end();
});

async function createProject(title: string, externalDeadlineAt: Date | null): Promise<string> {
  const area = await sql<{ id: string }[]>`
    INSERT INTO areas (user_id,name,status,sort_order) VALUES (${userId},${"Area " + crypto.randomUUID()},'active',0) RETURNING id`;
  const outcome = await sql<{ id: string }[]>`
    INSERT INTO outcomes (area_id,title,definition_of_done,status) VALUES (${area[0]!.id},'Outcome','Done','active') RETURNING id`;
  const project = await sql<{ id: string }[]>`
    INSERT INTO projects (outcome_id,title,status,external_deadline_at) VALUES (${outcome[0]!.id},${title},'active',${externalDeadlineAt}) RETURNING id`;
  return project[0]!.id;
}

async function createAction(projectId: string, title: string, mode = "one_off"): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO actions (project_id,title,scheduling_mode,status,optimistic_minutes,expected_minutes,pessimistic_minutes,remaining_minutes,energy,minimum_session_minutes,maximum_session_minutes)
    VALUES (${projectId},${title},${mode},'active',10,20,30,20,'medium',10,30) RETURNING id`;
  return rows[0]!.id;
}

async function link(kind: "about" | "prepares", from: [string, string], to: [string, string]) {
  const result = await createManualLink(
    sql,
    userId,
    { kind, fromType: from[0] as never, fromId: from[1], toType: to[0] as never, toId: to[1] },
    NOW
  );
  expect(result.ok).toBe(true);
}

/** A persisted-result shape with just the ranking the shadow pass reads. */
function resultFor(items: { id: string; projectId: string; score: number }[]) {
  return {
    recommendation: {
      candidates: items.map((item) => ({
        action: { id: item.id, projectId: item.projectId, title: item.id, schedulingMode: "one_off" },
        totalScore: item.score,
        eligible: true,
        criticalTier: "ordinary"
      }))
    }
  };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

async function seed() {
  const uni = await createProject("Uni prep", new Date(NOW.getTime() + 3 * 86_400_000));
  const other = await createProject("Garden", null);
  const practice = await createAction(uni, "Practice paper");
  const garden = await createAction(other, "Weed beds");
  await link("about", ["project", uni], ["subject", "maths"]);
  await link("prepares", ["action", practice], ["project", uni]);
  return { uni, other, practice, garden };
}

async function counts() {
  const [row] = await sql<{ runs: string; candidates: string; shadow: string }[]>`
    SELECT (SELECT count(*) FROM planning_runs) AS runs,
           (SELECT count(*) FROM recommendation_candidates) AS candidates,
           (SELECT count(*) FROM plan_shadow_log WHERE addon = 'nudge') AS shadow`;
  return { runs: Number(row!.runs), candidates: Number(row!.candidates), shadow: Number(row!.shadow) };
}

describe("plan map nudge shadow pass", () => {
  it("does nothing, and leaves the ranking untouched, while the switch is off", async () => {
    const { uni, other, practice, garden } = await seed();
    const result = deepFreeze(
      resultFor([
        { id: garden, projectId: other, score: 60 },
        { id: practice, projectId: uni, score: 55 }
      ])
    );
    const before = await counts();
    const outcome = await recordNudgeShadow(sql, userId, result, NOW);
    expect(outcome.ran).toBe(false);
    expect(await counts()).toEqual(before);
  });

  it("records would-be moves at all three caps in shadow without touching the ranking", async () => {
    const { uni, other, practice, garden } = await seed();
    await setSwitch(sql, userId, "nudge", "shadow");
    const result = deepFreeze(
      resultFor([
        { id: garden, projectId: other, score: 60 },
        { id: practice, projectId: uni, score: 55 }
      ])
    );
    const before = await counts();
    const outcome = await recordNudgeShadow(sql, userId, result, NOW);
    expect(outcome.ran).toBe(true);
    // Nothing the live path owns changed: only the shadow log grew.
    expect(await counts()).toEqual({ ...before, shadow: expect.any(Number) });
    expect((await counts()).shadow).toBeGreaterThan(0);
    // The result the caller holds is the frozen original: still identical.
    expect(result.recommendation.candidates.map((c) => c.action.id)).toEqual([garden, practice]);

    const summary = await readNudgeSummary(sql, userId, new Date(NOW.getTime() - 86_400_000));
    expect(summary.map((cap) => cap.capDays)).toEqual([0.5, 1, 2]);
    expect(summary.every((cap) => cap.runs === 1)).toBe(true);
    // 55 + 6 passes 60 only at the two day cap.
    expect(summary.map((cap) => cap.actionsMoved)).toEqual([0, 0, 1]);
    // The displaced action belongs to a project with no deadline, so nothing due slips.
    expect(summary.map((cap) => cap.slippedDue)).toEqual([0, 0, 0]);
    expect(summary.map((cap) => cap.movedThenDone)).toEqual([0, 0, 0]);
    await sql`UPDATE actions SET status = 'done', updated_at = ${new Date(NOW.getTime() + 3_600_000)} WHERE id = ${practice}`;
    const after = await readNudgeSummary(sql, userId, new Date(NOW.getTime() - 86_400_000));
    expect(after.map((cap) => cap.movedThenDone)).toEqual([0, 0, 1]);
  });

  it("boosts what prepares an exam, linked on its recurrence rule, and ignores a cancelled exam", async () => {
    const project = await createProject("Maths unit", null);
    const practice = await createAction(project, "Practice paper");
    const other = await createAction(await createProject("Garden", null), "Weed beds");
    const rule = await sql<{ id: string }[]>`
      INSERT INTO commitment_recurrence_rules (user_id, title, timezone, start_date, interval_unit, interval_weeks, weekdays, local_start_time, local_end_time)
      VALUES (${userId}, 'Maths exam', 'Australia/Sydney', '2026-10-01', 'weeks', 1, '[1]'::jsonb, '09:00', '11:00') RETURNING id`;
    const startsAt = new Date(NOW.getTime() + 2 * 86_400_000);
    const exam = await sql<{ id: string }[]>`
      INSERT INTO commitments(user_id,title,starts_at,ends_at,status,recurrence_rule_id,local_date)
      VALUES (${userId},'Maths exam',${startsAt},${new Date(startsAt.getTime() + 7_200_000)},'confirmed',${rule[0]!.id},'2026-10-03') RETURNING id`;
    await link("about", ["commitment", rule[0]!.id], ["subject", "maths"]);
    await link("prepares", ["action", practice], ["commitment", rule[0]!.id]);
    await setSwitch(sql, userId, "nudge", "shadow");
    const result = resultFor([
      { id: other, projectId: project, score: 60 },
      { id: practice, projectId: project, score: 55 }
    ]);
    const outcome = await recordNudgeShadow(sql, userId, result, NOW);
    expect(outcome.caps.find((cap) => cap.capDays === 2)!.moves).toEqual([
      expect.objectContaining({ targetId: practice, rankBefore: 2, rankAfter: 1 })
    ]);

    await sql`UPDATE commitments SET status = 'cancelled' WHERE id = ${exam[0]!.id}`;
    const later = await recordNudgeShadow(sql, userId, result, new Date(NOW.getTime() + 60 * 60_000));
    expect(later.ran).toBe(false);
  });

  it("stops boosting for a deliverable once it is archived, as it does once cancelled", async () => {
    const project = await createProject("Maths unit", null);
    const practice = await createAction(project, "Practice paper");
    const other = await createAction(await createProject("Garden", null), "Weed beds");
    const due = new Date(NOW.getTime() + 2 * 86_400_000);
    const deliverable = await sql<{ id: string }[]>`
      INSERT INTO deliverables (project_id,title,external_deadline_at) VALUES (${project},'Report',${due}) RETURNING id`;
    await link("about", ["deliverable", deliverable[0]!.id], ["subject", "maths"]);
    await link("prepares", ["action", practice], ["deliverable", deliverable[0]!.id]);
    await setSwitch(sql, userId, "nudge", "shadow");
    const result = resultFor([
      { id: other, projectId: project, score: 60 },
      { id: practice, projectId: project, score: 55 }
    ]);
    expect((await recordNudgeShadow(sql, userId, result, NOW)).ran).toBe(true);

    await sql`UPDATE deliverables SET status = 'archived' WHERE id = ${deliverable[0]!.id}`;
    expect((await recordNudgeShadow(sql, userId, result, new Date(NOW.getTime() + 60 * 60_000))).ran).toBe(false);
  });

  it("throttles a burst of recalculations to one comparison", async () => {
    const { uni, other, practice, garden } = await seed();
    await setSwitch(sql, userId, "nudge", "shadow");
    const result = resultFor([
      { id: garden, projectId: other, score: 60 },
      { id: practice, projectId: uni, score: 55 }
    ]);
    expect((await recordNudgeShadow(sql, userId, result, NOW)).ran).toBe(true);
    expect((await recordNudgeShadow(sql, userId, result, new Date(NOW.getTime() + 60_000))).ran).toBe(false);
    expect((await recordNudgeShadow(sql, userId, result, new Date(NOW.getTime() + 31 * 60_000))).ran).toBe(true);
  });

  it("never throws into the planning job", async () => {
    await setSwitch(sql, userId, "nudge", "shadow");
    await expect(recordNudgeShadow(sql, userId, { recommendation: "not a ranking" }, NOW)).resolves.toMatchObject({
      ran: false
    });
  });
});
