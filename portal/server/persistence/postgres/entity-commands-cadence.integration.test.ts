import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import { integrationDatabaseName } from "@openrhen/database";
import { InvalidCommandError } from "./command-errors";
import { ensureUser } from "./ensure-user";
import { saveEntity } from "./entity-commands";

/**
 * write-time half: a routine step's `cadenceActionId` must name an action actually in
 * `schedulingMode: 'cadence'` — `linkedCadenceAction` (`entity-commands.ts`) used to check ownership
 * only, so a save could create a link the sync-time gate could never evaluate in the first place. The
 * read-time half (a link that stops being valid *after* the save, or never resolves at all) is covered
 * by `routine-inheritance.integration.test.ts`'s "fails closed" cases and
 * `routine-inheritance.test.ts`'s `isPresetStepEligibleToday` unit coverage.
 */

config({ path: resolve(process.cwd(), "../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(
  process.env.ENTITY_CADENCE_TEST_DATABASE_NAME,
  "openrhen_entity_cadence"
);

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("ENTITY_CADENCE_TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let userId: string;

/** Builds a full area/outcome/project chain and one action in the given scheduling mode. */
async function createAction(schedulingMode: "cadence" | "one_off"): Promise<string> {
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
    VALUES (${project[0]!.id},'Practice piano',${schedulingMode},'active',10,20,30,5,'medium',10,30)
    RETURNING id
  `;
  if (schedulingMode === "cadence")
    await sql`
      INSERT INTO action_recurrence_rules (action_id,timezone,start_date,interval_days,completion_mode)
      VALUES (${action[0]!.id},'America/Chicago','2020-01-01',1,'manual')
    `;
  return action[0]!.id;
}

async function createCommitment(): Promise<string> {
  const id = crypto.randomUUID();
  const startsAt = new Date(Date.now() + 3_600_000);
  const endsAt = new Date(Date.now() + 7_200_000);
  await sql`
    INSERT INTO commitments (id,user_id,title,starts_at,ends_at,status)
    VALUES (${id},${userId},'Fixture commitment',${startsAt},${endsAt},'confirmed')
  `;
  return id;
}

function saveCommitmentCommand(entity: Record<string, unknown>, expectedVersion: number | null = null) {
  return {
    commandId: crypto.randomUUID(),
    expectedVersion,
    type: "save_entity" as const,
    entityType: "commitment" as const,
    entity: {
      title: "Family dinner",
      status: "confirmed",
      startsAt: new Date(Date.now() + 3_600_000).toISOString(),
      endsAt: new Date(Date.now() + 7_200_000).toISOString(),
      setupBeforeMinutes: 0,
      transitionAfterMinutes: 0,
      ...entity
    }
  };
}

function saveRoutineStepCommand(commitmentId: string, cadenceActionId: string) {
  return {
    commandId: crypto.randomUUID(),
    expectedVersion: null,
    type: "save_entity" as const,
    entityType: "routine_step" as const,
    entity: {
      id: crypto.randomUUID(),
      commitmentId,
      title: "Practice piano",
      durationMinutes: 10,
      sequence: 0,
      timingRule: "contiguous",
      energy: "low",
      phase: "before",
      contexts: [],
      cadenceActionId
    }
  };
}

beforeAll(async () => {
  const admin = postgres(adminUrl!, { max: 1, connect_timeout: 10 });
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
    "TRUNCATE TABLE writes, write_rows, routine_steps, commitments, action_recurrence_rules, actions, projects, outcomes, areas RESTART IDENTITY CASCADE"
  );
});

afterAll(async () => {
  await sql?.end();
});

describe("saving a routine step's cadenceActionId (write-time gate)", () => {
  it("refuses a link to an action that is not scheduling_mode 'cadence'", async () => {
    const actionId = await createAction("one_off");
    const commitmentId = await createCommitment();
    await expect(saveEntity(sql, saveRoutineStepCommand(commitmentId, actionId))).rejects.toThrow(InvalidCommandError);
    await expect(saveEntity(sql, saveRoutineStepCommand(commitmentId, actionId))).rejects.toThrow(
      "not scheduled as cadence"
    );
    const rows = await sql`SELECT id FROM routine_steps WHERE commitment_id=${commitmentId}`;
    expect(rows).toHaveLength(0);
  });

  it("refuses a link to an action id that does not exist", async () => {
    const commitmentId = await createCommitment();
    await expect(saveEntity(sql, saveRoutineStepCommand(commitmentId, crypto.randomUUID()))).rejects.toThrow(
      "no longer exists"
    );
  });

  it("accepts a link to an action genuinely in scheduling_mode 'cadence'", async () => {
    const actionId = await createAction("cadence");
    const commitmentId = await createCommitment();
    await saveEntity(sql, saveRoutineStepCommand(commitmentId, actionId));
    const rows = await sql<
      { cadence_action_id: string | null }[]
    >`SELECT cadence_action_id FROM routine_steps WHERE commitment_id=${commitmentId}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.cadence_action_id).toBe(actionId);
  });
});

describe("commitment save: share_to_calendar/share_source (Example Shared family-calendar sharing)", () => {
  it("creates a commitment with sharing on, defaulting share_source to 'inherit'", async () => {
    const id = crypto.randomUUID();
    await saveEntity(sql, saveCommitmentCommand({ id, shareToCalendar: true }));
    const rows = await sql<
      { share_to_calendar: boolean; share_source: string }[]
    >`SELECT share_to_calendar,share_source FROM commitments WHERE id=${id}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.share_to_calendar).toBe(true);
    expect(rows[0]!.share_source).toBe("inherit");
  });

  it("flips share_source to 'custom' when a save changes the occurrence's flag directly", async () => {
    const id = crypto.randomUUID();
    await saveEntity(sql, saveCommitmentCommand({ id, shareToCalendar: true }));
    const created = await sql<{ version: number }[]>`SELECT version FROM commitments WHERE id=${id}`;
    await saveEntity(sql, saveCommitmentCommand({ id, shareToCalendar: false }, created[0]!.version));
    const rows = await sql<
      { share_to_calendar: boolean; share_source: string }[]
    >`SELECT share_to_calendar,share_source FROM commitments WHERE id=${id}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.share_to_calendar).toBe(false);
    expect(rows[0]!.share_source).toBe("custom");
  });

  it("does not detach share_source when a save re-sends the same flag value unchanged", async () => {
    const id = crypto.randomUUID();
    await saveEntity(sql, saveCommitmentCommand({ id, shareToCalendar: true }));
    const created = await sql<{ version: number }[]>`SELECT version FROM commitments WHERE id=${id}`;
    await saveEntity(sql, saveCommitmentCommand({ id, shareToCalendar: true }, created[0]!.version));
    const rows = await sql<
      { share_to_calendar: boolean; share_source: string }[]
    >`SELECT share_to_calendar,share_source FROM commitments WHERE id=${id}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.share_to_calendar).toBe(true);
    expect(rows[0]!.share_source).toBe("inherit");
  });

  it("leaves share_to_calendar/share_source untouched when a save never mentions the flag", async () => {
    const id = crypto.randomUUID();
    await saveEntity(sql, saveCommitmentCommand({ id, shareToCalendar: true }));
    const created = await sql<{ version: number }[]>`SELECT version FROM commitments WHERE id=${id}`;
    await saveEntity(sql, saveCommitmentCommand({ id, title: "Family dinner (renamed)" }, created[0]!.version));
    const rows = await sql<
      { share_to_calendar: boolean; share_source: string }[]
    >`SELECT share_to_calendar,share_source FROM commitments WHERE id=${id}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.share_to_calendar).toBe(true);
    expect(rows[0]!.share_source).toBe("inherit");
  });
});
