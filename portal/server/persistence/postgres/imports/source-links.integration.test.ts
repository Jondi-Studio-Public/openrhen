import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { fileURLToPath } from "node:url";
import { integrationDatabaseName } from "@openrhen/database";
import { ensureUser } from "../ensure-user";
import { linkSourceToCommitment, loadMatchContext, recordSourceAlias, unlinkSource } from "./source-links";
import { EXAMPLE_DAILY, EXAMPLE_SHARED } from "@/test/example-calendar-sources";

/**
 * The source matching design note, step 2: the `source-links.ts` helpers against real constraints, with the example
 * calendar pair rather than a real provider (the migration's role backfill, which names the real providers, is in
 * the provider-specific twin of this file). Its own `_test` database, so it belongs to `corepack pnpm test:integration`.
 */

config({ path: fileURLToPath(new URL("../../../../../.env", import.meta.url)), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(
  process.env.SOURCE_LINKS_TEST_DATABASE_NAME,
  "openrhen_source_links_ex"
);

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
for (const name of [testDatabaseName]) {
  if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(name)) throw new Error("Test database names must end in _test");
}

const drizzleFolder = fileURLToPath(new URL("../../../../../platform/database/drizzle", import.meta.url));

function urlFor(database: string): string {
  const url = new URL(adminUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

async function freshDatabase(database: string): Promise<void> {
  const admin = postgres(adminUrl!, { max: 1, connect_timeout: 10 });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE "${database}"`);
  } finally {
    await admin.end();
  }
}

async function migrateTo(database: string, folder: string): Promise<void> {
  const migrationSql = postgres(urlFor(database), { max: 1, connect_timeout: 10 });
  try {
    await migrate(drizzle(migrationSql), { migrationsFolder: folder });
  } finally {
    await migrationSql.end();
  }
}

let sql: postgres.Sql;
let userId: string;

async function commitment(title: string, startsAt: string, endsAt: string, status = "confirmed"): Promise<string> {
  const rows = await sql<
    { id: string }[]
  >`INSERT INTO commitments(user_id,title,starts_at,ends_at,status) VALUES(${userId},${title},${startsAt},${endsAt},${status}) RETURNING id`;
  return rows[0]!.id;
}

function link(provider: string, commitmentId: string, externalEventId: string) {
  return linkSourceToCommitment(sql, {
    userId,
    provider,
    frameId: "frame-1",
    externalEventId,
    commitmentId,
    profileLabel: "Profile",
    snapshot: { title: "x" },
    hash: `hash-${externalEventId}`
  });
}

beforeAll(async () => {
  await freshDatabase(testDatabaseName);
  await migrateTo(testDatabaseName, drizzleFolder);
  sql = postgres(urlFor(testDatabaseName), { max: 5, connect_timeout: 10, fetch_types: false, prepare: true });
  userId = await ensureUser(sql);
}, 60_000);

beforeEach(async () => {
  await sql.unsafe(
    "TRUNCATE TABLE calendar_event_links, source_match_aliases, import_entity_keys, commitments RESTART IDENTITY CASCADE"
  );
});

afterAll(async () => {
  await sql?.end();
});

describe("linkSourceToCommitment", () => {
  it("lets two providers link one commitment, each with its provider's role", async () => {
    const id = await commitment("Harbor Mart", "2026-10-01T09:00:00Z", "2026-10-01T17:00:00Z");
    await link(EXAMPLE_DAILY, id, "daily-1");
    await link(EXAMPLE_SHARED, id, "sky-1");
    const rows = await sql<
      { provider: string; role: string }[]
    >`SELECT provider, role FROM calendar_event_links WHERE commitment_id=${id} ORDER BY provider`;
    expect(rows).toEqual([
      { provider: EXAMPLE_DAILY, role: "primary" },
      { provider: EXAMPLE_SHARED, role: "secondary" }
    ]);
  });

  it("refreshes rather than duplicates when the same external event links again", async () => {
    const id = await commitment("Harbor Mart", "2026-10-01T09:00:00Z", "2026-10-01T17:00:00Z");
    await link(EXAMPLE_SHARED, id, "sky-1");
    await link(EXAMPLE_SHARED, id, "sky-1");
    const [count] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM calendar_event_links`;
    expect(count!.n).toBe(1);
  });

  it("throws on a second Example Daily (primary) link to the same commitment", async () => {
    const id = await commitment("Harbor Mart", "2026-10-01T09:00:00Z", "2026-10-01T17:00:00Z");
    await link(EXAMPLE_DAILY, id, "daily-1");
    await expect(link(EXAMPLE_DAILY, id, "daily-2")).rejects.toThrow(/primary/);
  });

  it("refuses a second link from one provider to the same commitment", async () => {
    const id = await commitment("Harbor Mart", "2026-10-01T09:00:00Z", "2026-10-01T17:00:00Z");
    await link(EXAMPLE_SHARED, id, "sky-1");
    await expect(link(EXAMPLE_SHARED, id, "sky-2")).rejects.toThrow();
  });

  it("unlinks just the one link", async () => {
    const id = await commitment("Harbor Mart", "2026-10-01T09:00:00Z", "2026-10-01T17:00:00Z");
    await link(EXAMPLE_DAILY, id, "daily-1");
    await link(EXAMPLE_SHARED, id, "sky-1");
    const [target] = await sql<{ id: string }[]>`SELECT id FROM calendar_event_links WHERE provider=${EXAMPLE_SHARED}`;
    await unlinkSource(sql, { userId, linkId: target!.id });
    const rows = await sql<{ provider: string }[]>`SELECT provider FROM calendar_event_links`;
    expect(rows).toEqual([{ provider: EXAMPLE_DAILY }]);
    const [stillThere] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM commitments WHERE id=${id}`;
    expect(stillThere!.n).toBe(1);
  });
});

describe("recordSourceAlias", () => {
  it("records a normalised pair once", async () => {
    await recordSourceAlias(sql, {
      userId,
      provider: EXAMPLE_SHARED,
      remoteTitle: "Jon work",
      localTitle: "Work (Harbor Mart)"
    });
    await recordSourceAlias(sql, {
      userId,
      provider: EXAMPLE_SHARED,
      remoteTitle: "JON  work",
      localTitle: "work (harbor mart)"
    });
    const rows = await sql<{ provider: string }[]>`SELECT provider FROM source_match_aliases`;
    expect(rows).toHaveLength(1);
  });
});

describe("loadMatchContext", () => {
  it("returns non-cancelled commitments in the window with their links and the user's aliases", async () => {
    const inside = await commitment("Harbor Mart", "2026-10-01T09:00:00Z", "2026-10-01T17:00:00Z");
    await commitment("Cancelled thing", "2026-10-01T10:00:00Z", "2026-10-01T11:00:00Z", "cancelled");
    await commitment("Later", "2026-11-01T10:00:00Z", "2026-11-01T11:00:00Z");
    await link(EXAMPLE_DAILY, inside, "daily-1");
    await recordSourceAlias(sql, {
      userId,
      provider: EXAMPLE_SHARED,
      remoteTitle: "Jon work",
      localTitle: "Harbor Mart"
    });

    const context = await loadMatchContext(sql, {
      userId,
      fromIso: "2026-09-30T00:00:00Z",
      toIso: "2026-10-08T00:00:00Z",
      timezone: "Australia/Adelaide"
    });
    expect(context.commitments).toHaveLength(1);
    expect(context.commitments[0]).toMatchObject({
      id: inside,
      title: "Harbor Mart",
      allDay: false,
      // 09:00Z is 19:30 in Adelaide (ACDT), the same calendar day.
      localDate: "2026-10-01",
      links: [{ provider: EXAMPLE_DAILY, externalId: "daily-1" }]
    });
    expect(context.aliases).toHaveLength(1);
    expect(context.aliases[0]!.provider).toBe(EXAMPLE_SHARED);
  });
});

describe("linkSourceToCommitment", () => {
  it("lets two providers link one commitment, each with its provider's role", async () => {
    const id = await commitment("Harbor Mart", "2026-10-01T09:00:00Z", "2026-10-01T17:00:00Z");
    await link(EXAMPLE_DAILY, id, "daily-1");
    await link(EXAMPLE_SHARED, id, "sky-1");
    const rows = await sql<
      { provider: string; role: string }[]
    >`SELECT provider, role FROM calendar_event_links WHERE commitment_id=${id} ORDER BY provider`;
    expect(rows).toEqual([
      { provider: EXAMPLE_DAILY, role: "primary" },
      { provider: EXAMPLE_SHARED, role: "secondary" }
    ]);
  });

  it("refreshes rather than duplicates when the same external event links again", async () => {
    const id = await commitment("Harbor Mart", "2026-10-01T09:00:00Z", "2026-10-01T17:00:00Z");
    await link(EXAMPLE_SHARED, id, "sky-1");
    await link(EXAMPLE_SHARED, id, "sky-1");
    const [count] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM calendar_event_links`;
    expect(count!.n).toBe(1);
  });

  it("throws on a second Example Daily (primary) link to the same commitment", async () => {
    const id = await commitment("Harbor Mart", "2026-10-01T09:00:00Z", "2026-10-01T17:00:00Z");
    await link(EXAMPLE_DAILY, id, "daily-1");
    await expect(link(EXAMPLE_DAILY, id, "daily-2")).rejects.toThrow(/primary/);
  });

  it("refuses a second link from one provider to the same commitment", async () => {
    const id = await commitment("Harbor Mart", "2026-10-01T09:00:00Z", "2026-10-01T17:00:00Z");
    await link(EXAMPLE_SHARED, id, "sky-1");
    await expect(link(EXAMPLE_SHARED, id, "sky-2")).rejects.toThrow();
  });

  it("unlinks just the one link", async () => {
    const id = await commitment("Harbor Mart", "2026-10-01T09:00:00Z", "2026-10-01T17:00:00Z");
    await link(EXAMPLE_DAILY, id, "daily-1");
    await link(EXAMPLE_SHARED, id, "sky-1");
    const [target] = await sql<{ id: string }[]>`SELECT id FROM calendar_event_links WHERE provider=${EXAMPLE_SHARED}`;
    await unlinkSource(sql, { userId, linkId: target!.id });
    const rows = await sql<{ provider: string }[]>`SELECT provider FROM calendar_event_links`;
    expect(rows).toEqual([{ provider: EXAMPLE_DAILY }]);
    const [stillThere] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM commitments WHERE id=${id}`;
    expect(stillThere!.n).toBe(1);
  });
});

describe("recordSourceAlias", () => {
  it("records a normalised pair once", async () => {
    await recordSourceAlias(sql, {
      userId,
      provider: EXAMPLE_SHARED,
      remoteTitle: "Jon work",
      localTitle: "Work (Harbor Mart)"
    });
    await recordSourceAlias(sql, {
      userId,
      provider: EXAMPLE_SHARED,
      remoteTitle: "JON  work",
      localTitle: "work (harbor mart)"
    });
    const rows = await sql<{ provider: string }[]>`SELECT provider FROM source_match_aliases`;
    expect(rows).toHaveLength(1);
  });
});

describe("loadMatchContext", () => {
  it("returns non-cancelled commitments in the window with their links and the user's aliases", async () => {
    const inside = await commitment("Harbor Mart", "2026-10-01T09:00:00Z", "2026-10-01T17:00:00Z");
    await commitment("Cancelled thing", "2026-10-01T10:00:00Z", "2026-10-01T11:00:00Z", "cancelled");
    await commitment("Later", "2026-11-01T10:00:00Z", "2026-11-01T11:00:00Z");
    await link(EXAMPLE_DAILY, inside, "daily-1");
    await recordSourceAlias(sql, {
      userId,
      provider: EXAMPLE_SHARED,
      remoteTitle: "Jon work",
      localTitle: "Harbor Mart"
    });

    const context = await loadMatchContext(sql, {
      userId,
      fromIso: "2026-09-30T00:00:00Z",
      toIso: "2026-10-08T00:00:00Z",
      timezone: "Australia/Adelaide"
    });
    expect(context.commitments).toHaveLength(1);
    expect(context.commitments[0]).toMatchObject({
      id: inside,
      title: "Harbor Mart",
      allDay: false,
      // 09:00Z is 19:30 in Adelaide (ACDT), the same calendar day.
      localDate: "2026-10-01",
      links: [{ provider: EXAMPLE_DAILY, externalId: "daily-1" }]
    });
    expect(context.aliases).toHaveLength(1);
    expect(context.aliases[0]!.provider).toBe(EXAMPLE_SHARED);
  });
});
