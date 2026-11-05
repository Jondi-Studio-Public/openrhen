import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import type { PlanForecastResponse } from "@openrhen/contracts";
import { persistDerivedState } from "./plan-forecast-runtime.js";
import { integrationDatabaseName } from "../operations/integration-database.js";

config({ path: resolve(process.cwd(), "../../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
// A database of its own for the same reason the presence, occurrence, retention and routine
// suites each have one: these suites truncate, and two of them truncating the same database is an
// unreproducible flake.
const testDatabaseName = integrationDatabaseName(
  process.env.COMMITMENT_TOUCH_TEST_DATABASE_NAME,
  "openrhen_commitment_touch"
);

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("COMMITMENT_TOUCH_TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

const HOUR = 3_600_000;
const now = new Date("2026-09-01T22:00:00Z");

let sql: postgres.Sql;
let userId: string;
let ruleId: string;

beforeAll(async () => {
  const admin = postgres(adminUrl!, { max: 1, connect_timeout: 10 });
  try {
    const existing = await admin<
      { exists: boolean }[]
    >`SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = ${testDatabaseName}) AS exists`;
    if (!existing[0]?.exists) await admin.unsafe(`CREATE DATABASE "${testDatabaseName}"`);
  } finally {
    await admin.end();
  }
  const migrationSql = postgres(testUrl.toString(), { max: 1, connect_timeout: 10 });
  try {
    await migrate(drizzle(migrationSql), { migrationsFolder: resolve(process.cwd(), "drizzle") });
  } finally {
    await migrationSql.end();
  }
  sql = postgres(testUrl.toString(), { max: 5, connect_timeout: 10, fetch_types: false });
}, 60_000);

beforeEach(async () => {
  // This suite is allowed to clear only a database whose validated name ends in _test.
  await sql.unsafe("TRUNCATE TABLE users RESTART IDENTITY CASCADE");
  const users = await sql<{ id: string }[]>`
    INSERT INTO users (display_name) VALUES ('Touch Fixture') RETURNING id
  `;
  userId = users[0]!.id;
  await sql`INSERT INTO user_preferences (user_id) VALUES (${userId})`;
  const rules = await sql<{ id: string }[]>`
    INSERT INTO commitment_recurrence_rules (user_id,title,timezone,start_date,interval_days,local_start_time,local_end_time,presence,share_to_calendar)
    VALUES (${userId},'Evening Workshop','Australia/Sydney','2026-08-26',7,'18:00','20:30','blocking',true) RETURNING id
  `;
  ruleId = rules[0]!.id;
});

afterAll(async () => {
  await sql?.end();
});

/** A minimal PlanForecastResponse `persistDerivedState` reads only `derivedState`, `inputVersion`
 * and `calculatedAt` from — the rest of the (much larger) contract shape is irrelevant to it. */
function resultWith(commitmentRepeats: Array<Record<string, unknown>>, calculatedAt = now): PlanForecastResponse {
  return {
    inputVersion: "v1",
    calculatedAt: calculatedAt.toISOString(),
    derivedState: {
      sleepPlans: [],
      occurrences: [],
      routineSteps: [],
      commitmentRepeats
    }
  } as unknown as PlanForecastResponse;
}

function occurrence(id: string, startsAt: Date) {
  return {
    id,
    recurrenceRuleId: ruleId,
    localDate: startsAt.toISOString().slice(0, 10),
    startsAt: startsAt.toISOString(),
    endsAt: new Date(startsAt.getTime() + 8 * HOUR).toISOString(),
    title: "Evening Workshop",
    status: "confirmed",
    presence: "blocking"
  };
}

async function rowsOf(ids: string[]) {
  const rows = await sql<
    { id: string; title: string; starts_at: Date; updated_at: Date; version: number }[]
  >`SELECT id,title,starts_at,updated_at,version FROM commitments WHERE id IN ${sql(ids)} ORDER BY id`;
  return rows;
}

// `updated_at` is the "something about this row changed" signal. The replan re-upserts every derived
// occurrence each run, so an upsert that rewrote an unchanged row bumped `updated_at` on every
// commitment a second after an unrelated save (182 of them in one report).
describe("persistDerivedState — commitment occurrence upsert leaves unchanged rows untouched", () => {
  it("keeps updated_at on a replan that changes nothing, and moves it only for rows whose value changed", async () => {
    const starts = [0, 1, 2].map((day) => new Date(now.getTime() + day * 24 * HOUR));
    const ids = starts.map(() => crypto.randomUUID());
    const derived = (title: string) => ids.map((id, i) => ({ ...occurrence(id, starts[i]!), title }));

    await persistDerivedState(sql, userId, resultWith(derived("Evening Workshop")));
    const first = await rowsOf(ids);
    expect(first).toHaveLength(3);

    // Same input again, later: nothing may be written.
    await new Promise((done) => setTimeout(done, 20));
    await persistDerivedState(sql, userId, resultWith(derived("Evening Workshop"), new Date(now.getTime() + HOUR)));
    const second = await rowsOf(ids);
    expect(second.map((r) => r.updated_at.getTime())).toEqual(first.map((r) => r.updated_at.getTime()));

    // The rule's title changes. One occurrence was edited on its own (schedule_source 'custom'), so it
    // keeps its title and its row is not touched; the two inheriting ones take the new value.
    await sql`UPDATE commitments SET title='Custom title',schedule_source='custom' WHERE id=${ids[0]!}`;
    const edited = await rowsOf(ids);
    await new Promise((done) => setTimeout(done, 20));
    await persistDerivedState(sql, userId, resultWith(derived("Renamed Class"), new Date(now.getTime() + 2 * HOUR)));
    const third = await rowsOf(ids);
    const byId = new Map(third.map((r) => [r.id, r]));
    const editedById = new Map(edited.map((r) => [r.id, r]));

    expect(byId.get(ids[0]!)!.title).toBe("Custom title");
    expect(byId.get(ids[0]!)!.updated_at.getTime()).toBe(editedById.get(ids[0]!)!.updated_at.getTime());
    for (const id of [ids[1]!, ids[2]!]) {
      expect(byId.get(id)!.title).toBe("Renamed Class");
      expect(byId.get(id)!.updated_at.getTime()).toBeGreaterThan(editedById.get(id)!.updated_at.getTime());
    }

    // And a time change moves the inheriting rows too.
    const movedStarts = starts.map((d) => new Date(d.getTime() + HOUR));
    await new Promise((done) => setTimeout(done, 20));
    await persistDerivedState(
      sql,
      userId,
      resultWith(
        ids.map((id, i) => ({ ...occurrence(id, movedStarts[i]!), title: "Renamed Class" })),
        new Date(now.getTime() + 3 * HOUR)
      )
    );
    const fourth = new Map((await rowsOf(ids)).map((r) => [r.id, r]));
    expect(fourth.get(ids[1]!)!.starts_at.getTime()).toBe(movedStarts[1]!.getTime());
    expect(fourth.get(ids[1]!)!.updated_at.getTime()).toBeGreaterThan(byId.get(ids[1]!)!.updated_at.getTime());
    expect(fourth.get(ids[0]!)!.starts_at.getTime()).toBe(starts[0]!.getTime());
    expect(fourth.get(ids[0]!)!.updated_at.getTime()).toBe(byId.get(ids[0]!)!.updated_at.getTime());
  });
});

// "I'm free" is a per-occurrence fact stored on the materialised row. The replan upserts only the columns it
// lists, so the statement survives a replan that re-materialises the same occurrence.
describe("persistDerivedState — freed_from survives re-materialisation", () => {
  it("keeps freed_from (and the row's version and updated_at) when the planner re-upserts the occurrence", async () => {
    const id = crypto.randomUUID();
    const starts = new Date(now.getTime() - 2 * HOUR);
    await persistDerivedState(sql, userId, resultWith([occurrence(id, starts)]));
    const freedAt = new Date(now.getTime() - HOUR);
    await sql`UPDATE commitments SET freed_from=${freedAt} WHERE id=${id}`;
    const before = await rowsOf([id]);

    await new Promise((done) => setTimeout(done, 20));
    // The same occurrence with a changed title: the inheriting row takes the planner's value, the statement stays.
    await persistDerivedState(
      sql,
      userId,
      resultWith([{ ...occurrence(id, starts), title: "Renamed Class" }], new Date(now.getTime() + HOUR))
    );
    const after = await sql<
      { title: string; freed_from: Date | null }[]
    >`SELECT title,freed_from FROM commitments WHERE id=${id}`;
    expect(after[0]!.title).toBe("Renamed Class");
    expect(after[0]!.freed_from?.getTime()).toBe(freedAt.getTime());
    expect(before).toHaveLength(1);
  });
});
