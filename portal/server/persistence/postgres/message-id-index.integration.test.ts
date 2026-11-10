import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import { integrationDatabaseName } from "@openrhen/database";
import {
  ACTIVITY_SOURCES,
  canonicalMessageKey,
  enterCoreOnly,
  normaliseMessageId,
  registerContractsExtension
} from "@openrhen/contracts";
import { heldByMessageIds, ingestActivityEvents } from "./activity-store";
import { ensureUser } from "./ensure-user";

/**
 * The message-id index of supersession (migration 0156): the SQL `normalise_message_id` does exactly what the JavaScript
 * `normaliseMessageId` does, and the lookup that finds a message's other copies by id is served by its partial
 * expression index on a large table. `OPENRHEN_SUPERSESSION_SCALE_ROWS` sets the size of the fixture (half thin message
 * rows with a raw id, half derived rows without one); the default keeps CI quick and the merge gate was run at 4,000,000.
 */
config({ path: resolve(process.cwd(), "../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(process.env.TEST_DATABASE_NAME, "openrhen_message_id_index");
if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("TEST_DATABASE_NAME must be an identifier ending in _test");
}
const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

const ROWS = Number(process.env.OPENRHEN_SUPERSESSION_SCALE_ROWS ?? 200_000);
/**
 * Budget for one 500-id lookup chunk, in milliseconds, fixed from the first measurement on 4,000,000 rows (5.5 ms: 500 index
 * probes; the same lookup as a hash join over the table took 8,900 ms). The budget is 45 times the measurement, for a slow
 * runner, and still fails a scan.
 */
const CHUNK_BUDGET_MS = 250;
/** Budget for a whole 500-event import batch whose every row has a thin copy to link, at the same size (197 ms measured). */
const BATCH_BUDGET_MS = 5_000;

let sql: postgres.Sql;
let leaveCoreOnly: (() => void) | undefined;
const LEGACY = Object.entries(ACTIVITY_SOURCES).find(
  ([, entry]) => entry.kinds.includes("message") && entry.family === undefined
)![0];

beforeAll(async () => {
  leaveCoreOnly = enterCoreOnly();
  registerContractsExtension({
    id: "mix",
    activitySources: { "mix-archive": { schemaVersion: 1, kinds: ["message"], family: "message@1" } }
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
  sql = postgres(testUrl.toString(), { max: 4, connect_timeout: 10, fetch_types: false });
}, 120_000);

afterAll(async () => {
  leaveCoreOnly?.();
  await sql?.end();
});

describe("normalise_message_id", () => {
  const vectors = [
    " <Local.PART@Host.EXAMPLE> ",
    "<abc@mail.example.com>",
    "abc@mail.example.com",
    "<Abc.123@Mail.Example.COM>",
    "a@b@C.D",
    "MsgID-ABC",
    "<>",
    "< >",
    "<<a@B.example>>",
    "<a@B.example",
    "a@B.example>",
    "\t<ABC@Example.Com>\r\n",
    " < spaced@Host.Example > ",
    "<CAF=1x_2/3@Mail.Example.com>",
    "jörg@Mail.Example.COM",
    "@Alice-17",
    "alice@",
    "12",
    "<0123.456@[192.0.2.1]>",
    "x@y@",
    ""
  ];

  it("returns what the JavaScript normaliser returns, for every vector", async () => {
    for (const vector of vectors) {
      const [row] = await sql<{ n: string | null }[]>`SELECT normalise_message_id(${vector}) AS n`;
      expect(row!.n, JSON.stringify(vector)).toBe(normaliseMessageId(vector));
    }
  });

  it("is null for null, and immutable (so it can sit in an index)", async () => {
    const [row] = await sql<{ n: string | null; volatility: string }[]>`
      SELECT normalise_message_id(NULL) AS n, (SELECT provolatile FROM pg_proc WHERE proname = 'normalise_message_id') AS volatility`;
    expect(row).toEqual({ n: null, volatility: "i" });
  });
});

describe("the lookup of a message's other copies by id, on a large table", () => {
  let userId: string;
  const mid = (n: number) => `m${n}@mail.example.com`;

  beforeAll(async () => {
    userId = await ensureUser(sql);
    // A pinned TEST_DATABASE_NAME that already holds the fixture is reused, so a 4,000,000-row run is not rebuilt each time.
    const [filled] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM activity_events`;
    if (filled!.n >= ROWS) return;
    const half = Math.floor(ROWS / 2);
    const CHUNK = 500_000;
    for (let from = 1; from <= half; from += CHUNK) {
      const to = Math.min(from + CHUNK - 1, half);
      await sql`
        INSERT INTO activity_events (user_id, source, kind, event_key, ts_start, attrs, content)
        SELECT ${userId}, ${LEGACY}, 'message', 'k' || g, '2026-01-01T00:00:00Z'::timestamptz + g * interval '1 second',
               jsonb_build_object('message_id', '<m' || g || '@Mail.Example.com>', 'from', 'a@example.com'), NULL
        FROM generate_series(${from}::int, ${to}::int) g`;
      await sql`
        INSERT INTO activity_events (user_id, source, kind, event_key, ts_start, attrs, content)
        SELECT ${userId}, 'derived', 'msg_class', 'c' || g, '2026-01-01T00:00:00Z'::timestamptz + g * interval '1 second',
               jsonb_build_object('class', 'x'), NULL
        FROM generate_series(${from}::int, ${to}::int) g`;
    }
    await sql`ANALYZE activity_events`;
  }, 1_800_000);

  const ids = (count: number) => {
    const half = Math.floor(ROWS / 2);
    const step = Math.max(1, Math.floor(half / count));
    return Array.from({ length: count }, (_, n) => mid(1 + n * step));
  };

  it("uses the partial expression index, with no scan of the table", async () => {
    const plan = await sql<{ "QUERY PLAN": unknown }[]>`
      EXPLAIN (FORMAT JSON) ${heldByMessageIds(sql, userId, ids(500), [LEGACY, "mix-archive"])}`;
    const text = JSON.stringify(plan[0]!["QUERY PLAN"]);
    expect(text).toContain("activity_events_message_id_idx");
    expect(text).not.toMatch(/"Node Type":"Seq Scan"[^}]*"Relation Name":"activity_events"/);
    expect(text).not.toMatch(/"Relation Name":"activity_events"[^}]*"Node Type":"Seq Scan"/);
  });

  it("answers a 500-id chunk inside the budget", async () => {
    const wanted = ids(500);
    await heldByMessageIds(sql, userId, wanted, [LEGACY]); // warm
    const started = performance.now();
    const rows = await heldByMessageIds(sql, userId, wanted, [LEGACY]);
    const took = performance.now() - started;
    process.stderr.write(`message-id lookup: ${ROWS} rows, 500 ids, ${took.toFixed(1)} ms\n`);
    expect(rows).toHaveLength(500);
    expect(took).toBeLessThan(CHUNK_BUDGET_MS);
  });

  it("links a 500-event import batch against the large table inside the batch budget", async () => {
    const wanted = ids(500);
    const events = wanted.map((id, n) => {
      const text = `Body ${n}`;
      return {
        id: canonicalMessageKey({ messageId: id, sender: "a@example.com", tsStart: new Date(), content: text })!,
        source: "mix-archive",
        kind: "message",
        start: "2026-01-02T00:00:00Z",
        content: text,
        attrs: { message_id: id, from: "a@example.com" }
      };
    });
    const started = performance.now();
    const result = await ingestActivityEvents(
      sql,
      { events, import: { sha256: "f".repeat(64), filename: "big.mbox", source: "mix-archive" } },
      null,
      new Date("2026-11-20T12:00:00Z")
    );
    const took = performance.now() - started;
    process.stderr.write(`500-event import against ${ROWS} rows: ${took.toFixed(1)} ms\n`);
    expect(result).toMatchObject({ added: 500 });
    expect(result.replaced).toHaveLength(500);
    expect(took).toBeLessThan(BATCH_BUDGET_MS);
  });
});
