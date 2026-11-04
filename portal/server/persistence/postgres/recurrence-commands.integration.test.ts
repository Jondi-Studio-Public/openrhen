import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import {
  saveCommitmentRecurrenceRuleCommandSchema,
  type SaveCommitmentRecurrenceRuleCommand
} from "@openrhen/contracts";
import { PLAN_FORECAST_JOB_TYPE, integrationDatabaseName } from "@openrhen/database";
import { saveCommitmentRecurrenceRule } from "./recurrence-commands";
import { stableUuid } from "./command-values";

config({ path: resolve(process.cwd(), "../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(
  process.env.RECURRENCE_COMMANDS_TEST_DATABASE_NAME,
  "openrhen_recurrence_commands"
);

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
  await sql.unsafe("TRUNCATE TABLE users, user_preferences, portal_state, commitment_recurrence_rules CASCADE");
  const users = await sql<{ id: string }[]>`INSERT INTO users (display_name) VALUES ('Recurrence Test') RETURNING id`;
  userId = users[0]!.id;
  await sql`INSERT INTO user_preferences (user_id) VALUES (${userId})`;
});

afterAll(async () => {
  await sql?.end();
});

/** A minimal SaveCommitmentRecurrenceRuleCommand for testing. */
function ruleCommand(
  overrides: {
    commandId?: string;
    expectedVersion?: number | null;
    rule?: Partial<SaveCommitmentRecurrenceRuleCommand["rule"]>;
    applyToOccurrenceInProgress?: boolean;
  } = {}
): SaveCommitmentRecurrenceRuleCommand {
  const rule: SaveCommitmentRecurrenceRuleCommand["rule"] = {
    id: "college-class",
    title: "College Class",
    timezone: "Australia/Sydney",
    startDate: "2026-09-01",
    repeat: { unit: "days", intervalDays: 7 },
    localStartTime: "08:00",
    localEndTime: "16:00",
    setupBeforeMinutes: 0,
    transitionAfterMinutes: 0,
    ...overrides.rule
  };
  return {
    commandId: overrides.commandId ?? crypto.randomUUID(),
    expectedVersion: overrides.expectedVersion ?? null,
    rule,
    ...(overrides.applyToOccurrenceInProgress !== undefined
      ? { applyToOccurrenceInProgress: overrides.applyToOccurrenceInProgress }
      : {})
  };
}

async function ruleFromDb(ruleKey: string) {
  const id = await stableUuid(`commitment-recurrence:${userId}`, ruleKey);
  const rows = await sql<{ share_to_calendar: boolean; version: number }[]>`
    SELECT share_to_calendar, version FROM commitment_recurrence_rules WHERE id = ${id}
  `;
  return rows[0];
}

describe("saveCommitmentRecurrenceRule — shareToCalendar persistence", () => {
  it("saves a rule with shareToCalendar: true and persists it", async () => {
    const command = ruleCommand();
    command.rule.shareToCalendar = true;
    await saveCommitmentRecurrenceRule(sql, command);

    const row = await ruleFromDb("college-class");
    expect(row?.share_to_calendar).toBe(true);
  });

  it("saves a rule with shareToCalendar: false and persists it", async () => {
    const command = ruleCommand();
    command.rule.shareToCalendar = false;
    await saveCommitmentRecurrenceRule(sql, command);

    const row = await ruleFromDb("college-class");
    expect(row?.share_to_calendar).toBe(false);
  });

  it("omitting shareToCalendar on insert defaults to false", async () => {
    const command = ruleCommand();
    // Explicitly no shareToCalendar field
    delete command.rule.shareToCalendar;
    await saveCommitmentRecurrenceRule(sql, command);

    const row = await ruleFromDb("college-class");
    expect(row?.share_to_calendar).toBe(false);
  });

  it("omitting shareToCalendar on update leaves the stored value alone", async () => {
    // First save with true
    let command = ruleCommand();
    command.rule.shareToCalendar = true;
    await saveCommitmentRecurrenceRule(sql, command);

    let row = await ruleFromDb("college-class");
    expect(row?.share_to_calendar).toBe(true);
    const version1 = row!.version;

    // Now update without the shareToCalendar field — it should stay true
    command = ruleCommand();
    command.expectedVersion = version1;
    delete command.rule.shareToCalendar;
    await saveCommitmentRecurrenceRule(sql, command);

    row = await ruleFromDb("college-class");
    expect(row?.share_to_calendar).toBe(true);
  });

  it("updating with an explicit value overwrites the stored value", async () => {
    // First save with true
    let command = ruleCommand();
    command.rule.shareToCalendar = true;
    await saveCommitmentRecurrenceRule(sql, command);

    let row = await ruleFromDb("college-class");
    expect(row?.share_to_calendar).toBe(true);
    const version1 = row!.version;

    // Now update with explicit false
    command = ruleCommand();
    command.expectedVersion = version1;
    command.rule.shareToCalendar = false;
    await saveCommitmentRecurrenceRule(sql, command);

    row = await ruleFromDb("college-class");
    expect(row?.share_to_calendar).toBe(false);
  });
});

describe("saveCommitmentRecurrenceRule — monthly repeat", () => {
  async function repeatColumnsFromDb(ruleKey: string) {
    const id = await stableUuid(`commitment-recurrence:${userId}`, ruleKey);
    const rows = await sql<
      {
        interval_unit: string;
        interval_days: number | null;
        interval_weeks: number | null;
        weekdays: number[] | null;
        interval_months: number | null;
        month_anchor: string | null;
      }[]
    >`SELECT interval_unit, interval_days, interval_weeks, weekdays, interval_months, month_anchor FROM commitment_recurrence_rules WHERE id = ${id}`;
    return rows[0];
  }

  it("round trips a monthly rule through save and read", async () => {
    const command = ruleCommand({
      rule: {
        id: "book-club",
        title: "Book club",
        timezone: "Australia/Sydney",
        startDate: "2026-01-31",
        repeat: { unit: "months", intervalMonths: 1, anchor: "last_day" },
        localStartTime: "18:00",
        localEndTime: "20:00",
        setupBeforeMinutes: 0,
        transitionAfterMinutes: 0
      }
    });
    await saveCommitmentRecurrenceRule(sql, command);
    const row = await repeatColumnsFromDb("book-club");
    expect(row).toMatchObject({
      interval_unit: "months",
      interval_days: null,
      interval_months: 1,
      month_anchor: "last_day"
    });
  });

  it("round trips a weekday-set rule through save and read", async () => {
    const command = ruleCommand({
      rule: {
        id: "tue-thu-class",
        title: "Tue Thu class",
        timezone: "Australia/Sydney",
        startDate: "2026-09-01",
        repeat: { unit: "weeks", intervalWeeks: 2, weekdays: [2, 4] },
        localStartTime: "09:00",
        localEndTime: "10:00",
        setupBeforeMinutes: 0,
        transitionAfterMinutes: 0
      }
    });
    const state = await saveCommitmentRecurrenceRule(sql, command);
    expect(await repeatColumnsFromDb("tue-thu-class")).toMatchObject({
      interval_unit: "weeks",
      interval_days: null,
      interval_weeks: 2,
      weekdays: [2, 4],
      interval_months: null,
      month_anchor: null
    });
    const read = state.commitmentRecurrenceRules.find((rule) => rule.title === "Tue Thu class");
    expect(read?.repeat).toEqual({ unit: "weeks", intervalWeeks: 2, weekdays: [2, 4] });
  });

  it("the CHECK constraint rejects a weeks row with NULL weekdays, or with an empty list", async () => {
    const id = await stableUuid(`commitment-recurrence:${userId}`, "bare-weeks");
    await expect(
      sql`INSERT INTO commitment_recurrence_rules (id, user_id, title, timezone, start_date, interval_unit, interval_weeks, local_start_time, local_end_time) VALUES (${id}, ${userId}, 'Bare', 'Australia/Sydney', '2026-01-01', 'weeks', 1, '09:00', '10:00')`
    ).rejects.toThrow();
    await expect(
      sql`INSERT INTO commitment_recurrence_rules (id, user_id, title, timezone, start_date, interval_unit, interval_weeks, weekdays, local_start_time, local_end_time) VALUES (${id}, ${userId}, 'Empty', 'Australia/Sydney', '2026-01-01', 'weeks', 1, ${sql.json([])}, '09:00', '10:00')`
    ).rejects.toThrow();
  });

  it("switching an existing days rule to months clears interval_days and writes the month columns", async () => {
    const command = ruleCommand();
    await saveCommitmentRecurrenceRule(sql, command);
    const saved = await ruleFromDb("college-class");
    await saveCommitmentRecurrenceRule(
      sql,
      ruleCommand({
        expectedVersion: saved!.version,
        rule: { repeat: { unit: "months", intervalMonths: 2, anchor: "day_of_month" }, startDate: "2026-09-01" }
      })
    );
    const row = await repeatColumnsFromDb("college-class");
    expect(row).toMatchObject({
      interval_unit: "months",
      interval_days: null,
      interval_months: 2,
      month_anchor: "day_of_month"
    });
  });

  it("the CHECK constraint rejects a months row missing its anchor, direct at the database", async () => {
    const id = await stableUuid(`commitment-recurrence:${userId}`, "bare-months");
    await expect(
      sql`INSERT INTO commitment_recurrence_rules (id, user_id, title, timezone, start_date, interval_unit, interval_months, local_start_time, local_end_time) VALUES (${id}, ${userId}, 'Bare', 'Australia/Sydney', '2026-01-01', 'months', 1, '09:00', '10:00')`
    ).rejects.toThrow();
  });

  it("the CHECK constraint rejects a months row that still carries interval_days", async () => {
    const id = await stableUuid(`commitment-recurrence:${userId}`, "double-carrying");
    await expect(
      sql`INSERT INTO commitment_recurrence_rules (id, user_id, title, timezone, start_date, interval_unit, interval_days, interval_months, month_anchor, local_start_time, local_end_time) VALUES (${id}, ${userId}, 'Double', 'Australia/Sydney', '2026-01-01', 'months', 7, 1, 'last_day', '09:00', '10:00')`
    ).rejects.toThrow();
  });

  it("the command schema rejects a monthly rule whose anchor does not match its own start date", () => {
    // 2026-01-15 is not the last day of January.
    const parsed = saveCommitmentRecurrenceRuleCommandSchema.safeParse(
      ruleCommand({
        rule: { startDate: "2026-01-15", repeat: { unit: "months", intervalMonths: 1, anchor: "last_day" } }
      })
    );
    expect(parsed.success).toBe(false);
  });
});

const HOUR = 3_600_000;

async function occurrenceRow(id: string) {
  const rows = await sql<{ schedule_source: string; starts_at: Date; ends_at: Date }[]>`
    SELECT schedule_source, starts_at, ends_at FROM commitments WHERE id = ${id}
  `;
  return rows[0];
}

async function insertOccurrence(options: {
  ruleKey: string;
  startsAt: Date;
  endsAt: Date;
  scheduleSource?: "inherit" | "custom";
  // Only distinct occurrences of the same rule need distinct local dates, to satisfy
  // commitment_recurrence_occurrence_unique — defaults to starts_at's own calendar date.
  localDate?: string;
}) {
  const ruleId = await stableUuid(`commitment-recurrence:${userId}`, options.ruleKey);
  const id = crypto.randomUUID();
  const localDate = options.localDate ?? options.startsAt.toISOString().slice(0, 10);
  await sql`
    INSERT INTO commitments (id, user_id, recurrence_rule_id, title, starts_at, ends_at, schedule_source, local_date)
    VALUES (${id}, ${userId}, ${ruleId}, 'Occurrence', ${options.startsAt}, ${options.endsAt}, ${options.scheduleSource ?? "inherit"}, ${localDate})
  `;
  return id;
}

/** Stores a planning run whose `commitmentTimelines` carries one entry, as `applyOccurrenceInProgressRule` reads it. */
async function insertStoredTimeline(occurrenceId: string, setupStartsAt: Date, effectiveEndsAt: Date) {
  const result = {
    derivedState: {
      commitmentTimelines: [
        {
          id: occurrenceId,
          setupStartsAt: setupStartsAt.toISOString(),
          arriveBy: setupStartsAt.toISOString(),
          startsAt: setupStartsAt.toISOString(),
          endsAt: effectiveEndsAt.toISOString(),
          effectiveEndsAt: effectiveEndsAt.toISOString(),
          freeAt: effectiveEndsAt.toISOString(),
          protectedUntil: effectiveEndsAt.toISOString(),
          overtime: false,
          latenessMatters: true
        }
      ]
    }
  };
  await sql`
    INSERT INTO planning_runs (user_id, request_id, input_version, contract_version, engine_version, calculated_at, valid_until, result)
    VALUES (${userId}, gen_random_uuid(), 'v1', 'v1', 'v1', ${new Date()}, ${new Date(Date.now() + HOUR)}, ${sql.json(result as never)})
  `;
}

async function insertPreparationStep(commitmentId: string, status: "doing" | "completed") {
  await sql`
    INSERT INTO routine_steps (user_id, commitment_id, anchor_type, anchor_id, title, duration_minutes, sequence, timing_rule, status)
    VALUES (${userId}, ${commitmentId}, 'commitment', ${commitmentId}, 'Pack bag', 10, 1, 'contiguous', ${status})
  `;
}

async function insertOpenSession(commitmentId: string, status: "running" | "paused" | "awaiting_feedback") {
  const now = new Date();
  await sql`
    INSERT INTO sessions (user_id, target_type, target_id, status, planned_started_at, planned_end_at, started_at, planned_minutes, remaining_before_minutes)
    VALUES (${userId}, 'fixed_commitment', ${commitmentId}, ${status}, ${now}, ${new Date(now.getTime() + 30 * 60_000)}, ${now}, 30, 30)
  `;
}

async function changeLogCount() {
  const rows = await sql<{ count: string }[]>`SELECT COUNT(*)::text AS count FROM write_rows WHERE user_id = ${userId}`;
  return Number(rows[0]!.count);
}

async function pendingRecalculationJobCount() {
  const rows = await sql<{ count: string }[]>`
    SELECT COUNT(*)::text AS count FROM jobs WHERE type = ${PLAN_FORECAST_JOB_TYPE} AND payload->>'userId' = ${userId}
  `;
  return Number(rows[0]!.count);
}

describe("saveCommitmentRecurrenceRule — occurrence in progress (secondary case)", () => {
  it("leaves future custom rows unchanged", async () => {
    await saveCommitmentRecurrenceRule(sql, ruleCommand());
    const version = (await ruleFromDb("college-class"))!.version;
    const customStartsAt = new Date(Date.now() + 30 * 24 * HOUR);
    const customEndsAt = new Date(customStartsAt.getTime() + HOUR);
    const customId = await insertOccurrence({
      ruleKey: "college-class",
      startsAt: customStartsAt,
      endsAt: customEndsAt,
      scheduleSource: "custom"
    });

    await saveCommitmentRecurrenceRule(
      sql,
      ruleCommand({ expectedVersion: version, rule: { title: "College Class Renamed" } })
    );

    expect(await occurrenceRow(customId)).toEqual({
      schedule_source: "custom",
      starts_at: customStartsAt,
      ends_at: customEndsAt
    });
  });

  it("detects an occurrence in progress by its stored setupStartsAt, refuses without the flag, marks it custom with false, leaves it inherit with true", async () => {
    await saveCommitmentRecurrenceRule(sql, ruleCommand());
    let version = (await ruleFromDb("college-class"))!.version;
    const now = new Date();
    const startsAt = new Date(now.getTime() + HOUR);
    const endsAt = new Date(now.getTime() + 2 * HOUR);
    const occurrenceId = await insertOccurrence({ ruleKey: "college-class", startsAt, endsAt });
    // Now is past the stored setup start (5 minutes ago) but before starts_at.
    await insertStoredTimeline(occurrenceId, new Date(now.getTime() - 5 * 60_000), endsAt);

    await expect(
      saveCommitmentRecurrenceRule(sql, ruleCommand({ expectedVersion: version, rule: { title: "Refused" } }))
    ).rejects.toThrow();
    expect((await occurrenceRow(occurrenceId))!.schedule_source).toBe("inherit");

    await saveCommitmentRecurrenceRule(
      sql,
      ruleCommand({ expectedVersion: version, rule: { title: "Marked custom" }, applyToOccurrenceInProgress: false })
    );
    expect(await occurrenceRow(occurrenceId)).toEqual({
      schedule_source: "custom",
      starts_at: startsAt,
      ends_at: endsAt
    });

    // Put it back to `inherit` to exercise the `true` answer on its own.
    await sql`UPDATE commitments SET schedule_source = 'inherit' WHERE id = ${occurrenceId}`;
    version = (await ruleFromDb("college-class"))!.version;

    await saveCommitmentRecurrenceRule(
      sql,
      ruleCommand({ expectedVersion: version, rule: { title: "Left inherit" }, applyToOccurrenceInProgress: true })
    );
    expect((await occurrenceRow(occurrenceId))!.schedule_source).toBe("inherit");
  });

  it("detects an occurrence in progress by a started preparation step", async () => {
    await saveCommitmentRecurrenceRule(sql, ruleCommand());
    const version = (await ruleFromDb("college-class"))!.version;
    const now = new Date();
    // No stored timeline: the predicate falls back to starts_at, which has not come — only the
    // started preparation step makes this occurrence in progress.
    const startsAt = new Date(now.getTime() + HOUR);
    const endsAt = new Date(now.getTime() + 2 * HOUR);
    const occurrenceId = await insertOccurrence({ ruleKey: "college-class", startsAt, endsAt });
    await insertPreparationStep(occurrenceId, "doing");

    await expect(
      saveCommitmentRecurrenceRule(sql, ruleCommand({ expectedVersion: version, rule: { title: "Refused" } }))
    ).rejects.toThrow();

    await saveCommitmentRecurrenceRule(
      sql,
      ruleCommand({ expectedVersion: version, rule: { title: "Marked custom" }, applyToOccurrenceInProgress: false })
    );
    expect((await occurrenceRow(occurrenceId))!.schedule_source).toBe("custom");
  });

  it("detects an occurrence in progress by an open session", async () => {
    await saveCommitmentRecurrenceRule(sql, ruleCommand());
    const version = (await ruleFromDb("college-class"))!.version;
    const now = new Date();
    const startsAt = new Date(now.getTime() + HOUR);
    const endsAt = new Date(now.getTime() + 2 * HOUR);
    const occurrenceId = await insertOccurrence({ ruleKey: "college-class", startsAt, endsAt });
    await insertOpenSession(occurrenceId, "running");

    await expect(
      saveCommitmentRecurrenceRule(sql, ruleCommand({ expectedVersion: version, rule: { title: "Refused" } }))
    ).rejects.toThrow();

    await saveCommitmentRecurrenceRule(
      sql,
      ruleCommand({ expectedVersion: version, rule: { title: "Marked custom" }, applyToOccurrenceInProgress: false })
    );
    expect((await occurrenceRow(occurrenceId))!.schedule_source).toBe("custom");
  });

  it("with no stored timeline, falls back to starts_at: not yet started is not in progress, past its start is", async () => {
    await saveCommitmentRecurrenceRule(sql, ruleCommand());
    let version = (await ruleFromDb("college-class"))!.version;
    const now = new Date();

    // Future occurrence, no other signal: not in progress, so an ordinary series edit succeeds
    // without the flag and never touches its schedule_source. `local_date` only needs to satisfy
    // commitment_recurrence_occurrence_unique here — it plays no part in the predicate under test,
    // which reads starts_at/ends_at — so it is given explicit, fixed values below rather than derived
    // from `now`: deriving one occurrence's default from startsAt (now + 1h) and the other's from
    // now + 24h put both on the same calendar date whenever "now" fell in the last hour before UTC
    // midnight (now + 1h had already rolled to the next day, same as now + 24h), colliding on the
    // unique constraint and failing the insert every day between 23:00 and 24:00 UTC.
    const futureStartsAt = new Date(now.getTime() + HOUR);
    const futureEndsAt = new Date(now.getTime() + 2 * HOUR);
    const futureId = await insertOccurrence({
      ruleKey: "college-class",
      startsAt: futureStartsAt,
      endsAt: futureEndsAt,
      localDate: "2030-01-01"
    });
    await saveCommitmentRecurrenceRule(sql, ruleCommand({ expectedVersion: version, rule: { title: "Still fine" } }));
    expect((await occurrenceRow(futureId))!.schedule_source).toBe("inherit");
    version = (await ruleFromDb("college-class"))!.version;

    // An occurrence whose start has already passed (and whose effective end has not) is in progress.
    const pastStartsAt = new Date(now.getTime() - 30 * 60_000);
    const pastEndsAt = new Date(now.getTime() + 30 * 60_000);
    await insertOccurrence({
      ruleKey: "college-class",
      startsAt: pastStartsAt,
      endsAt: pastEndsAt,
      localDate: "2030-01-02"
    });
    await expect(
      saveCommitmentRecurrenceRule(sql, ruleCommand({ expectedVersion: version, rule: { title: "Refused too" } }))
    ).rejects.toThrow();
  });

  it("every successful save writes one write_rows row and enqueues one recalculation job", async () => {
    const before = await changeLogCount();
    await saveCommitmentRecurrenceRule(sql, ruleCommand());
    expect(await changeLogCount()).toBe(before + 1);
    expect(await pendingRecalculationJobCount()).toBeGreaterThan(0);
  });
});

describe("saveCommitmentRecurrenceRule — contactId", () => {
  async function contactIdFromDb(ruleKey: string) {
    const id = await stableUuid(`commitment-recurrence:${userId}`, ruleKey);
    const rows = await sql<{ contact_id: string | null }[]>`
      SELECT contact_id FROM commitment_recurrence_rules WHERE id = ${id}
    `;
    return rows[0]?.contact_id ?? null;
  }

  it("is written on save", async () => {
    await saveCommitmentRecurrenceRule(sql, ruleCommand({ rule: { contactId: "mum" } }));
    expect(await contactIdFromDb("college-class")).toBe("mum");
  });

  it("is cleared by an empty string", async () => {
    await saveCommitmentRecurrenceRule(sql, ruleCommand({ rule: { contactId: "mum" } }));
    const version = (await ruleFromDb("college-class"))!.version;
    await saveCommitmentRecurrenceRule(sql, ruleCommand({ expectedVersion: version, rule: { contactId: "" } }));
    expect(await contactIdFromDb("college-class")).toBeNull();
  });

  it("is left untouched when absent", async () => {
    await saveCommitmentRecurrenceRule(sql, ruleCommand({ rule: { contactId: "mum" } }));
    const version = (await ruleFromDb("college-class"))!.version;
    const command = ruleCommand({ expectedVersion: version, rule: { title: "Renamed" } });
    delete command.rule.contactId;
    await saveCommitmentRecurrenceRule(sql, command);
    expect(await contactIdFromDb("college-class")).toBe("mum");
  });
});

describe("saveCommitmentRecurrenceRule — change feed", () => {
  it("names the id the rule is stored under, not the id it was sent under", async () => {
    await saveCommitmentRecurrenceRule(sql, ruleCommand());
    const stored = await stableUuid(`commitment-recurrence:${userId}`, "college-class");
    expect(stored).not.toBe("college-class");
    const feed = await sql<{ entity_id: string; operation: string }[]>`
      SELECT r.entity_id, r.operation FROM write_rows r
      JOIN commitment_recurrence_rules rule ON rule.id::text = r.entity_id
      WHERE r.entity_type = 'commitment_recurrence_rule'
    `;
    expect(feed).toEqual([{ entity_id: stored, operation: "save" }]);
  });
});
