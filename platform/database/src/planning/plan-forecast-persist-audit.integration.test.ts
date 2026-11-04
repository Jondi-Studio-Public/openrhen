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
// A database of its own, mirroring the sibling commitment-presence/commitment-share suites: this
// suite truncates, and two suites truncating the same database is an unreproducible flake.
const testDatabaseName = integrationDatabaseName(
  process.env.PERSIST_AUDIT_TEST_DATABASE_NAME,
  "openrhen_persist_audit"
);

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("PERSIST_AUDIT_TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

const HOUR = 3_600_000;
// "Now" sits inside the fixture commitment's own window, so the first persisted row is already
// under way by the time the second (edited-rule) replan runs.
const now = new Date("2026-09-01T12:00:00Z");

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
    INSERT INTO users (display_name) VALUES ('Persist Audit Fixture') RETURNING id
  `;
  userId = users[0]!.id;
  await sql`INSERT INTO user_preferences (user_id) VALUES (${userId})`;
  const rules = await sql<{ id: string }[]>`
    INSERT INTO commitment_recurrence_rules (user_id,title,timezone,start_date,interval_days,local_start_time,local_end_time,presence)
    VALUES (${userId},'Evening Workshop','Australia/Sydney','2026-08-26',7,'18:00','20:30','blocking') RETURNING id
  `;
  ruleId = rules[0]!.id;
});

afterAll(async () => {
  await sql?.end();
});

/** A minimal PlanForecastResponse `persistDerivedState` reads only `derivedState`, `inputVersion`
 * and `calculatedAt` from — the rest of the (much larger) contract shape is irrelevant to it. */
function resultWith(commitmentRepeats: Array<Record<string, unknown>>, calculatedAt: Date): PlanForecastResponse {
  return {
    inputVersion: "v1",
    calculatedAt: calculatedAt.toISOString(),
    derivedState: {
      sleepPlans: [],
      occurrences: [],
      routineSteps: [],
      commitmentRepeats,
      commitmentTimelines: []
    }
  } as unknown as PlanForecastResponse;
}

function occurrence(id: string, title: string, startsAt: Date, endsAt: Date, extra: Record<string, unknown> = {}) {
  return {
    id,
    recurrenceRuleId: ruleId,
    localDate: startsAt.toISOString().slice(0, 10),
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    title,
    status: "confirmed",
    presence: "blocking",
    setupBeforeMinutes: 10,
    transitionAfterMinutes: 5,
    ...extra
  };
}

async function commitmentRowOf(id: string) {
  const rows = await sql<
    {
      title: string;
      starts_at: Date;
      ends_at: Date;
      setup_before_minutes: number;
      lateness_matters: boolean;
      transport_mode: string | null;
      contact_id: string | null;
    }[]
  >`SELECT title,starts_at,ends_at,setup_before_minutes,lateness_matters,transport_mode,contact_id FROM commitments WHERE id=${id}`;
  return rows[0];
}

// A recurring commitment's materialised row (deriveCommitmentRepeats, engine/core/src/engine.ts) is
// re-derived from its rule's *current* local_start_time/local_end_time/title/setup on every replan —
// deterministically, not "whatever was already resolved" the way an occurrence's window or a sleep
// plan's timing is. The plan-forecast persist runs on every entity command, so once today's
// occurrence has already begun (now falls inside [starts_at, ends_at)), an edit to the recurrence
// rule made *during* that live window — a corrected start time, a retitle, a setup-buffer tweak —
// would reach the very row the person is currently sitting inside of, silently moving the clock out
// from under a commitment already under way. Contrast `upsertActionOccurrence`, which freezes a
// `completed`/`missed` row, and the sleep upsert, which freezes a `sleeping`/`completed` row: this
// upsert (persistDerivedState, plan-forecast-runtime.ts, the `commitmentRepeats` loop) now has the
// same shape of guard, keyed on `schedule_source` rather than status — a row the series-save (or an
// occurrence edit) already marked 'custom' keeps its stored title, times, setup, lateness, transport
// mode and contact through every later replan; an 'inherit' row keeps healing from the rule.
describe("persistDerivedState — commitment repeat schedule_source guard", () => {
  // The secondary case: a series edit reaching an occurrence already under way. The design's answer
  // (series save asks "Also change the one happening now?"; declining marks that occurrence 'custom'
  // with its current values, task 005) is stood in for here with a direct SQL update, since the save
  // command itself is out of this file's scope. The primary case, "Edit this occurrence" surviving a
  // replan, runs end to end in
  // portal/server/persistence/postgres/commitment-occurrence-edit.integration.test.ts.
  it("keeps a 'custom' commitment repeat's stored values through a rule edit that reaches it mid-occurrence", async () => {
    const id = crypto.randomUUID();
    const startsAt = new Date(now.getTime() - HOUR); // started an hour ago
    const endsAt = new Date(now.getTime() + HOUR); // still running

    await persistDerivedState(
      sql,
      userId,
      resultWith([occurrence(id, "Evening Workshop", startsAt, endsAt)], new Date(startsAt.getTime() - HOUR))
    );
    expect(await commitmentRowOf(id)).toEqual({
      title: "Evening Workshop",
      starts_at: startsAt,
      ends_at: endsAt,
      setup_before_minutes: 10,
      lateness_matters: true,
      transport_mode: null,
      contact_id: null
    });

    // Stands in for the series save leaving the occurrence in progress alone (task 005): mark it
    // 'custom' with its current values before the edited-rule replan runs.
    await sql`UPDATE commitments SET schedule_source='custom' WHERE id=${id}`;

    // The rule is edited while this very occurrence is live: a later start time, a new title, a
    // longer setup buffer. The engine deterministically re-derives the *same* occurrence id from the
    // edited rule (recurrence.ts's `resolveCommitmentRecurrenceRepeats` keeps any occurrence whose
    // `endsAt > now`, so an in-progress one is not excluded), and the very next replan — which fires
    // on every entity command, including the rule save itself — persists it.
    const editedStartsAt = new Date(startsAt.getTime() + 30 * 60_000);
    const editedEndsAt = new Date(endsAt.getTime() + 30 * 60_000);
    await persistDerivedState(
      sql,
      userId,
      resultWith(
        [occurrence(id, "Evening Workshop (renamed)", editedStartsAt, editedEndsAt, { setupBeforeMinutes: 25 })],
        now
      )
    );

    // The 'custom' row keeps its original title, times and setup: the conflict branch never rewrites
    // those columns while schedule_source stays 'custom'.
    expect(await commitmentRowOf(id)).toEqual({
      title: "Evening Workshop",
      starts_at: startsAt,
      ends_at: endsAt,
      setup_before_minutes: 10,
      lateness_matters: true,
      transport_mode: null,
      contact_id: null
    });
  });

  it("still heals an 'inherit' commitment repeat's title, times, setup, lateness, transport mode and contact from the rule", async () => {
    const id = crypto.randomUUID();
    const startsAt = new Date(now.getTime() - HOUR);
    const endsAt = new Date(now.getTime() + HOUR);

    await persistDerivedState(
      sql,
      userId,
      resultWith([occurrence(id, "Evening Workshop", startsAt, endsAt)], new Date(startsAt.getTime() - HOUR))
    );
    expect(await commitmentRowOf(id)).toEqual({
      title: "Evening Workshop",
      starts_at: startsAt,
      ends_at: endsAt,
      setup_before_minutes: 10,
      lateness_matters: true,
      transport_mode: null,
      contact_id: null
    });

    // The row is never marked 'custom', so a later replan from an edited rule heals every overlay
    // column, including the ones the rule started emitting.
    const editedStartsAt = new Date(startsAt.getTime() + 30 * 60_000);
    const editedEndsAt = new Date(endsAt.getTime() + 30 * 60_000);
    await persistDerivedState(
      sql,
      userId,
      resultWith(
        [
          occurrence(id, "Evening Workshop (renamed)", editedStartsAt, editedEndsAt, {
            setupBeforeMinutes: 25,
            latenessMatters: false,
            transportMode: "bike",
            contactId: "contact-1"
          })
        ],
        now
      )
    );

    expect(await commitmentRowOf(id)).toEqual({
      title: "Evening Workshop (renamed)",
      starts_at: editedStartsAt,
      ends_at: editedEndsAt,
      setup_before_minutes: 25,
      lateness_matters: false,
      transport_mode: "bike",
      contact_id: "contact-1"
    });
  });
});

// The cleanup delete drops recurring occurrences the run no longer resolved. It used to bound "future"
// by the database clock while the engine resolved from the run's `calculatedAt`, so an occurrence
// starting in the gap between the two survived a replan that no longer produced it.
describe("persistDerivedState — recurring occurrence cleanup uses the run's clock", () => {
  it("drops an unresolved occurrence starting after calculatedAt the same way whether or not it has started by persist time", async () => {
    const wallNow = Date.now();
    const calculatedAt = new Date(wallNow - 2 * HOUR);
    const inGap = crypto.randomUUID(); // starts after calculatedAt but before the persist runs
    const ahead = crypto.randomUUID(); // starts after both, a day later
    const kept = crypto.randomUUID(); // still resolved by the run, two days later
    const gapStart = new Date(wallNow - HOUR);
    const aheadStart = new Date(wallNow + 25 * HOUR);
    const keptStart = new Date(wallNow + 49 * HOUR);

    await persistDerivedState(
      sql,
      userId,
      resultWith(
        [
          occurrence(inGap, "Evening Workshop", gapStart, new Date(gapStart.getTime() + 30 * 60_000)),
          occurrence(ahead, "Evening Workshop", aheadStart, new Date(aheadStart.getTime() + 30 * 60_000)),
          occurrence(kept, "Evening Workshop", keptStart, new Date(keptStart.getTime() + 30 * 60_000))
        ],
        calculatedAt
      )
    );

    // An hour-old run whose rule no longer produces the first two occurrences.
    await persistDerivedState(
      sql,
      userId,
      resultWith(
        [occurrence(kept, "Evening Workshop", keptStart, new Date(keptStart.getTime() + 30 * 60_000))],
        calculatedAt
      )
    );

    expect(await commitmentRowOf(inGap)).toBeUndefined();
    expect(await commitmentRowOf(ahead)).toBeUndefined();
    expect(await commitmentRowOf(kept)).toBeDefined();
  });
});
