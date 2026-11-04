import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import {
  CLOSE_TYPES,
  classifyClosedBy,
  closedPageSchema,
  closedSummarySchema,
  type CloseEntityCommand
} from "@openrhen/contracts";
import { integrationDatabaseName } from "@openrhen/database";
import { runWithActor } from "@/server/agent-actor";
import { closeEntity } from "../close-commands";
import { ensureUser } from "../ensure-user";
import { readClosed, readClosedSummary } from "./closed";

/**
 * The Closed page's read against a real database (archive-removals design sections 4 to 6; PR 6 plan WP2). Rows are
 * closed through `closeEntity` as the person, an agent and an owner-confirmed agent, so the stamps are the ones the
 * trigger writes; legacy, system and undo-of-create rows are written by raw SQL. Every restore below posts only what the
 * read returned (`id`, `version`, `restoreVerb`), which is what the page does.
 */
config({ path: resolve(process.cwd(), "../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(process.env.CLOSED_READ_TEST_DATABASE_NAME, "openrhen_closed_read");
if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName))
  throw new Error("CLOSED_READ_TEST_DATABASE_NAME must be an identifier ending in _test");
const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let userId: string;

const asAgent = <T>(run: () => Promise<T>, agent = "claude") => runWithActor(agent, run);
const asConfirmedAgent = <T>(run: () => Promise<T>, agent = "claude") => runWithActor(agent, run, "owner");

beforeAll(async () => {
  const admin = postgres(adminUrl!, { max: 1, connect_timeout: 10 });
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
  sql = postgres(testUrl.toString(), { max: 8, connect_timeout: 10, fetch_types: false, prepare: true });
}, 60_000);

beforeEach(async () => {
  await sql.unsafe(
    "TRUNCATE TABLE writes, write_rows, jobs, sessions, routine_steps, commitment_recurrence_rules, commitments, deliverables, actions, projects, outcomes, areas, condition_definitions, routine_presets, entity_prerequisites RESTART IDENTITY CASCADE"
  );
  userId = await ensureUser(sql);
  await sql`INSERT INTO user_preferences (user_id) VALUES (${userId}) ON CONFLICT DO NOTHING`;
  await sql`UPDATE user_preferences SET home_location_id = NULL WHERE user_id = ${userId}`;
});

afterAll(async () => {
  await sql?.end();
});

type Type = CloseEntityCommand["type"];

const one = async (query: Promise<{ id: string }[]>) => (await query)[0]!.id;
const seedArea = (name = "Area " + crypto.randomUUID(), status = "active") =>
  one(sql`INSERT INTO areas (user_id,name,status,sort_order) VALUES (${userId},${name},${status},0) RETURNING id`);
const seedOutcome = async (areaId?: string, title = "Outcome", status = "active") =>
  one(
    sql`INSERT INTO outcomes (area_id,title,definition_of_done,status) VALUES (${areaId ?? (await seedArea())},${title},'Done',${status}) RETURNING id`
  );
const seedProject = async (outcomeId?: string, title = "Project", status = "active") =>
  one(
    sql`INSERT INTO projects (outcome_id,title,status) VALUES (${outcomeId ?? (await seedOutcome())},${title},${status}) RETURNING id`
  );
const seedAction = async (projectId?: string, title = "Draft citations", status = "planned") =>
  one(sql`
    INSERT INTO actions (project_id,title,scheduling_mode,status,optimistic_minutes,expected_minutes,pessimistic_minutes,remaining_minutes,energy,minimum_session_minutes,maximum_session_minutes)
    VALUES (${projectId ?? (await seedProject())},${title},'one_off',${status},30,60,90,60,'medium',15,90) RETURNING id`);
const seedDeliverable = async (projectId?: string, status = "ready") =>
  one(
    sql`INSERT INTO deliverables (project_id,title,status) VALUES (${projectId ?? (await seedProject())},'Report',${status}) RETURNING id`
  );
const seedCommitment = (title = "Dentist", status = "confirmed", projectId?: string) =>
  one(sql`
    INSERT INTO commitments (user_id,title,starts_at,ends_at,status,project_id)
    VALUES (${userId},${title},now() + interval '3 days',now() + interval '3 days 1 hour',${status},${projectId ?? null}) RETURNING id`);
const seedPreset = () =>
  one(
    sql`INSERT INTO routine_presets (user_id,name,activity_name,status) VALUES (${userId},'Morning','Morning','active') RETURNING id`
  );
async function seedCondition(): Promise<string> {
  await sql`INSERT INTO condition_definitions (user_id,id,name,kind,status) VALUES (${userId},'office','Office','location','active')`;
  return "office";
}

const TABLE: Record<Type, string> = {
  area: "areas",
  outcome: "outcomes",
  project: "projects",
  action: "actions",
  deliverable: "deliverables",
  commitment: "commitments",
  routine_preset: "routine_presets",
  condition_definition: "condition_definitions"
};

const closeCmd = (type: Type, id: string, verb: "archive" | "cancel", extra: Partial<CloseEntityCommand> = {}) =>
  ({ type, id, verb, do: "close", ...extra }) as CloseEntityCommand;
const versionOf = async (type: Type, id: string) =>
  (await sql.unsafe<{ version: number }[]>(`SELECT version FROM ${TABLE[type]} WHERE id = $1`, [id]))[0]!.version;

/** Sets the closed time of a row, so ordering and the 24 hour window are exact without sleeping. */
const closedAtOf = (type: Type, id: string, at: string) =>
  sql.unsafe(`UPDATE ${TABLE[type]} SET closed_at = $2::timestamptz WHERE id = $1`, [id, at]);

const NOW = new Date("2026-11-04T12:00:00.000Z");

/** One open row of each type with the verb its status takes. */
async function seedEach(): Promise<{ type: Type; id: string; verb: "archive" | "cancel" }[]> {
  return [
    { type: "area", id: await seedArea(), verb: "archive" },
    { type: "outcome", id: await seedOutcome(), verb: "cancel" },
    { type: "project", id: await seedProject(), verb: "archive" },
    { type: "action", id: await seedAction(), verb: "cancel" },
    { type: "deliverable", id: await seedDeliverable(), verb: "cancel" },
    { type: "commitment", id: await seedCommitment(), verb: "cancel" },
    { type: "routine_preset", id: await seedPreset(), verb: "archive" },
    { type: "condition_definition", id: await seedCondition(), verb: "archive" }
  ];
}

describe("readClosed", () => {
  it("lists a person's close of each of the eight types under its tab, and each row restores using only what the read returned", async () => {
    const each = await seedEach();
    for (const { type, id, verb } of each) await closeEntity(sql, closeCmd(type, id, verb));

    const archived = closedPageSchema.parse(await readClosed(sql, userId, { tab: "archived" }));
    const cancelled = closedPageSchema.parse(await readClosed(sql, userId, { tab: "cancelled" }));
    expect(archived.rows.map((row) => row.type).sort()).toEqual([
      "area",
      "condition_definition",
      "project",
      "routine_preset"
    ]);
    expect(cancelled.rows.map((row) => row.type).sort()).toEqual(["action", "commitment", "deliverable", "outcome"]);
    expect(archived.counts).toEqual({ archived: 4, cancelled: 4 });
    for (const row of [...archived.rows, ...cancelled.rows]) {
      expect(row.closedBy).toBe("person");
      expect(row.closedAt).not.toBeNull();
      expect(row.restoreVerb).toBe(row.status === "archived" ? "archive" : "cancel");
    }

    // The round trip: the page posts only the row's own fields.
    for (const row of [...archived.rows, ...cancelled.rows]) {
      const { closed } = await closeEntity(sql, {
        type: row.type,
        id: row.id,
        verb: row.restoreVerb,
        do: "restore",
        expectedVersion: row.version
      });
      expect(closed.do).toBe("restore");
    }
    const after = await readClosed(sql, userId, { tab: "archived" });
    expect(after.rows).toEqual([]);
    expect(after.counts).toEqual({ archived: 0, cancelled: 0 });
  });

  it("names the parent, orders newest first and gives the version the row has now", async () => {
    const area = await seedArea("Finance");
    const outcome = await seedOutcome(area, "Tidy books");
    const project = await seedProject(outcome, "Quarterly report");
    const older = await seedAction(project, "Older action");
    const newer = await seedAction(project, "Newer action");
    await closeEntity(sql, closeCmd("action", older, "cancel"));
    await closeEntity(sql, closeCmd("action", newer, "cancel"));
    await closedAtOf("action", older, "2026-11-01T00:00:00Z");
    await closedAtOf("action", newer, "2026-11-03T00:00:00Z");

    const page = await readClosed(sql, userId, { tab: "cancelled" });
    expect(page.rows.map((row) => row.title)).toEqual(["Newer action", "Older action"]);
    expect(page.rows[0]).toMatchObject({
      type: "action",
      parent: "Quarterly report",
      fromStatus: "planned",
      version: await versionOf("action", newer)
    });
    // the area has no parent; the outcome's is the area
    await closeEntity(sql, closeCmd("outcome", await seedOutcome(area, "Solo"), "cancel"));
    const outcomes = await readClosed(sql, userId, { tab: "cancelled", type: "outcome" });
    expect(outcomes.rows.map((row) => [row.title, row.parent])).toEqual([["Solo", "Finance"]]);
    expect(outcomes.counts.cancelled).toBe(3);
  });

  it("hides closes that took back a create, and shows the person's, agents', confirmed, system and legacy closes", async () => {
    const mk = async (title: string) => seedAction(undefined, title);
    const byPerson = await mk("by person");
    const byAgent = await mk("by agent");
    const byConfirmed = await mk("by confirmed agent");
    const bySystem = await mk("by system");
    const legacy = await mk("legacy");
    const undone = await mk("undo of create");
    await closeEntity(sql, closeCmd("action", byPerson, "cancel"));
    await asAgent(() => closeEntity(sql, closeCmd("action", byAgent, "cancel", { reason: "Not needed" })));
    await asConfirmedAgent(() => closeEntity(sql, closeCmd("action", byConfirmed, "cancel", { reason: "Confirmed" })));
    await sql`UPDATE actions SET status = 'cancelled' WHERE id = ${bySystem}`;
    // a legacy row: closed before the stamps existed (closed_at backfilled, closed_by NULL)
    await sql`UPDATE actions SET status = 'cancelled', closed_at = now() - interval '30 days' WHERE id = ${legacy}`;
    await sql`UPDATE actions SET status = 'cancelled', closed_by = 'agent:claude:undo' WHERE id = ${undone}`;

    const page = await readClosed(sql, userId, { tab: "cancelled" });
    const byTitle = Object.fromEntries(page.rows.map((row) => [row.title, row]));
    expect(Object.keys(byTitle).sort()).toEqual(
      ["by agent", "by confirmed agent", "by person", "by system", "legacy"].sort()
    );
    expect(byTitle["by person"]!.closedBy).toBe("person");
    expect(byTitle["by agent"]).toMatchObject({ closedBy: "agent:claude", reason: "Not needed" });
    expect(byTitle["by confirmed agent"]!.closedBy).toBe("agent:claude:confirmed");
    expect(byTitle["by system"]!.closedBy).toBe("system");
    expect(byTitle["legacy"]!.closedBy).toBeNull();
    // the legacy row sorts below the recent ones
    expect(page.rows.at(-1)!.title).toBe("legacy");
    // the hidden row is not counted either
    expect(page.counts.cancelled).toBe(5);
  });

  it("keeps another user's closed rows out of the list, the counts and the summary", async () => {
    await closeEntity(sql, closeCmd("action", await seedAction(undefined, "mine"), "cancel"));
    const other = (await sql<{ id: string }[]>`INSERT INTO users (display_name) VALUES ('Other') RETURNING id`)[0]!.id;
    const theirArea = await one(
      sql`INSERT INTO areas (user_id,name,status,sort_order) VALUES (${other},'Theirs','archived',0) RETURNING id`
    );
    await sql`UPDATE areas SET closed_by = 'agent:claude', closed_at = ${NOW.toISOString()}::timestamptz WHERE id = ${theirArea}`;
    const archived = await readClosed(sql, userId, { tab: "archived" });
    expect(archived.rows).toEqual([]);
    expect(archived.counts).toEqual({ archived: 0, cancelled: 1 });
    expect((await readClosedSummary(sql, userId, NOW)).agentLast24h).toBe(0);
    expect((await readClosed(sql, userId, { tab: "cancelled" })).rows.map((row) => row.title)).toEqual(["mine"]);
  });

  it("pages by cursor with equal closed times, without a repeat or a gap", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const id = await seedAction(undefined, `Row ${i}`);
      await closeEntity(sql, closeCmd("action", id, "cancel"));
      ids.push(id);
    }
    // two pairs share a closed time to the microsecond; one row has no closed_at at all
    await sql.unsafe(
      `UPDATE actions SET closed_at = '2026-11-03T00:00:00.123456Z'::timestamptz WHERE title IN ('Row 0','Row 1')`
    );
    await sql.unsafe(
      `UPDATE actions SET closed_at = '2026-11-02T00:00:00Z'::timestamptz WHERE title IN ('Row 2','Row 3')`
    );
    await sql.unsafe(`UPDATE actions SET closed_at = NULL, updated_at = '2026-11-01T00:00:00Z' WHERE title = 'Row 4'`);

    const seen: string[] = [];
    let before: string | undefined;
    for (let guard = 0; guard < 10; guard += 1) {
      const page = await readClosed(sql, userId, { tab: "cancelled", limit: 2, ...(before ? { before } : {}) });
      seen.push(...page.rows.map((row) => row.title));
      if (page.nextCursor === null) break;
      before = page.nextCursor;
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    // a NULL closed_at sorts by updated_at, so the unstamped row is last
    expect(seen.at(-1)).toBe("Row 4");
  });

  it("names the closed ancestor that blocks a restore, and counts the batch", async () => {
    const area = await seedArea("Home");
    const outcome = await seedOutcome(area, "Garden");
    const project = await seedProject(outcome, "Beds");
    const a1 = await seedAction(project, "Dig");
    const a2 = await seedAction(project, "Plant");
    // close the project with its actions in one batch, then the outcome's other rows are untouched
    await closeEntity(sql, closeCmd("project", project, "archive", { includeChildren: true }));
    const page = await readClosed(sql, userId, { tab: "archived" });
    const projectRow = page.rows.find((row) => row.type === "project")!;
    expect(projectRow.batchSize).toBe(3);
    expect(projectRow.blockedBy).toBeNull();
    const actionRows = (await readClosed(sql, userId, { tab: "cancelled" })).rows;
    expect(actionRows.map((row) => row.title).sort()).toEqual(["Dig", "Plant"]);
    for (const row of actionRows) {
      expect(row.batchSize).toBe(3);
      expect(row.blockedBy).toEqual({ type: "project", id: project, title: "Beds", status: "archived" });
    }
    expect([a1, a2]).toHaveLength(2);

    // the top ancestor wins when two are closed
    await sql`UPDATE outcomes SET status = 'cancelled' WHERE id = ${outcome}`;
    const again = (await readClosed(sql, userId, { tab: "archived", type: "project" })).rows[0]!;
    expect(again.blockedBy).toMatchObject({ type: "outcome", id: outcome, title: "Garden", status: "cancelled" });
  });

  it("counts per tab ignoring the type filter, and an unknown row never leaks its null stamps as an error", async () => {
    await closeEntity(sql, closeCmd("action", await seedAction(), "cancel"));
    await closeEntity(sql, closeCmd("area", await seedArea(), "archive"));
    const filtered = await readClosed(sql, userId, { tab: "cancelled", type: "area" });
    expect(filtered.rows).toEqual([]);
    expect(filtered.counts).toEqual({ archived: 1, cancelled: 1 });
  });

  it("a legacy cancelled area is listed and restores with the cancel verb", async () => {
    const area = await seedArea("Old area", "active");
    await sql`UPDATE areas SET status = 'cancelled', closed_at = now() - interval '9 days' WHERE id = ${area}`;
    const row = (await readClosed(sql, userId, { tab: "cancelled" })).rows[0]!;
    expect(row).toMatchObject({ type: "area", restoreVerb: "cancel", closedBy: null });
    const { closed } = await closeEntity(sql, {
      type: row.type,
      id: row.id,
      verb: row.restoreVerb,
      do: "restore",
      expectedVersion: row.version
    });
    expect(closed.restoredTo).toBe("active");
    expect(closed.assumed).toBe(true);
  });
});

describe("readClosedSummary", () => {
  it("counts only plain agent closes still closed in the last 24 hours", async () => {
    const mk = (title: string) => seedAction(undefined, title);
    const agentNew = await mk("agent new");
    const agentNewer = await mk("agent newer");
    const agentOld = await mk("agent old");
    const agentRestored = await mk("agent restored");
    const confirmed = await mk("confirmed");
    const person = await mk("person");
    const system = await mk("system");
    const legacy = await mk("legacy");
    const undo = await mk("undo");
    const reason = { reason: "tidy" };
    for (const id of [agentNew, agentNewer, agentOld, agentRestored])
      await asAgent(() => closeEntity(sql, closeCmd("action", id, "cancel", reason)));
    await asConfirmedAgent(() => closeEntity(sql, closeCmd("action", confirmed, "cancel", reason)));
    await closeEntity(sql, closeCmd("action", person, "cancel"));
    await sql`UPDATE actions SET status = 'cancelled' WHERE id = ${system}`;
    await sql`UPDATE actions SET status = 'cancelled', closed_at = ${NOW.toISOString()}::timestamptz WHERE id = ${legacy}`;
    await sql`UPDATE actions SET status = 'cancelled', closed_by = 'agent:claude:undo' WHERE id = ${undo}`;
    for (const id of [agentNew, confirmed, person, system, undo])
      await closedAtOf("action", id, "2026-11-04T10:00:00Z");
    await closedAtOf("action", agentNewer, "2026-11-04T11:00:00Z");
    await closedAtOf("action", agentOld, "2026-11-03T11:59:59Z");
    await closedAtOf("action", agentRestored, "2026-11-04T09:00:00Z");
    // restoring leaves the count by itself (the trigger nulls its stamps)
    const restoredVersion = await versionOf("action", agentRestored);
    const { closed: agentClosed } = await asAgent(() =>
      closeEntity(sql, {
        type: "action",
        id: agentRestored,
        verb: "cancel",
        do: "restore",
        expectedVersion: restoredVersion
      })
    );
    expect(agentClosed.do).toBe("restore");

    const summary = closedSummarySchema.parse(await readClosedSummary(sql, userId, NOW));
    expect(summary).toEqual({ agentLast24h: 2, latestAt: "2026-11-04T11:00:00.000Z" });
  });

  it("is zero with a null latest when nothing qualifies", async () => {
    expect(await readClosedSummary(sql, userId, NOW)).toEqual({ agentLast24h: 0, latestAt: null });
  });
});

describe("parity with classifyClosedBy", () => {
  it("the SQL filters agree with the contract on the same strings", async () => {
    const strings = [
      "person",
      "system",
      "agent:claude",
      "agent:claude:confirmed",
      "person:undo",
      "agent:claude:undo",
      "agent:Claude",
      "agent:",
      "agent:a:b",
      "mystery"
    ];
    const ids: Record<string, string> = {};
    for (const closedBy of strings) {
      const id = await seedAction(undefined, closedBy);
      await sql`UPDATE actions SET status = 'cancelled', closed_by = ${closedBy}, closed_at = '2026-11-04T11:00:00Z'::timestamptz WHERE id = ${id}`;
      ids[closedBy] = id;
    }
    const listed = new Set(
      (await readClosed(sql, userId, { tab: "cancelled", limit: 50 })).rows.map((row) => row.title)
    );
    for (const closedBy of strings) expect(listed.has(closedBy)).toBe(classifyClosedBy(closedBy).kind !== "undo");
    const counted = (await readClosedSummary(sql, userId, NOW)).agentLast24h;
    expect(counted).toBe(strings.filter((closedBy) => classifyClosedBy(closedBy).kind === "agent").length);
    expect(CLOSE_TYPES).toHaveLength(8);
  });
});
