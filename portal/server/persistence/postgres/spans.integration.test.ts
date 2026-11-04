import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { fileURLToPath } from "node:url";
import { integrationDatabaseName } from "@openrhen/database";
import { CommandConflictError, InvalidCommandError } from "./command-errors";
import { ensureUser } from "./ensure-user";
import { saveEntity } from "./entity-commands";
import { readPortalState } from "./state-read";

/**
 * Calendar spans: create, edit, remove, the project link, the date check
 * and the bounded read into portal state. Self-contained `_test` database, same pattern as
 * `backfilled-start.integration.test.ts`. The backup round trip is in
 * `platform/database/src/operations/spans-backup.integration.test.ts`.
 */
config({ path: fileURLToPath(new URL("../../../../.env", import.meta.url)), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(process.env.SPANS_TEST_DATABASE_NAME, "openrhen_spans");

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("SPANS_TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let userId: string;

const dayOffset = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

function spanCommand(entity: Record<string, unknown>, expectedVersion: number | null = null) {
  return {
    commandId: crypto.randomUUID(),
    expectedVersion,
    type: "save_entity" as const,
    entityType: "span" as const,
    entity
  };
}

async function createProject(): Promise<string> {
  const area = await sql<
    { id: string }[]
  >`INSERT INTO areas (user_id,name,status,sort_order) VALUES (${userId},${"Area " + crypto.randomUUID()},'active',0) RETURNING id`;
  const outcome = await sql<
    { id: string }[]
  >`INSERT INTO outcomes (area_id,title,definition_of_done,status) VALUES (${area[0]!.id},'Outcome','Done','active') RETURNING id`;
  const project = await sql<
    { id: string }[]
  >`INSERT INTO projects (outcome_id,title,status) VALUES (${outcome[0]!.id},'Trip 1 planning','active') RETURNING id`;
  return project[0]!.id;
}

const rows = () =>
  sql<
    {
      id: string;
      title: string;
      start_date: string;
      end_date: string;
      window: unknown;
      project_id: string | null;
      version: number;
    }[]
  >`SELECT id,title,start_date::text,end_date::text,"window",project_id,version FROM spans ORDER BY start_date`;

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
    await migrate(drizzle(migrationSql), {
      migrationsFolder: fileURLToPath(new URL("../../../../platform/database/drizzle", import.meta.url))
    });
  } finally {
    await migrationSql.end();
  }
  sql = postgres(testUrl.toString(), { max: 5, connect_timeout: 10, fetch_types: false, prepare: true });
  userId = await ensureUser(sql);
}, 30_000);

beforeEach(async () => {
  await sql.unsafe("TRUNCATE TABLE writes, write_rows, spans, projects, outcomes, areas RESTART IDENTITY CASCADE");
});

afterAll(async () => {
  await sql?.end();
});

describe("save_entity span", () => {
  it("creates a span with no window and no project, keyed by its id", async () => {
    const id = crypto.randomUUID();
    const state = await saveEntity(
      sql,
      spanCommand({ id, title: "Trip 1", startDate: dayOffset(-8), endDate: dayOffset(-6) })
    );
    const stored = await rows();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      id,
      title: "Trip 1",
      start_date: dayOffset(-8),
      end_date: dayOffset(-6),
      window: null,
      project_id: null,
      version: 1
    });
    expect(state.spans.map((span) => span.id)).toEqual([id]);
  });

  it("stores a clock window and a linked project, and reads them back in state", async () => {
    const projectId = await createProject();
    const state = await saveEntity(
      sql,
      spanCommand({
        id: crypto.randomUUID(),
        title: "Conference",
        startDate: dayOffset(5),
        endDate: dayOffset(7),
        window: { localStartTime: "09:00", localEndTime: "17:00" },
        projectId
      })
    );
    expect(state.spans).toHaveLength(1);
    expect(state.spans[0]).toMatchObject({
      title: "Conference",
      window: { localStartTime: "09:00", localEndTime: "17:00" },
      projectId,
      version: 1
    });
  });

  it("edits with the stored version, bumps it, and can clear the window and project", async () => {
    const projectId = await createProject();
    const id = crypto.randomUUID();
    await saveEntity(
      sql,
      spanCommand({
        id,
        title: "Trip",
        startDate: dayOffset(1),
        endDate: dayOffset(2),
        window: { localStartTime: "08:00", localEndTime: "09:00" },
        projectId
      })
    );
    await saveEntity(
      sql,
      spanCommand({ id, title: "Trip renamed", startDate: dayOffset(1), endDate: dayOffset(3) }, 1)
    );
    const [edited] = await rows();
    expect(edited).toMatchObject({ title: "Trip renamed", window: null, project_id: null, version: 2 });
    expect(edited!.end_date).toBe(dayOffset(3));
  });

  it("refuses a stale version and a create over an existing id", async () => {
    const id = crypto.randomUUID();
    await saveEntity(sql, spanCommand({ id, title: "Trip", startDate: dayOffset(1), endDate: dayOffset(2) }));
    await expect(
      saveEntity(sql, spanCommand({ id, title: "Again", startDate: dayOffset(1), endDate: dayOffset(2) }, 7))
    ).rejects.toThrow(CommandConflictError);
    await expect(
      saveEntity(sql, spanCommand({ id, title: "Again", startDate: dayOffset(1), endDate: dayOffset(2) }, null))
    ).rejects.toThrow(CommandConflictError);
  });

  it("removes a span and refuses removing one that is gone", async () => {
    const id = crypto.randomUUID();
    await saveEntity(sql, spanCommand({ id, title: "Trip", startDate: dayOffset(1), endDate: dayOffset(2) }));
    await saveEntity(sql, spanCommand({ id, remove: true }, 1));
    expect(await rows()).toHaveLength(0);
    await expect(saveEntity(sql, spanCommand({ id, remove: true }, null))).rejects.toThrow(InvalidCommandError);
  });

  it("refuses a project that does not exist for this user", async () => {
    await expect(
      saveEntity(
        sql,
        spanCommand({
          id: crypto.randomUUID(),
          title: "Trip",
          startDate: dayOffset(1),
          endDate: dayOffset(2),
          projectId: crypto.randomUUID()
        })
      )
    ).rejects.toThrow(/The linked project ".+" no longer exists, or never existed/);
    expect(await rows()).toHaveLength(0);
  });

  it("refuses an end before the start, a bad window and a window anchor before writing", async () => {
    for (const entity of [
      { title: "Trip", startDate: "2026-09-29", endDate: "2026-09-27" },
      {
        title: "Trip",
        startDate: "2026-09-27",
        endDate: "2026-09-27",
        window: { localStartTime: "10:00", localEndTime: "09:00" }
      },
      {
        title: "Trip",
        startDate: "2026-09-27",
        endDate: "2026-09-27",
        window: { anchor: "wake", startOffsetMinutes: 0, endOffsetMinutes: 60 }
      }
    ])
      await expect(saveEntity(sql, spanCommand({ id: crypto.randomUUID(), ...entity }))).rejects.toThrow(
        InvalidCommandError
      );
    expect(await rows()).toHaveLength(0);
  });

  it("holds the end-on-or-after-start check in the database too", async () => {
    await expect(
      sql`INSERT INTO spans (user_id,title,start_date,end_date) VALUES (${userId},'Bad','2026-09-29','2026-09-27')`
    ).rejects.toThrow(/spans_date_order_check/);
  });

  it("records no plan-input change, because a span never touches planning", async () => {
    await saveEntity(
      sql,
      spanCommand({ id: crypto.randomUUID(), title: "Trip", startDate: dayOffset(1), endDate: dayOffset(2) })
    );
    const log = await sql<{ n: number }[]>`SELECT COUNT(*)::int n FROM write_rows WHERE entity_type='span'`;
    expect(log[0]!.n).toBe(0);
  });
});

describe("spans in portal state", () => {
  it("carries spans overlapping a year either side of today and nothing beyond", async () => {
    const add = (title: string, start: number, end: number) =>
      saveEntity(
        sql,
        spanCommand({ id: crypto.randomUUID(), title, startDate: dayOffset(start), endDate: dayOffset(end) })
      );
    await add("far past", -800, -700);
    await add("old trip, older than the 30-day session window", -200, -198);
    await add("starts before the bound but ends inside it", -400, -300);
    await add("future", 100, 102);
    await add("far future", 500, 501);
    const state = (await readPortalState(sql))!;
    expect(state.spans.map((span) => span.title)).toEqual([
      "starts before the bound but ends inside it",
      "old trip, older than the 30-day session window",
      "future"
    ]);
  });
});
