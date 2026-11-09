import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import { integrationDatabaseName } from "@openrhen/database";
import { correctedReasonTagKey, resolveReasons, type ReasonRow } from "@openrhen/contracts/drift/reasons";
import { withheldActivitySources } from "@openrhen/contracts";
import { lockActivityUser } from "@/server/persistence/postgres/activity-lock";
import { readActivityEvents } from "@/server/persistence/postgres/activity-store";
import { insertReasonRow } from "@/server/persistence/postgres/drift-reason-store";
import { ensureUser } from "@/server/persistence/postgres/ensure-user";
import { deleteReason, saveReason } from "./drift-reasons";

config({ path: resolve(process.cwd(), "../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(process.env.TEST_DATABASE_NAME, "openrhen_drift_reason");
if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("TEST_DATABASE_NAME must be an identifier ending in _test");
}
const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let userId: string;
const WORDS = "the neighbour's drill again";

async function checkIn(over: { status?: string; answeredBy?: string | null; source?: string | null } = {}) {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO check_in (user_id, slot_at, answered_at, directive_kind, directive_title, status, answered_by, answer_source)
    VALUES (${userId}, '2026-11-09T01:00:00Z', '2026-11-09T01:05:00Z', 'none', 'Synthetic task',
            ${over.status ?? "deviated"}, ${over.answeredBy ?? null}, ${over.source === undefined ? "sheet" : over.source})
    RETURNING id`;
  return row!.id;
}
const reasonRows = () =>
  sql<{ event_key: string; attrs: Record<string, unknown>; ingested_via: string | null; ts_start: Date }[]>`
    SELECT event_key, attrs, ingested_via, ts_start FROM activity_events
    WHERE source = 'drift-reason' ORDER BY ingested_at, id`;

beforeAll(async () => {
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
  sql = postgres(testUrl.toString(), { max: 5, connect_timeout: 10, fetch_types: false });
}, 60_000);

beforeEach(async () => {
  await sql.unsafe("TRUNCATE TABLE users RESTART IDENTITY CASCADE");
  userId = await ensureUser(sql);
});

afterAll(async () => {
  await sql.end();
});

describe("saving a reason", () => {
  it("stores the words verbatim as the owner's own row, timed at the answer, and answers only the id", async () => {
    const id = await checkIn();
    const result = await saveReason(sql, { checkInId: id, text: `  ${WORDS}\n`, requestId: "req-12345678" });
    expect(result).toEqual({ ok: true, id: `reason|${id}|req-12345678`, created: true });
    const [row] = await reasonRows();
    expect(row).toMatchObject({
      event_key: `reason|${id}|req-12345678`,
      attrs: { check_in_id: id, text: WORDS, request_id: "req-12345678" },
      ingested_via: null
    });
    expect(row!.ts_start.toISOString()).toBe("2026-11-09T01:05:00.000Z");
    expect(JSON.stringify(result)).not.toContain("drill");
  });

  it("stores a retry of the same save once, and refuses a reused id carrying other words", async () => {
    const id = await checkIn();
    await saveReason(sql, { checkInId: id, text: WORDS, requestId: "req-12345678" });
    expect(await saveReason(sql, { checkInId: id, text: WORDS, requestId: "req-12345678" })).toMatchObject({
      ok: true,
      created: false
    });
    const clash = await saveReason(sql, {
      checkInId: id,
      text: "a different thing entirely",
      requestId: "req-12345678"
    });
    expect(clash).toMatchObject({ ok: false, status: 409 });
    expect(JSON.stringify(clash)).not.toContain("different thing");
    expect(await reasonRows()).toHaveLength(1);
  });

  it("takes a later save for the same check-in as a new row, and the latest wins", async () => {
    const id = await checkIn();
    await saveReason(sql, { checkInId: id, text: "first words", requestId: "req-00000001" });
    await saveReason(sql, { checkInId: id, text: "second words", requestId: "req-00000002" });
    const stored = await sql<
      { id: string; attrs: { check_in_id: string; text: string }; ingested_at: Date; ingested_via: string | null }[]
    >`
      SELECT id, attrs, ingested_at, ingested_via FROM activity_events WHERE source = 'drift-reason' AND kind = 'reason'`;
    expect(stored).toHaveLength(2);
    const rows: ReasonRow[] = stored.map((row) => ({
      id: row.id,
      checkInId: row.attrs.check_in_id,
      text: row.attrs.text,
      ingestedAt: row.ingested_at,
      ingestedVia: row.ingested_via
    }));
    expect(resolveReasons(rows).get(id)?.text).toBe("second words");
  });

  it("refuses text over the byte cap with a readable sentence, writing nothing", async () => {
    const id = await checkIn();
    const emoji = await saveReason(sql, { checkInId: id, text: "\u{1F600}".repeat(1000), requestId: "req-12345678" });
    expect(emoji).toMatchObject({ ok: false, status: 400, error: expect.stringContaining("3500") });
    const long = await saveReason(sql, { checkInId: id, text: "x".repeat(1001), requestId: "req-12345679" });
    expect(long).toMatchObject({ ok: false, status: 400, error: expect.stringContaining("1000") });
    expect(await saveReason(sql, { checkInId: id, text: "   ", requestId: "req-12345670" })).toMatchObject({
      ok: false,
      status: 400
    });
    expect(await reasonRows()).toHaveLength(0);
  });

  it("refuses a check-in that is missing, pending, answered by an agent or by reconciliation, or not an id", async () => {
    const pending = await checkIn({ status: "pending" });
    const onTrack = await checkIn({ status: "on_track" });
    const byAgent = await checkIn({ answeredBy: "some-agent" });
    const reconciled = await checkIn({ source: "session_reconciliation" });
    const save = (checkInId: string) => saveReason(sql, { checkInId, text: WORDS, requestId: "req-12345678" });
    expect(await save("33333333-3333-4333-8333-333333333333")).toMatchObject({ ok: false, status: 404 });
    for (const id of [pending, onTrack, byAgent, reconciled])
      expect(await save(id)).toMatchObject({ ok: false, status: 409 });
    expect(await save("not-an-id")).toMatchObject({ ok: false, status: 400 });
    expect(await saveReason(sql, { checkInId: pending, text: WORDS, requestId: "x" })).toMatchObject({ status: 400 });
    expect(await reasonRows()).toHaveLength(0);
  });

  it("never touches the check-in row itself", async () => {
    const id = await checkIn();
    const before = await sql`SELECT * FROM check_in WHERE id = ${id}`;
    await saveReason(sql, { checkInId: id, text: WORDS, requestId: "req-12345678" });
    expect(await sql`SELECT * FROM check_in WHERE id = ${id}`).toEqual(before);
    expect((await sql`SELECT count(*)::int AS n FROM writes`)[0]).toMatchObject({ n: 0 });
  });
});

describe("who can read the words", () => {
  it("leaves them out of every generic activity read, whatever scopes the reader holds and whatever it asks for", async () => {
    const id = await checkIn();
    await saveReason(sql, { checkInId: id, text: WORDS, requestId: "req-12345678" });
    await sql`INSERT INTO activity_events (user_id, source, kind, event_key, ts_start, attrs)
              VALUES (${userId}, 'rhen-watch', 'idle', 'other-row', '2026-11-09T02:00:00Z', '{}'::jsonb)`;
    const holder = withheldActivitySources(["read:activity-event", "read:activity-health", "read:activity-drift"]);
    for (const query of [{}, { excludeSources: [] }, { excludeSources: holder }, { source: "drift-reason" }]) {
      const page = await readActivityEvents(sql, query);
      expect(JSON.stringify(page)).not.toContain("drill");
      expect(page.events.map((event) => event.source)).not.toContain("drift-reason");
    }
    expect((await readActivityEvents(sql, {})).events.map((event) => event.key)).toEqual(["other-row"]);
  });
});

describe("deleting a reason", () => {
  async function tags(checkInId: string, requestId: string) {
    await sql.begin(async (tx) => {
      await lockActivityUser(tx, userId);
      const written = await insertReasonRow(
        tx,
        userId,
        {
          id: correctedReasonTagKey(checkInId, requestId),
          source: "drift-reason",
          kind: "reason_tag",
          start: "2026-11-09T01:06:00Z",
          attrs: { check_in_id: checkInId, origin: "corrected", request_id: requestId, tags: ["noise"] }
        },
        new Date("2026-11-09T02:00:00Z")
      );
      expect(written).toEqual({ ok: true, added: true });
    });
  }

  it("removes every save and every tag for that check-in only, and nothing else", async () => {
    const first = await checkIn();
    const second = await checkIn();
    await saveReason(sql, { checkInId: first, text: "one", requestId: "req-00000001" });
    await saveReason(sql, { checkInId: first, text: "one again", requestId: "req-00000002" });
    await tags(first, "req-00000003");
    await saveReason(sql, { checkInId: second, text: "two", requestId: "req-00000004" });
    await sql`INSERT INTO activity_events (user_id, source, kind, event_key, ts_start, attrs)
              VALUES (${userId}, 'drift', 'work_label', 'label-row', '2026-11-09T02:00:00Z', '{}'::jsonb)`;
    expect(await deleteReason(sql, first)).toEqual({ ok: true, removed: 3 });
    expect((await reasonRows()).map((row) => row.attrs.check_in_id)).toEqual([second]);
    expect(await sql`SELECT 1 FROM activity_events WHERE source = 'drift'`).toHaveLength(1);
    expect(await deleteReason(sql, first)).toEqual({ ok: true, removed: 0 });
    expect(await deleteReason(sql, "nope")).toMatchObject({ ok: false, status: 400 });
  });
});
