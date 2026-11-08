import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import { integrationDatabaseName } from "@openrhen/database";
import { readActivityEvents } from "./activity-store";
import { writeDerivedRows, writeDerivedRowsTx, writeShadowRows, writeShadowRowsTx } from "./derived-write-store";
import { ensureUser } from "./ensure-user";

config({ path: resolve(process.cwd(), "../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(process.env.TEST_DATABASE_NAME, "openrhen_derived_write");

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

const now = new Date("2026-11-07T12:00:00.000Z");
const VIA = "extractor:test";

async function mail(key: string, user = userId): Promise<string> {
  const [made] = await sql<{ id: string }[]>`
    INSERT INTO activity_events (user_id, source, kind, event_key, ts_start)
    VALUES (${user}, 'gmail', 'message', ${key}, '2026-11-01T00:00:00Z') RETURNING id`;
  return made!.id;
}
const classRow = (id: string, extra: Record<string, unknown> = {}, attrs: Record<string, unknown> = {}) => ({
  id,
  source: "derived",
  kind: "msg_class",
  start: "2026-11-01T00:00:00Z",
  attrs: {
    source_event_id: "m",
    class: "bulk",
    reasons: ["list_id"],
    extractor: "msg-class-t0",
    extractor_version: "1",
    ...attrs
  },
  ...extra
});
const lineage = async () => (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM derived_lineage`)[0]!.n;
const derivedCount = async () =>
  (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM activity_events WHERE source = 'derived'`)[0]!.n;

describe("writeDerivedRows", () => {
  it("writes the row under the fixed extractor name, links it to its sources and returns its id", async () => {
    const m = await mail("m1");
    const [res] = await writeDerivedRows(sql, [{ event: classRow("k1"), sourceIds: [m] }], VIA, now);
    expect(res).toMatchObject({ ok: true, added: true });
    const [stored] = await sql<
      { id: string; ingested_via: string; content: string | null; import_id: string | null }[]
    >`
      SELECT id, ingested_via, content, import_id FROM activity_events WHERE source = 'derived'`;
    expect(stored).toMatchObject({ ingested_via: VIA, content: null, import_id: null });
    expect(res!.ok && res!.id).toBe(stored!.id);
    expect(await lineage()).toBe(1);
  });

  it("returns the id of a row it already holds, adds no second row and no second link", async () => {
    const m = await mail("m1");
    const first = await writeDerivedRows(sql, [{ event: classRow("k1"), sourceIds: [m] }], VIA, now);
    const again = await writeDerivedRows(sql, [{ event: classRow("k1"), sourceIds: [m] }], VIA, now);
    expect(again[0]).toMatchObject({ ok: true, added: false });
    expect(again[0]!.ok && again[0]!.id).toBe(first[0]!.ok && first[0]!.id);
    expect(await derivedCount()).toBe(1);
    expect(await lineage()).toBe(1);
  });

  it("returns an id for every row of a mixed batch, in input order, new and held alike", async () => {
    const [m1, m2, m3] = [await mail("m1"), await mail("m2"), await mail("m3")];
    await writeDerivedRows(sql, [{ event: classRow("k2"), sourceIds: [m2] }], VIA, now);
    const out = await writeDerivedRows(
      sql,
      [
        { event: classRow("k1"), sourceIds: [m1] },
        { event: classRow("k2"), sourceIds: [m2] },
        { event: classRow("k3"), sourceIds: [m3] },
        { event: classRow("k1"), sourceIds: [m1] }
      ],
      VIA,
      now
    );
    expect(out.map((r) => r.ok && r.added)).toEqual([true, false, true, false]);
    const ids = await sql<
      { event_key: string; id: string }[]
    >`SELECT event_key, id FROM activity_events WHERE source = 'derived'`;
    const byKey = new Map(ids.map((r) => [r.event_key, r.id]));
    expect(out.map((r) => r.ok && r.id)).toEqual(["k1", "k2", "k3", "k1"].map((k) => byKey.get(k)));
    expect(await lineage()).toBe(3);
  });

  it("runs every row through the validators and refuses what the API would, the rest still written", async () => {
    const m = await mail("m1");
    const out = await writeDerivedRows(
      sql,
      [
        { event: classRow("bad1", {}, { class: "unknown" }), sourceIds: [m] },
        { event: classRow("bad2", {}, { by: "someone" }), sourceIds: [m] },
        { event: classRow("bad3", { content: "the body" }), sourceIds: [m] },
        { event: classRow("bad4", { source: "gmail", kind: "message" }), sourceIds: [m] },
        { event: "not an event", sourceIds: [m] },
        { event: classRow("good"), sourceIds: [m] }
      ],
      VIA,
      now
    );
    expect(out.map((r) => r.ok)).toEqual([false, false, false, false, false, true]);
    expect(out[0]).toMatchObject({ reason: expect.stringContaining("unknown") });
    expect(out[3]).toMatchObject({ reason: expect.stringContaining("derived") });
    expect(await derivedCount()).toBe(1);
  });

  it("will not write a row of a source other than derived, nor a time too far ahead", async () => {
    const m = await mail("m1");
    const out = await writeDerivedRows(
      sql,
      [
        { event: { id: "x", source: "rhen-watch", kind: "foreground", start: "2026-11-01T00:00:00Z" }, sourceIds: [] },
        { event: classRow("future", { start: "2027-01-01T00:00:00Z" }), sourceIds: [m] }
      ],
      VIA,
      now
    );
    expect(out.map((r) => r.ok)).toEqual([false, false]);
    expect(await sql`SELECT 1 FROM activity_events WHERE source = 'rhen-watch'`).toHaveLength(0);
  });

  it("writes only the kinds an extractor writes: msg_class and fact, never a status, override or label", async () => {
    const m = await mail("m1");
    const fid = "a".repeat(40);
    const out = await writeDerivedRows(
      sql,
      [
        {
          event: {
            id: "s",
            source: "derived",
            kind: "fact_status",
            start: "2026-11-01T00:00:00Z",
            attrs: { fact_id: fid, status: "done", valid_from: "2026-11-01T00:00:00Z" }
          },
          sourceIds: [m]
        },
        {
          event: {
            id: "o",
            source: "derived",
            kind: "override",
            start: "2026-11-01T00:00:00Z",
            attrs: { fact_id: fid, field: "when", new_value: 1 }
          },
          sourceIds: [m]
        },
        {
          event: {
            id: "l",
            source: "derived",
            kind: "label",
            start: "2026-11-01T00:00:00Z",
            attrs: { fact_id: fid, answer: "x" }
          },
          sourceIds: [m]
        },
        {
          event: {
            id: "f",
            source: "derived",
            kind: "fact",
            start: "2026-11-01T00:00:00Z",
            attrs: { source_event_id: "m", fact_id: fid, fact_type: "ask", extractor: "x-t2", extractor_version: "1" }
          },
          sourceIds: [m]
        }
      ],
      VIA,
      now
    );
    expect(out.map((r) => r.ok)).toEqual([false, false, false, true]);
    expect(out[0]).toMatchObject({ reason: expect.stringContaining("msg_class") });
    expect(await derivedCount()).toBe(1);
  });

  it("is one transaction: a failure after some rows are in leaves nothing behind", async () => {
    const m = await mail("m1");
    await expect(
      sql.begin(async (tx) => {
        await writeDerivedRowsTx(tx, userId, [{ event: classRow("k1"), sourceIds: [m] }], VIA, now);
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    expect(await derivedCount()).toBe(0);
    expect(await lineage()).toBe(0);
  });

  it("keeps people apart: the same key for another person is its own row, and a link to their mail is skipped", async () => {
    const other = (await sql<{ id: string }[]>`INSERT INTO users (display_name) VALUES ('Other') RETURNING id`)[0]!.id;
    const theirs = await mail("t1", other);
    const out = await writeDerivedRows(sql, [{ event: classRow("k1"), sourceIds: [theirs] }], VIA, now);
    expect(out[0]).toMatchObject({ ok: true, added: true });
    expect(await lineage()).toBe(0);
  });
});

describe("writeShadowRows (extractor versions compared before one is promoted)", () => {
  const shadowRow = (id: string, version = "2") => ({
    ...classRow(id, { source: "derived-shadow" }, { extractor_version: version }),
    source: "derived-shadow"
  });
  const shadowCount = async () =>
    (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM activity_events WHERE source = 'derived-shadow'`)[0]!.n;

  it("writes under source derived-shadow with lineage, returns the id, and is idempotent", async () => {
    const m = await mail("m1");
    const [res] = await writeShadowRows(sql, [{ event: shadowRow("k1"), sourceIds: [m] }], VIA, now);
    expect(res).toMatchObject({ ok: true, added: true });
    const [again] = await writeShadowRows(sql, [{ event: shadowRow("k1"), sourceIds: [m] }], VIA, now);
    expect(again).toMatchObject({ ok: true, added: false });
    expect(again!.ok && again!.id).toBe(res!.ok && res!.id);
    expect(await shadowCount()).toBe(1);
    expect(await derivedCount()).toBe(0);
    expect(await lineage()).toBe(1);
    const [stored] = await sql<{ ingested_via: string; content: string | null }[]>`
      SELECT ingested_via, content FROM activity_events WHERE source = 'derived-shadow'`;
    expect(stored).toMatchObject({ ingested_via: VIA, content: null });
  });

  it("lets the same event key live in derived and derived-shadow without clashing", async () => {
    const m = await mail("m1");
    await writeDerivedRows(sql, [{ event: classRow("same"), sourceIds: [m] }], VIA, now);
    const [res] = await writeShadowRows(sql, [{ event: shadowRow("same"), sourceIds: [m] }], VIA, now);
    expect(res).toMatchObject({ ok: true, added: true });
    expect(await derivedCount()).toBe(1);
    expect(await shadowCount()).toBe(1);
  });

  it("refuses a row of the other source on each path, naming the source to build the row with", async () => {
    const m = await mail("m1");
    const [toShadow] = await writeShadowRows(sql, [{ event: classRow("k1"), sourceIds: [m] }], VIA, now);
    expect(toShadow).toMatchObject({ ok: false, reason: expect.stringContaining('source "derived-shadow"') });
    const [toDerived] = await writeDerivedRows(sql, [{ event: shadowRow("k2"), sourceIds: [m] }], VIA, now);
    expect(toDerived).toMatchObject({ ok: false, reason: expect.stringContaining('source "derived"') });
    expect(await derivedCount()).toBe(0);
    expect(await shadowCount()).toBe(0);
  });

  it("writes msg_class and fact only: the registry refuses a status, override, label or correction in derived-shadow", async () => {
    const m = await mail("m1");
    const [res] = await writeShadowRows(
      sql,
      [
        {
          event: {
            id: "l",
            source: "derived-shadow",
            kind: "label",
            start: "2026-11-01T00:00:00Z",
            attrs: { fact_id: "a".repeat(40), answer: "x" }
          },
          sourceIds: [m]
        }
      ],
      VIA,
      now
    );
    expect(res).toMatchObject({ ok: false, reason: expect.stringContaining("msg_class, fact") });
  });

  it("is available inside the caller's transaction and rolls back with it", async () => {
    const m = await mail("m1");
    await expect(
      sql.begin(async (tx) => {
        await writeShadowRowsTx(tx, userId, [{ event: shadowRow("k1"), sourceIds: [m] }], VIA, now);
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    expect(await shadowCount()).toBe(0);
  });

  it("is never read as active output: an unfiltered read and a derived read leave shadow rows out, an explicit shadow read shows them", async () => {
    const m = await mail("m1");
    await sql`INSERT INTO extractor_state (user_id, extractor, version, active) VALUES (${userId}, 'msg-class-t0', '1', true)`;
    await writeDerivedRows(sql, [{ event: classRow("live"), sourceIds: [m] }], VIA, now);
    await writeShadowRows(sql, [{ event: shadowRow("shadow"), sourceIds: [m] }], VIA, now);
    const keys = async (query: { source?: string }) =>
      (await readActivityEvents(sql, query)).events
        .filter((e) => e.kind === "msg_class")
        .map((e) => `${e.source}:${e.key}`);
    expect(await keys({})).toEqual(["derived:live"]);
    expect(await keys({ source: "derived" })).toEqual(["derived:live"]);
    expect(await keys({ source: "derived-shadow" })).toEqual(["derived-shadow:shadow"]);
  });

  it("goes with its source mail like any derived row", async () => {
    const m = await mail("m1");
    await writeShadowRows(sql, [{ event: shadowRow("k1"), sourceIds: [m] }], VIA, now);
    const { purgeActivitySource } = await import("./activity-store");
    await purgeActivitySource(sql, "gmail");
    expect(await shadowCount()).toBe(0);
  });
});
