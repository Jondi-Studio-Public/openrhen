import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import { integrationDatabaseName } from "@openrhen/database";
import { FACT_CLOSINGS_PER_HOUR, FACT_WRITES_PER_HOUR, locateEvidence } from "@openrhen/communication-readers";
import { ingestActivityEvents } from "./activity-store";
import { runWithActor } from "@/server/agent-actor";
import { listAgentChangesPage } from "./agent-changes";
import { lockActivityUser } from "./activity-lock";
import { CommandIdReusedError, ForbiddenCommandError } from "./command-errors";
import { ensureUser } from "./ensure-user";
import { FACT_CALLS_PER_HOUR, actOnFact, resetFactCallLog, type FactActOutcome } from "./fact-act-store";
import { clearFactListingCache, readFactListing } from "./fact-listing-store";
import { ensureExtractorStateTx } from "./extractor-state-store";
import { readOpenFacts } from "./open-facts-store";
import { SNAPSHOT_LIMIT } from "./write-snapshot";
import { runRevertCommand } from "./write-revert";

/**
 * Mark's marks on open mail facts against a real database (slice 2b-9): the write path (lock, receipt, rows, ledger),
 * attribution, replay, the owner's word, the rate limits, undo through the write ledger, and the races.
 */
config({ path: resolve(process.cwd(), "../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(process.env.TEST_DATABASE_NAME, "openrhen_fact_act");
if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) throw new Error("TEST_DATABASE_NAME must end in _test");
const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let userId: string;

const DAY = 86_400_000;
const NOW = new Date();
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);
const ahead = (days: number) => new Date(NOW.getTime() + days * DAY);
const fid = (name: string) => name.padEnd(40, "0").replace(/[^0-9a-f]/g, "a");
const STATED = { basis: "stated", evidence: "Jondi said it is handled" } as const;
const MARK = "mark";

interface Seed {
  name: string;
  tsStart?: Date;
  type?: string;
  when?: { start: string; end?: string } | null;
  thread?: string;
}

async function seedFact(item: Seed): Promise<void> {
  const tsStart = item.tsStart ?? ago(1);
  const attrs = {
    source_event_id: `msg-${item.name}`,
    fact_id: fid(item.name),
    fact_type: item.type ?? "ask",
    direction: "in",
    conversation_key: `gmail:${item.thread ?? `th-${item.name}`}`,
    extractor: "fact-llm",
    extractor_version: "1",
    tier: "t0",
    who: ["pat@example.test"],
    ...(item.when ? { when: { ambiguous: false, candidates: [item.when] } } : {})
  };
  await sql`
    INSERT INTO activity_events (user_id, source, kind, event_key, ts_start, attrs, ingested_at)
    VALUES (${userId}, 'derived', 'fact', ${`fact-${item.name}`}, ${tsStart}, ${sql.json(attrs as never)}, ${tsStart})`;
}

async function seedReply(thread: string, at: Date): Promise<void> {
  await sql`
    INSERT INTO activity_events (user_id, source, kind, event_key, ts_start, attrs, ingested_at)
    VALUES (${userId}, 'gmail', 'message', ${`reply-${thread}-${at.getTime()}`}, ${at}, ${sql.json({ thread_id: thread, from_self: "true" } as never)}, ${at})`;
}

/** A raw status row as the owner posts it: no `ingested_via`, a valid_from of their choosing. */
async function ownerStatus(
  name: string,
  status: string,
  validFrom: Date,
  ingestedAt: Date = new Date()
): Promise<void> {
  await sql`
    INSERT INTO activity_events (user_id, source, kind, event_key, ts_start, attrs, ingested_via, ingested_at)
    VALUES (${userId}, 'derived', 'fact_status', ${`owner-${name}-${status}-${validFrom.getTime()}`}, ${validFrom},
      ${sql.json({ fact_id: fid(name), status, valid_from: validFrom.toISOString() } as never)}, ${null}, ${ingestedAt})`;
}

const act = (
  action: string,
  name: string,
  over: {
    set?: Record<string, unknown>;
    basis?: string;
    evidence?: string;
    agent?: string;
    commandId?: string;
    dryRun?: boolean;
  } = {}
): Promise<FactActOutcome> =>
  runWithActor(over.agent ?? MARK, () =>
    actOnFact(sql, over.agent ?? MARK, {
      action,
      factId: fid(name),
      set: over.set ?? {},
      basis: over.basis,
      evidence: over.evidence,
      commandId: over.commandId ?? crypto.randomUUID(),
      dryRun: over.dryRun ?? false
    })
  );
const closeIt = (name: string, over: Parameters<typeof act>[2] = {}) => act("done", name, { ...STATED, ...over });
const refused = (outcome: FactActOutcome) => {
  if (outcome.ok) throw new Error(`expected a refusal, got: ${outcome.message}`);
  return outcome;
};
const done = (outcome: FactActOutcome) => {
  if (!outcome.ok) throw new Error(`expected success, got ${outcome.code}: ${outcome.message}`);
  return outcome;
};
const open = async () => (await readOpenFacts(sql, { now: NOW, limit: 200 })).facts.map((f) => f.factId);
const derived = (kind: string) =>
  sql<{ ingested_via: string | null; attrs: Record<string, unknown>; event_key: string }[]>`
    SELECT ingested_via, attrs, event_key FROM activity_events
    WHERE user_id = ${userId} AND source = 'derived' AND kind = ${kind} ORDER BY ingested_at, id`;

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
  sql = postgres(testUrl.toString(), { max: 10, connect_timeout: 10, fetch_types: false });
}, 60_000);

beforeEach(async () => {
  resetFactCallLog();
  clearFactListingCache();
  await sql.unsafe("TRUNCATE TABLE users RESTART IDENTITY CASCADE");
  userId = await ensureUser(sql);
  await sql.begin((tx) => ensureExtractorStateTx(tx, userId, "fact-llm", "1", NOW));
});

afterAll(async () => {
  await sql?.end();
});

describe("the write", () => {
  it("stores the mark as the authenticated agent's derived row, with the act, the basis and the owner's words, and no `by`", async () => {
    await seedFact({ name: "a1" });
    const outcome = done(await closeIt("a1"));
    expect(outcome.message).toContain("Marked the ask a1");
    expect(await open()).toEqual([]);
    const [row] = await derived("fact_status");
    expect(row).toMatchObject({
      ingested_via: MARK,
      attrs: { fact_id: fid("a1"), status: "done", act: "done", basis: "stated", evidence: STATED.evidence }
    });
    expect("by" in row!.attrs).toBe(false);
  });

  it("records another agent under its own name, and null is never what an agent route writes", async () => {
    await seedFact({ name: "a1" });
    await closeIt("a1", { agent: "companion" });
    expect((await derived("fact_status"))[0]!.ingested_via).toBe("companion");
  });

  it("shows in the owner's Agent changes list with a plain label and the agent's name", async () => {
    await seedFact({ name: "a1" });
    const commandId = crypto.randomUUID();
    await closeIt("a1", { commandId });
    const page = await listAgentChangesPage(sql);
    expect(page.changes).toHaveLength(1);
    expect(page.changes[0]).toMatchObject({
      agent: MARK,
      id: commandId,
      status: "applied"
    });
    expect(page.changes[0]!.label).toContain("Marked a mail item done");
  });

  it("undo from the owner's list deletes the derived row and the fact is open again; redo puts it back", async () => {
    await seedFact({ name: "a1" });
    const commandId = crypto.randomUUID();
    await closeIt("a1", { commandId });
    expect(await open()).toEqual([]);
    await runWithActor(null, () =>
      runRevertCommand(sql, { commandId: crypto.randomUUID(), target: commandId, direction: "undo" })
    );
    expect(await derived("fact_status")).toHaveLength(0);
    expect(await open()).toEqual([fid("a1")]);
    expect((await listAgentChangesPage(sql)).changes[0]!.status).toBe("undone");
    await runWithActor(null, () =>
      runRevertCommand(sql, { commandId: crypto.randomUUID(), target: commandId, direction: "redo" })
    );
    expect(await derived("fact_status")).toHaveLength(1);
    expect(await open()).toEqual([]);
  });

  it("the agent's own rhen_undo path (the revert command as that agent) also reverses it", async () => {
    await seedFact({ name: "a1" });
    const commandId = crypto.randomUUID();
    await closeIt("a1", { commandId });
    await runWithActor(MARK, () =>
      runRevertCommand(sql, { commandId: crypto.randomUUID(), target: commandId, direction: "undo" })
    );
    expect(await open()).toEqual([fid("a1")]);
  });

  it("an undo of a redate restores the extractor's time, no reopen needed", async () => {
    const start = ahead(5).toISOString();
    await seedFact({ name: "e1", type: "event", when: { start } });
    const commandId = crypto.randomUUID();
    done(await act("redate", "e1", { ...STATED, commandId, set: { when: ahead(9).toISOString() } }));
    expect((await readOpenFacts(sql, { now: NOW })).facts[0]!.dueAt).toBe(ahead(9).toISOString());
    await runWithActor(null, () =>
      runRevertCommand(sql, { commandId: crypto.randomUUID(), target: commandId, direction: "undo" })
    );
    expect((await readOpenFacts(sql, { now: NOW })).facts[0]!.dueAt).toBe(start);
  });

  it("a refusal leaves nothing behind: no row, no ledger entry, and a repeat is judged again", async () => {
    await seedFact({ name: "a1" });
    const noWords = refused(await act("done", "a1"));
    expect(noWords.code).toBe("needs_stated");
    expect(await derived("fact_status")).toHaveLength(0);
    expect((await listAgentChangesPage(sql)).changes).toHaveLength(0);
    const [receipts] = await sql<{ count: string }[]>`SELECT count(*)::text FROM writes WHERE user_id = ${userId}`;
    expect(receipts?.count).toBe("0");
  });

  it("refuses an unknown action, a bad id and an unknown fact without touching the database state", async () => {
    await seedFact({ name: "a1" });
    expect(refused(await act("hold", "a1", STATED)).code).toBe("unknown_action");
    expect(
      refused(
        await runWithActor(MARK, () =>
          actOnFact(sql, MARK, {
            action: "done",
            factId: "nope",
            set: {},
            commandId: crypto.randomUUID(),
            dryRun: false,
            ...STATED
          })
        )
      ).code
    ).toBe("bad_id");
    expect(refused(await closeIt("ff")).code).toBe("not_found");
    expect(await derived("fact_status")).toHaveLength(0);
  });
});

describe("replay and the same statement twice", () => {
  it("the same command id with the same payload stores once and answers that it already did", async () => {
    await seedFact({ name: "a1" });
    const commandId = crypto.randomUUID();
    const first = done(await closeIt("a1", { commandId }));
    const second = done(await closeIt("a1", { commandId }));
    expect(second.replay).toBe(true);
    expect(second.message).toContain("Already recorded");
    expect(second.message).toContain(first.message);
    expect(await derived("fact_status")).toHaveLength(1);
  });

  it("a retried confirm does not extend the hold again, and a retried reopen is not refused as 'no mark'", async () => {
    await seedFact({ name: "a1", tsStart: ago(13) });
    const hold = crypto.randomUUID();
    done(await act("confirm", "a1", { commandId: hold }));
    done(await act("confirm", "a1", { commandId: hold }));
    expect(await derived("fact_status")).toHaveLength(1);
    const back = crypto.randomUUID();
    done(await act("reopen", "a1", { commandId: back }));
    expect(done(await act("reopen", "a1", { commandId: back })).replay).toBe(true);
  });

  it("the same command id with a different payload is refused as a reuse", async () => {
    await seedFact({ name: "a1" });
    await seedFact({ name: "a2" });
    const commandId = crypto.randomUUID();
    await closeIt("a1", { commandId });
    await expect(closeIt("a2", { commandId })).rejects.toBeInstanceOf(CommandIdReusedError);
  });

  it("two identical calls at once store one row", async () => {
    await seedFact({ name: "a1" });
    const commandId = crypto.randomUUID();
    const [x, y] = await Promise.all([closeIt("a1", { commandId }), closeIt("a1", { commandId })]);
    expect([x, y].every((o) => o.ok)).toBe(true);
    expect(await derived("fact_status")).toHaveLength(1);
  });

  it("a dry run reads the live item, writes nothing and is not counted", async () => {
    await seedFact({ name: "a1" });
    for (let i = 0; i < 8; i += 1) {
      const outcome = done(await closeIt("a1", { dryRun: true }));
      expect(outcome.dryRun).toBe(true);
      expect(outcome.message).toContain("Dry run");
    }
    expect(await derived("fact_status")).toHaveLength(0);
    expect((await listAgentChangesPage(sql)).changes).toHaveLength(0);
    expect(refused(await act("done", "a1", { dryRun: true })).code).toBe("needs_stated");
    done(await closeIt("a1"));
  });
});

describe("what a later mail does", () => {
  it("the same ask coming up again reopens a done fact; a different sentence is a different fact and leaves it closed", async () => {
    await seedFact({ name: "a1", tsStart: ago(2) });
    done(await closeIt("a1"));
    expect(await open()).toEqual([]);
    // A different ask in the same conversation: a different fact id. The first stays closed.
    await seedFact({ name: "a2", tsStart: ago(0.5), thread: "th-a1" });
    expect(await open()).toEqual([fid("a2")]);
    // The same sentence again (same fact id, later message): reopened.
    await sql`
      INSERT INTO activity_events (user_id, source, kind, event_key, ts_start, attrs, ingested_at)
      SELECT user_id, source, kind, 'fact-a1-again', ${new Date(Date.now() + 1000)}, attrs, ${new Date(Date.now() + 1000)}
      FROM activity_events WHERE user_id = ${userId} AND event_key = 'fact-a1'`;
    const reopened = await readOpenFacts(sql, { now: new Date(Date.now() + 2000), limit: 200 });
    expect(reopened.facts.map((f) => f.factId).sort()).toEqual([fid("a1"), fid("a2")].sort());
  });
});

describe("the owner's word", () => {
  it("a mark after the owner's status is refused, and the owner's status recorded after Mark's wins whatever its valid_from (B5)", async () => {
    await seedFact({ name: "a1" });
    await seedFact({ name: "a2" });
    await ownerStatus("a1", "confirmed", new Date(Date.now() - 60_000));
    expect(refused(await closeIt("a1")).code).toBe("owner_decided");
    expect(refused(await act("reopen", "a1")).code).toBe("owner_decided");

    done(await closeIt("a2"));
    expect(await open()).toEqual([fid("a1")]);
    // The owner keeps it a moment later, dating the statement to when the mail arrived (older than Mark's done).
    await ownerStatus("a2", "confirmed", ago(0.9), new Date(Date.now() + 5));
    expect((await open()).sort()).toEqual([fid("a1"), fid("a2")].sort());
  });

  it("an owner write that lands while the mark waits for the lock is read under the lock and wins", async () => {
    await seedFact({ name: "a1" });
    const holder = sql.begin(async (tx) => {
      await lockActivityUser(tx, userId);
      await new Promise((resolveWait) => setTimeout(resolveWait, 600));
      // The owner's raw write takes no lock and commits first.
      await ownerStatus("a1", "confirmed", new Date(Date.now() - 1000));
    });
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
    const waiting = closeIt("a1");
    await holder;
    expect(refused(await waiting).code).toBe("owner_decided");
    expect(await derived("fact_status")).toHaveLength(1);
  });

  it("a fact removed while the mark waited (a source purge holds the lock) is not found, and nothing is written", async () => {
    await seedFact({ name: "a1" });
    const purge = sql.begin(async (tx) => {
      await lockActivityUser(tx, userId);
      await new Promise((resolveWait) => setTimeout(resolveWait, 500));
      await tx`DELETE FROM activity_events WHERE user_id = ${userId} AND kind = 'fact'`;
    });
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
    const waiting = closeIt("a1");
    await purge;
    expect(refused(await waiting).code).toBe("not_found");
    expect(await derived("fact_status")).toHaveLength(0);
  });

  it("an extractor's source_gone fact cannot be reopened by Mark", async () => {
    await seedFact({ name: "a1" });
    await sql`
      INSERT INTO activity_events (user_id, source, kind, event_key, ts_start, attrs, ingested_via, ingested_at)
      VALUES (${userId}, 'derived', 'fact_status', 'gone', ${new Date()}, ${sql.json({ fact_id: fid("a1"), status: "source_gone", valid_from: new Date().toISOString() } as never)}, 'extractor:retention', now())`;
    expect(refused(await act("reopen", "a1")).code).toBe("no_mark");
  });

  it("does not reopen an ask the owner answered after Mark's done", async () => {
    await seedFact({ name: "a1", tsStart: ago(2), thread: "t-reply" });
    done(await closeIt("a1"));
    await seedReply("t-reply", new Date(Date.now() - 30 * 60_000));
    const outcome = refused(await act("reopen", "a1"));
    expect(outcome.code).toBe("answered");
    expect(await open()).toEqual([]);
  });
});

describe("limits", () => {
  it("refuses the sixth closing in an hour and counts per agent", async () => {
    for (let i = 0; i < FACT_CLOSINGS_PER_HOUR + 1; i += 1) await seedFact({ name: `r${i}` });
    for (let i = 0; i < FACT_CLOSINGS_PER_HOUR; i += 1) done(await closeIt(`r${i}`));
    const sixth = refused(await closeIt(`r${FACT_CLOSINGS_PER_HOUR}`));
    expect(sixth.code).toBe("rate");
    expect(sixth.message).toContain("Try again after");
    done(await closeIt(`r${FACT_CLOSINGS_PER_HOUR}`, { agent: "companion" }));
    expect(await derived("fact_status")).toHaveLength(FACT_CLOSINGS_PER_HOUR + 1);
  });

  it("finds a fact beyond the 200 the listing shows", async () => {
    await sql`
      INSERT INTO activity_events (user_id, source, kind, event_key, ts_start, attrs, ingested_at)
      SELECT ${userId}, 'derived', 'fact', 'bulk-' || n, ${ago(3)}::timestamptz + (n || ' minutes')::interval,
        jsonb_build_object('source_event_id', 'm' || n, 'fact_id', lpad(to_hex(n + 4096), 40, '0'), 'fact_type', 'ask',
          'direction', 'in', 'conversation_key', 'gmail:bulk-' || n, 'extractor', 'fact-llm', 'extractor_version', '1', 'tier', 't0'),
        ${ago(3)}::timestamptz + (n || ' minutes')::interval
      FROM generate_series(1, 230) AS n`;
    const listing = await readFactListing(sql, { now: NOW, limit: 200, agent: MARK });
    expect(listing.total).toBe(230);
    expect(listing.facts).toHaveLength(200);
    const hidden = (await readOpenFacts(sql, { now: NOW, limit: 200 })).facts.map((f) => f.factId);
    const all = Array.from({ length: 230 }, (_, i) => (i + 1 + 4096).toString(16).padStart(40, "0"));
    const missing = all.find((id) => !hidden.includes(id))!;
    expect(missing).toBeDefined();
    const outcome = await runWithActor(MARK, () =>
      actOnFact(sql, MARK, {
        action: "done",
        factId: missing,
        set: {},
        commandId: crypto.randomUUID(),
        dryRun: false,
        ...STATED
      })
    );
    done(outcome);
  });

  it("answers busy and writes nothing when the lock cannot be had in 5 seconds", async () => {
    await seedFact({ name: "a1" });
    let release!: () => void;
    const held = new Promise<void>((resolveHeld) => (release = resolveHeld));
    const holder = sql.begin(async (tx) => {
      await lockActivityUser(tx, userId);
      await held;
    });
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
    const started = Date.now();
    const outcome = refused(await closeIt("a1"));
    release();
    await holder;
    expect(outcome.code).toBe("busy");
    expect(outcome.message).toContain("Wait 10 seconds");
    expect(outcome.message).toContain('rhen_inbox_act {"room":"facts","action":"done","id":"');
    expect(outcome.message).toContain('"command-id":"');
    expect(Date.now() - started).toBeGreaterThanOrEqual(4500);
    expect(await derived("fact_status")).toHaveLength(0);
    expect((await listAgentChangesPage(sql)).changes).toHaveLength(0);
    done(await closeIt("a1"));
  }, 30_000);
});

describe("the listing", () => {
  it("lists the open facts with ids, and the agent's standing marks (not limited to 7 days)", async () => {
    await seedFact({ name: "a1" });
    await seedFact({ name: "a2", tsStart: ago(40) });
    await seedFact({ name: "b1", type: "deadline", when: { start: ahead(3).toISOString() } });
    done(await closeIt("a1"));
    const listing = await readFactListing(sql, { now: NOW, agent: MARK });
    expect(listing.total).toBe(1);
    expect(listing.facts.map((f) => f.id)).toEqual([fid("b1")]);
    expect(listing.facts[0]).toMatchObject({ type: "deadline", dueAt: ahead(3).toISOString() });
    expect(listing.marks.map((m) => [m.id, m.act])).toEqual([[fid("a1"), "done"]]);
    const other = await readFactListing(sql, { now: NOW, agent: "companion" });
    expect(other.marks).toEqual([]);
  });
});

const revert = (commandId: string, direction: "undo" | "redo", agent: string | null) =>
  runWithActor(agent, () => runRevertCommand(sql, { commandId: crypto.randomUUID(), target: commandId, direction }));

describe("undo and redo cannot be used to get round the limits or the owner", () => {
  it("counts undone marks: five closings, undo, five more is refused, and an agent cannot redo", async () => {
    const names = Array.from({ length: 8 }, (_, i) => `c${i}`);
    for (const name of names) await seedFact({ name });
    const ids: string[] = [];
    for (const name of names.slice(0, FACT_CLOSINGS_PER_HOUR)) {
      const commandId = crypto.randomUUID();
      ids.push(commandId);
      done(await closeIt(name, { commandId }));
    }
    for (const commandId of ids) await revert(commandId, "undo", MARK);
    expect(await open()).toHaveLength(8);
    const sixth = refused(await closeIt("c5"));
    expect(sixth.code).toBe("rate");
    await expect(revert(ids[0]!, "redo", MARK)).rejects.toBeInstanceOf(ForbiddenCommandError);
    expect(await open()).toHaveLength(8);
  });

  it("the owner may redo, and an owner's undo is not undone by the agent", async () => {
    await seedFact({ name: "a1" });
    const commandId = crypto.randomUUID();
    done(await closeIt("a1", { commandId }));
    await revert(commandId, "undo", null);
    await expect(revert(commandId, "redo", MARK)).rejects.toThrow(/only the owner/);
    expect(await open()).toEqual([fid("a1")]);
    await revert(commandId, "redo", null);
    expect(await open()).toEqual([]);
  });

  it("limits all writes to the hourly figure, undone or not, and a hold to once a day per item", async () => {
    for (let i = 0; i < FACT_WRITES_PER_HOUR; i += 1) await seedFact({ name: `h${i}` });
    const first = crypto.randomUUID();
    done(await act("confirm", "h0", { commandId: first }));
    expect(refused(await act("confirm", "h0")).message).toContain("once a day");
    await revert(first, "undo", MARK);
    expect(refused(await act("confirm", "h0")).code).toBe("rate");
    for (let i = 1; i < FACT_WRITES_PER_HOUR; i += 1) done(await act("confirm", `h${i}`));
    expect(refused(await act("confirm", "h0", { agent: MARK })).code).toBe("rate");
  });
});

describe("what the owner reads", () => {
  it("labels the mark with the item: type, due time, short id and a sanitised quote", async () => {
    const quote = "Please send the figures by Friday";
    const content = `Hi. ${quote} Bye.`;
    const [message] = await sql<{ id: string }[]>`
      INSERT INTO activity_events (user_id, source, kind, event_key, ts_start, attrs, content)
      VALUES (${userId}, 'gmail', 'message', 'msg-d1', ${ago(1)}, ${sql.json({ thread_id: "th-d1" } as never)}, ${content})
      RETURNING id`;
    const span = locateEvidence(content, quote)!;
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO activity_events (user_id, source, kind, event_key, ts_start, attrs, ingested_at)
      VALUES (${userId}, 'derived', 'fact', 'fact-d1', ${ago(1)},
        ${sql.json({ source_event_id: "msg-d1", fact_id: fid("d1"), fact_type: "ask", direction: "in", conversation_key: "gmail:th-d1", extractor: "fact-llm", extractor_version: "1", tier: "t0", span } as never)}, ${ago(1)})
      RETURNING id`;
    await sql`INSERT INTO derived_lineage (user_id, derived_id, source_id) VALUES (${userId}, ${row!.id}, ${message!.id})`;
    done(await closeIt("d1"));
    const label = (await listAgentChangesPage(sql)).changes[0]!.label;
    expect(label).toContain("Marked a mail item done");
    expect(label).toContain("ask d1000000");
    expect(label).toContain("no due time");
    expect(label).toContain(`"${quote}"`);
    expect(label).not.toContain("extractor");
  });

  it("says so when the mail text is gone, and never shows raw attrs", async () => {
    await seedFact({ name: "a1" });
    done(await closeIt("a1"));
    const label = (await listAgentChangesPage(sql)).changes[0]!.label;
    expect(label).toContain("ask a1000000");
    expect(label).toContain("no longer available");
    expect(label).not.toContain("fact_id");
  });
});

describe("replay, the call limit and the shared listing", () => {
  it("a replay after the mark was undone says so and asks for a new command-id", async () => {
    await seedFact({ name: "a1" });
    const commandId = crypto.randomUUID();
    done(await closeIt("a1", { commandId }));
    await revert(commandId, "undo", null);
    const again = refused(await closeIt("a1", { commandId }));
    expect(again.code).toBe("undone");
    expect(again.message).toContain("new command-id");
    expect(await open()).toEqual([fid("a1")]);
  });

  it("counts refusals, not dry runs, toward a separate hourly limit, with no write", async () => {
    await seedFact({ name: "a1" });
    // A dry run is held to the limit but never counts toward it.
    for (let i = 0; i < FACT_CALLS_PER_HOUR + 5; i += 1)
      expect((await act("done", "a1", { ...STATED, dryRun: true })).ok).toBe(true);
    // A refusal (no basis) does count.
    for (let i = 0; i < FACT_CALLS_PER_HOUR; i += 1) refused(await act("done", "a1", {}));
    const over = refused(await act("done", "a1", { ...STATED }));
    expect(over.code).toBe("rate");
    expect(over.message).toContain("refusals included");
    expect(over.message).toContain('rhen_inbox {"room":"facts"}');
    expect(refused(await act("done", "a1", { ...STATED, dryRun: true })).code).toBe("rate");
    expect(await derived("fact_status")).toHaveLength(0);
    // Another agent has its own allowance.
    expect((await act("done", "a1", { ...STATED, agent: "companion", dryRun: true })).ok).toBe(true);
  }, 60_000);

  it("a dry run reads the agent's marks and says a real call would be refused, counting nothing itself", async () => {
    for (let i = 0; i < FACT_CLOSINGS_PER_HOUR + 1; i += 1) await seedFact({ name: `d${i}` });
    for (let i = 0; i < FACT_CLOSINGS_PER_HOUR; i += 1) done(await closeIt(`d${i}`));
    const last = `d${FACT_CLOSINGS_PER_HOUR}`;
    const check = refused(await closeIt(last, { dryRun: true }));
    expect(check.code).toBe("rate");
    expect(check.message).toContain("Dry run: a real call would be refused");
    expect(await derived("fact_status")).toHaveLength(FACT_CLOSINGS_PER_HOUR);
    const ledger = await sql`SELECT 1 FROM writes WHERE user_id = ${userId}`;
    expect(ledger).toHaveLength(FACT_CLOSINGS_PER_HOUR);
    // Another agent's dry run of the same close passes, and says how to make it for real.
    const other = done(await closeIt(last, { agent: "companion", dryRun: true }));
    expect(other.message).toContain('repeat the call without "dry-run"');
  });

  it("a shared listing is reused for a moment and cleared by a mark", async () => {
    await seedFact({ name: "a1" });
    const first = await readFactListing(sql, { now: NOW, agent: MARK, shared: true });
    await seedFact({ name: "a2" });
    const second = await readFactListing(sql, { now: NOW, agent: MARK, shared: true });
    expect(second).toBe(first);
    done(await closeIt("a1"));
    const third = await readFactListing(sql, { now: NOW, agent: MARK, shared: true });
    expect(third.facts.map((f) => f.id)).toEqual([fid("a2")]);
  });
});

describe("the owner's status and a mark are ordered by the commit, not by the transaction start (P7)", () => {
  it("an owner status written while a mark holds the lock waits for it and is recorded after it", async () => {
    await seedFact({ name: "a1" });
    let release!: () => void;
    const held = new Promise<void>((resolveHeld) => (release = resolveHeld));
    const markTx = sql.begin(async (tx) => {
      await lockActivityUser(tx, userId);
      await held;
    });
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    let finished = false;
    const owner = ingestActivityEvents(
      sql,
      {
        events: [
          {
            id: "own-1",
            source: "derived",
            kind: "fact_status",
            start: ago(3).toISOString(),
            attrs: { fact_id: fid("a1"), status: "cancelled", valid_from: ago(3).toISOString() }
          }
        ]
      } as never,
      null
    ).then((result) => {
      finished = true;
      return result;
    });
    await new Promise((resolveWait) => setTimeout(resolveWait, 300));
    expect(finished).toBe(false);
    const releasedAt = new Date();
    release();
    await markTx;
    await owner;
    const [row] = await sql<{ ingested_at: Date }[]>`
      SELECT ingested_at FROM activity_events WHERE user_id = ${userId} AND kind = 'fact_status'`;
    expect(row!.ingested_at.getTime()).toBeGreaterThanOrEqual(releasedAt.getTime() - 5);
  });

  it("the owner's later-recorded status wins over an earlier mark even with an older valid_from", async () => {
    await seedFact({ name: "a1", tsStart: ago(10) });
    done(await act("confirm", "a1"));
    await ingestActivityEvents(
      sql,
      {
        events: [
          {
            id: "own-2",
            source: "derived",
            kind: "fact_status",
            start: ago(3).toISOString(),
            attrs: { fact_id: fid("a1"), status: "cancelled", valid_from: ago(3).toISOString() }
          }
        ]
      } as never,
      null
    );
    expect(await open()).toEqual([]);
  });
});

describe("retention of marks", () => {
  it("a mark's undo is not pushed out by ordinary agent writes beyond the 500 cap", async () => {
    await seedFact({ name: "a1" });
    await seedFact({ name: "a2" });
    const first = crypto.randomUUID();
    done(await closeIt("a1", { commandId: first }));
    await sql`
      INSERT INTO writes (id, user_id, command_type, actor, kind, images, state, created_at)
      SELECT gen_random_uuid(), ${userId}, 'check_in', 'openclaw', 'check_in', '[]'::jsonb, 'applied', now() + make_interval(mins => n)
      FROM generate_series(1, ${SNAPSHOT_LIMIT + 20}) AS n`;
    done(await closeIt("a2"));
    expect(
      await sql`SELECT 1 FROM writes WHERE id = ${first} AND images IS NOT NULL AND state = 'applied'`
    ).toHaveLength(1);
    await revert(first, "undo", null);
    expect(await open()).toContain(fid("a1"));
  });
});
