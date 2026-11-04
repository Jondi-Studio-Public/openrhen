import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import { closedCount, type CloseEntityCommand } from "@openrhen/contracts";
import { integrationDatabaseName } from "@openrhen/database";
import { runWithActor } from "@/server/agent-actor";
import { closedInWindow } from "./close-budget";
import { closeEntity } from "./close-commands";
import { CommandConflictError } from "./command-errors";
import { ensureUser } from "./ensure-user";
import { runRevertCommand } from "./write-revert";

/**
 * The close brake against a real ledger (archive-removals design section 4; plan WP3): token agents together close at
 * most 20 rows in any rolling hour, counted from `write_rows`, so close/restore cycling counts, the owner and confirmed
 * replays do not, and a retried call neither double-counts nor makes a second batch.
 */
config({ path: resolve(process.cwd(), "../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(process.env.CLOSE_BUDGET_TEST_DATABASE_NAME, "openrhen_close_budget");
if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("CLOSE_BUDGET_TEST_DATABASE_NAME must be an identifier ending in _test");
}
const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let userId: string;
let projectId: string;

/** A token-held agent (it holds scopes), the party the brake is for. */
const asAgent = <T>(run: () => Promise<T>, agent = "claude") =>
  runWithActor(agent, run, undefined, undefined, ["write:entity:*"]);
/** A header-only agent: a name, no scopes, no token. */
const asHeaderAgent = <T>(run: () => Promise<T>) => runWithActor("scripty", run);
const asOwner = <T>(run: () => Promise<T>) => runWithActor(null, run);
const asConfirmed = <T>(run: () => Promise<T>) => runWithActor("claude", run, "owner", undefined, ["write:entity:*"]);

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
  sql = postgres(testUrl.toString(), { max: 10, connect_timeout: 10, fetch_types: false, prepare: true });
}, 60_000);

beforeEach(async () => {
  await sql.unsafe(
    "TRUNCATE TABLE writes, write_rows, jobs, sessions, routine_steps, commitments, deliverables, actions, projects, outcomes, areas, entity_prerequisites RESTART IDENTITY CASCADE"
  );
  userId = await ensureUser(sql);
  const area = (
    await sql<
      { id: string }[]
    >`INSERT INTO areas (user_id,name,status,sort_order) VALUES (${userId},'A','active',0) RETURNING id`
  )[0]!.id;
  const outcome = (
    await sql<
      { id: string }[]
    >`INSERT INTO outcomes (area_id,title,definition_of_done,status) VALUES (${area},'O','D','active') RETURNING id`
  )[0]!.id;
  projectId = (
    await sql<
      { id: string }[]
    >`INSERT INTO projects (outcome_id,title,status) VALUES (${outcome},'P','active') RETURNING id`
  )[0]!.id;
});

afterAll(async () => {
  await sql?.end();
});

async function seedActions(n: number): Promise<{ id: string; version: number }[]> {
  const made: { id: string; version: number }[] = [];
  for (let i = 0; i < n; i++)
    made.push({
      id: (
        await sql<{ id: string }[]>`
          INSERT INTO actions (project_id,title,scheduling_mode,status,optimistic_minutes,expected_minutes,pessimistic_minutes,remaining_minutes,energy,minimum_session_minutes,maximum_session_minutes)
          VALUES (${projectId},${"Action " + i},'one_off','planned',30,60,90,60,'medium',15,90) RETURNING id`
      )[0]!.id,
      version: 1
    });
  return made;
}

const cancel = (id: string, extra: Partial<CloseEntityCommand> = {}) =>
  ({ type: "action", id, verb: "cancel", do: "close", reason: "tidy", ...extra }) as CloseEntityCommand;
const restoreOf = (id: string, version: number) =>
  ({ type: "action", id, verb: "cancel", do: "restore", expectedVersion: version }) as CloseEntityCommand;
const used = async () => (await closedInWindow(sql, userId)).used;

describe("the hourly close budget", () => {
  it("applies 20 single closes and refuses the 21st with what counted and the same call to repeat", async () => {
    const actions = await seedActions(21);
    for (const a of actions.slice(0, 20)) await asAgent(() => closeEntity(sql, cancel(a.id)));
    expect(await used()).toBe(20);
    const err = await asAgent(() => closeEntity(sql, cancel(actions[20]!.id))).catch((e) => e);
    expect(err).toBeInstanceOf(CommandConflictError);
    expect(err.message).toMatch(/21 closures by agents in the last hour, over the 20 allowed/);
    expect(err.message).toMatch(/filed as a proposal/);
    expect(err.nextCall).toMatchObject({ tool: "rhen_cancel", arguments: { id: actions[20]!.id, do: "close" } });
    const left = await sql`SELECT status FROM actions WHERE id=${actions[20]!.id}`;
    expect(left[0]!.status).toBe("planned");
  });

  it("counts a project and everything it takes with it", async () => {
    await seedActions(3);
    const { closed } = await asAgent(() =>
      closeEntity(sql, {
        type: "project",
        id: projectId,
        verb: "cancel",
        do: "close",
        reason: "x",
        includeChildren: true
      })
    );
    expect(closed.cascaded).toHaveLength(3);
    const row = (
      await sql<
        { evidence: { closed: number; counted: boolean } }[]
      >`SELECT evidence FROM write_rows WHERE operation='close'`
    )[0]!;
    expect(row.evidence).toMatchObject({ closed: 4, counted: true });
    expect(await used()).toBe(4);
  });

  it("counts the cycle close, restore, close, and never a restore", async () => {
    const actions = await seedActions(12);
    for (const a of actions) await asAgent(() => closeEntity(sql, cancel(a.id)));
    for (const a of actions) await asAgent(() => closeEntity(sql, restoreOf(a.id, 2)));
    expect(await used()).toBe(12);
    // every row is open again, but the 12 closures still count: only 8 more fit
    await asAgent(() => closeEntity(sql, cancel(actions[0]!.id, { expectedVersion: 3 })));
    for (const a of actions.slice(1, 8)) await asAgent(() => closeEntity(sql, cancel(a.id, { expectedVersion: 3 })));
    expect(await used()).toBe(20);
    await expect(asAgent(() => closeEntity(sql, cancel(actions[8]!.id, { expectedVersion: 3 })))).rejects.toThrow(
      /last hour/
    );
  });

  it("lets a closure age out of the window", async () => {
    const actions = await seedActions(21);
    for (const a of actions.slice(0, 20)) await asAgent(() => closeEntity(sql, cancel(a.id)));
    await sql`UPDATE write_rows SET created_at = now() - interval '61 minutes' WHERE operation='close' AND id IN (SELECT id FROM write_rows WHERE operation='close' ORDER BY id LIMIT 5)`;
    expect(await used()).toBe(15);
    await asAgent(() => closeEntity(sql, cancel(actions[20]!.id)));
    expect(await used()).toBe(16);
    expect((await closedInWindow(sql, userId, new Date(Date.now() + 3 * 3_600_000))).used).toBe(0);
  });

  it("does not count or refuse the owner or a confirmed replay", async () => {
    const actions = await seedActions(20);
    for (const a of actions.slice(0, 10)) await asOwner(() => closeEntity(sql, cancel(a.id, { reason: undefined })));
    for (const a of actions.slice(10, 20)) await asConfirmed(() => closeEntity(sql, cancel(a.id)));
    expect(await used()).toBe(0);
  });

  it("counts and refuses a header-only agent the same as a token agent", async () => {
    const actions = await seedActions(22);
    for (const a of actions.slice(0, 20)) await asHeaderAgent(() => closeEntity(sql, cancel(a.id)));
    expect(await used()).toBe(20);
    const err = await asHeaderAgent(() => closeEntity(sql, cancel(actions[20]!.id))).catch((e) => e);
    expect(err.message).toMatch(/over the 20 allowed/);
    expect(err.message).not.toMatch(/filed as a proposal/);
    // a token agent shares the same hour
    await expect(asAgent(() => closeEntity(sql, cancel(actions[21]!.id)))).rejects.toThrow(/over the 20 allowed/);
  });

  it("answers a retry from its receipt: the sum does not move and no second batch is made", async () => {
    const actions = await seedActions(1);
    const command = cancel(actions[0]!.id, { commandId: crypto.randomUUID() });
    const first = await asAgent(() => closeEntity(sql, command));
    const second = await asAgent(() => closeEntity(sql, command));
    expect(second.closed.batch).toBe(first.closed.batch);
    expect(await used()).toBe(1);
    expect(await sql`SELECT 1 FROM write_rows WHERE operation='close'`).toHaveLength(1);
  });

  it("lets exactly one of two parallel 15-row closes land", async () => {
    const actions = await seedActions(30);
    const run = (slice: typeof actions) =>
      Promise.allSettled(slice.map((a) => asAgent(() => closeEntity(sql, cancel(a.id)))));
    // 15 closes each as separate calls in parallel: the ceiling holds whatever the interleaving
    const results = await Promise.all([run(actions.slice(0, 15)), run(actions.slice(15, 30))]);
    const applied = results.flat().filter((r) => r.status === "fulfilled").length;
    expect(applied).toBe(20);
    expect(await used()).toBe(20);
  });

  it("stamps closed_by for the person, the agent and a confirmed close", async () => {
    const [a, b, c] = await seedActions(3);
    await asOwner(() => closeEntity(sql, cancel(a!.id, { reason: undefined })));
    await asAgent(() => closeEntity(sql, cancel(b!.id)));
    await asConfirmed(() => closeEntity(sql, cancel(c!.id)));
    const by = await sql<
      { id: string; closed_by: string }[]
    >`SELECT id, closed_by FROM actions WHERE id IN ${sql([a!.id, b!.id, c!.id])}`;
    const map = Object.fromEntries(by.map((r) => [r.id, r.closed_by]));
    expect(map[a!.id]).toBe("person");
    expect(map[b!.id]).toBe("agent:claude");
    expect(map[c!.id]).toBe("agent:claude:confirmed");
  });

  it("sums PR 3 shaped rows (no closed figure) as the target plus its cascade", async () => {
    const [a] = await seedActions(1);
    const writeId = crypto.randomUUID();
    await sql`INSERT INTO writes (id,user_id,command_type,actor) VALUES (${writeId},${userId},'close_entity','claude')`;
    await sql`INSERT INTO write_rows (write_id,user_id,entity_type,entity_id,operation,evidence) VALUES (${writeId},${userId},'project',${a!.id},'close',${sql.json({ cascade: [{}, {}] } as never)})`;
    expect(await used()).toBe(closedCount({ cascade: [{}, {}] }));
  });

  describe("an undo or redo that puts rows back closed", () => {
    const revert = (target: string, direction: "undo" | "redo") => ({
      commandId: crypto.randomUUID(),
      target,
      direction
    });
    const spend = async (closed: number) => {
      const writeId = crypto.randomUUID();
      await sql`INSERT INTO writes (id,user_id,command_type,actor) VALUES (${writeId},${userId},'close_entity','claude')`;
      await sql`INSERT INTO write_rows (write_id,user_id,entity_type,entity_id,operation,evidence) VALUES (${writeId},${userId},'action','seed','close',${sql.json({ closed, counted: true } as never)})`;
    };
    const statusOf = async (id: string) =>
      (await sql<{ status: string }[]>`SELECT status::text AS status FROM actions WHERE id=${id}`)[0]!.status;

    it("refuses a redo of a close once the hour is spent, and counts one that fits", async () => {
      const [a] = await seedActions(1);
      const commandId = crypto.randomUUID();
      await asAgent(() => closeEntity(sql, cancel(a!.id, { commandId } as never)));
      await asAgent(() => runRevertCommand(sql, revert(commandId, "undo")));
      expect(await statusOf(a!.id)).toBe("planned");
      // the first close ages out of the hour; others spend it
      await sql`UPDATE write_rows SET created_at = now() - interval '2 hours' WHERE operation='close'`;
      await spend(20);
      const err = await asAgent(() => runRevertCommand(sql, revert(commandId, "redo"))).catch((e) => e);
      expect(err.message).toMatch(/over the 20 allowed/);
      expect(err.message).not.toMatch(/filed as a proposal/);
      expect(await statusOf(a!.id)).toBe("planned");
      // with room, the redo lands and is counted
      await sql`DELETE FROM write_rows WHERE evidence->>'closed'='20'`;
      await asAgent(() => runRevertCommand(sql, revert(commandId, "redo")));
      expect(await statusOf(a!.id)).toBe("cancelled");
      expect(await used()).toBe(1);
    });

    it("refuses an undo of a restore once the hour is spent", async () => {
      const [a] = await seedActions(1);
      const closed = await asAgent(() => closeEntity(sql, cancel(a!.id)));
      const restoreId = crypto.randomUUID();
      await asAgent(() =>
        closeEntity(sql, { ...restoreOf(a!.id, closed.closed.version), commandId: restoreId } as never)
      );
      expect(await statusOf(a!.id)).toBe("planned");
      await sql`UPDATE write_rows SET created_at = now() - interval '2 hours' WHERE operation='close'`;
      await spend(20);
      await expect(asAgent(() => runRevertCommand(sql, revert(restoreId, "undo")))).rejects.toThrow(
        /over the 20 allowed/
      );
      expect(await statusOf(a!.id)).toBe("planned");
    });

    it("does not hold the owner, and reopening (undo of a close) is not counted", async () => {
      const [a] = await seedActions(1);
      const commandId = crypto.randomUUID();
      await asAgent(() => closeEntity(sql, cancel(a!.id, { commandId } as never)));
      await spend(20);
      await asAgent(() => runRevertCommand(sql, revert(commandId, "undo")));
      expect(await statusOf(a!.id)).toBe("planned");
      await asOwner(() => runRevertCommand(sql, revert(commandId, "redo")));
      expect(await statusOf(a!.id)).toBe("cancelled");
    });
  });
});
