import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import { integrationDatabaseName } from "@openrhen/database";
import { ensureUser } from "./ensure-user";
import { lockRecurrenceRule, localDayIn, recordCadenceCycle } from "./cadence-completion";

config({ path: resolve(process.cwd(), "../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(process.env.TEST_DATABASE_NAME, "openrhen_cadence_completion");

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let userId: string;

const TIMEZONE = "America/Chicago";

/** Builds a full area/outcome/project chain and one cadence action with its recurrence rule. */
async function createCadenceAction(): Promise<{ actionId: string; ruleId: string }> {
  const area = await sql<
    { id: string }[]
  >`INSERT INTO areas (user_id,name,status,sort_order) VALUES (${userId},${"Area " + crypto.randomUUID()},'active',0) RETURNING id`;
  const outcome = await sql<
    { id: string }[]
  >`INSERT INTO outcomes (area_id,title,definition_of_done,status) VALUES (${area[0]!.id},'Outcome','Done','active') RETURNING id`;
  const project = await sql<
    { id: string }[]
  >`INSERT INTO projects (outcome_id,title,status) VALUES (${outcome[0]!.id},'Project','active') RETURNING id`;
  const action = await sql<{ id: string }[]>`
    INSERT INTO actions (project_id,title,scheduling_mode,status,optimistic_minutes,expected_minutes,pessimistic_minutes,remaining_minutes,energy,minimum_session_minutes,maximum_session_minutes)
    VALUES (${project[0]!.id},'Practice piano','cadence','active',10,20,30,5,'medium',10,30)
    RETURNING id
  `;
  const rule = await sql<{ id: string }[]>`
    INSERT INTO action_recurrence_rules (action_id,timezone,start_date,interval_days,completion_mode)
    VALUES (${action[0]!.id},${TIMEZONE},'2026-01-01',1,'manual')
    RETURNING id
  `;
  return { actionId: action[0]!.id, ruleId: rule[0]!.id };
}

async function readAction(actionId: string): Promise<{ version: number; remaining_minutes: number }> {
  const rows = await sql<
    { version: number; remaining_minutes: number }[]
  >`SELECT version,remaining_minutes FROM actions WHERE id=${actionId}`;
  return rows[0]!;
}

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
  sql = postgres(testUrl.toString(), { max: 5, connect_timeout: 10, fetch_types: false, prepare: true });
  userId = await ensureUser(sql);
}, 30_000);

beforeEach(async () => {
  await sql.unsafe(
    "TRUNCATE TABLE action_cadence_completions, action_recurrence_rules, actions, projects, outcomes, areas RESTART IDENTITY CASCADE"
  );
});

afterAll(async () => {
  await sql?.end();
});

describe("recordCadenceCycle", () => {
  it("records the first completion of a local day, bumping version and resetting effort", async () => {
    const { actionId, ruleId } = await createCadenceAction();
    await sql.unsafe(`UPDATE actions SET remaining_minutes=1 WHERE id='${actionId}'`);
    const before = await readAction(actionId);
    const at = new Date("2026-06-15T18:00:00Z"); // afternoon in America/Chicago, same local day either way
    const result = await sql.begin(async (transaction) => {
      const tx = transaction as unknown as postgres.Sql;
      const rule = await lockRecurrenceRule(tx, actionId);
      return recordCadenceCycle(tx, { actionId, rule: rule!, at, minutes: 15, sessionId: null, source: "manual" });
    });
    expect(result).toEqual({ recorded: true, goalReached: false });
    const after = await readAction(actionId);
    expect(after.version).toBe(before.version + 1);
    expect(after.remaining_minutes).toBe(20); // reset to expected_minutes
    const completions = await sql`SELECT * FROM action_cadence_completions WHERE rule_id=${ruleId}`;
    expect(completions).toHaveLength(1);
  });

  it("dates the reset estimate at the completion, and keeps that date on a repeat the same local day", async () => {
    const { actionId } = await createCadenceAction();
    const stale = new Date("2026-01-01T00:00:00Z");
    await sql`UPDATE actions SET remaining_set_at=${stale} WHERE id=${actionId}`;
    const readSetAt = async () =>
      (await sql<{ remaining_set_at: Date }[]>`SELECT remaining_set_at FROM actions WHERE id=${actionId}`)[0]!
        .remaining_set_at;
    const runAt = (at: Date) =>
      sql.begin(async (transaction) => {
        const tx = transaction as unknown as postgres.Sql;
        const rule = await lockRecurrenceRule(tx, actionId);
        return recordCadenceCycle(tx, { actionId, rule: rule!, at, minutes: 15, sessionId: null, source: "manual" });
      });
    const first = new Date("2026-06-15T18:00:00Z");
    await runAt(first);
    expect((await readSetAt()).toISOString()).toBe(first.toISOString());
    // Nothing is recorded twice in a local day, so the figure and its date stay as the first completion left them.
    await runAt(new Date("2026-06-15T20:00:00Z"));
    expect((await readSetAt()).toISOString()).toBe(first.toISOString());
  });

  it("leaves version and effort untouched on a second completion the same local day", async () => {
    const { actionId } = await createCadenceAction();
    const at = new Date("2026-06-15T18:00:00Z");
    const runOnce = () =>
      sql.begin(async (transaction) => {
        const tx = transaction as unknown as postgres.Sql;
        const rule = await lockRecurrenceRule(tx, actionId);
        return recordCadenceCycle(tx, { actionId, rule: rule!, at, minutes: 15, sessionId: null, source: "manual" });
      });
    const first = await runOnce();
    expect(first.recorded).toBe(true);
    const afterFirst = await readAction(actionId);

    // Mutate remaining_minutes as if the person had made further progress after the first completion,
    // so a spurious reset from the second call would be visible.
    await sql.unsafe(`UPDATE actions SET remaining_minutes=3 WHERE id='${actionId}'`);
    const beforeSecond = await readAction(actionId);

    const second = await runOnce();
    expect(second).toEqual({ recorded: false, goalReached: false });
    const afterSecond = await readAction(actionId);
    expect(afterSecond.version).toBe(beforeSecond.version);
    expect(afterSecond.remaining_minutes).toBe(3);
    expect(afterSecond.version).not.toBe(afterFirst.version + 1);
  });

  it("still records a completion on the next local day", async () => {
    const { actionId, ruleId } = await createCadenceAction();
    const day1 = new Date("2026-06-15T18:00:00Z");
    const day2 = new Date("2026-06-16T18:00:00Z");
    expect(localDayIn(TIMEZONE, day1)).not.toBe(localDayIn(TIMEZONE, day2));

    const runAt = (at: Date) =>
      sql.begin(async (transaction) => {
        const tx = transaction as unknown as postgres.Sql;
        const rule = await lockRecurrenceRule(tx, actionId);
        return recordCadenceCycle(tx, { actionId, rule: rule!, at, minutes: 10, sessionId: null, source: "manual" });
      });

    const first = await runAt(day1);
    expect(first.recorded).toBe(true);
    const afterFirst = await readAction(actionId);

    const second = await runAt(day2);
    expect(second.recorded).toBe(true);
    const afterSecond = await readAction(actionId);
    expect(afterSecond.version).toBe(afterFirst.version + 1);

    const completions =
      await sql`SELECT local_date FROM action_cadence_completions WHERE rule_id=${ruleId} ORDER BY local_date`;
    expect(completions).toHaveLength(2);
  });
});
