import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { fileURLToPath } from "node:url";
import type { ImportField, ImportRecord } from "@openrhen/contracts";
import { integrationDatabaseName } from "@openrhen/database";
import { EXAMPLE_DAILY, EXAMPLE_SHARED } from "@/test/example-calendar-sources";
import { ensureUser } from "../ensure-user";
import { fieldReader, upsertCommitment, upsertCommitmentRecurrenceRule } from "./upserts";

/**
 * Task 006: the primary-source shift-create path in `upsertCommitment` must set the new row's
 * `share_to_calendar` from the user's standing `share_primary_events` preference (not a per-shift
 * choice), while every other creator here keeps defaulting to unshared/inherit, and an update never
 * clobbers an existing value it wasn't asked to change. Runs against its own self-contained `_test`
 * database, same pattern as `../activity-commands-ended-at.integration.test.ts`, and so belongs to
 * `corepack pnpm test:integration`: the plain unit run opens no database.
 */

// Resolved from this file rather than from `process.cwd()` — see the note in
// `../activity-commands-ended-at.integration.test.ts`.
config({ path: fileURLToPath(new URL("../../../../../.env", import.meta.url)), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(process.env.UPSERTS_TEST_DATABASE_NAME, "openrhen_upserts");

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("UPSERTS_TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let userId: string;

function field(value: unknown): ImportField {
  return value === null || value === undefined
    ? { value: null, basis: "missing", confidence: null, evidence: [], needsReview: false, source: "cell" }
    : { value, basis: "explicit", confidence: "high", evidence: [], needsReview: false, source: "cell" };
}

function createRecord(importKey: string, fields: Record<string, unknown>): ImportRecord {
  return {
    id: crypto.randomUUID(),
    importKey,
    entityType: "fixed_commitment",
    operation: "create",
    expectedVersion: null,
    matchedEntityId: null,
    fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, field(v)])),
    relationships: {},
    errors: [],
    warnings: [],
    removed: false,
    sortOrder: 0
  };
}

const commitmentFields = () => ({
  title: "Work (Harbor Mart)",
  startsAt: new Date(Date.now() + 3_600_000).toISOString(),
  endsAt: new Date(Date.now() + 7_200_000).toISOString(),
  status: "confirmed",
  setupBeforeMinutes: 0,
  transitionAfterMinutes: 0
});

async function shareColumns(id: string) {
  const rows = await sql<
    { share_to_calendar: boolean; share_source: string }[]
  >`SELECT share_to_calendar, share_source FROM commitments WHERE id=${id}`;
  return rows[0]!;
}

async function setSharePrimaryEvents(value: boolean) {
  await sql`UPDATE user_preferences SET share_primary_events=${value} WHERE user_id=${userId}`;
}

beforeAll(async () => {
  const admin = postgres(adminUrl!, { max: 1, connect_timeout: 10 });
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
    await migrate(drizzle(migrationSql), {
      migrationsFolder: fileURLToPath(new URL("../../../../../platform/database/drizzle", import.meta.url))
    });
  } finally {
    await migrationSql.end();
  }
  sql = postgres(testUrl.toString(), { max: 5, connect_timeout: 10, fetch_types: false, prepare: true });
  userId = await ensureUser(sql);
}, 30_000);

beforeEach(async () => {
  await sql.unsafe("TRUNCATE TABLE commitments RESTART IDENTITY CASCADE");
  await sql`UPDATE user_preferences SET share_primary_events=false WHERE user_id=${userId}`;
});

afterAll(async () => {
  await sql?.end();
});

describe("upsertCommitment sharing columns", () => {
  it("sets a new primary-source shift's share_to_calendar to true when share_primary_events is enabled", async () => {
    await setSharePrimaryEvents(true);
    const id = crypto.randomUUID();
    const record = createRecord(`${EXAMPLE_DAILY}:shift:1`, commitmentFields());
    await upsertCommitment(sql, userId, id, record, fieldReader(record));
    expect(await shareColumns(id)).toEqual({ share_to_calendar: true, share_source: "inherit" });
  });

  it("sets a new primary-source shift's share_to_calendar to false when share_primary_events is disabled", async () => {
    await setSharePrimaryEvents(false);
    const id = crypto.randomUUID();
    const record = createRecord(`${EXAMPLE_DAILY}:shift:2`, commitmentFields());
    await upsertCommitment(sql, userId, id, record, fieldReader(record));
    expect(await shareColumns(id)).toEqual({ share_to_calendar: false, share_source: "inherit" });
  });

  it("leaves a non-primary create unshared/inherit even when share_primary_events is enabled", async () => {
    await setSharePrimaryEvents(true);
    const id = crypto.randomUUID();
    const record = createRecord(`${EXAMPLE_SHARED}:event:abc`, commitmentFields());
    await upsertCommitment(sql, userId, id, record, fieldReader(record));
    expect(await shareColumns(id)).toEqual({ share_to_calendar: false, share_source: "inherit" });
  });

  it("does not clobber an existing share_to_calendar/share_source on update", async () => {
    await setSharePrimaryEvents(true);
    const id = crypto.randomUUID();
    const createRec = createRecord(`${EXAMPLE_DAILY}:shift:3`, commitmentFields());
    await upsertCommitment(sql, userId, id, createRec, fieldReader(createRec));
    expect(await shareColumns(id)).toEqual({ share_to_calendar: true, share_source: "inherit" });

    // Pin it to 'custom' the way an occurrence-level save would, out of band from this file.
    await sql`UPDATE commitments SET share_source='custom' WHERE id=${id}`;

    const versionRow = await sql<{ version: number }[]>`SELECT version FROM commitments WHERE id=${id}`;
    const updateRec: ImportRecord = {
      ...createRec,
      operation: "update",
      expectedVersion: versionRow[0]!.version,
      fields: Object.fromEntries(
        Object.entries({ title: "Work (Harbor Mart) — updated" }).map(([k, v]) => [k, field(v)])
      )
    };
    await upsertCommitment(sql, userId, id, updateRec, fieldReader(updateRec));
    expect(await shareColumns(id)).toEqual({ share_to_calendar: true, share_source: "custom" });
  });
});

describe("upsertCommitmentRecurrenceRule repeat columns", () => {
  const ruleFields = (repeat: Record<string, unknown>) => ({
    title: "Tutoring",
    timezone: "Australia/Sydney",
    startDate: "2026-09-29",
    endDate: null,
    localStartTime: "16:00",
    localEndTime: "17:00",
    setupBeforeMinutes: 0,
    transitionAfterMinutes: 0,
    ...repeat
  });
  const ruleRecord = (fields: Record<string, unknown>): ImportRecord => ({
    ...createRecord("sheet:rule:tutoring", fields),
    entityType: "fixed_commitment_recurrence"
  });
  const repeatColumns = async (id: string) =>
    (
      await sql<
        {
          interval_unit: string;
          interval_days: number | null;
          interval_weeks: number | null;
          weekdays: number[] | null;
          interval_months: number | null;
          month_anchor: string | null;
          version: number;
        }[]
      >`SELECT interval_unit::text AS interval_unit, interval_days, interval_weeks, weekdays, interval_months, month_anchor::text AS month_anchor, version FROM commitment_recurrence_rules WHERE id=${id}`
    )[0]!;
  const update = async (id: string, fields: Record<string, unknown>) => {
    const record: ImportRecord = {
      ...ruleRecord(fields),
      operation: "update",
      expectedVersion: (await repeatColumns(id)).version
    };
    await upsertCommitmentRecurrenceRule(sql, userId, id, record, fieldReader(record));
  };

  beforeEach(async () => {
    await sql.unsafe("TRUNCATE TABLE commitment_recurrence_rules RESTART IDENTITY CASCADE");
  });

  it("stores a weeks rule's weekdays in their one sorted, de-duplicated spelling", async () => {
    const id = crypto.randomUUID();
    const record = ruleRecord(ruleFields({ intervalUnit: "weeks", intervalWeeks: 1, weekdays: [4, 2, 4] }));
    await upsertCommitmentRecurrenceRule(sql, userId, id, record, fieldReader(record));
    expect(await repeatColumns(id)).toMatchObject({
      interval_unit: "weeks",
      interval_days: null,
      interval_weeks: 1,
      weekdays: [2, 4],
      interval_months: null,
      month_anchor: null
    });
  });

  it("clears the old unit's columns when an update switches months to weeks, then weeks to days", async () => {
    const id = crypto.randomUUID();
    const record = ruleRecord(ruleFields({ intervalUnit: "months", intervalMonths: 1, monthAnchor: "last_weekday" }));
    await upsertCommitmentRecurrenceRule(sql, userId, id, record, fieldReader(record));

    await update(id, { intervalUnit: "weeks", intervalWeeks: 2, weekdays: [2, 4] });
    expect(await repeatColumns(id)).toMatchObject({
      interval_unit: "weeks",
      interval_days: null,
      interval_weeks: 2,
      weekdays: [2, 4],
      interval_months: null,
      month_anchor: null
    });

    await update(id, { intervalUnit: "days", intervalDays: 7 });
    expect(await repeatColumns(id)).toMatchObject({
      interval_unit: "days",
      interval_days: 7,
      interval_weeks: null,
      weekdays: null,
      interval_months: null,
      month_anchor: null
    });
  });
});
