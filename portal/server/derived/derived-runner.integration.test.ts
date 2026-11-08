import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import { integrationDatabaseName } from "@openrhen/database";
import { purgeActivitySource } from "@/server/persistence/postgres/activity-store";
import { ensureUser } from "@/server/persistence/postgres/ensure-user";
import { waitUntilBlocked } from "@/server/persistence/postgres/wait-until-blocked";
import { runDerivedTick } from "./derived-runner";
import type { Extractor } from "./extractor";
import { msgClassT0 } from "./msg-class-t0";

config({ path: resolve(process.cwd(), "../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(process.env.TEST_DATABASE_NAME, "openrhen_derived_runner");

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let userId: string;

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
  sql = postgres(testUrl.toString(), { max: 5, connect_timeout: 10, fetch_types: false });
}, 60_000);

beforeEach(async () => {
  await sql.unsafe("TRUNCATE TABLE users RESTART IDENTITY CASCADE");
  userId = await ensureUser(sql);
});

afterAll(async () => {
  await sql?.end();
});

const T = new Date("2026-11-08T00:00:00.000Z");
const at = (seconds: number) => new Date(T.getTime() + seconds * 1000);
const BULK = { message_id: "<a@x>", list_id: "<news.example.com>", from: "News <news@example.com>" };

let counter = 0;
/** A gmail message row with an exact `ingested_at`. */
async function mail(ingested: Date, attrs: unknown = BULK, user = userId, id?: string): Promise<string> {
  counter += 1;
  const [made] = await sql<{ id: string }[]>`
    INSERT INTO activity_events (user_id, source, kind, event_key, ts_start, attrs, ingested_at ${id ? sql`, id` : sql``})
    VALUES (${user}, 'gmail', 'message', ${`g${counter}`}, ${ingested}, ${sql.json(attrs as never)}, ${ingested} ${id ? sql`, ${id}` : sql``})
    RETURNING id`;
  return made!.id;
}
const classified = async () =>
  (
    await sql<{ source_event_id: string; class: string }[]>`
      SELECT attrs->>'source_event_id' AS source_event_id, attrs->>'class' AS class
      FROM activity_events WHERE source = 'derived' AND kind = 'msg_class' ORDER BY event_key`
  ).length;
const derivedRows = () =>
  sql<{ kind: string; ingested_via: string; attrs: Record<string, unknown>; key: string }[]>`
    SELECT kind, ingested_via, attrs, event_key AS key FROM activity_events WHERE source = 'derived'`;
const lineage = async () => (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM derived_lineage`)[0]!.n;
const cursorOf = async () =>
  (
    await sql<{ cursor: Record<string, any>; last_ok_at: Date | null; last_error: string | null }[]>`
    SELECT cursor, last_ok_at, last_error FROM extractor_state WHERE extractor = 'msg-class-t0' AND active`
  )[0]!;
const tick = (seconds: number, extra: Parameters<typeof runDerivedTick>[1] = {}) =>
  runDerivedTick(sql, { now: () => at(seconds), ...extra });

describe("msg-class-t0 runner", () => {
  it("classifies live mail and history, one msg_class row per message, in the fixed extractor name", async () => {
    await mail(at(-3600));
    await tick(0); // first run: both watermarks start now
    await mail(at(10), { message_id: "<b@x>", auto_submitted: "auto-generated" });
    const result = await tick(600);
    expect(result).toMatchObject({ status: "ok" });
    const rows = await derivedRows();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.kind === "msg_class" && r.ingested_via === "extractor:msg-class-t0")).toBe(true);
    expect(rows.map((r) => r.attrs.class).sort()).toEqual(["automated", "bulk"]);
    expect(rows[0]!.attrs).toMatchObject({ tier: "t0", extractor: "msg-class-t0", extractor_version: "1" });
    expect(await lineage()).toBe(2);
  });

  it("writes nothing for mail with no headers, and does not read it again: it never loops", async () => {
    await mail(at(-100), {});
    await mail(at(-90), { subject: "hello" });
    const first = await tick(0);
    const second = await tick(100);
    const third = await tick(200);
    expect(await derivedRows()).toHaveLength(0);
    expect(first).toMatchObject({ extractors: [{ backfillScanned: 2, unknown: 2 }] });
    expect(second).toMatchObject({ extractors: [{ backfillScanned: 0, forwardScanned: 0, unknown: 0 }] });
    expect(third).toMatchObject({ extractors: [{ backfillScanned: 0, forwardScanned: 0 }] });
  });

  it("runs forward work before backfill work in the same tick, and bounds both", async () => {
    await tick(0); // watermarks at T
    for (let i = 0; i < 6; i++) await mail(at(-1000 + i)); // history
    for (let i = 0; i < 3; i++) await mail(at(100 + i)); // live
    const result = await tick(1000, { forwardBatch: 2, backfillBatch: 2 });
    expect(result).toMatchObject({ more: true, extractors: [{ forwardScanned: 2, backfillScanned: 2 }] });
    const done = await sql<{ ts: Date }[]>`
      SELECT g.ingested_at AS ts FROM activity_events d
      JOIN derived_lineage l ON l.derived_id = d.id JOIN activity_events g ON g.id = l.source_id`;
    const times = done.map((r) => r.ts.getTime()).sort((a, b) => a - b);
    // The two oldest live rows, and the two NEWEST history rows.
    expect(times).toEqual([at(-996), at(-995), at(100), at(101)].map((d) => d.getTime()));
  });

  it("drains a backlog over ticks, newest history first, with nothing skipped or repeated", async () => {
    for (let i = 0; i < 11; i++) await mail(at(-2000 + i * 10));
    await tick(0, { backfillBatch: 4 });
    let guard = 0;
    for (;;) {
      guard += 1;
      const r = await tick(10 * guard, { backfillBatch: 4 });
      if (r.status === "ok" && !r.more) break;
      expect(guard).toBeLessThan(10);
    }
    expect(await classified()).toBe(11);
    const total = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM activity_events WHERE source = 'derived'`;
    expect(total[0]!.n).toBe(11);
    expect((await cursorOf()).cursor.backfill.at).toBe("2026-11-07T23:26:40.000000Z");
  });

  it("does not skip or repeat rows that share an ingested_at across a batch boundary (forward)", async () => {
    await tick(0);
    const same = at(100);
    for (let i = 0; i < 7; i++) await mail(same);
    const seen: number[] = [];
    for (let i = 1; i <= 4; i++) {
      const r = await tick(1000 + i, { forwardBatch: 3 });
      seen.push(r.status === "ok" ? r.extractors[0]!.forwardScanned : -1);
    }
    expect(seen).toEqual([3, 3, 1, 0]);
    expect(await classified()).toBe(7);
  });

  it("does not skip or repeat rows that share an ingested_at across a batch boundary (backfill)", async () => {
    const same = at(-500);
    for (let i = 0; i < 7; i++) await mail(same);
    const seen: number[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await tick(i, { backfillBatch: 3 });
      seen.push(r.status === "ok" ? r.extractors[0]!.backfillScanned : -1);
    }
    expect(seen).toEqual([3, 3, 1, 0]);
    expect(await classified()).toBe(7);
  });

  it("holds back mail newer than the settle margin, then reads it", async () => {
    await tick(0);
    await mail(at(100));
    await tick(110, { settleMs: 60_000 });
    expect(await classified()).toBe(0);
    await tick(170, { settleMs: 60_000 });
    expect(await classified()).toBe(1);
  });

  it("is idempotent: a rerun with the cursor wound back adds no rows and no links", async () => {
    await mail(at(-100));
    await tick(0);
    expect(await classified()).toBe(1);
    await sql`UPDATE extractor_state SET cursor = cursor - 'backfill' - 'forward'`;
    const r = await tick(10, { settleMs: 0 });
    expect(r).toMatchObject({ extractors: [{ alreadyHeld: 1, written: 0 }] });
    expect(await classified()).toBe(1);
    expect(await lineage()).toBe(1);
  });

  it("leaves other people's mail alone", async () => {
    const other = (await sql<{ id: string }[]>`INSERT INTO users (display_name) VALUES ('Other') RETURNING id`)[0]!.id;
    await mail(at(-100), BULK, other);
    await tick(0);
    expect(await classified()).toBe(0);
  });

  it("never writes a fact_status, override or label, whatever the mail", async () => {
    for (const attrs of [
      BULK,
      { message_id: "<m>", ics: { uid: "u1" } },
      { message_id: "<r>", subject: "Your order" },
      []
    ])
      await mail(at(-100), attrs);
    for (let i = 0; i < 4; i++) await tick(i);
    const kinds = new Set((await derivedRows()).map((r) => r.kind));
    expect([...kinds]).toEqual(["msg_class"]);
    expect(await sql`SELECT 1 FROM activity_events WHERE kind IN ('fact_status','override','label')`).toHaveLength(0);
  });

  it("runs only the active version of an extractor", async () => {
    await mail(at(-100));
    await tick(0);
    const v2: Extractor = { ...msgClassT0, version: "2" };
    const r = await tick(10, { extractors: [v2] });
    expect(r).toMatchObject({ extractors: [{ version: "2", status: "inactive" }] });
    expect(await sql`SELECT 1 FROM extractor_state WHERE version = '2' AND NOT active`).toHaveLength(1);
  });

  it("records last_ok_at on every completed tick", async () => {
    await tick(0);
    expect((await cursorOf()).last_ok_at).toEqual(at(0));
    await tick(50);
    expect((await cursorOf()).last_ok_at).toEqual(at(50));
  });
});

describe("first run and odd dates", () => {
  it("classifies a message dated in the far future, with the row dated no later than now", async () => {
    const [made] = await sql<{ id: string }[]>`
      INSERT INTO activity_events (user_id, source, kind, event_key, ts_start, attrs, ingested_at)
      VALUES (${userId}, 'gmail', 'message', 'future', '2027-06-01T00:00:00Z', ${sql.json(BULK as never)}, ${at(-100)}) RETURNING id`;
    expect(made).toBeTruthy();
    await tick(0);
    const rows = await sql<{ ts_start: Date }[]>`SELECT ts_start FROM activity_events WHERE source = 'derived'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ts_start.getTime()).toBeLessThanOrEqual(at(0).getTime());
    expect((await cursorOf()).cursor.skipped).toBe(0);
  });

  it("does not lose a row committed after the first run began, whose ingest began 30 s before it", async () => {
    await mail(at(-500));
    await tick(0, { backfillBatch: 1 });
    await mail(at(-30)); // a slow ingest that started before the first tick and committed after it
    for (let i = 1; i <= 6; i++) await tick(i * 100);
    expect(await classified()).toBe(2);
  });
});

describe("failures", () => {
  it("keeps the ids of skipped messages with a reason code, last 50 only", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 53; i++) ids.push(await mail(at(-1000 + i), "bad"));
    for (let i = 0; i < 3; i++) await tick(i, { backfillBatch: 500 });
    const state = await cursorOf();
    expect(state.cursor.skipped).toBe(53);
    expect(state.cursor.skippedIds).toHaveLength(50);
    expect(state.cursor.skippedIds[0]).toMatchObject({
      id: expect.any(String),
      key: expect.stringMatching(/^g/),
      code: "extractor_error"
    });
    expect(new Set(state.cursor.skippedIds.map((x: { id: string }) => x.id)).size).toBe(50);
    expect(ids.length).toBe(53);
    await tick(10);
    expect((await cursorOf()).cursor.skippedIds).toHaveLength(50);
  });

  it("records a refused row with its own code", async () => {
    const refused = await mail(at(-100));
    const bad: Extractor = {
      ...msgClassT0,
      extract(message, now) {
        const rows = msgClassT0.extract(message, now) as { attrs: Record<string, unknown> }[];
        rows[0]!.attrs.class = "spam";
        return rows;
      }
    };
    for (let i = 0; i < 3; i++) await tick(i, { extractors: [bad] });
    expect((await cursorOf()).cursor.skippedIds[0]).toMatchObject({ id: refused, code: "row_refused" });
  });

  it("counts a malformed message as a failure of that message alone, retries it, then skips it and says so", async () => {
    const bad = await mail(at(-100), ["not", "an", "object"]);
    await mail(at(-90));
    await tick(0);
    expect(await classified()).toBe(1);
    let state = await cursorOf();
    expect(state.cursor.retries[bad]).toEqual({ n: 1 });
    expect(state.last_error).toContain("attrs");
    expect(state.cursor.skipped).toBe(0);
    await tick(10);
    expect((await cursorOf()).cursor.retries[bad]).toEqual({ n: 2 });
    const third = await tick(20);
    expect(third).toMatchObject({ extractors: [{ skipped: 1 }] });
    state = await cursorOf();
    expect(state.cursor.retries[bad]).toBeUndefined();
    expect(state.cursor.skipped).toBe(1);
    expect(state.last_error).toBeTruthy();
    expect(state.last_ok_at).toEqual(at(20));
    const after = await tick(30);
    expect(after).toMatchObject({ extractors: [{ retried: 0, failed: 0, skipped: 0 }] });
    expect((await cursorOf()).last_error).toBeNull();
    expect(await sql`SELECT 1 FROM activity_events WHERE kind IN ('fact_status','override','label')`).toHaveLength(0);
  });

  it("treats a classifier that throws, and a row the validators refuse, as failures of that message only", async () => {
    const ok = await mail(at(-100));
    const throws = await mail(at(-99));
    const refused = await mail(at(-98));
    const picky: Extractor = {
      ...msgClassT0,
      extract(message, now) {
        if (message.id === throws) throw new Error("boom");
        const rows = msgClassT0.extract(message, now) as { attrs: Record<string, unknown> }[];
        if (message.id === refused) rows[0]!.attrs.class = "spam";
        return rows;
      }
    };
    const r = await tick(0, { extractors: [picky] });
    expect(r).toMatchObject({ extractors: [{ written: 1, failed: 2 }] });
    expect(await classified()).toBe(1);
    const state = await cursorOf();
    expect(Object.keys(state.cursor.retries).sort()).toEqual([refused, throws].sort());
    expect(state.last_error).toMatch(/failed/);
    expect(ok).toBeTruthy();
  });

  it("forgets a failing message that has been deleted", async () => {
    const bad = await mail(at(-100), "text");
    await tick(0);
    expect((await cursorOf()).cursor.retries[bad]).toEqual({ n: 1 });
    await sql`DELETE FROM activity_events WHERE id = ${bad}`;
    await tick(10);
    expect((await cursorOf()).cursor.retries).toEqual({});
  });

  it("caps the retry list: past the cap a failing message is skipped at once", async () => {
    for (let i = 0; i < 103; i++) await mail(at(-1000 + i), "bad");
    const r = await tick(0, { backfillBatch: 500 });
    const state = await cursorOf();
    expect(Object.keys(state.cursor.retries)).toHaveLength(100);
    expect(state.cursor.skipped).toBe(3);
    expect(r).toMatchObject({ extractors: [{ failed: 100, skipped: 3 }] });
  });

  it("rolls the whole tick back on a database error, so the cursor does not pass unwritten rows", async () => {
    await mail(at(-100));
    // A database error the runner cannot see coming: the insert violates a constraint added for this test only.
    await sql`ALTER TABLE activity_events ADD CONSTRAINT runner_test_never CHECK (kind <> 'msg_class')`;
    try {
      await expect(tick(0)).rejects.toThrow();
    } finally {
      await sql`ALTER TABLE activity_events DROP CONSTRAINT runner_test_never`;
    }
    expect(await sql`SELECT 1 FROM extractor_state`).toHaveLength(0);
    expect(await classified()).toBe(0);
  });
});

describe("overlapping runs and deletes", () => {
  it("answers busy and writes nothing while another run holds the lock, scheduled or manual alike", async () => {
    await mail(at(-100));
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const holder = sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`activity_store:${userId}`}, 0))`;
      await held;
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(await tick(0)).toEqual({ status: "busy" });
    expect(await tick(1)).toEqual({ status: "busy" });
    expect(await classified()).toBe(0);
    release();
    await holder;
    expect(await tick(2)).toMatchObject({ status: "ok" });
    expect(await classified()).toBe(1);
  });

  it("two simultaneous runs write each row once", async () => {
    for (let i = 0; i < 20; i++) await mail(at(-1000 + i));
    const results = await Promise.all([tick(0), tick(0), tick(0)]);
    expect(results.filter((r) => r.status === "ok").length).toBeGreaterThanOrEqual(1);
    for (let i = 0; i < 3; i++) await tick(10 + i);
    expect(await classified()).toBe(20);
    expect(await lineage()).toBe(20);
  });

  it("a delete of the source rows waits for the run, then takes the derived rows and lineage with it: no orphans", async () => {
    await mail(at(-100));
    let reading!: () => void;
    let proceed!: () => void;
    const started = new Promise<void>((r) => (reading = r));
    const gate = new Promise<void>((r) => (proceed = r));
    // The run has read the message and holds the lock; it writes only after the gate opens.
    const slow: Extractor = {
      ...msgClassT0,
      async extract(message, now) {
        reading();
        await gate;
        return msgClassT0.extract(message, now);
      }
    };
    const run = tick(0, { extractors: [slow] });
    await started;
    const purge = purgeActivitySource(sql, "gmail");
    await waitUntilBlocked(sql, { queryLike: "%pg_advisory_xact_lock%" });
    proceed();
    await run;
    await purge;
    expect(await sql`SELECT 1 FROM activity_events WHERE source = 'gmail'`).toHaveLength(0);
    expect(await derivedRows()).toHaveLength(0);
    expect(await lineage()).toBe(0);
  });

  it("a purge waits while a run holds the lock", async () => {
    await mail(at(-100));
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const holder = sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`activity_store:${userId}`}, 0))`;
      await held;
    });
    await new Promise((r) => setTimeout(r, 100));
    let finished = false;
    const purge = purgeActivitySource(sql, "gmail").then((v) => ((finished = true), v));
    await waitUntilBlocked(sql, { queryLike: "%pg_advisory_xact_lock%" });
    expect(finished).toBe(false);
    release();
    await holder;
    expect(await purge).toEqual({ removed: 1 });
  });
});
