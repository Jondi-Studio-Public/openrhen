import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import {
  CLOSE_BUDGET_LIMIT,
  RECURRENCE_ENDED_REASON,
  isClosedStatus,
  type CloseEntityCommand,
  type ImportRecord,
  type SaveCommitmentRecurrenceRuleCommand
} from "@openrhen/contracts";
import { integrationDatabaseName, persistDerivedState } from "@openrhen/database";
import { runWithActor } from "@/server/agent-actor";
import { closeEntity, previewClose } from "./close-commands";
import { closedInWindow } from "./close-budget";
import { stableUuid } from "./command-values";
import { ensureUser } from "./ensure-user";
import { endCommitmentRecurrenceRule } from "./imports/upserts";
import { saveCommitmentRecurrenceRule } from "./recurrence-commands";
import { runRevertCommand } from "./write-revert";

/**
 * Ending a recurrence rule closes its future occurrences instead of deleting them (archive-removals design section 7,
 * PR 7b): one shared batch with the reason "Recurrence ended", stamped with the real closer, their pending and blocked steps
 * cancelled and recorded on one ledger row on the rule; the planner never prunes or reopens a closed row; setting the rule
 * active again restores only that end's future rows and revives their steps; one occurrence restores on its own.
 * Self-contained `_test` database.
 */
config({ path: resolve(process.cwd(), "../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(
  process.env.RECURRENCE_END_TEST_DATABASE_NAME,
  "openrhen_recurrence_end"
);
if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) throw new Error("test database name must end in _test");
const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let userId: string;
let ruleId: string;

const asPerson = <T>(run: () => Promise<T>) => runWithActor(null, run);
const asAgent = <T>(run: () => Promise<T>, agent = "claude") => runWithActor(agent, run);
const asConfirmedAgent = <T>(run: () => Promise<T>, agent = "claude") => runWithActor(agent, run, "owner");
const DAY = 86_400_000;

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
    "TRUNCATE TABLE writes, write_rows, jobs, sessions, routine_steps, commitment_recurrence_rules, commitments, planning_runs RESTART IDENTITY CASCADE"
  );
  userId = await ensureUser(sql);
  await sql`INSERT INTO user_preferences (user_id) VALUES (${userId}) ON CONFLICT DO NOTHING`;
  await sql`UPDATE user_preferences SET home_location_id = NULL WHERE user_id = ${userId}`;
});

afterAll(async () => {
  await sql?.end();
});

// ---- seeding ----

const ruleBody = (status: "active" | "ended" = "active"): SaveCommitmentRecurrenceRuleCommand["rule"] => ({
  id: "college-class",
  title: "College Class",
  timezone: "Australia/Sydney",
  startDate: "2026-09-01",
  repeat: { unit: "days", intervalDays: 7 },
  localStartTime: "08:00",
  localEndTime: "16:00",
  setupBeforeMinutes: 0,
  transitionAfterMinutes: 0,
  status
});

// The dates with a started step count as under way, which a series save must be told how to treat.
const withInProgress = { applyToOccurrenceInProgress: true };

async function ruleVersion(): Promise<number> {
  return (await sql<{ version: number }[]>`SELECT version FROM commitment_recurrence_rules WHERE id=${ruleId}`)[0]!
    .version;
}

async function createRule() {
  await asPerson(() =>
    saveCommitmentRecurrenceRule(sql, {
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      rule: ruleBody()
    } as SaveCommitmentRecurrenceRuleCommand)
  );
  ruleId = await stableUuid(`commitment-recurrence:${userId}`, "college-class");
}

const setStatus =
  (status: "active" | "ended", run: <T>(work: () => Promise<T>) => Promise<T> = asPerson) =>
  async () =>
    run(async () =>
      saveCommitmentRecurrenceRule(sql, {
        commandId: crypto.randomUUID(),
        expectedVersion: await ruleVersion(),
        rule: ruleBody(status),
        ...withInProgress
      } as SaveCommitmentRecurrenceRuleCommand)
    );

/** An occurrence `days` from now (negative: in the past). */
async function occurrence(days: number, status = "confirmed"): Promise<string> {
  const starts = new Date(Date.now() + days * DAY);
  const rows = await sql<{ id: string }[]>`
    INSERT INTO commitments (user_id,title,starts_at,ends_at,status,recurrence_rule_id,local_date)
    VALUES (${userId},'College Class',${starts},${new Date(starts.getTime() + 3_600_000)},${status},${ruleId},${starts.toISOString().slice(0, 10)})
    RETURNING id`;
  return rows[0]!.id;
}

async function step(commitmentId: string, title: string, status = "pending"): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO routine_steps (user_id,commitment_id,anchor_id,title,duration_minutes,sequence,timing_rule,status)
    VALUES (${userId},${commitmentId},${commitmentId},${title},10,
      (SELECT COALESCE(max(sequence),0)+1 FROM routine_steps WHERE commitment_id=${commitmentId}),'contiguous',${status}) RETURNING id`;
  return rows[0]!.id;
}

const row = async (id: string) =>
  (
    await sql<
      {
        status: string;
        version: number;
        closed_by: string | null;
        closed_batch: string | null;
        closed_reason: string | null;
        closed_from_status: string | null;
      }[]
    >`SELECT status::text AS status, version, closed_by, closed_batch, closed_reason, closed_from_status FROM commitments WHERE id=${id}`
  )[0]!;
const stepRow = async (id: string) =>
  (await sql<{ status: string; version: number }[]>`SELECT status, version FROM routine_steps WHERE id=${id}`)[0]!;
const count = async (table: string) =>
  (await sql.unsafe<{ n: string }[]>(`SELECT count(*)::text AS n FROM ${table}`))[0]!.n;
const ledger = async (operation: string) =>
  sql<{ evidence: Record<string, any> }[]>`
    SELECT evidence FROM write_rows WHERE entity_type='commitment_recurrence_rule' AND entity_id=${ruleId} AND operation=${operation}
    ORDER BY created_at, id`;

/** A rule with three future dates, one past date, and steps in every state on the first future date. */
async function seed() {
  await createRule();
  const past = await occurrence(-3);
  const f1 = await occurrence(3);
  const f2 = await occurrence(10);
  const f3 = await occurrence(17);
  const steps = {
    pending: await step(f1, "Pack the bag"),
    blocked: await step(f1, "Book the room", "blocked"),
    doing: await step(f3, "Print notes", "doing"),
    done: await step(f3, "Read ahead", "completed"),
    other: await step(f2, "Pack the bag"),
    past: await step(past, "Pack the bag")
  };
  return { past, f1, f2, f3, steps };
}

// ---- ending ----

describe("ending a recurrence rule", () => {
  it("closes the future occurrences (not the past) with one batch and the reason, stamped with the person, and deletes nothing", async () => {
    const { past, f1, f2, f3, steps } = await seed();
    await sql`INSERT INTO calendar_event_links (user_id,provider,frame_id,external_event_id,commitment_id,profile_label,last_remote_hash)
      VALUES (${userId},'example_daily','frame','ext-1',${f1},'Work','h1')`;
    const before = await count("commitments");
    await setStatus("ended")();
    expect(await count("commitments")).toBe(before);
    expect(await count("calendar_event_links")).toBe("1");
    const closed = await Promise.all([f1, f2, f3].map(row));
    const batch = closed[0]!.closed_batch;
    expect(batch).not.toBeNull();
    for (const r of closed)
      expect(r).toMatchObject({
        status: "cancelled",
        closed_reason: RECURRENCE_ENDED_REASON,
        closed_by: "person",
        closed_batch: batch,
        closed_from_status: "confirmed"
      });
    expect(await row(past)).toMatchObject({ status: "confirmed", closed_batch: null, version: 1 });
    expect(closed.every((r) => r.version === 2)).toBe(true);
    // pending and blocked steps cancel; a started or finished one stays
    expect(await stepRow(steps.pending)).toMatchObject({ status: "cancelled", version: 2 });
    expect(await stepRow(steps.blocked)).toMatchObject({ status: "cancelled", version: 2 });
    expect(await stepRow(steps.other)).toMatchObject({ status: "cancelled" });
    expect(await stepRow(steps.doing)).toMatchObject({ status: "doing", version: 1 });
    expect(await stepRow(steps.done)).toMatchObject({ status: "completed", version: 1 });
    expect(await stepRow(steps.past)).toMatchObject({ status: "pending", version: 1 });
  });

  it("writes one ledger row on the rule with the step tuples", async () => {
    const { f1, f2, steps } = await seed();
    await setStatus("ended")();
    const rows = await ledger("close");
    expect(rows).toHaveLength(1);
    const evidence = rows[0]!.evidence;
    expect(evidence).toMatchObject({ closed: 1, rows: 3, via: "recurrence_end", verb: "cancel", counted: false });
    expect(evidence.batch).toBe((await row(f1)).closed_batch);
    expect(evidence.steps).toHaveLength(3);
    expect(evidence.steps).toEqual(
      expect.arrayContaining([
        [steps.pending, f1, "pending", 2],
        [steps.blocked, f1, "blocked", 2],
        [steps.other, f2, "pending", 2]
      ])
    );
  });

  it("ending a rule that is already ended is a no-op (no close, no ledger row, nothing rewritten)", async () => {
    const { f1 } = await seed();
    await setStatus("ended")();
    const stored = await row(f1);
    await setStatus("ended")();
    expect(await row(f1)).toEqual(stored);
    expect(await ledger("close")).toHaveLength(1);
  });

  it("an occurrence already cancelled keeps its own close", async () => {
    const { f1, f2 } = await seed();
    await asPerson(() =>
      closeEntity(sql, { type: "commitment", id: f1, verb: "cancel", do: "close" } as CloseEntityCommand)
    );
    const own = await row(f1);
    await setStatus("ended")();
    expect(await row(f1)).toEqual(own);
    expect((await row(f2)).closed_batch).not.toBe(own.closed_batch);
    expect((await ledger("close"))[0]!.evidence.rows).toBe(2);
  });

  it("an agent's end is stamped with the agent and counts as one closure for the brake, however many dates it closes", async () => {
    await createRule();
    const ids: string[] = [];
    for (let i = 1; i <= 60; i += 1) ids.push(await occurrence(i));
    await setStatus("ended", asAgent)();
    expect(await row(ids[0]!)).toMatchObject({ status: "cancelled", closed_by: "agent:claude" });
    expect(await row(ids[59]!)).toMatchObject({ status: "cancelled", closed_by: "agent:claude" });
    expect((await ledger("close"))[0]!.evidence).toMatchObject({ closed: 1, rows: 60, counted: true });
    expect((await closedInWindow(sql, userId)).used).toBe(1);
    // ending, restoring and ending again counts twice
    await setStatus("active", asAgent)();
    await setStatus("ended", asAgent)();
    expect((await closedInWindow(sql, userId)).used).toBe(2);
    expect(CLOSE_BUDGET_LIMIT).toBeGreaterThan(2);
  });

  it("an owner-confirmed agent end is stamped agent:<name>:confirmed and not counted", async () => {
    const { f1 } = await seed();
    await setStatus("ended", asConfirmedAgent)();
    expect((await row(f1)).closed_by).toBe("agent:claude:confirmed");
    expect((await closedInWindow(sql, userId)).used).toBe(0);
  });

  it("an import's series end closes the dates stamped system, keeps the rule row, and ending twice is a no-op", async () => {
    const { f1, f2, past } = await seed();
    const batchId = crypto.randomUUID();
    await sql`INSERT INTO writes (id,user_id,command_type,actor) VALUES (${batchId},${userId},'import_commit',NULL)`;
    const record = {
      entityType: "fixed_commitment_recurrence",
      operation: "delete",
      importKey: "series-1",
      expectedVersion: await ruleVersion()
    } as unknown as ImportRecord;
    await sql.begin((tx) => endCommitmentRecurrenceRule(tx as never, userId, ruleId, record, { batchId }));
    expect(await row(f1)).toMatchObject({
      status: "cancelled",
      closed_by: "system",
      closed_batch: batchId,
      closed_reason: RECURRENCE_ENDED_REASON
    });
    expect((await row(f2)).status).toBe("cancelled");
    expect((await row(past)).status).toBe("confirmed");
    expect(
      (await sql<{ status: string }[]>`SELECT status FROM commitment_recurrence_rules WHERE id=${ruleId}`)[0]!.status
    ).toBe("ended");
    const stored = await row(f1);
    await sql.begin((tx) =>
      endCommitmentRecurrenceRule(tx as never, userId, ruleId, { ...record, expectedVersion: 2 } as ImportRecord, {
        batchId: crypto.randomUUID()
      })
    );
    expect(await row(f1)).toEqual(stored);
    expect(await ledger("close")).toHaveLength(1);
  });
});

// ---- the planner ----

const HOUR = 3_600_000;
const derived = (id: string, startsAt: Date) => ({
  id,
  recurrenceRuleId: ruleId,
  localDate: startsAt.toISOString().slice(0, 10),
  startsAt: startsAt.toISOString(),
  endsAt: new Date(startsAt.getTime() + HOUR).toISOString(),
  title: "College Class",
  status: "confirmed",
  presence: "blocking"
});
const replan = (repeats: unknown[], at = new Date()) =>
  persistDerivedState(sql, userId, {
    inputVersion: "v1",
    calculatedAt: at.toISOString(),
    derivedState: { sleepPlans: [], occurrences: [], routineSteps: [], commitmentRepeats: repeats }
  } as never);

describe("the planner and a closed occurrence", () => {
  it("end a rule then replan twice: the closed rows survive, none are added or reopened", async () => {
    const { f1, f2, f3 } = await seed();
    await setStatus("ended")();
    const before = await sql<{ id: string }[]>`SELECT id FROM commitments ORDER BY id`;
    await replan([]);
    await replan([]);
    expect(await sql<{ id: string }[]>`SELECT id FROM commitments ORDER BY id`).toEqual(before);
    for (const id of [f1, f2, f3]) expect((await row(id)).status).toBe("cancelled");
  });

  it("(guard) the planner's upsert does not reopen a closed occurrence a live rule still derives", async () => {
    const { f1 } = await seed();
    await asPerson(() =>
      closeEntity(sql, { type: "commitment", id: f1, verb: "cancel", do: "close" } as CloseEntityCommand)
    );
    const starts = (await sql<{ starts_at: Date }[]>`SELECT starts_at FROM commitments WHERE id=${f1}`)[0]!.starts_at;
    await replan([derived(f1, starts)]);
    await replan([derived(f1, starts)]);
    expect(await row(f1)).toMatchObject({ status: "cancelled", closed_by: "person" });
  });

  it("a live rule edited off a date still prunes that open row, never a cancelled one", async () => {
    const { f1, f2 } = await seed();
    const open = await occurrence(24);
    await asPerson(() =>
      closeEntity(sql, { type: "commitment", id: f2, verb: "cancel", do: "close" } as CloseEntityCommand)
    );
    const starts = (await sql<{ starts_at: Date }[]>`SELECT starts_at FROM commitments WHERE id=${f1}`)[0]!.starts_at;
    await replan([derived(f1, starts)]);
    expect(await sql`SELECT 1 FROM commitments WHERE id=${open}`).toHaveLength(0);
    expect((await row(f2)).status).toBe("cancelled");
    expect((await row(f1)).status).toBe("confirmed");
  });
});

// ---- re-activation ----

describe("setting an ended rule active again", () => {
  it("restores the future occurrences that end closed, reviving their steps to the status they had, with versions bumped", async () => {
    const { past, f1, f2, f3, steps } = await seed();
    await setStatus("ended")();
    await setStatus("active")();
    for (const id of [f1, f2, f3])
      expect(await row(id)).toMatchObject({
        status: "confirmed",
        closed_by: null,
        closed_batch: null,
        closed_reason: null,
        version: 3
      });
    expect(await row(past)).toMatchObject({ status: "confirmed", version: 1 });
    expect(await stepRow(steps.pending)).toMatchObject({ status: "pending", version: 3 });
    // a blocked step returns blocked, not pending
    expect(await stepRow(steps.blocked)).toMatchObject({ status: "blocked", version: 3 });
    expect(await stepRow(steps.other)).toMatchObject({ status: "pending", version: 3 });
    expect(await stepRow(steps.doing)).toMatchObject({ status: "doing", version: 1 });
    const restore = await ledger("restore");
    expect(restore).toHaveLength(1);
    expect(restore[0]!.evidence).toMatchObject({ rows: 3, steps: 3, via: "recurrence_reactivate" });
  });

  it("leaves a past occurrence closed by that end and every occurrence closed another way", async () => {
    const { f1, f2, f3 } = await seed();
    await asPerson(() =>
      closeEntity(sql, { type: "commitment", id: f1, verb: "cancel", do: "close" } as CloseEntityCommand)
    );
    await asAgent(() =>
      closeEntity(sql, {
        type: "commitment",
        id: f2,
        verb: "cancel",
        do: "close",
        reason: "holiday"
      } as CloseEntityCommand)
    );
    const personOwn = await row(f1);
    const agentOwn = await row(f2);
    await setStatus("ended")();
    // a date that slipped into the past before the rule came back
    await sql`UPDATE commitments SET starts_at=now() - interval '1 hour', ends_at=now() WHERE id=${f3}`;
    await setStatus("active")();
    expect(await row(f1)).toEqual(personOwn);
    expect(await row(f2)).toEqual(agentOwn);
    expect((await row(f3)).status).toBe("cancelled");
  });

  it("end, re-activate, end again makes a new batch and re-activation restores only the newer one", async () => {
    const { f1, f2, f3 } = await seed();
    await setStatus("ended")();
    const first = (await row(f1)).closed_batch;
    await setStatus("active")();
    // a stale row from some earlier end of the same rule, still closed
    const stale = await occurrence(24, "cancelled");
    await sql`UPDATE commitments SET closed_batch=${crypto.randomUUID()}, closed_reason=${RECURRENCE_ENDED_REASON} WHERE id=${stale}`;
    await setStatus("ended")();
    const second = (await row(f1)).closed_batch;
    expect(second).not.toBe(first);
    expect((await ledger("close")).map((r) => r.evidence.batch)).toEqual([first, second]);
    await setStatus("active")();
    for (const id of [f1, f2, f3]) expect((await row(id)).status).toBe("confirmed");
    expect((await row(stale)).status).toBe("cancelled");
  });

  it("an agent may set a person-ended rule active again", async () => {
    const { f1 } = await seed();
    await setStatus("ended")();
    await setStatus("active", asAgent)();
    expect((await row(f1)).status).toBe("confirmed");
  });

  it("falls back to pending for a step the tuples do not cover (changed since the end)", async () => {
    const { f1, steps } = await seed();
    await setStatus("ended")();
    await sql`UPDATE routine_steps SET version=version+1 WHERE id=${steps.blocked}`;
    await setStatus("active")();
    expect(await row(f1)).toMatchObject({ status: "confirmed" });
    expect(await stepRow(steps.blocked)).toMatchObject({ status: "pending", version: 4 });
  });

  it("an agent's undo of a rule end puts the close-era state back (status, closed_*, steps) and a redo ends it again", async () => {
    const { f1, steps } = await seed();
    const before = { occurrence: await row(f1), pending: await stepRow(steps.pending) };
    const commandId = crypto.randomUUID();
    await asAgent(async () =>
      saveCommitmentRecurrenceRule(sql, {
        commandId,
        expectedVersion: await ruleVersion(),
        rule: ruleBody("ended"),
        ...withInProgress
      } as SaveCommitmentRecurrenceRuleCommand)
    );
    expect((await row(f1)).status).toBe("cancelled");
    await asAgent(() =>
      runRevertCommand(sql, { commandId: crypto.randomUUID(), target: commandId, direction: "undo" })
    );
    expect(await row(f1)).toMatchObject({
      status: "confirmed",
      closed_by: null,
      closed_batch: null,
      closed_reason: null,
      closed_from_status: null
    });
    expect(await stepRow(steps.pending)).toMatchObject({ status: before.pending.status });
    await asAgent(() =>
      runRevertCommand(sql, { commandId: crypto.randomUUID(), target: commandId, direction: "redo" })
    );
    expect((await row(f1)).status).toBe("cancelled");
    expect((await stepRow(steps.pending)).status).toBe("cancelled");
  });
});

// ---- one occurrence ----

describe("restoring one occurrence of an ended rule", () => {
  it("brings back that occurrence and only its own steps, from the rule's tuples", async () => {
    const { f1, f2, steps } = await seed();
    await setStatus("ended")();
    const stored = await row(f1);
    const result = await asPerson(() =>
      closeEntity(sql, {
        type: "commitment",
        id: f1,
        verb: "cancel",
        do: "restore",
        expectedVersion: stored.version
      } as CloseEntityCommand)
    );
    expect(result.closed.skipped).toEqual([]);
    expect((await row(f1)).status).toBe("confirmed");
    expect(await stepRow(steps.pending)).toMatchObject({ status: "pending" });
    expect(await stepRow(steps.blocked)).toMatchObject({ status: "blocked" });
    // the other date and its step stay closed
    expect((await row(f2)).status).toBe("cancelled");
    expect((await stepRow(steps.other)).status).toBe("cancelled");
  });

  it("an agent restoring an occurrence of a person-ended rule is not the closer (the route files a proposal); the agent's own end is its to restore", async () => {
    const { f1 } = await seed();
    await setStatus("ended")();
    const byPerson = await previewClose(sql, {
      type: "commitment",
      id: f1,
      verb: "cancel",
      do: "restore"
    } as CloseEntityCommand);
    expect(byPerson.closedBy).toBe("person");
    expect(isClosedStatus(byPerson.status)).toBe(true);
    await setStatus("active")();
    await setStatus("ended", asAgent)();
    const byAgent = await previewClose(sql, {
      type: "commitment",
      id: f1,
      verb: "cancel",
      do: "restore"
    } as CloseEntityCommand);
    expect(byAgent.closedBy).toBe("agent:claude");
  });
});
