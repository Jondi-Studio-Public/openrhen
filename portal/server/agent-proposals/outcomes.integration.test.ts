import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { fileURLToPath } from "node:url";
import { integrationDatabaseName } from "@openrhen/database";
import { attentionCursor } from "@openrhen/contracts";
import { ensureUser } from "@/server/persistence/postgres/ensure-user";
import { queueCatchUpNudge, readCatchUpDue, readCatchUpLedger } from "@/server/persistence/postgres/catch-up";
import {
  countDecidedOutcomes,
  readDecidedCount,
  readDecidedWindowStart,
  readProposalOutcomes,
  outcomeTarget
} from "./outcomes";
import { expireOld } from "./store";

/**
 * The persistence half of the agent attention feed (the design notes, 7, 9): the
 * outcome query, the decided window and count, a read-only catch-up due check. Own `_test` database, as the doctor
 * suites do.
 */
config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(
  process.env.ATTENTION_PERSIST_TEST_DATABASE_NAME,
  "openrhen_attention_persist"
);

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("ATTENTION_PERSIST_TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let userId: string;

interface Made {
  agent?: string;
  status?: "pending" | "confirmed" | "rejected" | "expired" | "stale";
  shadow?: boolean;
  /** Postgres interval text: how long ago the row was created. */
  createdAgo?: string;
  /** How long ago it was resolved (confirmed, rejected, stale, or an expiry stamp). */
  resolvedAgo?: string;
  coalesceKey?: string | null;
  kind?: string;
  /** Entity keys the applier would have derived, such as `project:<id>`. */
  targets?: string[];
  note?: string;
}

/** Inserts a proposal row exactly as given (dates relative to the database clock). */
async function make(made: Made = {}): Promise<string> {
  const id = crypto.randomUUID();
  const status = made.status ?? "pending";
  const targets = Object.fromEntries((made.targets ?? []).map((key) => [key, 1]));
  await sql`
    INSERT INTO agent_proposals (id, user_id, agent, kind, summary, payload, payload_hash, basis, target_versions, status, coalesce_key, shadow, created_at, updated_at, resolved_at, resolved_by, resolution_note)
    VALUES (${id}, ${userId}, ${made.agent ?? "scribe"}, ${made.kind ?? "entity_command"}, 'Rename a project', ${sql.json({ command: "save_project", body: { project: { id: made.targets?.[0]?.split(":")[1] ?? id } } } as never)}, ${id}, 'inferred',
      ${sql.json(targets as never)}, ${status}, ${made.coalesceKey ?? null}, ${made.shadow ?? false},
      now() - ${made.createdAgo ?? "1 hour"}::interval, now() - ${made.createdAgo ?? "1 hour"}::interval,
      ${status === "pending" ? null : sql`now() - ${made.resolvedAgo ?? "10 minutes"}::interval`},
      ${status === "pending" ? null : "owner"}, ${made.note ?? null})`;
  return id;
}

async function session(agent: string, startedAgo: string, endedAgo: string, source = "calls"): Promise<void> {
  await sql`
    INSERT INTO agent_sessions (user_id, agent, source, kind, started_at, ended_at, request_count)
    VALUES (${userId}, ${agent}, ${source}, 'work', now() - ${startedAgo}::interval, now() - ${endedAgo}::interval, 3)`;
}

const statusOf = async (id: string) =>
  (await sql<{ status: string }[]>`SELECT status FROM agent_proposals WHERE id=${id}`)[0]!.status;

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

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
      migrationsFolder: fileURLToPath(new URL("../../../platform/database/drizzle", import.meta.url))
    });
  } finally {
    await migrationSql.end();
  }
  sql = postgres(testUrl.toString(), { max: 6, connect_timeout: 10, fetch_types: false, prepare: true });
  userId = await ensureUser(sql);
}, 30_000);

beforeEach(async () => {
  await sql.unsafe(
    "TRUNCATE TABLE agent_proposals, agent_sessions, catch_up_runs, push_outbox, projects, outcomes, areas RESTART IDENTITY CASCADE"
  );
});

afterAll(async () => {
  await sql?.end();
});

describe("readProposalOutcomes", () => {
  it("returns only the viewer agent's own non-shadow outcomes, and nothing for the owner view", async () => {
    const mine = await make({ status: "rejected", note: "No thanks" });
    const confirmed = await make({ status: "confirmed" });
    const stale = await make({ status: "stale" });
    await make({ status: "rejected", agent: "other" });
    await make({ status: "rejected", shadow: true });
    await make({ status: "pending" });

    const result = (await readProposalOutcomes(sql, userId, "scribe"))!;
    expect(result.outcomes.map((o) => o.id).sort()).toEqual([mine, confirmed, stale].sort());
    expect(result.outcomes.find((o) => o.id === mine)).toMatchObject({
      status: "rejected",
      note: "No thanks",
      kind: "entity_command"
    });
    expect(result.staleCount).toBe(1);
    const theirs = (await readProposalOutcomes(sql, userId, "other"))!;
    expect(theirs.outcomes).toHaveLength(1);

    // The owner view has no outcomes: nothing is read and expireOld does not run.
    const overdue = await make({ createdAgo: "20 days" });
    expect(await readProposalOutcomes(sql, userId, null)).toBeUndefined();
    expect(await statusOf(overdue)).toBe("pending");
  });

  it("runs its own expireOld first, and dates an expiry created_at + 14 days, not its stamp", async () => {
    const overdue = await make({ createdAgo: "15 days" });
    const lateStamp = await make({ status: "expired", createdAgo: "17 days", resolvedAgo: "1 minute" });
    await make({ status: "expired", createdAgo: "30 days", resolvedAgo: "1 minute" }); // expired 16 days ago: outside
    const result = (await readProposalOutcomes(sql, userId, "scribe"))!;
    expect(await statusOf(overdue)).toBe("expired");
    expect(result.outcomes.map((o) => o.id).sort()).toEqual([overdue, lateStamp].sort());
    for (const outcome of result.outcomes) expect(outcome.status).toBe("expired");
    const created = (
      await sql<{ created: Date }[]>`SELECT created_at AS created FROM agent_proposals WHERE id=${overdue}`
    )[0]!.created;
    expect(result.outcomes.find((o) => o.id === overdue)!.at).toBe(
      new Date(created.getTime() + 14 * 86_400_000).toISOString()
    );
  });

  it("keeps a 30 second overlap on resolved_at and clamps since to the last 7 days and to now()", async () => {
    const since = (await sql<{ s: Date }[]>`SELECT now() - interval '1 hour' AS s`)[0]!.s.toISOString();
    const inside = await make({ status: "rejected", resolvedAgo: "1 hour 20 seconds" });
    await make({ status: "rejected", resolvedAgo: "1 hour 40 seconds" });
    const result = (await readProposalOutcomes(sql, userId, "scribe", { since }))!;
    expect(result.outcomes.map((o) => o.id)).toEqual([inside]);
    expect(result.sinceClamped).toBeUndefined();

    const future = (await readProposalOutcomes(sql, userId, "scribe", { since: "2999-01-01T00:00:00Z" }))!;
    expect(future.sinceClamped).toBe("future");
    expect(future.since).toBe(future.queryNow);

    const old = (await readProposalOutcomes(sql, userId, "scribe", { since: "2001-01-01T00:00:00Z" }))!;
    expect(old.sinceClamped).toBe("older_than_window");
    expect(Date.parse(old.queryNow) - Date.parse(old.since)).toBe(7 * 86_400_000);
  });

  it("produces a cursor that strictly advances, and none when the query throws", async () => {
    await make({ status: "rejected", resolvedAgo: "2 minutes" });
    const first = (await readProposalOutcomes(sql, userId, "scribe"))!;
    await sleep(15);
    const second = (await readProposalOutcomes(sql, userId, "scribe", { since: first.queryNow }))!;
    expect(attentionCursor({ outcomeQueryNow: second.queryNow, since: first.queryNow })).toBe(second.queryNow);
    expect(second.queryNow > first.queryNow).toBe(true);

    // A failing read throws: the caller never holds an outcome-query clock, so the cursor is the since it sent, or none.
    const broken = Object.assign(() => Promise.reject(new Error("down")), {
      begin: () => Promise.reject(new Error("down"))
    }) as unknown as postgres.Sql;
    const sent = "2026-11-01T10:00:00.000Z";
    let queryNow: string | undefined;
    await expect(
      readProposalOutcomes(broken, userId, "scribe", { since: sent }).then((r) => {
        queryNow = r?.queryNow;
      })
    ).rejects.toThrow("down");
    expect(attentionCursor({ outcomeQueryNow: queryNow, since: sent })).toBe(sent);
    expect(attentionCursor({ outcomeQueryNow: queryNow })).toBeUndefined();
  });

  it("marks an outcome re-proposed by a later proposal with the same coalesce key, else the same kind and target", async () => {
    // Same key: the later proposal is a re-proposal; one created before the outcome is not.
    const keyed = await make({
      status: "stale",
      coalesceKey: "rename-a",
      createdAgo: "3 hours",
      resolvedAgo: "2 hours"
    });
    const sameKey = await make({ coalesceKey: "rename-a", createdAgo: "1 hour" });
    const keyedBefore = await make({
      status: "rejected",
      coalesceKey: "rename-b",
      createdAgo: "3 hours",
      resolvedAgo: "1 hour"
    });
    await make({ coalesceKey: "rename-b", createdAgo: "2 hours" }); // made before the rejection
    // Same kind and target, no key.
    const targeted = await make({ status: "expired", createdAgo: "14 days 6 hours", targets: ["project:p-1"] });
    const sameTarget = await make({ createdAgo: "1 hour", targets: ["project:p-1"] });
    // Different target, other agent, other kind, and no target at all: none of these match.
    const untouched = await make({
      status: "rejected",
      createdAgo: "3 hours",
      resolvedAgo: "2 hours",
      targets: ["project:p-2"]
    });
    await make({ createdAgo: "1 hour", targets: ["project:p-3"] });
    await make({ createdAgo: "1 hour", targets: ["project:p-2"], agent: "other" });
    await make({ createdAgo: "1 hour", targets: ["project:p-2"], kind: "settle_catch_up" });
    const bare = await make({ status: "rejected", createdAgo: "3 hours", resolvedAgo: "2 hours" });
    await make({ createdAgo: "1 hour" });

    const result = (await readProposalOutcomes(sql, userId, "scribe"))!;
    const by = (id: string) => result.outcomes.find((o) => o.id === id)!;
    expect(by(keyed).reproposedAs).toBe(sameKey);
    expect(by(targeted).reproposedAs).toBe(sameTarget);
    expect(by(keyedBefore).reproposedAs).toBeUndefined();
    expect(by(untouched).reproposedAs).toBeUndefined();
    expect(by(bare).reproposedAs).toBeUndefined();

    // The status block's count leaves the two re-proposed ones out.
    const { start } = await readDecidedWindowStart(sql, userId, "scribe");
    expect(await countDecidedOutcomes(sql, userId, "scribe", start)).toBe(result.outcomes.length - 2);
  });

  it("selects a changeset-held expiry, including a pending row that passes expiry while expireOld waits", async () => {
    const stamped = await make({ createdAgo: "14 days 6 hours" });
    // Expires two seconds from now: not expired when the reader's expireOld statement starts.
    const passing = await make({ createdAgo: "14 days 0 seconds" });
    await sql`UPDATE agent_proposals SET created_at = now() - interval '14 days' + interval '2 seconds' WHERE id=${passing}`;

    let locked!: () => void;
    let release!: () => void;
    const lockedP = new Promise<void>((done) => (locked = done));
    const held = new Promise<void>((done) => (release = done));
    // A changeset's transaction ran expireOld (its resolved_at is the changeset's start) and has not committed.
    const holder = sql.begin(async (tx) => {
      await expireOld(tx, userId);
      locked();
      await held;
    });
    await lockedP;
    const reading = readProposalOutcomes(sql, userId, "scribe");
    const waiting = async () =>
      (
        await sql`SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%UPDATE agent_proposals%'`
      ).length > 0;
    for (let i = 0; i < 50 && !(await waiting()); i++) await sleep(100);
    expect(await waiting()).toBe(true);
    await sleep(2500); // `passing` crosses 14 days while the reader waits
    release();
    await holder;
    const result = (await reading)!;
    expect(result.outcomes.map((o) => o.id).sort()).toEqual([stamped, passing].sort());
    expect(result.outcomes.every((o) => o.status === "expired")).toBe(true);
    const created = (
      await sql<{ created: Date }[]>`SELECT created_at AS created FROM agent_proposals WHERE id=${passing}`
    )[0]!.created;
    expect(result.outcomes.find((o) => o.id === passing)!.at).toBe(
      new Date(created.getTime() + 14 * 86_400_000).toISOString()
    );
    // The count sees both too.
    expect(await countDecidedOutcomes(sql, userId, "scribe", new Date(Date.now() - 86_400_000).toISOString())).toBe(2);
  });
});

describe("re-proposal and the decided count", () => {
  it("drops only stale and expired outcomes that a later same-target proposal re-proposed", async () => {
    const statuses = ["confirmed", "rejected", "stale", "expired"] as const;
    const ids: Record<string, string> = {};
    for (const [index, status] of statuses.entries()) {
      const target = `project:re-${status}`;
      ids[status] = await make({
        status,
        targets: [target],
        createdAgo: status === "expired" ? "14 days 6 hours" : "3 hours",
        resolvedAgo: "2 hours"
      });
      await make({ createdAgo: `${index + 1} minutes`, targets: [target] }); // later, same kind and target
    }
    const { outcomes } = (await readProposalOutcomes(sql, userId, "scribe"))!;
    expect(outcomes.map((o) => o.id).sort()).toEqual(Object.values(ids).sort());
    // The match is reported for every status; the model uses it only for stale and expired.
    for (const outcome of outcomes) expect(outcome.reproposedAs).toBeDefined();
    const { start } = await readDecidedWindowStart(sql, userId, "scribe");
    expect(await countDecidedOutcomes(sql, userId, "scribe", start)).toBe(2);
    const counted = outcomes.filter((o) => o.status === "confirmed" || o.status === "rejected");
    expect(counted).toHaveLength(2);
  });
});

describe("the decided window and count", () => {
  it("is 24 hours with no closed session", async () => {
    await make({ status: "rejected", resolvedAgo: "2 hours" });
    await make({ status: "confirmed", resolvedAgo: "30 hours" });
    const window = await readDecidedWindowStart(sql, userId, "scribe");
    expect(Date.parse(window.now) - Date.parse(window.start)).toBe(86_400_000);
    expect((await readDecidedCount(sql, userId, "scribe")).count).toBe(1);
  });

  it("starts at the previous closed calls session, floored at 7 days", async () => {
    await session("scribe", "3 days 1 hour", "3 days"); // closed: the window starts here
    await session("scribe", "5 minutes", "1 minute"); // open: the current session never counts
    await session("scribe", "6 days", "5 days", "reported"); // not a calls session
    await session("other", "9 days", "8 days");
    await make({ status: "rejected", resolvedAgo: "2 days" });
    await make({ status: "confirmed", resolvedAgo: "4 days" });
    await make({ status: "stale", resolvedAgo: "2 days", agent: "other" });
    const window = await readDecidedWindowStart(sql, userId, "scribe");
    const span = Date.parse(window.now) - Date.parse(window.start);
    expect(span).toBeGreaterThanOrEqual(3 * 86_400_000 + 3_600_000);
    expect(span).toBeLessThan(3 * 86_400_000 + 3_600_000 + 10_000);
    expect((await readDecidedCount(sql, userId, "scribe")).count).toBe(1);

    // An agent away longer than a week is floored at 7 days.
    const floored = await readDecidedWindowStart(sql, userId, "other");
    expect(Date.parse(floored.now) - Date.parse(floored.start)).toBe(7 * 86_400_000);
  });

  it("counts non-shadow outcomes with the expiry expression, and runs no UPDATE", async () => {
    const pending = await make({ createdAgo: "14 days 1 hour" }); // past expiry, never stamped
    await make({ status: "expired", createdAgo: "14 days 2 hours", resolvedAgo: "5 minutes" }); // stamped late
    await make({ createdAgo: "13 days" }); // not expired
    await make({ status: "rejected", shadow: true });
    await make({ status: "rejected", agent: "other" });
    await make({ status: "confirmed" });
    const { count } = await readDecidedCount(sql, userId, "scribe");
    expect(count).toBe(3);
    expect(await statusOf(pending)).toBe("pending");
    expect(await sql`SELECT 1 FROM agent_proposals WHERE status='expired' AND resolved_by='system'`).toHaveLength(0);
  });
});

describe("readCatchUpDue", () => {
  async function staleProject(): Promise<void> {
    const area = await sql<{ id: string }[]>`
      INSERT INTO areas (user_id,name,status,sort_order) VALUES (${userId},'Area','active',0) RETURNING id`;
    const outcome = await sql<{ id: string }[]>`
      INSERT INTO outcomes (area_id,title,definition_of_done,status) VALUES (${area[0]!.id},'Outcome','Done','active') RETURNING id`;
    await sql`
      INSERT INTO projects (outcome_id,title,status,internal_deadline_at)
      VALUES (${outcome[0]!.id},'Stale','active',${new Date("2026-10-15T12:00:00Z")})`;
  }
  const NOW = new Date("2026-10-18T12:00:00Z");
  const nudge = async () => (await sql<{ status: string }[]>`SELECT status FROM push_outbox`)[0]!.status;

  it("answers as the ledger does but never cancels a held nudge, while the ledger still does", async () => {
    await staleProject();
    await sql`INSERT INTO catch_up_runs (user_id,window_until,closed_at) VALUES (${userId},${new Date("2026-10-15T12:00:00Z")},${new Date("2026-10-16T12:00:00Z")})`;
    expect(await queueCatchUpNudge(sql as never, userId, NOW)).toEqual({ due: true, queued: true });
    const away = await readCatchUpDue(sql as never, userId, NOW);
    expect(away).toMatchObject({ due: true, lapsed: false });
    const ledger = await readCatchUpLedger(sql as never, { now: NOW });
    expect(ledger.due).toBe(true);
    expect(ledger.unsettled).toBe(away.unsettled);
    expect(await nudge()).toBe("pending");

    // Activity resumes: not due. The read-only check leaves the nudge; the ledger read cancels it, as before.
    await sql`INSERT INTO catch_up_runs (user_id,window_until,closed_at) VALUES (${userId},${NOW},${NOW})`;
    expect((await readCatchUpDue(sql as never, userId, NOW)).due).toBe(false);
    expect(await nudge()).toBe("pending");
    expect((await readCatchUpLedger(sql as never, { now: NOW })).due).toBe(false);
    expect(await nudge()).toBe("cancelled");
  });
});

describe("outcomeTarget", () => {
  it("reads the target defensively from agent-written payloads", () => {
    expect(outcomeTarget("entity_command", { command: "save_project", body: { project: { id: "a" } } })).toEqual({
      entity: "project",
      id: "a"
    });
    expect(outcomeTarget("entity_command", { command: "save_action", body: { action: { id: "b" } } })).toEqual({
      entity: "action",
      id: "b"
    });
    expect(
      outcomeTarget("entity_command", { command: "save_entity", body: { entityType: "area", entity: { id: 4 } } })
    ).toEqual({ entity: "area" });
    expect(outcomeTarget("entity_command", { command: "other", body: {} })).toBeUndefined();
    expect(outcomeTarget("settle_catch_up", { command: "save_project", body: {} })).toBeUndefined();
    expect(outcomeTarget("entity_command", null)).toBeUndefined();
  });
});
