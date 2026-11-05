import { afterEach, describe, expect, it, vi } from "vitest";
import type postgres from "postgres";
import type { PlanForecastResponse } from "@openrhen/contracts";
import { persistDerivedState } from "./plan-forecast-runtime.js";

/**
 * The write-back of `derivedState.commitmentRepeats` deletes every future repeating commitment the
 * derived list does not name, so it must not run on a list that cannot be believed. These tests drive
 * `persistDerivedState` against a recording fake of the tagged-template client: no database is needed
 * because only which statements run, and what is logged, is under test.
 */

const CALCULATED_AT = "2026-10-07T09:00:00.000Z";
const USER_ID = "00000000-0000-4000-8000-000000000001";
const RULE_ID = "00000000-0000-4000-8000-0000000000a1";
const STALE_ID = "00000000-0000-4000-8000-0000000000c1";

/** One `commitment_recurrence_rules` row as the write-back's rules query returns it. */
interface FakeRule {
  id: string;
  routine_source: string;
  routine_preset_id: null;
  share_to_calendar: boolean;
  live: boolean;
  start_date: string;
  end_date: string | null;
  /** The run's local first day and the horizon's local last day, in the rule's timezone. */
  from_date: string;
  through_date: string;
  interval_unit: string;
  interval_days: number | null;
  interval_weeks: number | null;
  weekdays: number[] | null;
  interval_months: number | null;
  month_anchor: string | null;
}

interface FakeOptions {
  /** Rows the rules query returns. */
  rules: FakeRule[];
  /** Rows the commitment DELETE ... RETURNING id returns. */
  deleted?: { id: string }[];
}

function fakeSql(options: FakeOptions) {
  const statements: string[] = [];
  const client = ((strings: TemplateStringsArray | unknown[], ...values: unknown[]) => {
    if (!Array.isArray((strings as { raw?: unknown }).raw)) return { fragment: strings, values };
    const text = (strings as TemplateStringsArray).join("?").replace(/\s+/g, " ").trim();
    statements.push(text);
    if (text.includes("FROM commitment_recurrence_rules")) return Promise.resolve(options.rules);
    if (text.startsWith("DELETE FROM commitments")) return Promise.resolve(options.deleted ?? []);
    return Promise.resolve([]);
  }) as unknown as postgres.Sql;
  return { sql: client, statements };
}

function repeat(overrides: Record<string, unknown> = {}) {
  return {
    id: "00000000-0000-4000-8000-0000000000b1",
    recurrenceRuleId: RULE_ID,
    localDate: "2026-10-08",
    startsAt: "2026-10-08T09:00:00.000Z",
    endsAt: "2026-10-08T10:00:00.000Z",
    title: "Standup",
    ...overrides
  };
}

function resultWith(commitmentRepeats: unknown[]): PlanForecastResponse {
  return {
    requestId: "00000000-0000-4000-8000-0000000000f1",
    calculatedAt: CALCULATED_AT,
    derivedState: {
      sleepPlans: [],
      occurrences: [],
      routineSteps: [],
      commitmentRepeats,
      stepPlacements: []
    }
  } as unknown as PlanForecastResponse;
}

// A daily rule that started long ago and has no end: it yields on every day of the horizon.
const liveRule: FakeRule = {
  id: RULE_ID,
  routine_source: "inherit",
  routine_preset_id: null,
  share_to_calendar: false,
  live: true,
  start_date: "2026-01-01",
  end_date: null,
  from_date: "2026-10-07",
  through_date: "2027-04-04",
  interval_unit: "days",
  interval_days: 1,
  interval_weeks: null,
  weekdays: null,
  interval_months: null,
  month_anchor: null
};
const endedRule: FakeRule = { ...liveRule, live: false };

const isPrune = (statement: string) => statement.startsWith("DELETE FROM commitments");
const isUpsert = (statement: string) => statement.startsWith("INSERT INTO commitments");

function spyLogs() {
  return {
    error: vi.spyOn(console, "error").mockImplementation(() => undefined),
    warn: vi.spyOn(console, "warn").mockImplementation(() => undefined),
    info: vi.spyOn(console, "info").mockImplementation(() => undefined)
  };
}
const logged = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map((call) => JSON.parse(String(call[0])));

afterEach(() => vi.restoreAllMocks());

describe("future repeating-commitment pruning in persistDerivedState", () => {
  it("prunes a stale future commitment and logs what it deleted", async () => {
    const logs = spyLogs();
    const { sql, statements } = fakeSql({ rules: [liveRule], deleted: [{ id: STALE_ID }] });
    await persistDerivedState(sql, USER_ID, resultWith([repeat()]));
    expect(statements.filter(isUpsert)).toHaveLength(1);
    expect(statements.filter(isPrune)).toHaveLength(1);
    expect(logs.error).not.toHaveBeenCalled();
    expect(logs.warn).not.toHaveBeenCalled();
    expect(logged(logs.info)).toEqual([
      expect.objectContaining({ level: "info", userId: USER_ID, deletedCount: 1, deletedIds: [STALE_ID] })
    ]);
  });

  it("never prunes a closed occurrence: both delete statements leave cancelled rows alone", async () => {
    spyLogs();
    // the named-list variant (a live rule's derived dates) and the empty-list variant (every rule ended)
    for (const [rules, derived] of [
      [[liveRule], [repeat()]],
      [[endedRule], []]
    ] as const) {
      const { sql, statements } = fakeSql({ rules: [...rules] });
      await persistDerivedState(sql, USER_ID, resultWith([...derived]));
      const prune = statements.filter(isPrune);
      expect(prune).toHaveLength(1);
      expect(prune[0]).toContain("status<>'cancelled'");
    }
  });

  it("does not log a deletion when the prune removes nothing", async () => {
    const logs = spyLogs();
    const { sql, statements } = fakeSql({ rules: [liveRule] });
    await persistDerivedState(sql, USER_ID, resultWith([repeat()]));
    expect(statements.filter(isPrune)).toHaveLength(1);
    expect(logs.info).not.toHaveBeenCalled();
  });

  it("skips every delete and logs an error when any derived row is malformed, still upserting the good rows", async () => {
    const logs = spyLogs();
    const { sql, statements } = fakeSql({ rules: [liveRule], deleted: [{ id: STALE_ID }] });
    await persistDerivedState(
      sql,
      USER_ID,
      resultWith([repeat(), repeat({ startsAt: 42 }), null, "nope", repeat({ id: undefined })])
    );
    expect(statements.filter(isPrune)).toHaveLength(0);
    expect(statements.filter(isUpsert)).toHaveLength(1);
    expect(logged(logs.error)).toEqual([
      expect.objectContaining({ level: "error", userId: USER_ID, malformedCount: 4, derivedCount: 5 })
    ]);
    expect(logs.info).not.toHaveBeenCalled();
  });

  it("skips every delete when the only derived row is malformed", async () => {
    const logs = spyLogs();
    const { sql, statements } = fakeSql({ rules: [] });
    await persistDerivedState(sql, USER_ID, resultWith([repeat({ recurrenceRuleId: null })]));
    expect(statements.filter(isPrune)).toHaveLength(0);
    expect(logged(logs.error)).toEqual([expect.objectContaining({ malformedCount: 1, derivedCount: 1 })]);
  });

  it("treats an empty derived list as not authoritative while a live rule exists", async () => {
    const logs = spyLogs();
    const { sql, statements } = fakeSql({ rules: [liveRule, endedRule], deleted: [{ id: STALE_ID }] });
    await persistDerivedState(sql, USER_ID, resultWith([]));
    expect(statements.filter(isPrune)).toHaveLength(0);
    expect(logs.error).not.toHaveBeenCalled();
    expect(logged(logs.warn)).toEqual([
      expect.objectContaining({ level: "warn", userId: USER_ID, horizonRuleCount: 1 })
    ]);
  });

  it("still prunes on an empty derived list once every rule has ended or none exist", async () => {
    for (const rules of [[endedRule], []]) {
      const logs = spyLogs();
      const { sql, statements } = fakeSql({ rules, deleted: [{ id: STALE_ID }] });
      await persistDerivedState(sql, USER_ID, resultWith([]));
      expect(statements.filter(isPrune)).toHaveLength(1);
      expect(logs.warn).not.toHaveBeenCalled();
      expect(logged(logs.info)).toEqual([expect.objectContaining({ deletedCount: 1, deletedIds: [STALE_ID] })]);
      vi.restoreAllMocks();
    }
  });

  it("still prunes on an empty derived list when no live rule can yield inside the horizon", async () => {
    // Each of these is active and unended, but its recurrence lands on no day between today and the
    // horizon's last day, so an empty list is the engine's honest answer (an edit moved or stretched the rule).
    const cases: Record<string, Partial<FakeRule>> = {
      "starts after the horizon": { start_date: "2027-05-01" },
      "daily interval longer than the horizon": {
        start_date: "2026-10-01",
        interval_days: 365
      },
      "every 52nd week, the next one past the horizon": {
        start_date: "2026-10-01",
        interval_unit: "weeks",
        interval_days: null,
        interval_weeks: 52,
        weekdays: [4]
      },
      "monthly rule whose next month is past the horizon": {
        start_date: "2026-06-15",
        interval_unit: "months",
        interval_days: null,
        interval_months: 12,
        month_anchor: "day_of_month"
      }
    };
    for (const [name, override] of Object.entries(cases)) {
      const logs = spyLogs();
      const { sql, statements } = fakeSql({ rules: [{ ...liveRule, ...override }], deleted: [{ id: STALE_ID }] });
      await persistDerivedState(sql, USER_ID, resultWith([]));
      expect(statements.filter(isPrune), name).toHaveLength(1);
      expect(logs.warn, name).not.toHaveBeenCalled();
      vi.restoreAllMocks();
    }
  });

  it("scans the engine's one extra local day each side, so a moved occurrence on the boundary is not pruned", async () => {
    // The engine scans from_date-1 .. through_date+1 for a `custom` occurrence moved onto a boundary day
    // (`resolveCommitmentRecurrenceRepeats`), so a rule whose only landing is on one of those days still
    // counts: an empty derived list is then suspect. A landing two days out is not scanned.
    const holds: Record<string, Partial<FakeRule>> = {
      "first occurrence the day after the horizon's last day": { start_date: "2027-04-05" },
      "last occurrence the day before today": {
        start_date: "2026-10-06",
        end_date: "2026-10-06",
        interval_days: 365
      },
      "next occurrence the day before today, then past the horizon": {
        start_date: "2026-10-06",
        interval_days: 365
      }
    };
    for (const [name, override] of Object.entries(holds)) {
      const logs = spyLogs();
      const { sql, statements } = fakeSql({ rules: [{ ...liveRule, ...override }], deleted: [{ id: STALE_ID }] });
      await persistDerivedState(sql, USER_ID, resultWith([]));
      expect(statements.filter(isPrune), name).toHaveLength(0);
      expect(logs.warn, name).toHaveBeenCalledTimes(1);
      vi.restoreAllMocks();
    }
    for (const override of [{ start_date: "2027-04-06" }, { start_date: "2026-10-05", end_date: "2026-10-05" }]) {
      const { sql, statements } = fakeSql({ rules: [{ ...liveRule, ...override, interval_days: 365 }] });
      await persistDerivedState(sql, USER_ID, resultWith([]));
      expect(statements.filter(isPrune), JSON.stringify(override)).toHaveLength(1);
    }
  });

  it("keeps the guard when a rule yields on the horizon's last day or its row cannot be read", async () => {
    const cases: Record<string, Partial<FakeRule>> = {
      "first occurrence on the last horizon day": { start_date: "2027-04-04" },
      "monthly rule landing inside the horizon": {
        start_date: "2026-06-15",
        interval_unit: "months",
        interval_days: null,
        interval_months: 6,
        month_anchor: "day_of_month"
      },
      "weekly rule with no weekdays column": {
        interval_unit: "weeks",
        interval_days: null,
        interval_weeks: 1,
        weekdays: null
      }
    };
    for (const [name, override] of Object.entries(cases)) {
      const logs = spyLogs();
      const { sql, statements } = fakeSql({ rules: [{ ...liveRule, ...override }], deleted: [{ id: STALE_ID }] });
      await persistDerivedState(sql, USER_ID, resultWith([]));
      expect(statements.filter(isPrune), name).toHaveLength(0);
      expect(logs.warn, name).toHaveBeenCalledTimes(1);
      vi.restoreAllMocks();
    }
  });
});
