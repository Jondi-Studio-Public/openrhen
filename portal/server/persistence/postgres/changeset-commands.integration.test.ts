import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import type { ChangesetCommand, ChangesetItem, RevertCommand, SaveActionCommand } from "@openrhen/contracts";
import { integrationDatabaseName } from "@openrhen/database";
import { runWithActor } from "@/server/agent-actor";
import { resolveAgentProposal } from "@/server/agent-proposals/store";
import { runChangeset } from "./changeset-commands";
import { CommandConflictError, CommandIdReusedError, NotFoundCommandError } from "./command-errors";
import { readAgentChangeDetail } from "./agent-change-detail";
import { ensureUser } from "./ensure-user";
import { runRevertCommand } from "./write-revert";
import { waitUntilBlocked } from "./wait-until-blocked";

/**
 * Changeset ingest: a preview runs every command and keeps nothing; an apply keeps
 * all of them or none; the set undoes and redoes as one write, and a member never alone; a retried apply lands once;
 * a token is held to each command's own route decision. Self-contained `_test` database.
 */
config({ path: resolve(process.cwd(), "../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(process.env.CHANGESET_TEST_DATABASE_NAME, "rhen_changeset");

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("CHANGESET_TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let userId: string;
let projectId: string;

const asAgent = <T>(run: () => Promise<T>, scopes?: string[], directWrites?: Record<string, string>) =>
  runWithActor("companion", run, undefined, { basis: "stated", evidence: "from the message" }, scopes, directWrites);
const revert = (target: string, direction: "undo" | "redo"): RevertCommand => ({
  commandId: crypto.randomUUID(),
  target,
  direction
});

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
  sql = postgres(testUrl.toString(), { max: 5, connect_timeout: 10, fetch_types: false, prepare: true });
}, 60_000);

beforeEach(async () => {
  await sql.unsafe(
    "TRUNCATE TABLE writes, write_rows, agent_proposals, actions, projects, outcomes, areas, captures, sleep_plans RESTART IDENTITY CASCADE"
  );
  userId = await ensureUser(sql);
  await sql`INSERT INTO user_preferences (user_id) VALUES (${userId}) ON CONFLICT DO NOTHING`;
  const area = await sql<
    { id: string }[]
  >`INSERT INTO areas (user_id,name,status,sort_order) VALUES (${userId},'Family','active',0) RETURNING id`;
  const outcome = await sql<
    { id: string }[]
  >`INSERT INTO outcomes (area_id,title,definition_of_done,status) VALUES (${area[0]!.id},'Outcome','Done','active') RETURNING id`;
  const project = await sql<
    { id: string }[]
  >`INSERT INTO projects (outcome_id,title,status) VALUES (${outcome[0]!.id},'Family','active') RETURNING id`;
  projectId = project[0]!.id;
});

afterAll(async () => {
  await sql?.end();
});

function action(
  id: string,
  version: number | null,
  patch: Partial<SaveActionCommand["action"]> = {}
): SaveActionCommand {
  return {
    commandId: crypto.randomUUID(),
    expectedVersion: version,
    action: {
      id,
      projectId,
      title: "Call mum",
      status: "planned",
      optimisticMinutes: 30,
      expectedMinutes: 60,
      pessimisticMinutes: 90,
      remainingMinutes: 60,
      energy: "medium",
      minimumSessionMinutes: 15,
      maximumSessionMinutes: 60,
      splittable: true,
      setupMinutes: 0,
      importance: 3,
      consequence: 3,
      contexts: [],
      dependencyIds: [],
      ...patch
    }
  } as SaveActionCommand;
}

function item(intent: number, command: SaveActionCommand, creates = false): ChangesetItem {
  return {
    intent,
    path: "/api/commands/action",
    payload: command as unknown as Record<string, unknown>,
    ...(creates ? { creates: { kind: "action", id: command.action.id } } : {})
  };
}

const changeset = (
  mode: "preview" | "apply",
  items: ChangesetItem[],
  commandId = crypto.randomUUID()
): ChangesetCommand => ({
  commandId,
  mode,
  items
});

async function existingAction(title: string): Promise<{ id: string; version: number }> {
  const rows = await sql<{ id: string; version: number }[]>`
    INSERT INTO actions (project_id,title,status,optimistic_minutes,expected_minutes,pessimistic_minutes,remaining_minutes,energy,minimum_session_minutes,maximum_session_minutes)
    VALUES (${projectId},${title},'planned',30,60,90,60,'medium',15,60) RETURNING id, version`;
  return rows[0]!;
}

const titles = async () =>
  (await sql<{ title: string }[]>`SELECT title FROM actions WHERE status <> 'cancelled' ORDER BY title`).map(
    (row) => row.title
  );

describe("preview", () => {
  it("runs every command, says each applies, and keeps nothing", async () => {
    const form = await existingAction("Sign Mia's form");
    const result = await asAgent(() =>
      runChangeset(
        sql,
        changeset("preview", [
          item(0, action(crypto.randomUUID(), null), true),
          item(1, action(form.id, form.version, { title: "Sign Mia's form", status: "done" }))
        ])
      )
    );
    expect(result.ok).toBe(true);
    expect(result.items.map((entry) => entry.outcome)).toEqual(["applies", "applies"]);
    expect(result.items.every((entry) => entry.undoable)).toBe(true);
    expect(result.changesetId).toBeUndefined();
    expect(await titles()).toEqual(["Sign Mia's form"]);
    expect((await sql`SELECT status FROM actions WHERE id=${form.id}`)[0]!.status).toBe("planned");
    expect(await sql`SELECT id FROM writes`).toHaveLength(0);
  });

  it("names a conflict and an invalid command without stopping the rest", async () => {
    const form = await existingAction("Sign Mia's form");
    const result = await asAgent(() =>
      runChangeset(
        sql,
        changeset("preview", [
          item(0, action(form.id, form.version + 4, { title: "Sign Mia's form", status: "done" })),
          item(1, action(crypto.randomUUID(), null, { projectId: crypto.randomUUID() }), true),
          item(2, action(crypto.randomUUID(), null, { title: "Ring the dentist" }), true)
        ])
      )
    );
    expect(result.ok).toBe(false);
    expect(result.items.map((entry) => entry.outcome)).toEqual(["conflict", "invalid", "applies"]);
    expect(result.items[1]!.message).toMatch(/Project ".*" no longer exists/);
  });

  it("shows a token that cannot read the plan no duplicates", async () => {
    await existingAction("Call mum about Sunday");
    const result = await asAgent(
      () =>
        runChangeset(
          sql,
          changeset("preview", [item(0, action(crypto.randomUUID(), null, { title: "Call mum on Sunday" }), true)])
        ),
      ["write:entity:action"],
      { action: "on" }
    );
    expect(result.items[0]!.outcome).toBe("applies");
    expect(result.items[0]!.likelyDuplicates).toBeUndefined();
  });

  it("finds a likely duplicate of an open record, by words when meaning is unavailable", async () => {
    await existingAction("Call mum about Sunday");
    const result = await asAgent(() =>
      runChangeset(
        sql,
        changeset("preview", [item(0, action(crypto.randomUUID(), null, { title: "Call mum on Sunday" }), true)])
      )
    );
    expect(result.items[0]!.likelyDuplicates?.map((hit) => hit.title)).toEqual(["Call mum about Sunday"]);
  });
});

describe("alongside other writers", () => {
  it("does not hold the user lock, so a save holding a row it wants finishes first instead of deadlocking", async () => {
    const first = await existingAction("Sign Mia's form");
    const held = await existingAction("Book the dentist");
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    // A browser save: it locks its row, then reads the user (as recording its change does), then commits.
    let rowLocked!: () => void;
    const lockTaken = new Promise<void>((resolve) => (rowLocked = resolve));
    const save = sql.begin(async (tx) => {
      await tx`SELECT id FROM actions WHERE id=${held.id} FOR UPDATE`;
      rowLocked();
      await released;
      await ensureUser(tx);
    });
    await lockTaken;
    const preview = asAgent(() =>
      runChangeset(
        sql,
        changeset("preview", [
          item(0, action(first.id, first.version, { title: "Sign Mia's form", status: "done" })),
          item(1, action(held.id, held.version, { title: "Book the dentist", status: "done" }))
        ])
      )
    );
    // The changeset is now waiting on the held row, having been through the first command's handler.
    await waitUntilBlocked(sql);
    release();
    await save;
    expect((await preview).items.map((entry) => entry.outcome)).toEqual(["applies", "applies"]);
  });

  it("refuses a command whose id another write already used, rather than adopting that write as its own", async () => {
    const form = await existingAction("Sign Mia's form");
    const command = action(form.id, form.version, { title: "Sign Mia's form", status: "done" });
    await sql`INSERT INTO writes (id, user_id, command_type) VALUES (${command.commandId!}, ${userId}, 'save_action')`;
    const result = await asAgent(() => runChangeset(sql, changeset("apply", [item(0, command)])));
    expect(result.ok).toBe(false);
    expect(result.items[0]).toMatchObject({ outcome: "conflict" });
    expect((await sql`SELECT status FROM actions WHERE id=${form.id}`)[0]!.status).toBe("planned");
    expect(await sql`SELECT id FROM writes WHERE command_type='changeset'`).toHaveLength(0);
  });
});

describe("answers to the third review", () => {
  it("names a command whose id is not a uuid as invalid, and the rest still run", async () => {
    const form = await existingAction("Sign Mia's form");
    const bad = { ...action(crypto.randomUUID(), null), commandId: "not-a-uuid" } as SaveActionCommand;
    const result = await asAgent(() =>
      runChangeset(
        sql,
        changeset("preview", [
          item(0, bad, true),
          item(1, action(form.id, form.version, { title: "Sign Mia's form", status: "done" }))
        ])
      )
    );
    expect(result.items.map((entry) => entry.outcome)).toEqual(["invalid", "applies"]);
  });

  it("shows a changeset on Agent changes as its members' records, each with its basis", async () => {
    const form = await existingAction("Sign Mia's form");
    const result = await asAgent(() =>
      runChangeset(
        sql,
        changeset("apply", [
          { ...item(0, action(crypto.randomUUID(), null), true), basis: "stated", evidence: "call mum tonight" },
          item(1, action(form.id, form.version, { title: "Sign Mia's form", status: "done" }))
        ])
      )
    );
    const detail = await readAgentChangeDetail(sql, userId, result.changesetId!);
    expect(detail).toMatchObject({ commandType: "changeset", state: "applied" });
    expect(detail!.rows.filter((row) => row.entityType === "action").map((row) => [row.title, row.basis])).toEqual([
      ["Call mum", "stated"],
      ["Sign Mia's form", "stated"]
    ]);
    expect(
      detail!.rows.find((row) => row.title === "Sign Mia's form")!.fields.find((field) => field.field === "status")
    ).toMatchObject({ before: "planned", after: "done" });
  });
});

describe("apply", () => {
  it("keeps every command, and undoes and redoes them as one write", async () => {
    const form = await existingAction("Sign Mia's form");
    const created = crypto.randomUUID();
    const result = await asAgent(() =>
      runChangeset(
        sql,
        changeset("apply", [
          item(0, action(created, null), true),
          item(1, action(form.id, form.version, { title: "Sign Mia's form", status: "done" }))
        ])
      )
    );
    expect(result.ok).toBe(true);
    expect(result.changesetId).toBeDefined();
    expect(await titles()).toEqual(["Call mum", "Sign Mia's form"]);
    const [header] = await sql<{ command_type: string; state: string; response: { members: string[] } }[]>`
      SELECT command_type, state, response FROM writes WHERE id=${result.changesetId!}`;
    expect(header).toMatchObject({ command_type: "changeset", state: "applied" });
    expect(header!.response.members).toEqual(result.items.map((entry) => entry.commandId));

    // A member is never undone alone.
    await expect(asAgent(() => runRevertCommand(sql, revert(result.items[1]!.commandId, "undo")))).rejects.toThrow(
      /part of changeset/
    );

    await asAgent(() => runRevertCommand(sql, revert(result.changesetId!, "undo")));
    expect(await titles()).toEqual(["Sign Mia's form"]);
    expect((await sql`SELECT status FROM actions WHERE id=${form.id}`)[0]!.status).toBe("planned");
    await expect(asAgent(() => runRevertCommand(sql, revert(result.changesetId!, "undo")))).rejects.toThrow(
      CommandConflictError
    );

    await asAgent(() => runRevertCommand(sql, revert(result.changesetId!, "redo")));
    expect(await titles()).toEqual(["Call mum", "Sign Mia's form"]);
    expect((await sql`SELECT status FROM actions WHERE id=${form.id}`)[0]!.status).toBe("done");
  });

  it("keeps nothing when one command fails, and says which", async () => {
    const form = await existingAction("Sign Mia's form");
    const result = await asAgent(() =>
      runChangeset(
        sql,
        changeset("apply", [
          item(0, action(crypto.randomUUID(), null), true),
          item(1, action(form.id, form.version + 1, { title: "Sign Mia's form", status: "done" }))
        ])
      )
    );
    expect(result.ok).toBe(false);
    expect(result.items.map((entry) => entry.outcome)).toEqual(["applies", "conflict"]);
    expect(result.changesetId).toBeUndefined();
    expect(await titles()).toEqual(["Sign Mia's form"]);
    expect(await sql`SELECT id FROM writes`).toHaveLength(0);
  });

  it("lands once when the same apply is sent again", async () => {
    const commandId = crypto.randomUUID();
    const command = changeset("apply", [item(0, action(crypto.randomUUID(), null), true)], commandId);
    const first = await asAgent(() => runChangeset(sql, command));
    const second = await asAgent(() => runChangeset(sql, command));
    expect(second).toEqual(first);
    expect(await titles()).toEqual(["Call mum"]);
  });

  it("undoes and redoes two writes to the preferences row (where he is, and a night's wake) as one", async () => {
    const energy = async () =>
      (
        await sql<{ current_energy: string; last_woke_at: Date | null }[]>`
        SELECT current_energy, last_woke_at FROM user_preferences`
      )[0]!;
    const before = await energy();
    const { version } = (await sql<{ version: number }[]>`SELECT version FROM user_preferences`)[0]!;
    const result = await asAgent(() =>
      runChangeset(
        sql,
        changeset("apply", [
          {
            intent: 0,
            path: "/api/commands/entity",
            payload: {
              commandId: crypto.randomUUID(),
              type: "save_entity",
              expectedVersion: version,
              entityType: "current_availability",
              entity: { currentEnergy: before.current_energy === "low" ? "high" : "low", assertedConditions: [] }
            }
          },
          {
            intent: 1,
            path: "/api/commands/entity",
            payload: {
              commandId: crypto.randomUUID(),
              type: "save_entity",
              expectedVersion: null,
              entityType: "sleep_log_entry",
              entity: { sleepAt: "2026-10-26T23:40:00+11:00", wakeAt: "2026-10-27T07:30:00+11:00" }
            }
          }
        ])
      )
    );
    expect(result.ok).toBe(true);
    const applied = await energy();
    expect(applied.current_energy).not.toBe(before.current_energy);
    await asAgent(() => runRevertCommand(sql, revert(result.changesetId!, "undo")));
    expect(await energy()).toEqual(before);
    expect(await sql`SELECT id FROM sleep_plans`).toHaveLength(0);
    await asAgent(() => runRevertCommand(sql, revert(result.changesetId!, "redo")));
    expect(await energy()).toEqual(applied);
  });

  it("undoes a settings save and a night's wake, both on the preferences row, as one", async () => {
    const breakMinutes = async () =>
      (await sql<{ session_break_minutes: number }[]>`SELECT session_break_minutes FROM user_preferences`)[0]!
        .session_break_minutes;
    const before = await breakMinutes();
    const { version } = (await sql<{ version: number }[]>`SELECT version FROM user_preferences`)[0]!;
    const result = await asAgent(() =>
      runChangeset(
        sql,
        changeset("apply", [
          {
            intent: 0,
            path: "/api/commands/entity",
            payload: {
              commandId: crypto.randomUUID(),
              type: "save_entity",
              expectedVersion: version,
              entityType: "settings",
              entity: { sessionBreakMinutes: before + 5 }
            }
          },
          {
            intent: 1,
            path: "/api/commands/entity",
            payload: {
              commandId: crypto.randomUUID(),
              type: "save_entity",
              expectedVersion: null,
              entityType: "sleep_log_entry",
              entity: { sleepAt: "2026-10-26T23:40:00+11:00", wakeAt: "2026-10-27T07:30:00+11:00" }
            }
          }
        ])
      )
    );
    expect(result.items.map((entry) => [entry.outcome, entry.message])).toEqual([
      ["applies", undefined],
      ["applies", undefined]
    ]);
    await asAgent(() => runRevertCommand(sql, revert(result.changesetId!, "undo")));
    expect(await breakMinutes()).toBe(before);
    expect(await sql`SELECT id FROM sleep_plans`).toHaveLength(0);
  });

  it("refuses to undo a set when a member's images have expired, and changes nothing", async () => {
    const form = await existingAction("Sign Mia's form");
    const result = await asAgent(() =>
      runChangeset(
        sql,
        changeset("apply", [
          item(0, action(crypto.randomUUID(), null), true),
          item(1, action(form.id, form.version, { title: "Sign Mia's form", status: "done" }))
        ])
      )
    );
    await sql`UPDATE writes SET images=NULL WHERE id=${result.items[0]!.commandId}`;
    await expect(asAgent(() => runRevertCommand(sql, revert(result.changesetId!, "undo")))).rejects.toThrow(
      NotFoundCommandError
    );
    expect(await titles()).toEqual(["Call mum", "Sign Mia's form"]);
    expect((await sql`SELECT status FROM actions WHERE id=${form.id}`)[0]!.status).toBe("done");
  });

  it("answers a replay with what an apply kept, and refuses one for a command id that never applied", async () => {
    const commandId = crypto.randomUUID();
    const first = await asAgent(() =>
      runChangeset(sql, changeset("apply", [item(0, action(crypto.randomUUID(), null), true)], commandId))
    );
    const replayed = await asAgent(() => runChangeset(sql, { commandId, mode: "apply", replay: true, items: [] }));
    expect(replayed).toEqual(first);
    await expect(
      asAgent(() => runChangeset(sql, { commandId: crypto.randomUUID(), mode: "apply", replay: true, items: [] }))
    ).rejects.toThrow(NotFoundCommandError);
    // Another agent cannot read this one's changeset back, or apply under its id.
    const other = <T>(run: () => Promise<T>) => runWithActor("other-agent", run);
    await expect(other(() => runChangeset(sql, { commandId, mode: "apply", replay: true, items: [] }))).rejects.toThrow(
      NotFoundCommandError
    );
    await expect(
      other(() => runChangeset(sql, changeset("apply", [item(0, action(crypto.randomUUID(), null), true)], commandId)))
    ).rejects.toThrow(CommandConflictError);
    expect(await titles()).toEqual(["Call mum"]);
  });

  it("floors an edit to a commitment the family calendar shows, though the command leaves sharing out", async () => {
    const [stored] = await sql<{ id: string; version: number }[]>`
      INSERT INTO commitments (user_id, title, starts_at, ends_at, share_to_calendar)
      VALUES (${userId}, 'Swimming', now(), now() + interval '1 hour', true) RETURNING id, version`;
    const edit = (shared: boolean) =>
      asAgent(
        () =>
          runChangeset(
            sql,
            changeset("preview", [
              {
                intent: 0,
                path: "/api/commands/entity",
                payload: {
                  commandId: crypto.randomUUID(),
                  type: "save_entity",
                  expectedVersion: stored!.version,
                  entityType: "commitment",
                  entity: { id: stored!.id, title: shared ? "Swimming lesson" : "Swim" }
                }
              }
            ])
          ),
        ["write:entity:commitment", "propose:entity:commitment"],
        { commitment: "on" }
      );
    const floored = await edit(true);
    expect(floored.items[0]).toMatchObject({ outcome: "proposal" });
    expect((floored.items[0] as { reason: string }).reason).toMatch(/another person/);
    await sql`UPDATE commitments SET share_to_calendar=false WHERE id=${stored!.id}`;
    expect((await edit(false)).items[0]!.outcome).not.toBe("proposal");
  });

  it("holds a token to each command's route: an off class is filed for the person with the rest", async () => {
    const result = await asAgent(
      () =>
        runChangeset(
          sql,
          changeset("apply", [
            item(0, action(crypto.randomUUID(), null), true),
            {
              intent: 1,
              path: "/api/commands/entity",
              payload: {
                commandId: crypto.randomUUID(),
                type: "save_entity",
                expectedVersion: null,
                entityType: "outcome",
                entity: {
                  title: "Fitter",
                  definitionOfDone: "Gym twice a week",
                  value: 3,
                  status: "active",
                  areaId: "x"
                }
              }
            }
          ])
        ),
      ["write:entity:action", "propose:entity:outcome"],
      { action: "on" }
    );
    expect(result.ok).toBe(true);
    expect(result.items.map((entry) => entry.outcome)).toEqual(["applies", "proposal"]);
    expect(result.items[1]!.proposalId).toBeDefined();
    // The proposal is the person's once confirmed, so the set does not take it with it.
    const [header] = await sql<{ response: { members: string[] } }[]>`
      SELECT response FROM writes WHERE id=${result.changesetId!}`;
    expect(header!.response.members).toEqual([result.items[0]!.commandId]);
    expect(await titles()).toEqual(["Call mum"]);
    expect(await sql`SELECT id FROM agent_proposals WHERE status='pending'`).toHaveLength(1);
  });
});

describe("reusing a changeset's command id", () => {
  const hashA = "a".repeat(64);
  const hashB = "b".repeat(64);
  const apply = (items: ChangesetItem[], commandId: string, inputHash?: string) =>
    asAgent(() => runChangeset(sql, { ...changeset("apply", items, commandId), ...(inputHash ? { inputHash } : {}) }));

  it("replays an honest retry whose commands were rebuilt, and refuses other intents under the same id", async () => {
    const commandId = crypto.randomUUID();
    const first = await apply([item(0, action(crypto.randomUUID(), null), true)], commandId, hashA);
    expect(first.ok).toBe(true);
    // The retry rebuilt its commands against the plan (new ids), but the agent's intents are the same.
    const again = await apply(
      [item(0, action(crypto.randomUUID(), null, { title: "Rebuilt" }), true)],
      commandId,
      hashA
    );
    expect(again).toEqual(first);
    expect(await titles()).toEqual(["Call mum"]);
    await expect(apply([item(0, action(crypto.randomUUID(), null), true)], commandId, hashB)).rejects.toBeInstanceOf(
      CommandIdReusedError
    );
  });

  it("still replays when the client sends no input hash, or the receipt predates one", async () => {
    const commandId = crypto.randomUUID();
    await apply([item(0, action(crypto.randomUUID(), null), true)], commandId);
    await expect(apply([item(0, action(crypto.randomUUID(), null), true)], commandId, hashA)).resolves.toBeDefined();
  });
});

describe("the floor on a whole set (issue 804)", () => {
  const tokenScopes = ["read:plan", "write:entity:action"];
  const direct = { action: "on" };
  const many = async (count: number) =>
    Promise.all(Array.from({ length: count }, (_, index) => existingAction(`Task ${index}`)));
  const doneItems = (rows: { id: string; version: number }[], title = (index: number) => `Task ${index}`) =>
    rows.map((row, index) => item(index, action(row.id, row.version, { title: title(index), status: "done" })));
  const statuses = async () =>
    (await sql<{ status: string }[]>`SELECT status FROM actions ORDER BY title`).map((row) => row.status);

  it("files twenty-one updates as one proposal and applies none of them", async () => {
    const rows = await many(21);
    const result = await asAgent(() => runChangeset(sql, changeset("apply", doneItems(rows))), tokenScopes, direct);
    expect(result.ok).toBe(true);
    expect(new Set(result.items.map((entry) => entry.outcome))).toEqual(new Set(["proposal"]));
    expect(new Set(result.items.map((entry) => entry.proposalId)).size).toBe(1);
    expect(result.items[0]!.reason).toMatch(/21 existing records/);
    expect(new Set(await statuses())).toEqual(new Set(["planned"]));
    const filed = await sql<
      { kind: string; payload: { atomic?: boolean } }[]
    >`SELECT kind, payload FROM agent_proposals`;
    expect(filed).toHaveLength(1);
    expect(filed[0]).toMatchObject({ kind: "entity_command_batch", payload: { atomic: true } });
  });

  it("lets twenty updates apply, and does not count creates against the limit", async () => {
    const rows = await many(20);
    const creates = Array.from({ length: 10 }, (_, index) =>
      item(100 + index, action(crypto.randomUUID(), null, { title: `New ${index}` }), true)
    );
    const result = await asAgent(
      () => runChangeset(sql, changeset("apply", [...doneItems(rows), ...creates])),
      tokenScopes,
      direct
    );
    expect(new Set(result.items.map((entry) => entry.outcome))).toEqual(new Set(["applies"]));
  });

  it("does not take the agent's word that an update is a create", async () => {
    const rows = await many(21);
    const items = doneItems(rows).map((entry) => ({ ...entry, creates: { kind: "action", id: "x" } }));
    const result = await asAgent(() => runChangeset(sql, changeset("apply", items)), tokenScopes, direct);
    expect(result.items[0]!.outcome).toBe("proposal");
  });

  it("confirming the proposal applies every command, or none when one record has moved", async () => {
    const rows = await many(21);
    await asAgent(() => runChangeset(sql, changeset("apply", doneItems(rows))), tokenScopes, direct);
    const proposal = (await sql<{ id: string; revision: number }[]>`SELECT id, revision FROM agent_proposals`)[0]!;
    // The person edits one of the records after the agent read it.
    await sql`UPDATE actions SET version = version + 1 WHERE id=${rows[20]!.id}`;
    await expect(
      resolveAgentProposal(sql, null, proposal.id, { decision: "confirm", revision: proposal.revision })
    ).rejects.toMatchObject({ status: 409 });
    expect(new Set(await statuses())).toEqual(new Set(["planned"]));
  });

  it("applies all of them when nothing has moved", async () => {
    const rows = await many(21);
    await asAgent(() => runChangeset(sql, changeset("apply", doneItems(rows))), tokenScopes, direct);
    const proposal = (await sql<{ id: string; revision: number }[]>`SELECT id, revision FROM agent_proposals`)[0]!;
    await resolveAgentProposal(sql, null, proposal.id, { decision: "confirm", revision: proposal.revision });
    expect(new Set(await statuses())).toEqual(new Set(["done"]));
  });

  it("refuses a floored set that holds a session command, naming how to split it", async () => {
    const rows = await many(21);
    const session = {
      intent: 99,
      path: "/api/commands/session" as const,
      payload: { commandId: crypto.randomUUID() }
    };
    const result = await asAgent(
      () => runChangeset(sql, changeset("apply", [...doneItems(rows), session])),
      [...tokenScopes, "write:session"],
      direct
    );
    expect(result.ok).toBe(false);
    expect(result.items.every((entry) => entry.outcome === "invalid")).toBe(true);
    expect(result.items[0]!.message).toMatch(/split it/);
    expect(await sql`SELECT id FROM agent_proposals`).toHaveLength(0);
  });
});
