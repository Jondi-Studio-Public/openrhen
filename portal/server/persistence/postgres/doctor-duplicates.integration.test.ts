import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import { integrationDatabaseName } from "@openrhen/database";
import { ensureUser } from "./ensure-user";
import { duplicateItems } from "@openrhen/contracts";
import { readDuplicatesSlice } from "./doctor-duplicates";

/**
 * The doctor's duplicates and dead-links reader.
 */
config({ path: resolve(process.cwd(), "../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(process.env.TEST_DATABASE_NAME, "openrhen_doctor_dup");

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let userId: string;

const NOW = new Date("2026-10-18T12:00:00Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000);

async function createProject(title: string, status = "active"): Promise<string> {
  const area = await sql<
    { id: string }[]
  >`INSERT INTO areas (user_id,name,status,sort_order) VALUES (${userId},${"Area " + crypto.randomUUID()},'active',0) RETURNING id`;
  const outcome = await sql<
    { id: string }[]
  >`INSERT INTO outcomes (area_id,title,definition_of_done,status) VALUES (${area[0]!.id},'Outcome','Done','active') RETURNING id`;
  const project = await sql<{ id: string }[]>`
    INSERT INTO projects (outcome_id,title,status,created_at) VALUES (${outcome[0]!.id},${title},${status},${daysAgo(10)}) RETURNING id`;
  return project[0]!.id;
}

async function createAction(projectId: string, title: string, status = "planned"): Promise<string> {
  const action = await sql<{ id: string }[]>`
    INSERT INTO actions (project_id,title,scheduling_mode,status,optimistic_minutes,expected_minutes,pessimistic_minutes,remaining_minutes,energy,minimum_session_minutes,maximum_session_minutes,created_at)
    VALUES (${projectId},${title},'one_off',${status},30,60,90,60,'medium',15,60,${daysAgo(5)}) RETURNING id`;
  return action[0]!.id;
}

async function createProposal(forUser: string, externalId: string, title: string): Promise<string> {
  const source = await sql<{ id: string }[]>`
    INSERT INTO sources (user_id,source_type,external_id,title) VALUES (${forUser},'email',${externalId},${title}) RETURNING id`;
  const row = await sql<{ id: string }[]>`
    INSERT INTO captures (user_id,source_id,proposal_type,status,proposed_fields,created_at)
    VALUES (${forUser},${source[0]!.id},'action','pending',${sql.json({ title } as never)},${daysAgo(5)}) RETURNING id`;
  return row[0]!.id;
}

async function link(forUser: string, fromId: string, toType: string, toId: string, kind: string, status: string) {
  await sql`
    INSERT INTO plan_links (user_id,from_type,from_id,to_type,to_id,kind,status,proposer,created_at)
    VALUES (${forUser},'action',${fromId},${toType},${toId},${kind},${status},'owner',${daysAgo(2)})`;
}

beforeAll(async () => {
  const admin = postgres(adminUrl, { max: 1, connect_timeout: 10 });
  try {
    const existing = await admin<{ exists: boolean }[]>`
      SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = ${testDatabaseName}) AS exists`;
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
    "TRUNCATE TABLE plan_links, plan_findings, captures, sources, actions, deliverables, projects, outcomes, areas RESTART IDENTITY CASCADE"
  );
  await sql`DELETE FROM users WHERE id <> ${userId}`;
});

afterAll(async () => {
  await sql?.end();
});

describe("readDuplicatesSlice", () => {
  it("reads an empty database as an empty slice", async () => {
    const slice = await readDuplicatesSlice(sql as never, userId, NOW);
    expect(slice).toEqual({
      actions: [],
      proposals: [],
      openDuplicateFindingItemIds: [],
      deadLinkEnds: [],
      deadLinksTruncated: false
    });
    expect(duplicateItems(slice, NOW.getTime())).toEqual([]);
  });

  it("finds duplicate open actions and pending proposals, and skips finished or inactive ones", async () => {
    const project = await createProject("Active");
    const paused = await createProject("Paused", "paused");
    const a1 = await createAction(project, "Buy milk");
    const a2 = await createAction(project, "buy  milk");
    await createAction(project, "Buy milk", "done");
    await createAction(paused, "Buy milk");
    const p1 = await createProposal(userId, "m1", "Book dentist");
    const p2 = await createProposal(userId, "m2", "Re: Book dentist");
    const items = duplicateItems(await readDuplicatesSlice(sql as never, userId, NOW), NOW.getTime());
    expect(items.map((i) => i.id).sort()).toEqual(
      [`duplicate_action:${[a1, a2].sort()[0]}`, `duplicate_proposal:${[p1, p2].sort()[0]}`].sort()
    );
  });

  it("counts nothing extra when an open duplicate_captures finding already names the group", async () => {
    const project = await createProject("Active");
    const a1 = await createAction(project, "Buy milk");
    const a2 = await createAction(project, "Buy milk");
    await sql`INSERT INTO plan_findings (user_id,check_name,item_ids,text,status)
      VALUES (${userId},'duplicate_captures',${sql.json([a1, a2].sort().map((id) => `action:${id}`) as never)},'dup','open')`;
    const slice = await readDuplicatesSlice(sql as never, userId, NOW);
    expect(slice.openDuplicateFindingItemIds).toHaveLength(1);
    expect(duplicateItems(slice, NOW.getTime())).toEqual([]);
    // A dismissed finding no longer covers it.
    await sql`UPDATE plan_findings SET status='dismissed'`;
    const again = await readDuplicatesSlice(sql as never, userId, NOW);
    expect(duplicateItems(again, NOW.getTime())).toHaveLength(1);
  });

  it("reports links whose end is present but finished, never a missing end", async () => {
    const project = await createProject("Active");
    const live = await createAction(project, "Live");
    const cancelled = await createAction(project, "Gone", "cancelled");
    const done = await createAction(project, "Done", "done");
    await link(userId, live, "action", cancelled, "prepares", "confirmed");
    await link(userId, live, "action", done, "prepares", "confirmed");
    await link(userId, live, "action", done, "before", "suggested");
    await link(userId, live, "action", crypto.randomUUID(), "about", "confirmed");
    await link(userId, live, "action", cancelled, "references", "rejected");
    const slice = await readDuplicatesSlice(sql as never, userId, NOW);
    expect(slice.deadLinkEnds.map((e) => `${e.kind}:${e.linkStatus}:${e.endState}`).sort()).toEqual([
      "before:suggested:done",
      "prepares:confirmed:cancelled",
      "prepares:confirmed:done"
    ]);
    expect(duplicateItems(slice, NOW.getTime()).map((i) => i.id)).toEqual([
      "link_to_finished:before:suggested:done",
      "link_to_finished:prepares:confirmed:cancelled"
    ]);
  });

  it("excludes another user's rows", async () => {
    const other = await sql<{ id: string }[]>`INSERT INTO users (display_name) VALUES ('Other') RETURNING id`;
    const otherId = other[0]!.id;
    await createProposal(otherId, "o1", "Book dentist");
    await createProposal(otherId, "o2", "Book dentist");
    await sql`INSERT INTO plan_findings (user_id,check_name,item_ids,text,status)
      VALUES (${otherId},'duplicate_captures','["action:x"]','dup','open')`;
    const slice = await readDuplicatesSlice(sql as never, userId, NOW);
    expect(slice).toEqual({
      actions: [],
      proposals: [],
      openDuplicateFindingItemIds: [],
      deadLinkEnds: [],
      deadLinksTruncated: false
    });
  });
});
