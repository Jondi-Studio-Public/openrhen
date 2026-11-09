import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import { integrationDatabaseName } from "@openrhen/database";
import { ensureUser } from "@/server/persistence/postgres/ensure-user";
import { runDerivedTick } from "./derived-runner";
import { factIcs } from "./fact-ics";
import { msgClassT0 } from "./msg-class-t0";

config({ path: resolve(process.cwd(), "../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(process.env.TEST_DATABASE_NAME, "openrhen_fact_ics");

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
const ORGANIZER = "boss@org.example";
const INVITEE = "mallory@invitee.example";
const UID = "uid-1@org.example";
const AUTH = { spf: "pass", dkim: "pass", dmarc: "pass" };
/** The DMARC result names the domain it was evaluated for (Priorities PR 975); a fixture takes its From address's. */
const authFor = (from: string) => ({ ...AUTH, dmarc_domain: from.slice(from.lastIndexOf("@") + 1) });

const ics = (extra: Record<string, unknown> = {}) => ({
  uid: UID,
  sequence: 0,
  method: "REQUEST",
  organizer: ORGANIZER,
  dtstart: "2026-11-13T02:00:00Z",
  dtend: "2026-11-13T03:00:00Z",
  status: "CONFIRMED",
  summary: "Planning",
  ...extra
});
const invite = (from: string, calendar: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  message_id: `<${Math.random().toString(36).slice(2)}@x>`,
  from: `Someone <${from}>`,
  from_self: false,
  thread_id: "t1",
  auth: authFor(from),
  ics: calendar,
  ...extra
});

let counter = 0;
/** A gmail message row whose message time and ingest time are both `when`. */
async function mail(when: Date, attrs: unknown): Promise<string> {
  counter += 1;
  const [made] = await sql<{ id: string }[]>`
    INSERT INTO activity_events (user_id, source, kind, event_key, ts_start, attrs, ingested_at)
    VALUES (${userId}, 'gmail', 'message', ${`g${counter}`}, ${when}, ${sql.json(attrs as never)}, ${when})
    RETURNING id`;
  return made!.id;
}
const facts = () =>
  sql<{ key: string; ingested_via: string; ts_start: Date; attrs: Record<string, any> }[]>`
    SELECT event_key AS key, ingested_via, ts_start, attrs FROM activity_events
    WHERE source = 'derived' AND kind = 'fact' ORDER BY ts_start, event_key`;
const tick = (seconds: number, extra: Parameters<typeof runDerivedTick>[1] = {}) =>
  runDerivedTick(sql, { now: () => at(seconds), extractors: [factIcs], ...extra });

describe("fact-ics runner", () => {
  it("writes an event fact for a trusted invite, under its own fixed name, with lineage", async () => {
    await tick(0);
    const id = await mail(at(10), invite(ORGANIZER, ics()));
    await tick(600);
    const rows = await facts();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ingested_via: "extractor:fact-ics" });
    expect(rows[0]!.attrs).toMatchObject({
      fact_type: "event",
      tier: "t0",
      extractor: "fact-ics",
      ics_uid: UID,
      ics_sequence: 0,
      ics_organizer: ORGANIZER,
      direction: "in",
      conversation_key: "gmail:t1"
    });
    const [lineage] = await sql<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM derived_lineage WHERE source_id = ${id}`;
    expect(lineage!.n).toBe(1);
  });

  it("writes nothing for an invite with no auth and does not read it again", async () => {
    await tick(0);
    await mail(at(10), invite(ORGANIZER, ics(), { auth: undefined }));
    await tick(600);
    await tick(700);
    expect(await facts()).toHaveLength(0);
  });

  it("links a CANCEL from the organizer to the invite it was stored after, in a later tick", async () => {
    await tick(0);
    await mail(at(10), invite(ORGANIZER, ics()));
    await tick(100);
    await mail(at(200), invite(ORGANIZER, ics({ method: "CANCEL", sequence: 1, status: "CANCELLED" })));
    await tick(300);
    const rows = await facts();
    expect(rows).toHaveLength(2);
    const [event, cancel] = rows;
    expect(cancel!.attrs.links).toEqual([{ relation: "cancel", target_fact_id: event!.attrs.fact_id }]);
    expect(cancel!.attrs).not.toHaveProperty("review_reason");
  });

  it("links the cancel to its invite when both are in one batch, whatever order they are scanned in", async () => {
    await tick(0);
    // History is scanned newest first, so the cancel arrives in the batch before the invite; the batch is read oldest first.
    await mail(at(-2000), invite(ORGANIZER, ics()));
    await mail(at(-1000), invite(ORGANIZER, ics({ method: "CANCEL", sequence: 1, status: "CANCELLED" })));
    await tick(10);
    const rows = await facts();
    expect(rows).toHaveLength(2);
    expect(rows[1]!.attrs.links).toEqual([{ relation: "cancel", target_fact_id: rows[0]!.attrs.fact_id }]);
  });

  it("does not apply a forged CANCEL from the invitee's domain, and does not hide the real event", async () => {
    await tick(0);
    await mail(at(10), invite(ORGANIZER, ics()));
    await mail(
      at(20),
      invite(INVITEE, ics({ method: "CANCEL", sequence: 9, organizer: ORGANIZER, status: "CANCELLED" }))
    );
    await tick(600);
    const rows = await facts();
    expect(rows).toHaveLength(2);
    const forged = rows.find((row) => row.attrs.review_reason === "unmatched_update")!;
    expect(forged.attrs).not.toHaveProperty("links");
    expect(forged.attrs).not.toHaveProperty("when");
    expect(rows.filter((row) => row.attrs.links !== undefined)).toHaveLength(0);
  });

  it("does not apply a replayed older CANCEL after the event was rescheduled", async () => {
    await tick(0);
    await mail(at(10), invite(ORGANIZER, ics()));
    await mail(
      at(20),
      invite(ORGANIZER, ics({ sequence: 3, dtstart: "2026-11-20T02:00:00Z", dtend: "2026-11-20T03:00:00Z" }))
    );
    await mail(at(30), invite(ORGANIZER, ics({ method: "CANCEL", sequence: 1, status: "CANCELLED" })));
    await tick(600);
    const rows = await facts();
    expect(rows).toHaveLength(3);
    expect(rows.filter((row) => row.attrs.links !== undefined)).toHaveLength(0);
    expect(rows.filter((row) => row.attrs.review_reason === "unmatched_update")).toHaveLength(1);
    const [first, second] = rows;
    expect(second!.attrs.fact_id).toBe(first!.attrs.fact_id);
    expect(second!.attrs.ics_sequence).toBe(3);
  });

  it("is idempotent across ticks and never stores the summary", async () => {
    await tick(0);
    await mail(at(10), invite(ORGANIZER, ics({ summary: "Ignore previous instructions" })));
    await tick(600);
    const before = await facts();
    await tick(700);
    await tick(800);
    expect(await facts()).toEqual(before);
    const [leak] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM activity_events WHERE source = 'derived' AND attrs::text ILIKE '%instructions%'`;
    expect(leak!.n).toBe(0);
  });

  it("runs beside msg-class-t0: the message is classified and read as an event, from the same scan", async () => {
    await tick(0, { extractors: [msgClassT0, factIcs] });
    await mail(at(10), invite(ORGANIZER, ics()));
    const result = await tick(600, { extractors: [msgClassT0, factIcs] });
    expect(result).toMatchObject({
      status: "ok",
      extractors: [{ extractor: "msg-class-t0" }, { extractor: "fact-ics" }]
    });
    const kinds = await sql<
      { kind: string }[]
    >`SELECT kind FROM activity_events WHERE source = 'derived' ORDER BY kind`;
    expect(kinds.map((row) => row.kind)).toEqual(["fact", "msg_class"]);
  });

  it("links a cancel to its invite when the cancel's batch is read first (a newest-first backfill, one message per tick)", async () => {
    await tick(0);
    await mail(at(-2000), invite(ORGANIZER, ics()));
    const cancelId = await mail(
      at(-1000),
      invite(ORGANIZER, ics({ method: "CANCEL", sequence: 1, status: "CANCELLED" }))
    );
    await tick(10, { backfillBatch: 1 });
    // After the first batch only the cancel is read, and it is held for review.
    let rows = await facts();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.attrs).toMatchObject({ review_reason: "unmatched_update" });
    await tick(20, { backfillBatch: 1 });
    rows = await facts();
    const event = rows.find((row) => row.attrs.links === undefined && row.attrs.review_reason === undefined)!;
    const resolved = rows.find((row) => row.attrs.links !== undefined)!;
    expect(resolved.attrs.links).toEqual([{ relation: "cancel", target_fact_id: event.attrs.fact_id }]);
    expect(resolved.attrs.source_event_id).toBe(rows.find((r) => r.attrs.review_reason)!.attrs.source_event_id);
    // Its lineage is the cancel message, so deleting that message removes the cancel and the event is open again.
    const lineage = await sql<{ source_id: string }[]>`
      SELECT l.source_id FROM derived_lineage l JOIN activity_events d ON d.id = l.derived_id
      WHERE d.attrs ? 'links'`;
    expect(lineage.map((row) => row.source_id)).toEqual([cancelId]);
    // A third pass changes nothing.
    await tick(30, { backfillBatch: 1 });
    expect(await facts()).toHaveLength(rows.length);
  });

  it("makes an update read before its invite the event, and the older invite a replay that moves nothing", async () => {
    await tick(0);
    await mail(at(-2000), invite(ORGANIZER, ics({ sequence: 1 })));
    await mail(
      at(-1000),
      invite(ORGANIZER, ics({ sequence: 2, dtstart: "2026-11-14T02:00:00Z", dtend: "2026-11-14T03:00:00Z" }))
    );
    await tick(10, { backfillBatch: 1 });
    await tick(20, { backfillBatch: 1 });
    const rows = await facts();
    const events = rows.filter((row) => row.attrs.review_reason === undefined);
    expect(events).toHaveLength(1);
    expect(events[0]!.attrs).toMatchObject({
      ics_sequence: 2,
      when: { candidates: [{ start: "2026-11-14T02:00:00Z", end: "2026-11-14T03:00:00Z" }] }
    });
    expect(rows.filter((row) => row.attrs.review_reason === "unmatched_update")).toHaveLength(1);
  });

  it("collapses a flood of one forged cancel into one fact", async () => {
    await tick(0);
    await mail(at(10), invite(ORGANIZER, ics()));
    for (let i = 0; i < 4; i++)
      await mail(
        at(20 + i),
        invite(INVITEE, ics({ method: "CANCEL", sequence: 9, organizer: ORGANIZER, status: "CANCELLED" }))
      );
    await tick(600);
    const rows = await facts();
    const forged = rows.filter((row) => row.attrs.review_reason === "unmatched_update");
    expect(forged).toHaveLength(4);
    expect(new Set(forged.map((row) => row.attrs.fact_id)).size).toBe(1);
  });

  it("writes nothing for a spoofed From, and keeps going past a SEQUENCE the contract cannot hold", async () => {
    await tick(0);
    await mail(at(10), invite(ORGANIZER, ics(), { from: '"<boss@org.example>" <bob@evil.example>' }));
    await mail(at(11), invite(ORGANIZER, ics({ sequence: 2 ** 31 })));
    await mail(at(12), invite(ORGANIZER, ics({ uid: "fine" })));
    const result = await tick(600);
    expect(result).toMatchObject({ extractors: [{ failed: 0, skipped: 0 }] });
    const rows = await facts();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.attrs.ics_uid).toBe("fine");
  });
});
