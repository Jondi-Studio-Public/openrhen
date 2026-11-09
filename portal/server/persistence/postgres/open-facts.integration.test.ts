import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import { integrationDatabaseName } from "@openrhen/database";
import { ensureUser } from "./ensure-user";
import { ensureExtractorStateTx } from "./extractor-state-store";
import { readOpenFacts } from "./open-facts-store";

config({ path: resolve(process.cwd(), "../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(process.env.TEST_DATABASE_NAME, "openrhen_open_facts");

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
  await sql.begin((tx) => ensureExtractorStateTx(tx, userId, "fact-llm", "1", NOW));
});

afterAll(async () => {
  await sql?.end();
});

const NOW = new Date("2026-11-08T12:00:00.000Z");
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);
const ahead = (days: number) => new Date(NOW.getTime() + days * DAY);
const fid = (name: string) => name.padEnd(40, "0");

async function fact(
  name: string,
  tsStart: Date,
  extra: Record<string, unknown> = {},
  opts: { source?: string; version?: string; user?: string; ingested?: Date } = {}
): Promise<void> {
  const attrs = {
    source_event_id: `m-${name}`,
    fact_id: fid(name),
    fact_type: "ask",
    direction: "in",
    conversation_key: `gmail:th-${name}`,
    extractor: "fact-llm",
    extractor_version: opts.version ?? "1",
    ...extra
  };
  await sql`INSERT INTO activity_events (user_id, source, kind, event_key, ts_start, attrs, ingested_at)
    VALUES (${opts.user ?? userId}, ${opts.source ?? "derived"}, 'fact', ${`fact-${name}-${tsStart.getTime()}`}, ${tsStart}, ${sql.json(attrs as never)}, ${opts.ingested ?? NOW})`;
}
async function message(
  thread: string,
  tsStart: Date,
  fromSelf: boolean,
  extra: Record<string, unknown> = {},
  ingested = NOW
): Promise<void> {
  await sql`INSERT INTO activity_events (user_id, source, kind, event_key, ts_start, attrs, ingested_at)
    VALUES (${userId}, 'gmail', 'message', ${`g-${thread}-${tsStart.getTime()}-${fromSelf}`}, ${tsStart},
      ${sql.json({ thread_id: thread, from_self: fromSelf, ...extra } as never)}, ${ingested})`;
}
async function status(
  name: string,
  s: string,
  validFrom: Date | string,
  via: string | null,
  ingested = NOW
): Promise<void> {
  await sql`INSERT INTO activity_events (user_id, source, kind, event_key, ts_start, attrs, ingested_via, ingested_at)
    VALUES (${userId}, 'derived', 'fact_status', ${`st-${name}-${s}-${new Date(validFrom).getTime()}-${via}`}, ${ingested},
      ${sql.json({ fact_id: fid(name), status: s, valid_from: typeof validFrom === "string" ? validFrom : validFrom.toISOString() } as never)}, ${via}, ${ingested})`;
}
async function override(
  name: string,
  field: string,
  value: unknown,
  via: string | null,
  ingested = NOW
): Promise<void> {
  await sql`INSERT INTO activity_events (user_id, source, kind, event_key, ts_start, attrs, ingested_via, ingested_at)
    VALUES (${userId}, 'derived', 'override', ${`ov-${name}-${field}-${via}-${ingested.getTime()}`}, ${ingested},
      ${sql.json({ fact_id: fid(name), field, new_value: value } as never)}, ${via}, ${ingested})`;
}
const ids = async (options: Parameters<typeof readOpenFacts>[1] = {}) =>
  (await readOpenFacts(sql, { now: NOW, ...options })).facts.map((f) => f.factId);

async function rawFact(key: string, factId: string, tsStart: Date, extra: Record<string, unknown>): Promise<void> {
  const attrs = {
    source_event_id: "m-tier",
    fact_id: factId,
    fact_type: "deadline",
    direction: "in",
    conversation_key: "gmail:th-tier",
    extractor: "fact-llm",
    extractor_version: "1",
    ...extra
  };
  await sql`INSERT INTO activity_events (user_id, source, kind, event_key, ts_start, attrs, ingested_at)
    VALUES (${userId}, 'derived', 'fact', ${key}, ${tsStart}, ${sql.json(attrs as never)}, ${NOW})`;
}

describe("tier ranking and the daily cap (2b-6 readers)", () => {
  const when = (days: number) => ({ ambiguous: false, candidates: [{ start: ahead(days).toISOString() }] });

  it("a t3 row beats a t2 row of the same sentence whatever their keys, and the cap-held row is not shown", async () => {
    const id = fid("tier");
    for (const [t2key, t3key] of [
      ["a-key", "z-key"],
      ["z-key", "a-key"]
    ] as [string, string][]) {
      await sql`DELETE FROM activity_events WHERE user_id = ${userId} AND kind = 'fact'`;
      await rawFact(t2key, id, ago(1), { tier: "t2", when: when(3) });
      await rawFact(t3key, id, ago(1), { tier: "t3", when: when(5) });
      const read = await readOpenFacts(sql, { now: NOW });
      expect(read.facts.find((f) => f.factId === id)!.dueAt).toBe(ahead(5).toISOString());
    }
  });

  it("does not list a fact whose only row was held back by the cap, and lists low_signal", async () => {
    await rawFact("capped", fid("capped"), ago(1), { tier: "t3", review_reason: "over_cap", when: when(2) });
    await rawFact("low", fid("low"), ago(1), { tier: "t2", review_reason: "low_signal", when: when(2) });
    expect(await ids()).toEqual([fid("low")]);
  });
});

describe("readOpenFacts", () => {
  it("lists an unanswered ask, with the conversation's later messages deciding closure", async () => {
    await fact("a", ago(3));
    await fact("b", ago(3));
    await message("th-a", ago(2), true); // his reply closes a
    await message("th-b", ago(2), false); // an incoming message does not close b
    const read = await readOpenFacts(sql, { now: NOW });
    expect(read.facts.map((f) => f.factId)).toEqual([fid("b")]);
    expect(read.facts[0]).toMatchObject({ state: "open", factType: "ask", conversationKey: "gmail:th-b" });
    expect(read.total).toBe(1);
    expect(read.truncated).toBe(false);
  });

  it("closes on a status, with the person's word beating Mark's at the same instant, and reopens on a later repeat", async () => {
    await fact("a", ago(5));
    await status("a", "done", ago(4), "mark");
    await status("a", "confirmed", ago(4), null);
    await fact("b", ago(5));
    await status("b", "cancelled", ago(4), "mark");
    await fact("c", ago(6));
    await fact("c", ago(1)); // a repeated ask after the done below
    await status("c", "done", ago(3), null);
    expect((await ids()).sort()).toEqual([fid("a"), fid("c")].sort());
    const c = (await readOpenFacts(sql, { now: NOW })).facts.find((f) => f.factId === fid("c"))!;
    expect(c).toMatchObject({ state: "reopened", reopened: true });
  });

  it("applies overrides, and lets the person's beat Mark's", async () => {
    await fact("a", ago(30), {
      fact_type: "event",
      when: {
        ref_time: ago(30).toISOString(),
        tz: "UTC",
        candidates: [{ start: ago(1).toISOString() }],
        ambiguous: false
      }
    });
    expect(await ids()).toEqual([]);
    await override("a", "when", { start: ahead(2).toISOString() }, null);
    await override("a", "when", { start: ago(2).toISOString() }, "mark", ago(0.1));
    const [a] = (await readOpenFacts(sql, { now: NOW })).facts;
    expect(a).toMatchObject({ factId: fid("a"), dueAt: ahead(2).toISOString() });
  });

  it("resolves a cancel link at read, in either arrival order, and never lists the link row", async () => {
    const when = {
      ref_time: ago(9).toISOString(),
      tz: "UTC",
      candidates: [{ start: ahead(4).toISOString() }],
      ambiguous: false
    };
    await fact("c", ago(2), {
      fact_type: "event",
      conversation_key: "gmail:th-e",
      links: [{ relation: "cancel", target_fact_id: fid("e") }],
      when: { ref_time: ago(2).toISOString(), tz: "UTC", candidates: [], ambiguous: true }
    }); // the cancel is written before the invite it targets (backfill runs newest first)
    await fact("e", ago(9), { fact_type: "event", conversation_key: "gmail:th-e", when });
    await fact("f", ago(9), { fact_type: "event", when });
    expect(await ids()).toEqual([fid("f")]);
  });

  it("returns timed items soonest first, then the rest newest first", async () => {
    const when = (days: number) => ({
      ref_time: ago(2).toISOString(),
      tz: "UTC",
      candidates: [{ start: ahead(days).toISOString() }],
      ambiguous: false
    });
    await fact("old", ago(9));
    await fact("new", ago(1));
    await fact("late", ago(2), { fact_type: "event", when: when(6) });
    await fact("soon", ago(2), { fact_type: "deadline", when: when(1) });
    expect(await ids()).toEqual([fid("soon"), fid("late"), fid("new"), fid("old")]);
    expect(await ids({ limit: 2 })).toEqual([fid("soon"), fid("late")]);
    expect((await readOpenFacts(sql, { now: NOW, limit: 2 })).total).toBe(4);
  });

  it("shows only the active version's rows, never the shadow source, and only this person's", async () => {
    const other = (await sql<{ id: string }[]>`INSERT INTO users (display_name) VALUES ('Other') RETURNING id`)[0]!.id;
    await fact("a", ago(1));
    await fact("b", ago(1), {}, { version: "2" });
    await fact("c", ago(1), {}, { source: "derived-shadow" });
    await fact("d", ago(1), {}, { user: other });
    expect(await ids()).toEqual([fid("a")]);
  });

  it("only the horizon surfaces from a three-year backlog: the read looks at the horizon's rows, not all of them", async () => {
    // One unanswered ask a day for three years, written by a backfill.
    await sql`
      INSERT INTO activity_events (user_id, source, kind, event_key, ts_start, attrs, ingested_at)
      SELECT ${userId}, 'derived', 'fact', 'bulk-' || d, ${NOW}::timestamptz - d * interval '1 day',
        jsonb_build_object('source_event_id', 'm-' || d, 'fact_id', substr(md5(d::text) || md5(d::text || 'x'), 1, 40),
          'fact_type', 'ask', 'direction', 'in', 'conversation_key', 'gmail:bulk-' || d,
          'extractor', 'fact-llm', 'extractor_version', '1'), ${NOW}
      FROM generate_series(0, 1094) AS d`;
    // And noise a plain fact scan would have to walk: a class row per day.
    await sql`
      INSERT INTO activity_events (user_id, source, kind, event_key, ts_start, attrs, ingested_at)
      SELECT ${userId}, 'derived', 'msg_class', 'cls-' || d, ${NOW}::timestamptz - d * interval '1 day',
        jsonb_build_object('source_event_id', 'm-' || d, 'class', 'person', 'reasons', '[]'::jsonb,
          'extractor', 'fact-llm', 'extractor_version', '1'), ${NOW}
      FROM generate_series(0, 1094) AS d`;
    // A deadline mentioned 100 days ago for tomorrow is inside the horizon; one mentioned 200 days ago is not read.
    const tomorrow = {
      ref_time: ago(100).toISOString(),
      tz: "UTC",
      candidates: [{ start: ahead(1).toISOString() }],
      ambiguous: false
    };
    await fact("near", ago(100), { fact_type: "deadline", when: tomorrow });
    await fact("far", ago(200), { fact_type: "deadline", when: tomorrow });
    const read = await readOpenFacts(sql, { now: NOW });
    expect(read.scanned.facts).toBeLessThanOrEqual(122); // the 120-day horizon (121 daily rows) plus the near deadline
    expect(read.scanned.facts).toBeGreaterThanOrEqual(120);
    expect(read.facts.map((f) => f.factId)).toContain(fid("near"));
    expect(read.facts.map((f) => f.factId)).not.toContain(fid("far"));
    // Asks age out after 14 days: only the newest 14 of the three years are open, plus the deadline.
    expect(read.total).toBe(15);
    expect(read.horizon.days).toBe(120);
    expect(read.truncated).toBe(false);
    // A narrower horizon reads fewer rows.
    const narrow = await readOpenFacts(sql, { now: NOW, horizonDays: 10 });
    expect(narrow.scanned.facts).toBeLessThanOrEqual(11);
  });

  it("is bounded by maxRows and says so when the horizon holds more", async () => {
    for (let i = 0; i < 6; i++) await fact(`k${i}`, ago(1 + i / 10));
    const read = await readOpenFacts(sql, { now: NOW, maxRows: 4 });
    expect(read.truncated).toBe(true);
    expect(read.scanned.facts).toBe(4);
    expect(read.facts).toHaveLength(4);
    expect(read.problems.join(" ")).toContain("horizonDays");
  });

  it("does not read statuses or messages from outside what the facts need", async () => {
    await fact("a", ago(1));
    await message("th-a", ago(0.5), false);
    await message("th-other", ago(0.5), true);
    await status("zz", "done", ago(1), null);
    const read = await readOpenFacts(sql, { now: NOW });
    expect(read.scanned).toMatchObject({ facts: 1, statuses: 0, messages: 1 });
  });

  it("skips a fact row it cannot read instead of failing the read", async () => {
    await fact("a", ago(1));
    await sql`INSERT INTO activity_events (user_id, source, kind, event_key, ts_start, attrs)
      VALUES (${userId}, 'derived', 'fact', 'broken', ${ago(1)}, ${sql.json({ extractor: "fact-llm", extractor_version: "1", fact_type: 7 } as never)})`;
    const read = await readOpenFacts(sql, { now: NOW });
    expect(read.facts.map((f) => f.factId)).toEqual([fid("a")]);
    expect(read.problems.join(" ")).toContain("1 fact row");
  });

  it("ignores an auto-reply when deciding whether he answered", async () => {
    await fact("a", ago(3));
    await fact("b", ago(3));
    await message("th-a", ago(2), true, { auto_submitted: "auto-replied" });
    await message("th-b", ago(2), true, { auto_submitted: "no" });
    expect(await ids()).toEqual([fid("a")]);
  });

  it("clamps a status to when it was recorded, so a far-future valid_from cannot pin a fact open", async () => {
    await fact("a", ago(4));
    await status("a", "proposed", "2199-01-01T00:00:00Z", "mark", ago(3));
    await status("a", "done", ago(1), null, ago(1));
    expect(await ids()).toEqual([]);
  });

  it("dates a fact no later than it was recorded, so a future-dated message cannot reopen a closure", async () => {
    await fact("a", ago(6));
    await fact("a", new Date(NOW.getTime() + 23 * 3_600_000), {}, { ingested: ago(0.01) });
    await status("a", "done", NOW, null, NOW);
    expect(await ids()).toEqual([]);
  });

  it("a future-dated reply does not outlive its record: it is dated by when it arrived", async () => {
    await fact("a", ago(3));
    await message("th-a", new Date(NOW.getTime() + 20 * 3_600_000), true, {}, ago(2.5));
    expect(await ids()).toEqual([]);
  });

  it("says plainly that facts whose message is older than the horizon are not read", async () => {
    await fact("a", ago(1));
    const read = await readOpenFacts(sql, { now: NOW, horizonDays: 30 });
    expect(read.problems.join(" ")).toMatch(/older than 30 days are not read/);
    expect(read.problems.join(" ")).toContain("horizonDays");
  });

  it("an orphan link row is listed and a link that names its target cancels only it", async () => {
    const when = {
      ref_time: ago(9).toISOString(),
      tz: "UTC",
      candidates: [{ start: ahead(4).toISOString() }],
      ambiguous: false
    };
    await fact("m", ago(2), {
      fact_type: "event",
      links: [{ relation: "reschedule", target_fact_id: fid("gone") }],
      when
    });
    expect(await ids()).toEqual([fid("m")]);
  });
  it("fact-ics rows: a held unmatched_update and an orphan cancel link are not listed; a cancel of a held event closes it", async () => {
    await sql.begin((tx) => ensureExtractorStateTx(tx, userId, "fact-ics", "1", NOW));
    const ics = { extractor: "fact-ics", fact_type: "event", ics_uid: "u1" };
    const when = {
      ref_time: ago(9).toISOString(),
      tz: "UTC",
      candidates: [{ start: ahead(4).toISOString() }],
      ambiguous: false
    };
    // A real event, a held (unmatched) update of the same uid under its own id, and a cancel naming an event that is gone.
    await fact("e", ago(5), { ...ics, ics_sequence: 0, when });
    await fact("held", ago(1), { ...ics, ics_sequence: 3, review_reason: "unmatched_update" });
    await fact("orphan", ago(1), {
      ...ics,
      ics_sequence: 2,
      links: [{ relation: "cancel", target_fact_id: fid("gone") }]
    });
    expect(await ids()).toEqual([fid("e")]);
    // The same event with a cancel that names it: closed, and the cancel row is a link, not a listing.
    await fact("c", ago(1), { ...ics, ics_sequence: 1, links: [{ relation: "cancel", target_fact_id: fid("e") }] });
    expect(await ids()).toEqual([]);
  });
});
