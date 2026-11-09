import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import { integrationDatabaseName } from "@openrhen/database";
import { canonicalMessageKey, coverageKey, enterCoreOnly, registerContractsExtension } from "@openrhen/contracts";
import { ingestActivityEvents, readActivityEvents } from "./activity-store";
import { ensureUser } from "./ensure-user";
import { resetRunThrottle } from "./run-log";

/**
 * Cross-source dedupe of messages (B2). A fixture extension registers three message-family sources; the rest of the
 * suite is about which copies are stored. The time tolerance is 60 s (`MESSAGE_FINGERPRINT_TIME_TOLERANCE_SECONDS`).
 */
config({ path: resolve(process.cwd(), "../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(process.env.TEST_DATABASE_NAME, "openrhen_message_dedupe");
if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("TEST_DATABASE_NAME must be an identifier ending in _test");
}
const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let userId: string;
let leaveCoreOnly: (() => void) | undefined;

const A = "ddfx-inbox";
const B = "ddfx-paste";
const C = "ddfx-chat";
const now = new Date("2026-11-20T12:00:00.000Z");
const BASE = Date.parse("2026-11-09T10:00:00.000Z");
const iso = (seconds: number) => new Date(BASE + seconds * 1000).toISOString();

interface Options {
  /** Seconds after the base time. */
  at?: number;
  text?: string | null;
  mid?: string;
  from?: string;
}
/** A message event with its canonical key worked out the way a collector must. */
function message(source: string, options: Options = {}) {
  const text = options.text === undefined ? "Can you send the draft by Friday?" : options.text;
  const from = options.from ?? "alex@example.com";
  const start = iso(options.at ?? 0);
  const key = canonicalMessageKey({
    messageId: options.mid,
    sender: from,
    tsStart: new Date(start),
    content: text
  })!;
  return {
    id: key,
    source,
    kind: "message",
    start,
    ...(text === null ? {} : { content: text }),
    attrs: { from, ...(options.mid === undefined ? {} : { message_id: options.mid }) }
  };
}
const ingest = (events: unknown[], extra: Record<string, unknown> = {}) =>
  ingestActivityEvents(sql, { events, ...extra }, "agent-a", now);
const rows = () =>
  sql<{ source: string; event_key: string; content: string | null; attrs: Record<string, unknown> }[]>`
    SELECT source, event_key, content, attrs FROM activity_events WHERE kind = 'message' ORDER BY source, event_key`;
const count = async () => (await rows()).length;

beforeAll(async () => {
  leaveCoreOnly = enterCoreOnly();
  registerContractsExtension({
    id: "ddfx",
    activitySources: {
      [A]: { schemaVersion: 1, kinds: ["message"], family: "message@1" },
      [B]: { schemaVersion: 1, kinds: ["message"], family: "message@1" },
      [C]: { schemaVersion: 1, kinds: ["message"], family: "message@1" }
    }
  });
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
  sql = postgres(testUrl.toString(), { max: 8, connect_timeout: 10, fetch_types: false });
}, 60_000);

const reset = async () => {
  await sql.unsafe("TRUNCATE TABLE users RESTART IDENTITY CASCADE");
  userId = await ensureUser(sql);
  resetRunThrottle();
};
beforeEach(reset);

afterEach(async () => {
  await sql`DELETE FROM activity_source_state`;
});

afterAll(async () => {
  leaveCoreOnly?.();
  await sql?.end();
});

describe("the same message from two sources", () => {
  it("stores it once when the same text and sender arrive within 60 s, in either order", async () => {
    const first = await ingest([message(A, { mid: "<m1@mail.example.com>" })]);
    expect(first).toMatchObject({ added: 1, alreadyHeld: 0, duplicates: [] });
    const second = await ingest([message(B, { at: 20 })]);
    expect(second).toMatchObject({ added: 0, alreadyHeld: 1, rejected: [] });
    expect(second.duplicates).toEqual([
      {
        index: 0,
        source: B,
        key: message(B, { at: 20 }).id,
        of: { source: A, key: "mid:m1@mail.example.com" },
        by: "fingerprint",
        endState: "duplicate"
      }
    ]);
    expect(await count()).toBe(1);

    // The reverse order: the paste is held first, the collector's copy is the one dropped.
    await reset();
    await ingest([message(B, { at: 20 })]);
    const reverse = await ingest([message(A, { mid: "<m1@mail.example.com>" })]);
    expect(reverse).toMatchObject({ added: 0, alreadyHeld: 1 });
    expect(reverse.duplicates[0]).toMatchObject({ source: A, of: { source: B }, by: "fingerprint" });
    expect(await count()).toBe(1);
  });

  it("keeps both when the sent times are more than 60 s apart, and at exactly 60 s drops one", async () => {
    await ingest([message(A, { mid: "<m1@h.example>" })]);
    const far = await ingest([message(B, { at: 61 })]);
    expect(far).toMatchObject({ added: 1, alreadyHeld: 0, duplicates: [] });
    expect(await count()).toBe(2);
    const edge = await ingest([message(C, { at: 60 })]);
    expect(edge).toMatchObject({ added: 0, alreadyHeld: 1 });
    expect(edge.duplicates[0]).toMatchObject({ source: C, of: { source: A } });
  });

  it("keeps a weekly message: the same text a week later from another source is a new message", async () => {
    await ingest([message(A, { mid: "<w1@h.example>" })]);
    const next = await ingest([message(B, { at: 7 * 86_400 })]);
    expect(next).toMatchObject({ added: 1, duplicates: [] });
    expect(await count()).toBe(2);
  });

  it("keeps both when the text or the sender differs", async () => {
    await ingest([message(A, { mid: "<m1@h.example>" })]);
    const other = await ingest([
      message(B, { text: "A different message", at: 5 }),
      message(C, { from: "sam@example.com", at: 5 })
    ]);
    expect(other).toMatchObject({ added: 2, duplicates: [] });
  });

  it("dedupes across sources by the canonical mid: key even when the sent times differ", async () => {
    await ingest([message(A, { mid: "<same@mail.example.com>" })]);
    const again = await ingest([message(B, { mid: "<same@Mail.Example.COM>", at: 3600, text: "Re-rendered body" })]);
    expect(again).toMatchObject({ added: 0, alreadyHeld: 1 });
    expect(again.duplicates).toEqual([
      expect.objectContaining({ by: "message_id", of: { source: A, key: "mid:same@mail.example.com" } })
    ]);
  });

  it("does not merge a bare chat id across sources (only an id with an @ is shared)", async () => {
    await ingest([message(A, { mid: "42", text: "first" })]);
    const other = await ingest([message(B, { mid: "42", text: "second", at: 3600 })]);
    expect(other).toMatchObject({ added: 1, duplicates: [] });
  });
});

describe("ids that are not RFC shaped, and re-posts", () => {
  it("does not merge a non-RFC id with an @ across sources", async () => {
    await ingest([message(A, { mid: "@alice-17", text: "first" })]);
    const other = await ingest([message(B, { mid: "@alice-17", text: "second", at: 3600 })]);
    expect(other).toMatchObject({ added: 1, duplicates: [] });
    expect(await count()).toBe(2);
  });

  it("reports the dropped copy again when its batch is re-posted", async () => {
    await ingest([message(A, { mid: "<r1@h.example>" })]);
    const copy = message(B, { at: 10 });
    const first = await ingest([copy]);
    const again = await ingest([copy]);
    expect(again).toMatchObject({ added: 0, alreadyHeld: 1 });
    expect(again.duplicates).toEqual(first.duplicates);
    expect(await count()).toBe(1);
  });

  it("is alreadyHeld only, not a duplicate, when the posted key is itself held (message already in two sources)", async () => {
    // Legacy data from before the check: the same message is held by A and by B.
    const a = message(A, { mid: "<l1@h.example>" });
    const b = message(B, { at: 10 });
    await ingest([a]);
    await sql`INSERT INTO activity_events (user_id, source, kind, event_key, ts_start, attrs)
      SELECT user_id, ${B}, 'message', ${b.id}, ${iso(10)}::timestamptz, attrs FROM activity_events WHERE source = ${A}`;
    expect(await count()).toBe(2);
    const repost = await ingest([a, b]);
    expect(repost).toMatchObject({ added: 0, alreadyHeld: 2, duplicates: [] });
    expect(await count()).toBe(2);
  });

  it("stores a coverage row in the same batch as a dropped copy", async () => {
    await ingest([message(A, { mid: "<k1@h.example>" })]);
    const coverage = {
      id: coverageKey("paste", new Date(iso(-3600)), new Date(iso(60))),
      source: B,
      kind: "coverage",
      start: iso(-3600),
      end: iso(60),
      attrs: { complete: true, scope: "paste" }
    };
    const result = await ingest([message(B, { at: 10 }), coverage]);
    expect(result).toMatchObject({ added: 1, alreadyHeld: 1, rejected: [] });
    expect(result.duplicates.map((d) => d.index)).toEqual([0]);
    const [row] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM activity_events WHERE kind = 'coverage'`;
    expect(row!.n).toBe(1);
  });
});

describe("what must not change", () => {
  it("leaves one source's own key behaviour alone: same key is alreadyHeld, not a duplicate entry", async () => {
    await ingest([message(A, { mid: "<m1@h.example>" })]);
    const again = await ingest([message(A, { mid: "<m1@h.example>" })]);
    expect(again).toMatchObject({ added: 0, alreadyHeld: 1, duplicates: [] });
  });

  it("keeps two messages of one source with the same text and time but different ids", async () => {
    const result = await ingest([
      message(A, { mid: "<a1@h.example>", text: "ok" }),
      message(A, { mid: "<a2@h.example>", text: "ok", at: 1 })
    ]);
    expect(result).toMatchObject({ added: 2, duplicates: [] });
    const withoutId = await ingest([message(A, { text: "ok", at: 2 })]);
    expect(withoutId).toMatchObject({ added: 1, duplicates: [] });
  });

  it("stores a gated message as a bare row and still fingerprints it, then dedupes against it", async () => {
    const first = await ingest([message(A, { mid: "<g1@h.example>" })]);
    expect(first).toMatchObject({ added: 1, contentDropped: 1 });
    const [row] = await rows();
    expect(row).toMatchObject({ content: null });
    expect(typeof row!.attrs.fp).toBe("string");
    const copy = await ingest([message(B, { at: 10 })]);
    expect(copy).toMatchObject({ added: 0, alreadyHeld: 1, contentDropped: 0 });
    const page = await readActivityEvents(sql, { source: A });
    expect(page.events).toHaveLength(1);
  });

  it("does not touch sources outside the message family", async () => {
    const watch = {
      id: "w1",
      source: "rhen-watch",
      kind: "foreground",
      start: iso(0),
      end: iso(60),
      attrs: { exe: "a.exe" }
    };
    const watch2 = { ...watch, id: "w2" };
    expect(await ingest([watch, watch2])).toMatchObject({ added: 2, duplicates: [] });
  });
});

describe("a batch with both copies", () => {
  it("keeps the first, drops the second and names the kept event by index", async () => {
    const result = await ingest([
      message("ddfx-unknown-but-rejected"),
      message(A, { mid: "<b1@h.example>" }),
      message(B, { at: 30 }),
      message(C, { at: 59 })
    ]);
    expect(result.rejected.map((r) => r.index)).toEqual([0]);
    expect(result).toMatchObject({ added: 1, alreadyHeld: 2 });
    expect(result.duplicates.map((d) => [d.index, d.source, d.of.index])).toEqual([
      [2, B, 1],
      [3, C, 1]
    ]);
    expect(await count()).toBe(1);
    // added + alreadyHeld + rejected = events
    expect(result.added + result.alreadyHeld + result.rejected.length).toBe(4);
  });

  it("keeps a third copy that is more than 60 s from the kept one", async () => {
    const result = await ingest([
      message(A, { mid: "<b2@h.example>" }),
      message(B, { at: 50 }),
      message(C, { at: 100 })
    ]);
    expect(result).toMatchObject({ added: 2, alreadyHeld: 1 });
    expect(result.duplicates.map((d) => d.index)).toEqual([1]);
  });

  it("does not count a dropped copy against the content gate", async () => {
    await sql`INSERT INTO activity_source_state (user_id, source, content_enabled) VALUES (${userId}, ${B}, false)`;
    await ingest([message(A, { mid: "<b3@h.example>" })]);
    const result = await ingest([message(B, { at: 1 })]);
    expect(result).toMatchObject({ added: 0, contentDropped: 0 });
  });
});

describe("concurrent posts", () => {
  it("store one copy when two sources post the same message at the same time", async () => {
    for (let round = 0; round < 5; round += 1) {
      await reset();
      const results = await Promise.all([
        ingest([message(A, { mid: `<c${round}@h.example>` })]),
        ingest([message(B, { at: 5 })]),
        ingest([message(C, { at: 9 })])
      ]);
      expect(await count()).toBe(1);
      expect(results.reduce((total, r) => total + r.added, 0)).toBe(1);
      expect(results.reduce((total, r) => total + r.duplicates.length, 0)).toBe(2);
    }
  });
});

describe("volume", () => {
  it("ingests 1000 fingerprinted events and 1000 cross-source copies inside a few seconds", async () => {
    const first = Array.from({ length: 1000 }, (_, i) =>
      message(A, { mid: `<v${i}@h.example>`, text: `message number ${i}`, at: i * 5 })
    );
    const began = performance.now();
    expect(await ingest(first)).toMatchObject({ added: 1000 });
    const copies = Array.from({ length: 1000 }, (_, i) => message(B, { text: `message number ${i}`, at: i * 5 + 5 }));
    const second = await ingest(copies);
    expect(second).toMatchObject({ added: 0, alreadyHeld: 1000 });
    expect(second.duplicates).toHaveLength(1000);
    expect(performance.now() - began).toBeLessThan(15_000);
  }, 60_000);
});
