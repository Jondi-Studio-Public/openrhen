import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from "vitest";
import { config } from "dotenv";
import { resolve } from "node:path";
import postgres from "postgres";
import {
  bigint,
  boolean,
  date,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  smallint,
  text,
  time,
  timestamp,
  uuid
} from "drizzle-orm/pg-core";
import { integrationDatabaseName } from "@openrhen/database";
import type { DbRow, LeftJoined, Row } from "./db-row";
import { sqlPool, type PoolSql } from "./sql-pool";

config({ path: resolve(process.cwd(), "../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(process.env.TEST_DATABASE_NAME, "openrhen_db_row");

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

// One column of every kind `DbRow` maps, declared the way `schema.ts` declares them, including the
// `date` mode `string` that postgres.js ignores.
const mood = pgEnum("db_row_mood", ["low", "high"]);
const probe = pgTable("db_row_probe", {
  id: uuid("id").primaryKey(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  localDay: date("local_day", { mode: "string" }).notNull(),
  dayAsDate: date("day_as_date", { mode: "date" }),
  startsAt: time("starts_at").notNull(),
  fraction: numeric("fraction").notNull(),
  total: bigint("total", { mode: "number" }).notNull(),
  count: integer("count").notNull(),
  rank: smallint("rank").notNull(),
  flag: boolean("flag").notNull(),
  payload: jsonb("payload").notNull(),
  tags: text("tags").array().notNull(),
  mood: mood("mood").notNull(),
  note: text("note")
});

let sql: PoolSql;

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
  // The production pool, options and all: `fetch_types` decides how arrays and enums come back.
  sql = sqlPool(testUrl.toString());
  await sql.unsafe(`
    DROP TABLE IF EXISTS db_row_probe;
    DROP TYPE IF EXISTS db_row_mood;
    CREATE TYPE db_row_mood AS ENUM ('low', 'high');
    CREATE TABLE db_row_probe (
      id uuid PRIMARY KEY, started_at timestamptz NOT NULL, local_day date NOT NULL, day_as_date date,
      starts_at time NOT NULL, fraction numeric NOT NULL, total bigint NOT NULL, count integer NOT NULL,
      rank smallint NOT NULL, flag boolean NOT NULL, payload jsonb NOT NULL, tags text[] NOT NULL,
      mood db_row_mood NOT NULL, note text
    );
    INSERT INTO db_row_probe VALUES ('00000000-0000-4000-8000-000000000001', '2026-10-27T01:02:03Z',
      '2026-10-27', NULL, '07:30', 0.25, 9007199254740993, 42, 3, true, '{"a":[1]}', '{x,y}', 'high', NULL);
  `);
}, 30_000);

afterAll(async () => {
  await sql?.end();
});

describe("DbRow", () => {
  it("types every column the way postgres.js decodes it", async () => {
    const rows = await sql<DbRow<typeof probe>[]>`SELECT * FROM db_row_probe`;
    const row = rows[0]!;

    expectTypeOf(row.started_at).toEqualTypeOf<Date>();
    expect(row.started_at).toBeInstanceOf(Date);
    expectTypeOf(row.local_day).toEqualTypeOf<Date>();
    expect(row.local_day).toBeInstanceOf(Date);
    expectTypeOf(row.day_as_date).toEqualTypeOf<Date | null>();
    expect(row.day_as_date).toBeNull();
    expectTypeOf(row.starts_at).toEqualTypeOf<string>();
    expect(row.starts_at).toBe("07:30:00");
    expectTypeOf(row.fraction).toEqualTypeOf<string>();
    expect(row.fraction).toBe("0.25");
    expectTypeOf(row.total).toEqualTypeOf<string>();
    expect(row.total).toBe("9007199254740993");
    expectTypeOf(row.count).toEqualTypeOf<number>();
    expect(row.count).toBe(42);
    expect(row.rank).toBe(3);
    expectTypeOf(row.flag).toEqualTypeOf<boolean>();
    expect(row.flag).toBe(true);
    expect(row.payload).toEqual({ a: [1] });
    expectTypeOf(row.tags).toEqualTypeOf<string[]>();
    expect(row.tags).toEqual(["x", "y"]);
    expectTypeOf(row.mood).toEqualTypeOf<"low" | "high">();
    expect(row.mood).toBe("high");
    expectTypeOf(row.note).toEqualTypeOf<string | null>();
    expect(row.note).toBeNull();
  });

  it("keys rows by database column name and refuses columns the table does not have", () => {
    expectTypeOf<keyof Row<typeof probe, "started_at" | "note">>().toEqualTypeOf<"started_at" | "note">();
    // @ts-expect-error `startedAt` is the Drizzle property name; a raw query returns `started_at`.
    expectTypeOf<Row<typeof probe, "startedAt">>();
    expectTypeOf<LeftJoined<Row<typeof probe, "count">>["count"]>().toEqualTypeOf<number | null>();
  });
});
