import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { fileURLToPath } from "node:url";
import { integrationDatabaseName } from "@openrhen/database";
import {
  AGENT_SCOPE_PRESETS,
  FEED_OWNS_DOCTOR_CHECKS,
  attentionCallProblem,
  type AttentionItem,
  type DoctorReport
} from "@openrhen/contracts";
import { readProposalOutcomes, readDecidedCount } from "@/server/agent-proposals/outcomes";
import { readCatchUpLedger } from "@/server/persistence/postgres/catch-up";
import { readDoctorReport } from "@/server/persistence/postgres/doctor";
import { ensureUser } from "@/server/persistence/postgres/ensure-user";
import { ensureExtractorStateTx } from "@/server/persistence/postgres/extractor-state-store";
import { readAttentionCounts, resetAttentionCountsMemo } from "./counts";
import { readAttention, type AttentionResponse } from "./read-attention";
import { defaultAttentionReaders } from "./readers";

/**
 * The attention feed over a real database (the design notes, 5, 6, 7, 8): what it leaves
 * alone, what it delivers exactly once, and that every outcome the status block counts is in the answer.
 */
config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(
  process.env.ATTENTION_FEED_TEST_DATABASE_NAME,
  "openrhen_attention_feed"
);
if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("ATTENTION_FEED_TEST_DATABASE_NAME must be an identifier ending in _test");
}
const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let userId: string;

const SENTINEL = "SENTINEL-feed-db-42";
const hoursAgo = (n: number) => new Date(Date.now() - n * 3_600_000);

interface Made {
  agent?: string;
  status?: "pending" | "confirmed" | "rejected" | "expired" | "stale";
  shadow?: boolean;
  createdAgo?: string;
  resolvedAgo?: string;
  coalesceKey?: string | null;
  note?: string;
}

async function make(made: Made = {}): Promise<string> {
  const id = crypto.randomUUID();
  const status = made.status ?? "pending";
  await sql`
    INSERT INTO agent_proposals (id, user_id, agent, kind, summary, payload, payload_hash, basis, target_versions, status, coalesce_key, shadow, created_at, updated_at, resolved_at, resolved_by, resolution_note)
    VALUES (${id}, ${userId}, ${made.agent ?? "scribe"}, 'entity_command', ${`${SENTINEL} summary`}, ${sql.json({ command: "save_project", body: { project: { id } } } as never)}, ${id}, 'inferred',
      ${sql.json({} as never)}, ${status}, ${made.coalesceKey ?? null}, ${made.shadow ?? false},
      now() - ${made.createdAgo ?? "1 hour"}::interval, now() - ${made.createdAgo ?? "1 hour"}::interval,
      ${status === "pending" ? null : sql`now() - ${made.resolvedAgo ?? "10 minutes"}::interval`},
      ${status === "pending" ? null : "owner"}, ${made.note ?? null})`;
  return id;
}

const handlesOf = (items: readonly AttentionItem[]) => items.flatMap((item) => item.handles);
const outcomeItems = (answer: AttentionResponse) => answer.items.filter((item) => item.kind === "proposal_decided");
const weight = (item: AttentionItem) => item.folded ?? 1;

const feed = async (
  request: { agent?: string | null; scopes?: readonly string[] | undefined; since?: string } = {}
): Promise<AttentionResponse> => {
  const result = await readAttention(sql, {
    agent: request.agent === undefined ? "scribe" : request.agent,
    scopes: request.scopes,
    ...(request.since ? { since: request.since } : {})
  });
  if (!("answer" in result)) throw new Error("expected an answer");
  return result.answer;
};

async function failingSync() {
  await sql`INSERT INTO integration_sync_runs (user_id,provider,trigger,started_at,finished_at,status,summary)
    VALUES (${userId},'google_calendar','scheduled',now() - interval '3 days',now() - interval '3 days','synced','{}'),
           (${userId},'google_calendar','scheduled',now() - interval '1 day',now() - interval '1 day','failed',${sql.json({ error: SENTINEL } as never)})`;
}

async function openCheckIn() {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO check_in (user_id,slot_at,directive_kind,directive_title,status)
    VALUES (${userId},${hoursAgo(1)},'action',${`${SENTINEL} directive`},'pending') RETURNING id`;
  return row!.id;
}

/** Recent recorded activity, so the catch-up is not due. */
const recentActivity = () =>
  sql`INSERT INTO catch_up_runs (user_id,window_until,closed_at) VALUES (${userId},${hoursAgo(3)},${hoursAgo(2)})`;

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
    await migrate(drizzle(migrationSql), {
      migrationsFolder: fileURLToPath(new URL("../../../platform/database/drizzle", import.meta.url))
    });
  } finally {
    await migrationSql.end();
  }
  sql = postgres(testUrl.toString(), { max: 8, connect_timeout: 10, fetch_types: false, prepare: true });
  userId = await ensureUser(sql);
}, 30_000);

beforeEach(async () => {
  resetAttentionCountsMemo();
  await sql.unsafe(
    "TRUNCATE TABLE agent_proposals, agent_sessions, catch_up_runs, check_in, integration_sync_runs, pulse_segments, pulse_state, push_outbox, projects, outcomes, areas RESTART IDENTITY CASCADE"
  );
  // A plan with nothing else wrong has a recent backup on record.
  await sql`INSERT INTO integration_sync_runs (user_id,provider,trigger,started_at,finished_at,status,summary)
    VALUES (${userId},'backup','scheduled',now(),now(),'synced','{}'::jsonb)`;
});

afterAll(async () => {
  await sql?.end();
});

describe("the feed leaves everything it only reads", () => {
  it("leaves the check-in unstamped and the push outbox untouched, and following every nextCall changes neither", async () => {
    await failingSync();
    const checkInId = await openCheckIn();
    await recentActivity();
    await sql`INSERT INTO push_outbox (user_id,dedupe_key,kind,payload,status,next_attempt_at,expires_at)
      VALUES (${userId},'catch-up-due:2026-10-10T00:00:00.000Z','test','{}','pending',now() + interval '1 day',now() + interval '4 days')`;
    const outboxBefore = await sql`SELECT * FROM push_outbox ORDER BY id`;

    const answer = await feed({ scopes: undefined });
    expect(answer.items.map((i) => i.kind)).toEqual(expect.arrayContaining(["check_in_open", "health_blocking"]));
    expect(answer.items.some((i) => i.kind === "catch_up_due")).toBe(false);
    expect(await sql`SELECT * FROM push_outbox ORDER BY id`).toEqual(outboxBefore);
    expect((await sql`SELECT prompted_at FROM check_in WHERE id=${checkInId}`)[0]!.prompted_at).toBeNull();

    // Follow every nextCall (the doctor reads here), as an agent would, without status.
    const doctor: DoctorReport = await readDoctorReport(sql);
    const reached: string[] = [];
    for (const item of answer.items) {
      const call = item.nextCall;
      if (!call || !("tool" in call)) continue;
      expect(attentionCallProblem(call, undefined)).toBeUndefined();
      expect(call.tool).toBe("rhen_doctor");
      const { tier, area, limit } = call.arguments as { tier?: string; area?: string; limit?: number };
      expect(limit).toBe(0);
      const returned = doctor.items.filter((d) => (!tier || d.tier === tier) && (!area || d.area === area));
      // The doctor answer for the area holds no check the status read owns.
      expect(
        returned.map((d) => d.check).filter((c) => (FEED_OWNS_DOCTOR_CHECKS as readonly string[]).includes(c))
      ).toEqual([]);
      expect(returned.length).toBeGreaterThan(0);
      reached.push(JSON.stringify({ returned }));
    }
    expect(reached.length).toBeGreaterThan(0);
    // The owned checks exist in the doctor, so the area test above is not vacuous.
    expect(doctor.items.some((d) => (FEED_OWNS_DOCTOR_CHECKS as readonly string[]).includes(d.check))).toBe(true);
    for (const text of [...reached, JSON.stringify(answer)])
      expect(text).not.toContain(["rhen", "attention"].join("_"));

    expect(await sql`SELECT * FROM push_outbox ORDER BY id`).toEqual(outboxBefore);
    expect((await sql`SELECT prompted_at FROM check_in WHERE id=${checkInId}`)[0]!.prompted_at).toBeNull();
    expect((await sql`SELECT status FROM push_outbox`)[0]!.status).toBe("pending");

    // No loop: a second read gives the same items, and none of them points back at status or the feed.
    const again = await feed({ scopes: undefined });
    expect(again.items.map((i) => i.id)).toEqual(answer.items.map((i) => i.id));
    for (const item of again.items)
      if (item.nextCall && "tool" in item.nextCall) expect(item.nextCall.tool).not.toBe("rhen_status");
  });

  it("states the numbers status states: the check-in is on the ledger, and the unsettled count equals catchUp.unsettled", async () => {
    await openCheckIn();
    await recentActivity();
    const answer = await feed({ scopes: undefined });
    const ledger = await readCatchUpLedger(sql);
    expect(ledger.entries.some((e) => e.kind === "check_in")).toBe(true);
    expect(answer.items.some((i) => i.kind === "check_in_open")).toBe(true);
    // Not due: the ledger's unsettled entries are the whole of health_more here.
    expect(ledger.due).toBe(false);
    expect(answer.items.find((i) => i.kind === "health_more")?.why).toContain(`${ledger.unsettled} data-health items`);
  });

  it("lists a due catch-up and the ledger agrees it is due", async () => {
    await openCheckIn();
    const answer = await feed({ scopes: undefined });
    expect((await readCatchUpLedger(sql)).due).toBe(true);
    expect(answer.items.find((i) => i.kind === "catch_up_due")?.nextCall).toMatchObject({
      tool: "rhen_catch_up"
    });
  });
});

describe("outcomes and the cursor", () => {
  it("poll twice with the returned cursor: the second cursor is greater, with no fold and no repeated outcome", async () => {
    await failingSync();
    for (let i = 0; i < 7; i += 1)
      await make({ status: i % 2 ? "rejected" : "confirmed", resolvedAgo: `${2 + i} hours` });
    await make({ status: "stale", resolvedAgo: "3 hours" });
    const first = await feed();
    expect(first.cursor).toBeDefined();
    expect(outcomeItems(first)).toHaveLength(8);
    expect(first.items.some((i) => i.folded)).toBe(false);
    const second = await feed({ since: first.cursor! });
    expect(Date.parse(second.cursor!)).toBeGreaterThan(Date.parse(first.cursor!));
    expect(outcomeItems(second)).toEqual([]);
    expect(second.items.some((i) => i.folded)).toBe(false);
    // The condition that persists is still there.
    expect(second.items.some((i) => i.kind === "health_blocking")).toBe(true);
    const third = await feed({ since: second.cursor! });
    expect(Date.parse(third.cursor!)).toBeGreaterThan(Date.parse(second.cursor!));
  });

  it("delivers a later decision on the next poll only", async () => {
    await make({ status: "rejected", resolvedAgo: "2 hours" });
    const first = await feed();
    const later = await make({ status: "confirmed", resolvedAgo: "0 seconds" });
    const second = await feed({ since: first.cursor! });
    expect(handlesOf(outcomeItems(second))).toEqual([`proposal:${later}`]);
  });

  it("a read:plan-only token gets no cursor without since, and its since back with one; it reads and writes no proposal", async () => {
    const overdue = await make({ createdAgo: "20 days" });
    expect((await feed({ scopes: ["read:plan"] })).cursor).toBeUndefined();
    const since = new Date(Date.now() - 3_600_000).toISOString();
    expect((await feed({ scopes: ["read:plan"], since })).cursor).toBe(since);
    expect((await sql`SELECT status FROM agent_proposals WHERE id=${overdue}`)[0]!.status).toBe("pending");
  });

  it("when expireOld fails the cursor is the since sent, and absent without one", async () => {
    const failing = new Proxy(sql, {
      apply(target, thisArg, args) {
        const text = Array.isArray(args[0]) ? (args[0] as string[]).join("?") : "";
        if (text.includes("UPDATE agent_proposals")) return Promise.reject(new Error(`${SENTINEL} expireOld`));
        return Reflect.apply(target, thisArg, args);
      }
    });
    const readers = { ...defaultAttentionReaders(failing as never), userId: async () => userId };
    const since = new Date(Date.now() - 3_600_000).toISOString();
    for (const [request, expected] of [
      [{ agent: "scribe", scopes: undefined, since }, since],
      [{ agent: "scribe", scopes: undefined }, undefined]
    ] as const) {
      const result = await readAttention(sql, request, readers);
      if (!("answer" in result)) throw new Error("expected an answer");
      expect(result.answer.cursor).toBe(expected);
      expect(result.answer.complete).toBe(false);
      expect(result.answer.items.map((i) => i.id)).toContain("source_unavailable:proposals");
      expect(JSON.stringify(result.answer)).not.toContain(SENTINEL);
    }
  });

  it("lists a never-stamped expiry as expired at created_at + 14 days, and the status counts it too", async () => {
    const id = await make({ status: "pending", createdAgo: "14 days 1 hour" });
    const { count } = await readDecidedCount(sql, userId, "scribe");
    expect(count).toBe(1);
    const answer = await feed();
    const item = outcomeItems(answer).find((i) => i.handles.includes(`proposal:${id}`))!;
    expect(item.title).toBe("A proposal of yours expired");
    const [row] = await sql<
      { expires: Date }[]
    >`SELECT created_at + interval '14 days' AS expires FROM agent_proposals WHERE id=${id}`;
    expect(item.at).toBe(row!.expires.toISOString());
  });
});

describe("every outcome the status block counts is in the answer", () => {
  it("lists each one of the decided window as its own item, folds older fyi ones past 5, and leaves the shadow row out of both", async () => {
    const confirmed = await make({ status: "confirmed", resolvedAgo: "2 hours" });
    const rejected = await make({ status: "rejected", resolvedAgo: "3 hours" });
    const expired = await make({ status: "expired", createdAgo: "14 days 2 hours", resolvedAgo: "1 hour" });
    const stale = await make({ status: "stale", resolvedAgo: "4 hours" });
    // A stale outcome already acted on: a later proposal with the same coalesce key.
    const old = await make({ status: "stale", coalesceKey: "k1", resolvedAgo: "5 hours", createdAgo: "6 hours" });
    await make({ status: "pending", coalesceKey: "k1", createdAgo: "1 hour" });
    const shadow = await make({ status: "rejected", shadow: true, resolvedAgo: "1 hour" });
    // Six older fyi outcomes, inside 7 days but before the decided window (24 hours with no closed session).
    for (let i = 0; i < 6; i += 1) await make({ status: "rejected", resolvedAgo: `${36 + i * 24} hours` });

    const { count, windowStart } = await readDecidedCount(sql, userId, "scribe");
    const answer = await feed();
    const items = outcomeItems(answer);
    const listed = new Set(handlesOf(items));
    for (const id of [confirmed, rejected, expired, stale]) expect(listed, id).toContain(`proposal:${id}`);
    expect(count).toBe(4);
    expect(listed).toContain(`proposal:${old}`);
    expect(listed).not.toContain(`proposal:${shadow}`);
    expect(JSON.stringify(answer)).not.toContain(shadow);
    const recent = items.filter((i) => Date.parse(i.at) >= Date.parse(windowStart));
    expect(recent.reduce((sum, i) => sum + weight(i), 0)).toBeGreaterThanOrEqual(count);
    // Older fyi outcomes: the newest 5 are items and the 6th is in the fold.
    const older = items.filter((i) => Date.parse(i.at) < Date.parse(windowStart));
    expect(older.reduce((sum, i) => sum + weight(i), 0)).toBe(6);
    expect(older.filter((i) => i.folded)).toHaveLength(1);
    expect(older.find((i) => i.folded)?.folded).toBe(1);
  });

  it("lists 7 fyi outcomes inside the window as 7 items", async () => {
    for (let i = 0; i < 7; i += 1) await make({ status: "rejected", resolvedAgo: `${i + 1} hours` });
    const answer = await feed();
    expect(outcomeItems(answer)).toHaveLength(7);
    expect(outcomeItems(answer).some((i) => i.folded)).toBe(false);
  });

  it("lists the newest 20 of 25 recent fyi outcomes and folds 5; decided equals listed plus folded", async () => {
    for (let i = 0; i < 25; i += 1)
      await make({ status: i % 2 ? "rejected" : "confirmed", resolvedAgo: `${i + 1} minutes` });
    const { count } = await readDecidedCount(sql, userId, "scribe");
    const answer = await feed();
    const items = outcomeItems(answer);
    expect(items).toHaveLength(21);
    expect(items.filter((i) => !i.folded)).toHaveLength(20);
    expect(items.find((i) => i.folded)?.folded).toBe(5);
    expect(count).toBe(25);
    expect(items.reduce((sum, i) => sum + weight(i), 0)).toBe(count);
    expect(answer.counts.fyi).toBeGreaterThanOrEqual(25);
  });

  it("the decided window follows a closed session: a 4-day-old outcome is outside it, a 2-day-old one inside", async () => {
    await sql`INSERT INTO agent_sessions (user_id, agent, source, kind, started_at, ended_at, request_count)
      VALUES (${userId}, 'scribe', 'calls', 'work', now() - interval '3 days', now() - interval '3 days' + interval '10 minutes', 3)`;
    await make({ status: "rejected", resolvedAgo: "4 days" });
    const inside = await make({ status: "rejected", resolvedAgo: "2 days" });
    const { count } = await readDecidedCount(sql, userId, "scribe");
    expect(count).toBe(1);
    const answer = await feed();
    expect(handlesOf(outcomeItems(answer))).toContain(`proposal:${inside}`);
  });
});

describe("proposals waiting and the owner view", () => {
  it("summarises this agent's own pending proposals only, soon once one is near expiry", async () => {
    await make({ status: "pending", createdAgo: "3 days" });
    await make({ status: "pending", createdAgo: "1 hour" });
    await make({ status: "pending", createdAgo: "5 days", agent: "other" });
    await make({ status: "pending", createdAgo: "5 days", shadow: true });
    const fyi = (await feed()).items.find((i) => i.kind === "proposals_waiting")!;
    expect(fyi.why).toContain("1 of your proposals");
    expect(fyi.urgency).toBe("fyi");
    await make({ status: "pending", createdAgo: "13 days" });
    const soon = (await feed()).items.find((i) => i.kind === "proposals_waiting")!;
    expect(soon.urgency).toBe("soon");
    expect(soon.nextCall).toMatchObject({ ownerPage: "/inbox" });
  });

  it("the owner view has no proposal kinds and runs no expireOld", async () => {
    const overdue = await make({ createdAgo: "20 days" });
    await make({ status: "rejected" });
    const answer = await feed({ agent: null });
    expect(answer.items.filter((i) => i.kind === "proposal_decided" || i.kind === "proposals_waiting")).toEqual([]);
    expect((await sql`SELECT status FROM agent_proposals WHERE id=${overdue}`)[0]!.status).toBe("pending");
  });
});

describe("failure and lapse over the real readers", () => {
  it("answers the gate's 428 when the pulse has lapsed after the gate, but not for a pulse never confirmed", async () => {
    await sql`INSERT INTO pulse_segments (user_id,started_at,state,reason) VALUES (${userId},now() - interval '1 day','off','lapsed')`;
    const unconfirmed = await readAttention(sql, { agent: "scribe", scopes: undefined });
    expect("answer" in unconfirmed).toBe(true);
    await sql`UPDATE pulse_segments SET confirmed_at = now() - interval '2 days' WHERE user_id=${userId}`;
    const lapsed = await readAttention(sql, { agent: "scribe", scopes: undefined });
    expect("lapsed" in lapsed).toBe(true);
    if ("lapsed" in lapsed) {
      expect(lapsed.lapsed.status).toBe(428);
      expect(((await lapsed.lapsed.json()) as { code: string }).code).toBe("reentryRequired");
    }
  });

  it("a source that throws leaves the rest of the answer, and nothing from the error", async () => {
    await failingSync();
    const readers = {
      ...defaultAttentionReaders(sql),
      entries: async () => {
        throw new Error(`${SENTINEL} imported title`);
      }
    };
    const result = await readAttention(sql, { agent: "scribe", scopes: undefined }, readers);
    if (!("answer" in result)) throw new Error("expected an answer");
    expect(result.answer.complete).toBe(false);
    expect(result.answer.items.some((i) => i.kind === "health_blocking")).toBe(true);
    expect(JSON.stringify(result.answer)).not.toContain(SENTINEL);
  });
});

describe("the counts for the status block", () => {
  it("count the same blocking items and decided outcomes the feed lists, per agent and per token", async () => {
    await failingSync();
    await make({ status: "rejected", resolvedAgo: "1 hour" });
    await make({ status: "confirmed", resolvedAgo: "1 hour", agent: "other" });
    const mine = await readAttentionCounts(sql, { agent: "scribe", scopes: undefined });
    const theirs = await readAttentionCounts(sql, { agent: "other", scopes: undefined });
    const planOnly = await readAttentionCounts(sql, { agent: "scribe", scopes: ["read:plan"] });
    const owner = await readAttentionCounts(sql, { agent: null, scopes: undefined });
    const answer = await feed();
    expect(mine).toMatchObject({ viewer: "agent", sourcesFailed: 0, decided: 1 });
    expect(mine.healthBlocking).toBe(answer.items.filter((i) => i.kind === "health_blocking").length);
    expect(theirs.decided).toBe(1);
    expect(planOnly.decided).toBe(0);
    expect(owner).toMatchObject({ viewer: "owner", decided: 0, healthBlocking: mine.healthBlocking });
    expect(mine.healthBlocking).toBeGreaterThan(0);
  });
});

describe("the counts agree with the feed over a real open check-in", () => {
  it("count the open check-in as the feed does, without stamping it", async () => {
    await failingSync();
    const checkInId = await openCheckIn();
    const counts = await readAttentionCounts(sql, { agent: "scribe", scopes: undefined });
    const answer = await feed();
    expect(counts.checkInOpen).toBe(1);
    expect(counts.healthBlocking + counts.sourcesFailed + counts.checkInOpen + counts.catchUpDue).toBe(
      answer.counts.now
    );
    expect((await sql`SELECT prompted_at FROM check_in WHERE id=${checkInId}`)[0]!.prompted_at).toBeNull();
  });
});

/** An open ask: a gmail message and a fact row read from it (no span, so no quote), the active version's. */
async function openFact(n: number, daysAgo: number): Promise<void> {
  await sql.begin((tx) => ensureExtractorStateTx(tx, userId, "fact-llm", "1", new Date()));
  const at = new Date(Date.now() - daysAgo * 86_400_000);
  await sql`INSERT INTO activity_events (user_id, source, kind, event_key, ts_start, attrs, ingested_at)
    VALUES (${userId}, 'gmail', 'message', ${`m-${n}`}, ${at}, ${sql.json({ thread_id: `t-${n}` } as never)}, ${at})`;
  await sql`INSERT INTO activity_events (user_id, source, kind, event_key, ts_start, attrs, ingested_at)
    VALUES (${userId}, 'derived', 'fact', ${`f-${n}`}, ${at},
      ${sql.json({ source_event_id: `m-${n}`, fact_id: String(n).padStart(40, "e"), fact_type: "ask", direction: "in", conversation_key: `gmail:t-${n}`, extractor: "fact-llm", extractor_version: "1" } as never)}, ${at})`;
}

describe("the counts agree with the feed over real open mail facts", () => {
  beforeEach(async () => {
    await sql`DELETE FROM activity_events WHERE user_id = ${userId}`;
  });

  it("factsOpen is the sum of the fact_open item weights, folds included, and counts.now is unchanged", async () => {
    await failingSync();
    const before = await feed();
    for (let n = 1; n <= 8; n += 1) await openFact(n, 0.2 + n * 0.1);
    resetAttentionCountsMemo();
    const counts = await readAttentionCounts(sql, { agent: "scribe", scopes: undefined });
    const answer = await feed();
    const facts = answer.items.filter((item) => item.kind === "fact_open");
    expect(facts.reduce((sum, item) => sum + weight(item), 0)).toBe(8);
    expect(facts.some((item) => item.folded === 3)).toBe(true);
    expect(counts.factsOpen).toBe(8);
    expect(counts.healthBlocking + counts.sourcesFailed + counts.checkInOpen + counts.catchUpDue).toBe(
      answer.counts.now
    );
    expect(answer.counts.now).toBe(before.counts.now);
    expect(answer.counts.soon + answer.counts.fyi).toBe(before.counts.soon + before.counts.fyi + 8);
  });

  it("a token without read:plan and the owner view see no facts, in the feed or the counts", async () => {
    await openFact(1, 0.5);
    resetAttentionCountsMemo();
    expect((await readAttentionCounts(sql, { agent: "scribe", scopes: ["read:proposals"] })).factsOpen).toBe(0);
    expect((await readAttentionCounts(sql, { agent: null, scopes: undefined })).factsOpen).toBe(0);
    expect((await feed({ scopes: ["read:proposals"] })).items.some((item) => item.kind === "fact_open")).toBe(false);
    expect((await feed({ agent: null })).items.some((item) => item.kind === "fact_open")).toBe(false);
  });

  it("a failed facts read is factsFailed in the counts and one soon item in the feed, and counts.now does not move", async () => {
    resetAttentionCountsMemo();
    const readers = {
      ...defaultAttentionReaders(sql),
      facts: async () => {
        throw new Error(`${SENTINEL} facts`);
      }
    };
    const counts = await readAttentionCounts(sql, { agent: "scribe", scopes: undefined }, readers);
    const result = await readAttention(sql, { agent: "scribe", scopes: undefined }, readers);
    if (!("answer" in result)) throw new Error("expected an answer");
    expect(counts).toMatchObject({ sourcesFailed: 0, factsFailed: 1, factsOpen: 0 });
    expect(result.answer.items.find((item) => item.id === "source_unavailable:facts")?.urgency).toBe("soon");
    expect(result.answer.complete).toBe(false);
    expect(counts.healthBlocking + counts.sourcesFailed + counts.checkInOpen + counts.catchUpDue).toBe(
      result.answer.counts.now
    );
    expect(result.answer.empty).toBeUndefined();
    expect(JSON.stringify(result.answer)).not.toContain(SENTINEL);
  });
});

describe("the four presets over a real fixture", () => {
  it.each(["read-only", "scribe", "assistant"])("%s: every pointer is safe to follow", async (name) => {
    await failingSync();
    await openCheckIn();
    await make({ status: "stale", resolvedAgo: "1 hour" });
    const scopes = AGENT_SCOPE_PRESETS[name] as readonly string[];
    const answer = await feed({ scopes });
    for (const item of answer.items) {
      if (item.nextCall && "tool" in item.nextCall)
        expect(attentionCallProblem(item.nextCall, scopes), `${item.id}`).toBeUndefined();
      if (item.source) expect(attentionCallProblem(item.source, scopes, { allowStatus: true })).toBeUndefined();
    }
  });
});

describe("the outcome reader is the one the feed uses", () => {
  it("returns a cursor-clock reading no earlier than the rows it delivered", async () => {
    await make({ status: "rejected", resolvedAgo: "1 minute" });
    const result = (await readProposalOutcomes(sql, userId, "scribe"))!;
    expect(Date.parse(result.queryNow)).toBeGreaterThan(Date.parse(result.outcomes[0]!.at));
  });
});
