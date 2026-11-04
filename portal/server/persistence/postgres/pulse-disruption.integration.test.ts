import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import { integrationDatabaseName } from "@openrhen/database";
import { recordDisruptionCommandSchema, type RecordDisruptionCommand } from "@openrhen/contracts";
import { runWithActor } from "@/server/agent-actor";
import { ensureUser } from "./ensure-user";
import { CommandConflictError, InvalidCommandError } from "./command-errors";
import { DisruptionIncompleteError, recordDisruption } from "./pulse-disruption";
import { runRevertCommand } from "./write-revert";
import { waitUntilBlocked } from "./wait-until-blocked";

/**
 * `record_disruption` (the pulse on plan design note, sections 1 and 2): all or nothing with each missing field named,
 * the row it stores, the replacement of the one in force, the explicit end, the refusal while lapsed, and the one undo
 * (and redo) from the write snapshot.
 */
config({ path: resolve(process.cwd(), "../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(process.env.TEST_DATABASE_NAME, "openrhen_pulse_disruption");

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let userId: string;

const NOW = new Date("2026-10-28T02:00:00Z");
const inMinutes = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000).toISOString();

const COMPLETE = {
  doing: "Hospital visit with Mum",
  until: inMinutes(180),
  locationId: "hospital",
  contexts: ["phone"],
  exclusive: true
} as const;
function command(overrides: Partial<RecordDisruptionCommand> = {}): RecordDisruptionCommand {
  return recordDisruptionCommandSchema.parse({ commandId: crypto.randomUUID(), ...COMPLETE, ...overrides });
}

const asAgent = <T>(fn: () => Promise<T>) => runWithActor("companion", fn);
const rows = () =>
  sql<
    { id: string; doing: string; ended_at: Date | null; recorded_by: string; exclusive: boolean; contexts: string[] }[]
  >`SELECT id, doing, ended_at, recorded_by, exclusive, contexts FROM pulse_disruptions WHERE user_id=${userId} ORDER BY created_at, id`;
const active = async () => (await rows()).filter((row) => row.ended_at === null);
const writeCount = async () => (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM writes`)[0]!.n;

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
    "TRUNCATE TABLE writes, write_rows, pulse_disruptions, pulse_segments, pulse_state, condition_definitions RESTART IDENTITY CASCADE"
  );
  await sql`INSERT INTO condition_definitions (user_id,id,name,kind) VALUES (${userId},'hospital','Hospital','location'),(${userId},'home','Home','location'),(${userId},'phone','Phone','capability'),(${userId},'laptop','Laptop','capability')`;
  await sql`INSERT INTO pulse_segments (user_id, started_at, state, reason, confirmed_at) VALUES (${userId}, ${new Date(NOW.getTime() - 3_600_000)}, 'off', 'deviated', NULL)`;
});

afterAll(async () => {
  await sql?.end();
});

describe("record_disruption", () => {
  it("stores a complete disruption and names its command id as revertible", async () => {
    const cmd = command();
    const result = await recordDisruption(sql as never, cmd, NOW);
    expect(result).toMatchObject({ recorded: true, ended: false, doing: COMPLETE.doing, revertible: cmd.commandId });
    const [row] = await active();
    expect(row).toMatchObject({ doing: COMPLETE.doing, recorded_by: "person", exclusive: true, contexts: ["phone"] });
  });

  it("takes a target as what he is doing, and keeps exclusive false", async () => {
    await recordDisruption(
      sql as never,
      command({ doing: { kind: "action", id: "a1", title: "Laundry" }, exclusive: false }),
      NOW
    );
    const stored = await sql<
      { doing: string; doing_kind: string | null; doing_id: string | null; exclusive: boolean }[]
    >`SELECT doing, doing_kind, doing_id, exclusive FROM pulse_disruptions`;
    expect(stored[0]).toMatchObject({ doing: "Laundry", doing_kind: "action", doing_id: "a1", exclusive: false });
  });

  it("names every missing field in a 422 body and writes nothing", async () => {
    const before = await writeCount();
    const failure = await recordDisruption(
      sql as never,
      command({ doing: undefined, locationId: undefined, contexts: [], exclusive: undefined }),
      NOW
    ).catch((error) => error);
    expect(failure).toBeInstanceOf(DisruptionIncompleteError);
    const { body } = failure as DisruptionIncompleteError;
    expect(body).toMatchObject({
      code: "disruptionIncomplete",
      missing: ["doing", "locationId", "contexts", "exclusive"]
    });
    expect(body.error).toContain("exclusive");
    expect(body.choices.places.map((place) => place.id)).toContain("hospital");
    expect(await rows()).toHaveLength(0);
    expect(await writeCount()).toBe(before);
  });

  it("refuses an until that is not in the future, one that is far off, an unknown place and an unknown context", async () => {
    await expect(recordDisruption(sql as never, command({ until: inMinutes(-5) }), NOW)).rejects.toBeInstanceOf(
      InvalidCommandError
    );
    await expect(
      recordDisruption(sql as never, command({ until: inMinutes(60 * 24 * 20) }), NOW)
    ).rejects.toBeInstanceOf(InvalidCommandError);
    await expect(recordDisruption(sql as never, command({ locationId: "moon" }), NOW)).rejects.toBeInstanceOf(
      InvalidCommandError
    );
    await expect(recordDisruption(sql as never, command({ contexts: ["phone", "nope"] }), NOW)).rejects.toThrow(/nope/);
    // A place is not a context.
    await expect(recordDisruption(sql as never, command({ contexts: ["home"] }), NOW)).rejects.toThrow(/home/);
    expect(await rows()).toHaveLength(0);
  });

  it("is refused while the pulse is lapsed: only re-entry heals it", async () => {
    await sql`UPDATE pulse_segments SET reason='lapsed' WHERE user_id=${userId} AND ended_at IS NULL`;
    await expect(recordDisruption(sql as never, command(), NOW)).rejects.toBeInstanceOf(CommandConflictError);
    expect(await rows()).toHaveLength(0);
  });

  it("replays the same command id without a second row", async () => {
    const cmd = command();
    const first = await recordDisruption(sql as never, cmd, NOW);
    const second = await recordDisruption(sql as never, cmd, new Date(NOW.getTime() + 60_000));
    expect(second).toEqual(first);
    expect(await rows()).toHaveLength(1);
  });

  it("replaces the disruption in force; one undo brings the earlier back and removes the new", async () => {
    await recordDisruption(sql as never, command({ doing: "First" }), NOW);
    const second = command({ doing: "Second" });
    await asAgent(() => recordDisruption(sql as never, second, new Date(NOW.getTime() + 60_000)));
    expect((await active()).map((row) => row.doing)).toEqual(["Second"]);
    expect((await active())[0]!.recorded_by).toBe("agent");

    await asAgent(() =>
      runRevertCommand(
        sql as never,
        { commandId: crypto.randomUUID(), target: second.commandId, direction: "undo" } as never
      )
    );
    expect((await rows()).map((row) => row.doing)).toEqual(["First"]);
    expect((await active()).map((row) => row.doing)).toEqual(["First"]);

    await asAgent(() =>
      runRevertCommand(
        sql as never,
        { commandId: crypto.randomUUID(), target: second.commandId, direction: "redo" } as never
      )
    );
    expect((await active()).map((row) => row.doing)).toEqual(["Second"]);
  });

  it("ends the disruption in force, undoably, and refuses an end with nothing to end", async () => {
    await expect(recordDisruption(sql as never, command({ end: true }), NOW)).rejects.toBeInstanceOf(
      CommandConflictError
    );
    await recordDisruption(sql as never, command(), NOW);
    const end = recordDisruptionCommandSchema.parse({ commandId: crypto.randomUUID(), end: true });
    const result = await asAgent(() => recordDisruption(sql as never, end, new Date(NOW.getTime() + 60_000)));
    expect(result).toMatchObject({ recorded: false, ended: true, revertible: end.commandId });
    expect(await active()).toHaveLength(0);

    await asAgent(() =>
      runRevertCommand(
        sql as never,
        { commandId: crypto.randomUUID(), target: end.commandId, direction: "undo" } as never
      )
    );
    expect(await active()).toHaveLength(1);
  });

  it("writes one change-log row per record and counts as the contact it is", async () => {
    const cmd = command();
    await recordDisruption(sql as never, cmd, NOW);
    const logged = await sql<
      { entity_type: string; operation: string }[]
    >`SELECT entity_type, operation FROM write_rows WHERE write_id=${cmd.commandId}`;
    expect(logged).toEqual([{ entity_type: "pulse_disruption", operation: "record_disruption" }]);
    const header = await sql<{ command_type: string }[]>`SELECT command_type FROM writes WHERE id=${cmd.commandId}`;
    expect(header[0]!.command_type).toBe("record_disruption");
  });

  it("waits for the recorder's per-user lock before it reads the pulse", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => (locked = resolve));
    // A recorder pass in flight: it holds the advisory lock for the length of its transaction.
    const tick = sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`pulse_recorder:${userId}`}, 0))`;
      locked();
      await held;
    });
    await lockTaken;
    let finished = false;
    const done = recordDisruption(sql as never, command(), NOW).then(() => (finished = true));
    await waitUntilBlocked(sql);
    expect(finished).toBe(false);
    release();
    await tick;
    await done;
    expect(finished).toBe(true);
    expect(await active()).toHaveLength(1);
  });

  it("is refused if the pulse lapses while it waits for the lock", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => (locked = resolve));
    const tick = sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`pulse_recorder:${userId}`}, 0))`;
      await tx`UPDATE pulse_segments SET reason='lapsed' WHERE user_id=${userId} AND ended_at IS NULL`;
      locked();
      await held;
    });
    await lockTaken;
    const outcome = recordDisruption(sql as never, command(), NOW).catch((error) => error);
    await waitUntilBlocked(sql);
    release();
    await tick;
    expect(await outcome).toBeInstanceOf(CommandConflictError);
    expect(await rows()).toHaveLength(0);
  });

  it("allows only one open disruption per user in the table itself", async () => {
    await recordDisruption(sql as never, command(), NOW);
    await expect(
      sql`INSERT INTO pulse_disruptions (user_id,doing,until,location_id,contexts,exclusive,recorded_by)
        VALUES (${userId},'x',${new Date(NOW.getTime() + 60_000)},'home',${sql.json(["phone"] as never)},true,'person')`
    ).rejects.toMatchObject({ code: "23505" });
  });
});
