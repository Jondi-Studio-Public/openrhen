import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import { integrationDatabaseName } from "@openrhen/database";
import type { CheckInCommand, RevertCommand } from "@openrhen/contracts";
import { runWithActor } from "@/server/agent-actor";
import { claimCommandReceipt } from "./command-receipt";
import { runCheckInCommand } from "./check-in-commands";
import { CommandConflictError, ForbiddenCommandError, NotFoundCommandError } from "./command-errors";
import { ensureUser } from "./ensure-user";
import { runRevertCommand } from "./write-revert";
import { SNAPSHOT_LIMIT, WriteSnapshot, type SnapshotRow } from "./write-snapshot";

/**
 * Undo and redo of an agent's check-in answer from its row snapshot:
 * who may revert, what state it needs, the refusal when the row changed since, force, the receipt, and retention.
 */
type SingleAnswerCommand = Extract<CheckInCommand, { type: "answer_check_in" }>;

config({ path: resolve(process.cwd(), "../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(process.env.TEST_DATABASE_NAME, "openrhen_write_revert");

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let userId: string;

/** Only one slot per user can be `pending` at a time, so the rows a test wants several of are inserted `unknown`. */
async function insertCheckIn(minutesAgo = 0, status = "pending"): Promise<{ id: string; version: number }> {
  const slotAt = new Date(Date.now() - minutesAgo * 60_000);
  const rows = await sql<{ id: string; version: number }[]>`
    INSERT INTO check_in (user_id, slot_at, directive_kind, directive_target_id, directive_title, status)
    VALUES (${userId}, ${slotAt}, 'action', ${null}, 'Write the report', ${status})
    RETURNING id, version`;
  return rows[0]!;
}

function answerCommand(
  checkInId: string,
  expectedVersion: number,
  overrides: Partial<SingleAnswerCommand> = {}
): SingleAnswerCommand {
  return {
    commandId: crypto.randomUUID(),
    type: "answer_check_in",
    checkInId,
    expectedVersion,
    status: "deviated",
    deviationCategory: "work",
    deviationNote: "Pulled onto something else",
    answerSource: "in_app_banner",
    ...overrides
  };
}

const asAgent = <T>(agent: string, fn: () => Promise<T>) => runWithActor(agent, fn);

const revert = (target: string, direction: RevertCommand["direction"], overrides: Partial<RevertCommand> = {}) => ({
  commandId: crypto.randomUUID(),
  target,
  direction,
  ...overrides
});

const readCheckIn = async (id: string) =>
  (
    await sql<
      {
        status: string;
        answered_at: Date | null;
        version: number;
        answered_by: string | null;
        deviation_note: string | null;
      }[]
    >`SELECT status, answered_at, version, answered_by, deviation_note FROM check_in WHERE id=${id}`
  )[0]!;

const readSnapshot = async (commandId: string) =>
  (
    await sql<
      { agent: string; kind: string; state: string; rows: (SnapshotRow & { undone?: unknown })[] }[]
    >`SELECT actor AS agent, kind, state, images AS rows FROM writes WHERE id=${commandId} AND images IS NOT NULL`
  )[0];

/** The agent answers a fresh check-in; returns its id, the write's commandId and the version it ended at. */
async function agentAnswers(agent = "openclaw") {
  const row = await insertCheckIn();
  const command = answerCommand(row.id, row.version);
  await asAgent(agent, () => runCheckInCommand(sql, command));
  return { id: row.id, target: command.commandId, answeredVersion: (await readCheckIn(row.id)).version };
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
  await sql.unsafe("TRUNCATE TABLE check_in, writes, write_rows, planning_runs CASCADE");
});

afterAll(async () => {
  await sql?.end();
});

describe("undo of a voluntary check-in", () => {
  it("deletes the voluntary row on undo and puts it back on redo", async () => {
    const now = new Date();
    await sql`
      INSERT INTO planning_runs (user_id,request_id,input_version,contract_version,engine_version,calculated_at,valid_until,result)
      VALUES (${userId},${crypto.randomUUID()},'v1','1','v1',${now},${new Date(now.getTime() + 3_600_000)},
        ${sql.json({ currentDirective: { kind: "action", targetId: crypto.randomUUID(), title: "Write" } } as never)})`;
    const commandId = crypto.randomUUID();
    await asAgent("openclaw", () =>
      runCheckInCommand(sql, {
        commandId,
        type: "voluntary_check_in",
        expectedVersion: null,
        status: "on_track",
        answerSource: "sheet"
      })
    );
    const count = async () => (await sql`SELECT id FROM check_in WHERE user_id=${userId}`).length;
    expect(await count()).toBe(1);
    await asAgent("openclaw", () => runRevertCommand(sql, revert(commandId, "undo")));
    expect(await count()).toBe(0);
    await asAgent("openclaw", () => runRevertCommand(sql, revert(commandId, "redo")));
    expect(await count()).toBe(1);
  });
});

describe("snapshots of check-in answers", () => {
  it("keeps the row's before and after images for an agent's answer", async () => {
    const { id, target } = await agentAnswers();
    const snapshot = await readSnapshot(target);
    expect(snapshot).toMatchObject({ agent: "openclaw", kind: "check_in", state: "applied" });
    expect(snapshot!.rows).toHaveLength(1);
    expect(snapshot!.rows[0]).toMatchObject({
      table: "check_in",
      id,
      before: { status: "pending", answered_at: null, version: 1 },
      after: { status: "deviated", answered_by: "openclaw", version: 2 }
    });
  });

  it("keeps nothing for the owner's own answer", async () => {
    const row = await insertCheckIn();
    await runCheckInCommand(sql, answerCommand(row.id, row.version));
    expect(await sql`SELECT 1 FROM writes WHERE images IS NOT NULL`).toHaveLength(0);
  });

  it("keeps one snapshot for a reconciliation batch and undoes every row", async () => {
    const first = await insertCheckIn(30, "unknown");
    const second = await insertCheckIn(20, "unknown");
    const commandId = crypto.randomUUID();
    await asAgent("openclaw", () =>
      runCheckInCommand(sql, {
        commandId,
        type: "answer_check_ins",
        checkInIds: [first.id, second.id],
        upTo: new Date().toISOString(),
        tail: { status: "unknown" }
      })
    );
    expect((await readSnapshot(commandId))!.rows).toHaveLength(2);
    await asAgent("openclaw", () => runRevertCommand(sql, revert(commandId, "undo")));
    for (const id of [first.id, second.id]) {
      expect(await readCheckIn(id)).toMatchObject({ status: "unknown", answered_at: null, answered_by: null });
    }
  });
});

describe("runRevertCommand", () => {
  it("undoes an answer: the row is open again and its version moves on", async () => {
    const { id, target, answeredVersion } = await agentAnswers();
    await asAgent("openclaw", () => runRevertCommand(sql, revert(target, "undo")));
    expect(await readCheckIn(id)).toMatchObject({
      status: "pending",
      answered_at: null,
      answered_by: null,
      deviation_note: null,
      version: answeredVersion + 1
    });
    const snapshot = await readSnapshot(target);
    expect(snapshot!.state).toBe("undone");
    expect(snapshot!.rows[0]!.undone).toMatchObject({ status: "pending", version: answeredVersion + 1 });
  });

  it("ignores a column the system rewrote since (the replan after every write touches updated_at)", async () => {
    const { id, target } = await agentAnswers();
    await sql`UPDATE check_in SET updated_at=now() + interval '1 minute' WHERE id=${id}`;
    await asAgent("openclaw", () => runRevertCommand(sql, revert(target, "undo")));
    expect(await readCheckIn(id)).toMatchObject({ status: "pending", answered_at: null });
  });

  it("records the revert in the change log under the agent", async () => {
    const { id, target } = await agentAnswers();
    const command = revert(target, "undo");
    await asAgent("openclaw", () => runRevertCommand(sql, command));
    const [change] = await sql<
      { entity_type: string; entity_id: string; operation: string; actor: string; evidence: Record<string, unknown> }[]
    >`
      SELECT r.entity_type, r.entity_id, r.operation, w.actor, r.evidence FROM write_rows r JOIN writes w ON w.id=r.write_id WHERE r.write_id=${command.commandId}`;
    expect(change).toMatchObject({ entity_type: "check_in", entity_id: target, operation: "undo", actor: "openclaw" });
    expect(change!.evidence).toMatchObject({ target, rows: 1 });
    expect(id).toBeTruthy();
  });

  it("redoes it: the answer is back, then undoes again", async () => {
    const { id, target, answeredVersion } = await agentAnswers();
    await asAgent("openclaw", () => runRevertCommand(sql, revert(target, "undo")));
    await asAgent("openclaw", () => runRevertCommand(sql, revert(target, "redo")));
    expect(await readCheckIn(id)).toMatchObject({
      status: "deviated",
      answered_by: "openclaw",
      deviation_note: "Pulled onto something else",
      version: answeredVersion + 2
    });
    expect((await readCheckIn(id)).answered_at).not.toBeNull();
    expect((await readSnapshot(target))!.state).toBe("applied");
    // The redo stored what it left as the new after-image, so the next undo is checked against it.
    await asAgent("openclaw", () => runRevertCommand(sql, revert(target, "undo")));
    expect(await readCheckIn(id)).toMatchObject({ status: "pending", version: answeredVersion + 3 });
  });

  it("refuses to undo twice, and to redo what is not undone", async () => {
    const { target } = await agentAnswers();
    await expect(asAgent("openclaw", () => runRevertCommand(sql, revert(target, "redo")))).rejects.toThrow(
      CommandConflictError
    );
    await asAgent("openclaw", () => runRevertCommand(sql, revert(target, "undo")));
    await expect(asAgent("openclaw", () => runRevertCommand(sql, revert(target, "undo")))).rejects.toThrow(
      CommandConflictError
    );
  });

  it("refuses when the row was edited after the write, and changes nothing", async () => {
    const { id, target, answeredVersion } = await agentAnswers();
    await sql`UPDATE check_in SET deviation_note='Edited by hand', version=version+1 WHERE id=${id}`;
    await expect(asAgent("openclaw", () => runRevertCommand(sql, revert(target, "undo")))).rejects.toThrow(
      /was changed after the agent's write, so undoing it would overwrite that change/
    );
    expect(await readCheckIn(id)).toMatchObject({
      status: "deviated",
      deviation_note: "Edited by hand",
      version: answeredVersion + 1
    });
    expect((await readSnapshot(target))!.state).toBe("applied");
    expect(await sql`SELECT 1 FROM write_rows WHERE operation='undo'`).toHaveLength(0);
  });

  it("overwrites an edit made since when the owner forces it, and never for an agent", async () => {
    const { id, target } = await agentAnswers();
    await sql`UPDATE check_in SET deviation_note='Edited by hand', version=version+1 WHERE id=${id}`;
    const command = revert(target, "undo", { force: true });
    // An agent may not force: it would overwrite the person's later change.
    await expect(asAgent("openclaw", () => runRevertCommand(sql, command))).rejects.toThrow(ForbiddenCommandError);
    expect(await readCheckIn(id)).toMatchObject({ deviation_note: "Edited by hand" });
    await runWithActor(null, () => runRevertCommand(sql, command));
    expect(await readCheckIn(id)).toMatchObject({ status: "pending", deviation_note: null });
    const [change] = await sql<{ evidence: Record<string, unknown> }[]>`
      SELECT evidence FROM write_rows WHERE write_id=${command.commandId}`;
    expect(change!.evidence).toMatchObject({ forced: true });
  });

  it("refuses an undo once the scheduler has opened the next pending check-in", async () => {
    const { id, target } = await agentAnswers();
    const next = await insertCheckIn(0);
    await expect(asAgent("openclaw", () => runRevertCommand(sql, revert(target, "undo")))).rejects.toThrow(
      CommandConflictError
    );
    expect(await readCheckIn(id)).toMatchObject({ status: "deviated" });
    expect(await readCheckIn(next.id)).toMatchObject({ status: "pending" });
    expect((await readSnapshot(target))!.state).toBe("applied");
  });

  it("refuses a redo when the row was edited after the undo", async () => {
    const { id, target } = await agentAnswers();
    await asAgent("openclaw", () => runRevertCommand(sql, revert(target, "undo")));
    await sql`UPDATE check_in SET deviation_note='Typed since', version=version+1 WHERE id=${id}`;
    await expect(asAgent("openclaw", () => runRevertCommand(sql, revert(target, "redo")))).rejects.toThrow(
      CommandConflictError
    );
    expect((await readCheckIn(id)).status).toBe("pending");
  });

  it("keeps one agent out of another's write, and lets the owner revert any", async () => {
    const { id, target } = await agentAnswers("openclaw");
    await expect(asAgent("hermes", () => runRevertCommand(sql, revert(target, "undo")))).rejects.toThrow(
      ForbiddenCommandError
    );
    expect((await readCheckIn(id)).status).toBe("deviated");
    await runWithActor(null, () => runRevertCommand(sql, revert(target, "undo")));
    expect((await readCheckIn(id)).status).toBe("pending");
    const [change] = await sql<
      { actor: string | null }[]
    >`SELECT w.actor FROM write_rows r JOIN writes w ON w.id=r.write_id WHERE r.operation='undo'`;
    expect(change!.actor).toBeNull();
  });

  it("answers 404 for a write nothing was kept for", async () => {
    await expect(asAgent("openclaw", () => runRevertCommand(sql, revert(crypto.randomUUID(), "undo")))).rejects.toThrow(
      NotFoundCommandError
    );
    // An owner's answer was never snapshotted either.
    const row = await insertCheckIn();
    const command = answerCommand(row.id, row.version);
    await runCheckInCommand(sql, command);
    await expect(runRevertCommand(sql, revert(command.commandId, "undo"))).rejects.toThrow(NotFoundCommandError);
  });

  it("replays the same revert commandId without reverting twice", async () => {
    const { id, target, answeredVersion } = await agentAnswers();
    const command = revert(target, "undo");
    await asAgent("openclaw", () => runRevertCommand(sql, command));
    await expect(asAgent("openclaw", () => runRevertCommand(sql, command))).resolves.toBeTruthy();
    expect((await readCheckIn(id)).version).toBe(answeredVersion + 1);
    expect(await sql`SELECT 1 FROM write_rows WHERE write_id=${command.commandId}`).toHaveLength(1);
  });

  it("deletes a row the write created and brings back one it deleted, redoing both", async () => {
    const kept = await insertCheckIn(10, "unknown");
    const commandId = crypto.randomUUID();
    const createdId = crypto.randomUUID();
    await asAgent("openclaw", () =>
      sql.begin(async (tx) => {
        await claimCommandReceipt(tx, { id: commandId, userId, commandType: "check_in" });
        const snap = (await WriteSnapshot.open(tx, userId, commandId, "check_in"))!;
        await snap.before("check_in", [kept.id, createdId]);
        await tx`DELETE FROM check_in WHERE id=${kept.id}`;
        await tx`INSERT INTO check_in (id, user_id, slot_at, directive_kind, directive_title, status)
          VALUES (${createdId}, ${userId}, now(), 'action', 'Made by the write', 'unknown')`;
        await snap.save();
      })
    );
    expect(await sql`SELECT 1 FROM check_in WHERE id=${kept.id}`).toHaveLength(0);

    await asAgent("openclaw", () => runRevertCommand(sql, revert(commandId, "undo")));
    expect(await sql`SELECT 1 FROM check_in WHERE id=${createdId}`).toHaveLength(0);
    expect(await readCheckIn(kept.id)).toMatchObject({ status: "unknown", version: kept.version + 1 });

    await asAgent("openclaw", () => runRevertCommand(sql, revert(commandId, "redo")));
    expect(await sql`SELECT 1 FROM check_in WHERE id=${kept.id}`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM check_in WHERE id=${createdId}`).toHaveLength(1);
  });
});

describe("retention", () => {
  it("keeps the images of the newest 500 writes per user, and the header of every one", async () => {
    await sql`
      INSERT INTO writes (id, user_id, command_type, actor, kind, images, state, created_at)
      SELECT gen_random_uuid(), ${userId}, 'check_in', 'openclaw', 'check_in', '[]'::jsonb, 'applied', now() - make_interval(mins => n + 10)
      FROM generate_series(1, ${SNAPSHOT_LIMIT}) AS n`;
    const [oldest] = await sql<{ id: string }[]>`SELECT id FROM writes ORDER BY created_at LIMIT 1`;
    const { target } = await agentAnswers();
    const kept = await sql<{ id: string }[]>`SELECT id FROM writes WHERE images IS NOT NULL`;
    expect(kept).toHaveLength(SNAPSHOT_LIMIT);
    expect(kept.map((row) => row.id)).toContain(target);
    // The oldest one lost its images (and its undo state), so it can no longer be undone, but its header stays.
    expect(kept.map((row) => row.id)).not.toContain(oldest!.id);
    expect(await sql`SELECT 1 FROM writes WHERE id=${oldest!.id} AND images IS NULL AND state IS NULL`).toHaveLength(1);
    await expect(asAgent("openclaw", () => runRevertCommand(sql, revert(oldest!.id, "undo")))).rejects.toThrow(
      NotFoundCommandError
    );
  });

  it("answers 404 for a target that is not a uuid", async () => {
    await expect(asAgent("openclaw", () => runRevertCommand(sql, revert("old-1", "undo")))).rejects.toThrow(
      NotFoundCommandError
    );
  });
});
