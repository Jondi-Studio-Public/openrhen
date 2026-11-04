import { describe, expect, it } from "vitest";
import { importRecordSchema, type ImportBatch, type ImportRecord } from "@openrhen/contracts";
import type { CalendarFeedSeriesException } from "@openrhen/contracts/integrations/calendar-feed";
import {
  FEED_EXCEPTION_HORIZON_DAYS,
  addDays,
  askedSnapshot,
  feedDateRecords,
  feedHolds,
  feedOccKey,
  generatedSnapshot,
  mergeDate,
  rowSnapshot,
  type FeedDateInput,
  type FeedDateRow,
  type FeedDateRule
} from "./calendar-feed-dates";
import { conflictedFields } from "@/features/imports/calendar-conflict";
import { resolveRecordSharedCalendarConflict } from "@/features/imports/import-batch-edits";
import { feedSeries } from "./calendar-feed-test-support";

const RULE_ID = "11111111-1111-4111-8111-111111111111";
const rule: FeedDateRule = {
  recurrence_rule_id: RULE_ID,
  version: 3,
  title: "Series w",
  timezone: "Australia/Sydney",
  start_date: "2026-11-10",
  end_date: null,
  interval_unit: "weeks",
  interval_days: null,
  interval_weeks: 1,
  weekdays: [2],
  interval_months: null,
  month_anchor: null,
  local_start_time: "09:00:00",
  local_end_time: "10:00:00",
  location: null,
  location_id: null,
  setup_before_minutes: 0,
  transition_after_minutes: 0
};
const TODAY = "2026-11-04";
const NOW = new Date("2026-11-03T14:00:00.000Z");
const cancel = (date: string): CalendarFeedSeriesException => ({ kind: "cancelled", date });
const change = (date: string, over: Partial<Extract<CalendarFeedSeriesException, { kind: "changed" }>> = {}) =>
  ({
    kind: "changed",
    date,
    title: "Moved hour",
    location: "Room 9",
    startDate: date,
    localStartTime: "14:00",
    endDate: date,
    localEndTime: "15:30",
    ...over
  }) as CalendarFeedSeriesException;

/** The stored row of `date` as the planner writes it: inherit, confirmed, the rule's own times. */
function rowFor(date: string, over: Partial<FeedDateRow> = {}): FeedDateRow {
  const generated = generatedSnapshot(rule, date);
  return {
    id: `row-${date}`,
    recurrence_rule_id: RULE_ID,
    local_date: date,
    title: generated.title,
    starts_at: new Date(generated.startsAt),
    ends_at: new Date(generated.endsAt),
    status: "confirmed",
    location: null,
    location_id: null,
    setup_before_minutes: 0,
    transition_after_minutes: 0,
    schedule_source: "inherit",
    version: 5,
    ...over
  };
}

function run(
  over: Partial<Omit<FeedDateInput, "rows">> & { exceptions?: CalendarFeedSeriesException[]; rows?: FeedDateRow[] }
) {
  const { exceptions = [], rows = [], ...rest } = over;
  return feedDateRecords({
    stem: "w",
    series: feedSeries("w", { exceptions }),
    rule,
    snapshot: { occurrences: {} },
    rows: new Map(rows.map((row) => [row.local_date, row])),
    today: TODAY,
    now: NOW,
    locations: [],
    ...rest
  }).records;
}

const D1 = "2026-11-10";
const D2 = "2026-11-17";
const D3 = "2026-11-24";

describe("a date the feed cancels", () => {
  it("is an update of the stored date: cancelled, detached, marked as a cancel, keyed by rule and date", () => {
    const [record] = run({ exceptions: [cancel(D2)], rows: [rowFor(D2)] });
    expect(record).toMatchObject({
      importKey: feedOccKey(RULE_ID, D2),
      entityType: "fixed_commitment",
      operation: "update",
      matchedEntityId: `row-${D2}`,
      expectedVersion: 5,
      errors: [],
      relationships: {
        feedSeries: "w",
        feedRule: RULE_ID,
        feedDate: D2,
        feedOccurrence: `row-${D2}`,
        feedCancel: "true"
      }
    });
    expect(record!.fields.status!.value).toBe("cancelled");
    expect(record!.fields.scheduleSource!.value).toBe("custom");
    expect(record!.fields.title!.value).toBe("Series w");
    expect(() => importRecordSchema.parse(record)).not.toThrow();
  });

  it("is a create the commit turns into the date's own row when the planner has not made the date yet", () => {
    const [record] = run({ exceptions: [cancel(D2)] });
    expect(record).toMatchObject({
      operation: "create",
      matchedEntityId: null,
      relationships: { feedInsert: "true", feedCancel: "true", feedDate: D2 }
    });
    expect(record!.relationships.feedOccurrence).toBeUndefined();
    expect(record!.fields.startsAt!.value).toBe(generatedSnapshot(rule, D2).startsAt);
    expect(record!.fields.status!.value).toBe("cancelled");
  });

  it("is pending, with no record, past the 170-day insert horizon, and proposed on the boundary day", () => {
    const edge = addDays(TODAY, FEED_EXCEPTION_HORIZON_DAYS);
    const weekly = (offset: number) => addDays("2026-11-10", 7 * offset);
    const onRule = (date: string) =>
      date >= "2026-11-10" && (new Date(date).getTime() - new Date("2026-11-10").getTime()) % (7 * 86_400_000) === 0;
    // Find the rule dates either side of the edge.
    let before = edge;
    while (!onRule(before)) before = addDays(before, -1);
    const after = weekly(
      Math.round((new Date(before).getTime() - new Date("2026-11-10").getTime()) / (7 * 86_400_000)) + 1
    );
    expect(before <= edge && after > edge).toBe(true);
    expect(run({ exceptions: [cancel(before)] })).toHaveLength(1);
    expect(run({ exceptions: [cancel(after)] })).toHaveLength(0);
    // A row the planner already made beyond the horizon is followed.
    expect(run({ exceptions: [cancel(after)], rows: [rowFor(after)] })).toHaveLength(1);
  });

  it("is nothing when the date is already cancelled and remembered", () => {
    const snapshot = { occurrences: { [D2]: { ...rowSnapshot(rowFor(D2)), status: "cancelled" } } };
    const row = rowFor(D2, { status: "cancelled", schedule_source: "custom" });
    expect(run({ exceptions: [cancel(D2)], rows: [row], snapshot })).toEqual([]);
  });

  it("keeps an owner edit the feed does not dispute while cancelling the date", () => {
    const remembered = { ...rowSnapshot(rowFor(D2)), title: "Feed said this" };
    const row = rowFor(D2, { title: "Owner retitled", schedule_source: "custom" });
    const out = run({ exceptions: [cancel(D2)], rows: [row], snapshot: { occurrences: { [D2]: remembered } } });
    // Only the status is asked; the owner's title is not in dispute, so this is a plain cancel that keeps it.
    expect(out).toHaveLength(1);
    expect(out[0]!.fields.title!.value).toBe("Owner retitled");
    expect(out[0]!.operation).toBe("update");
  });

  it("is a conflict when the owner already changed the very field the feed changes now", () => {
    const remembered = { ...rowSnapshot(rowFor(D2)), status: "confirmed" };
    const row = rowFor(D2, { status: "tentative", schedule_source: "custom" });
    const out = run({ exceptions: [cancel(D2)], rows: [row], snapshot: { occurrences: { [D2]: remembered } } });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ operation: "conflict", relationships: { calendar_feedConflictFields: "status" } });
    expect(out[0]!.errors[0]).toContain("status changed in both Calendar feed and OpenRhen");
  });

  it("is held as a conflict when the owner edited a detached date and nothing remembers what the feed said", () => {
    const row = rowFor(D2, { title: "Owner's own", schedule_source: "custom" });
    const out = run({ exceptions: [cancel(D2)], rows: [row] });
    expect(out).toHaveLength(1);
    expect(out[0]!.operation).toBe("conflict");
  });
});

describe("a date the feed changes in place", () => {
  it("is a held update with the feed's title, place and wall-clock times, not marked as a cancel", () => {
    const [record] = run({ exceptions: [change(D2)], rows: [rowFor(D2)] });
    expect(record).toMatchObject({ operation: "update", matchedEntityId: `row-${D2}` });
    expect(record!.relationships.feedCancel).toBeUndefined();
    expect(record!.fields.title!.value).toBe("Moved hour");
    expect(record!.fields.location!.value).toBe("Room 9");
    // 14:00 in the feed zone (UTC+11 in November) is 03:00Z.
    expect(record!.fields.startsAt!.value).toBe("2026-11-17T03:00:00.000Z");
    expect(record!.fields.endsAt!.value).toBe("2026-11-17T04:30:00.000Z");
    expect(record!.fields.status!.value).toBe("confirmed");
    expect(feedHolds(record!)).toBe(true);
  });

  it("keeps the owner's value for a field the feed did not change and applies the one it did (three-way)", () => {
    const asked = askedSnapshot(change(D2), rowSnapshot(rowFor(D2)), rule.timezone)!;
    const remembered = { ...asked, location: "Room 9" };
    const row = rowFor(D2, {
      title: "Owner title",
      starts_at: new Date(asked.startsAt),
      ends_at: new Date(asked.endsAt),
      location: "Room 9",
      schedule_source: "custom"
    });
    const out = run({
      exceptions: [change(D2, { location: "Room 12" })],
      rows: [row],
      snapshot: { occurrences: { [D2]: { ...remembered, title: "Moved hour" } } }
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.operation).toBe("update");
    expect(out[0]!.fields.title!.value).toBe("Owner title");
    expect(out[0]!.fields.location!.value).toBe("Room 12");
  });

  it("is a conflict when the owner and the feed both changed the title since the feed last set it", () => {
    const asked = askedSnapshot(change(D2), rowSnapshot(rowFor(D2)), rule.timezone)!;
    const row = rowFor(D2, {
      title: "Owner title",
      starts_at: new Date(asked.startsAt),
      ends_at: new Date(asked.endsAt),
      location: asked.location,
      schedule_source: "custom"
    });
    const out = run({
      exceptions: [change(D2, { title: "Feed title two" })],
      rows: [row],
      snapshot: { occurrences: { [D2]: asked } }
    });
    expect(out[0]).toMatchObject({ operation: "conflict", relationships: { calendar_feedConflictFields: "title" } });
  });

  it("shows its conflicted fields to the review and resolves them with the feed's value", () => {
    const asked = askedSnapshot(change(D2), rowSnapshot(rowFor(D2)), rule.timezone)!;
    const row = rowFor(D2, {
      title: "Owner title",
      starts_at: new Date(asked.startsAt),
      ends_at: new Date(asked.endsAt),
      location: asked.location,
      schedule_source: "custom"
    });
    const [record] = run({
      exceptions: [change(D2, { title: "Feed title two" })],
      rows: [row],
      snapshot: { occurrences: { [D2]: asked } }
    });
    expect(conflictedFields(record!)).toEqual(["title"]);
    const batch = { id: "b", records: [record!] } as unknown as ImportBatch;
    const kept = resolveRecordSharedCalendarConflict(batch, record!.id, "title", false).records[0]!;
    expect(kept.fields.title!.value).toBe("Owner title");
    expect(kept.operation).toBe("update");
    const taken = resolveRecordSharedCalendarConflict(batch, record!.id, "title", true).records[0]!;
    expect(taken.fields.title!.value).toBe("Feed title two");
    expect(taken.operation).toBe("update");
  });

  it("inserts the changed date when the planner has not made it, as a held create", () => {
    const [record] = run({ exceptions: [change(D3)] });
    expect(record).toMatchObject({ operation: "create", relationships: { feedInsert: "true" } });
    expect(feedHolds(record!)).toBe(true);
  });
});

describe("a date the feed no longer changes", () => {
  const remembered = (date: string) => ({ ...rowSnapshot(rowFor(date)), status: "cancelled" });
  const cancelledRow = (date: string) => rowFor(date, { status: "cancelled", schedule_source: "custom" });

  it("goes back to the series as a held revert when nothing on the plan changed since the feed set it", () => {
    const out = run({ rows: [cancelledRow(D2)], snapshot: { occurrences: { [D2]: remembered(D2) } } });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      operation: "update",
      matchedEntityId: `row-${D2}`,
      relationships: { feedRevert: "true", feedDate: D2 }
    });
    expect(out[0]!.fields.scheduleSource!.value).toBe("inherit");
    expect(out[0]!.fields.status!.value).toBe("confirmed");
    expect(out[0]!.fields.startsAt!.value).toBe(generatedSnapshot(rule, D2).startsAt);
    expect(feedHolds(out[0]!)).toBe(true);
    expect(out[0]!.relationships.feedCancel).toBeUndefined();
  });

  it("is a conflict, never an overwrite, when the owner edited the date since", () => {
    const row = rowFor(D2, { status: "cancelled", title: "Owner edit", schedule_source: "custom" });
    const out = run({ rows: [row], snapshot: { occurrences: { [D2]: remembered(D2) } } });
    expect(out).toHaveLength(1);
    expect(out[0]!.operation).toBe("conflict");
    expect(out[0]!.errors[0]).toContain("no longer changes it");
  });

  it("is nothing when the date is already back with the series, or its row is gone", () => {
    expect(run({ rows: [rowFor(D2)], snapshot: { occurrences: { [D2]: remembered(D2) } } })).toEqual([]);
    expect(run({ rows: [], snapshot: { occurrences: { [D2]: remembered(D2) } } })).toEqual([]);
  });
});

describe("dates the lifecycle leaves alone", () => {
  it("skips a date before today, a date already under way, and a date the rule does not produce", () => {
    expect(run({ exceptions: [cancel("2026-10-27")], rows: [rowFor("2026-10-27")] })).toEqual([]);
    const started = rowFor(D1, {
      starts_at: new Date("2026-11-03T13:00:00.000Z"),
      ends_at: new Date("2026-11-03T15:00:00.000Z")
    });
    expect(run({ exceptions: [cancel(D1)], rows: [started] })).toEqual([]);
    // 2026-11-11 is a Wednesday: not a Tuesday rule date.
    expect(run({ exceptions: [cancel("2026-11-11")] })).toEqual([]);
  });

  it("does not insert a date whose start has already passed", () => {
    const late = new Date("2026-11-09T23:30:00.000Z");
    expect(run({ exceptions: [cancel(D1)], now: late })).toEqual([]);
  });
});

describe("the three-way merge of a date", () => {
  it("takes the feed's value for a field the owner left alone and keeps the owner's for a field the feed left alone", () => {
    const current = { ...rowSnapshot(rowFor(D2)), title: "Mine" };
    const prior = { ...rowSnapshot(rowFor(D2)) } as Record<string, unknown>;
    const asked = { ...current, location: "Room 3" };
    const { wanted, conflicts } = mergeDate(current, asked, prior);
    expect(conflicts).toEqual([]);
    expect(wanted).toMatchObject({ title: "Mine", location: "Room 3" });
  });
});

describe("which records the sync holds", () => {
  const rec = (relationships: Record<string, string>) => ({ relationships }) as Pick<ImportRecord, "relationships">;

  it("applies a plain date cancel on its own and holds every other series record", () => {
    expect(feedHolds(rec({ feedSeries: "w", feedCancel: "true" }))).toBe(false);
    expect(feedHolds(rec({ feedSeries: "w", feedCancel: "true", feedMove: "p" }))).toBe(true);
    expect(feedHolds(rec({ feedSeries: "w" }))).toBe(true);
    expect(feedHolds(rec({ feedSeries: "w", feedRevert: "true" }))).toBe(true);
    expect(feedHolds(rec({ feedMove: "p" }))).toBe(true);
  });

  it("leaves a per-instance record, which names no series, as it was", () => {
    expect(feedHolds(rec({}))).toBe(false);
  });
});

describe("a date the feed moves to another day", () => {
  const moved = change(D1, { startDate: D2, endDate: D2 });
  const pair = `mv:w:${D1}`;
  it("cancels the original date as one half of a held pair", () => {
    const records = run({ exceptions: [moved], rows: [rowFor(D1)] });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      operation: "update",
      relationships: { feedCancel: "true", feedMove: pair, feedDate: D1 }
    });
    expect(records[0]!.fields.status!.value).toBe("cancelled");
    expect(feedHolds(records[0]!)).toBe(true);
  });

  it("is a create of the cancelled row, still a held half, when the planner has no row for the date", () => {
    const records = run({ exceptions: [moved], rows: [] });
    expect(records[0]).toMatchObject({ operation: "create", relationships: { feedInsert: "true", feedMove: pair } });
    expect(feedHolds(records[0]!)).toBe(true);
  });

  it("is steady once the original is cancelled and remembered", () => {
    const asked = askedSnapshot(moved, rowSnapshot(rowFor(D1)), rule.timezone)!;
    const row = rowFor(D1, { status: "cancelled", schedule_source: "custom" });
    expect(run({ exceptions: [moved], rows: [row], snapshot: { occurrences: { [D1]: asked } } })).toEqual([]);
  });

  it("pairs the revert of the original with the replacement's removal when the move is dropped", () => {
    const asked = askedSnapshot(moved, rowSnapshot(rowFor(D1)), rule.timezone)!;
    const row = rowFor(D1, { status: "cancelled", schedule_source: "custom" });
    const records = run({
      exceptions: [],
      rows: [row],
      snapshot: { occurrences: { [D1]: asked } },
      moveDates: new Set([D1])
    });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ relationships: { feedRevert: "true", feedMove: pair } });
  });

  it("pairs the in-place change that replaces a move (moved back inside its day) with the replacement's removal", () => {
    const asked = askedSnapshot(moved, rowSnapshot(rowFor(D1)), rule.timezone)!;
    const row = rowFor(D1, { status: "cancelled", schedule_source: "custom" });
    const records = run({
      exceptions: [change(D1, { localStartTime: "11:00", localEndTime: "12:00" })],
      rows: [row],
      snapshot: { occurrences: { [D1]: asked } },
      moveDates: new Set([D1])
    });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ operation: "update", relationships: { feedMove: pair } });
    expect(records[0]!.fields.status!.value).toBe("confirmed");
  });
});

describe("conflicts the review can resolve", () => {
  it("offers each field when the owner edited a custom date and nothing remembers what the feed said", () => {
    const [record] = run({
      exceptions: [change(D2, { title: "Feed title" })],
      rows: [rowFor(D2, { title: "Owner's own", schedule_source: "custom" })]
    });
    expect(record).toMatchObject({ operation: "conflict" });
    const fields = conflictedFields(record!);
    expect(fields).toContain("title");
    const batch = { id: "b", records: [record!] } as unknown as ImportBatch;
    expect(resolveRecordSharedCalendarConflict(batch, record!.id, "title", false).records[0]!.fields.title!.value).toBe(
      "Owner's own"
    );
    let resolved = batch;
    for (const name of fields) resolved = resolveRecordSharedCalendarConflict(resolved, record!.id, name, true);
    expect(resolved.records[0]).toMatchObject({ operation: "update" });
    expect(resolved.records[0]!.fields.title!.value).toBe("Feed title");
  });

  it("offers each field when the owner edited a date the feed no longer changes", () => {
    const asked = askedSnapshot(cancel(D2), rowSnapshot(rowFor(D2)), rule.timezone)!;
    const [record] = run({
      exceptions: [],
      rows: [rowFor(D2, { status: "cancelled", title: "Owner edit", schedule_source: "custom" })],
      snapshot: { occurrences: { [D2]: asked } }
    });
    expect(record).toMatchObject({ operation: "conflict", relationships: { feedRevert: "true" } });
    const fields = conflictedFields(record!);
    expect(fields).toEqual(expect.arrayContaining(["title", "status"]));
    const batch = { id: "b", records: [record!] } as unknown as ImportBatch;
    expect(resolveRecordSharedCalendarConflict(batch, record!.id, "title", false).records[0]!.fields.title!.value).toBe(
      "Owner edit"
    );
  });
});

describe("a move's two records stand or fall together", () => {
  const moved = change(D1, { startDate: D2, endDate: D2 });
  it("names the date's cancel as half of a pair of two only when its meeting is not yet a one-off event", () => {
    const first = run({ exceptions: [moved], rows: [rowFor(D1)] })[0]!;
    expect(first.relationships).toMatchObject({ feedMove: `mv:w:${D1}`, feedMoveSize: "2" });
    // The replacement is already there: an owner edit of the date is its own change, not a pair.
    const second = run({
      exceptions: [moved],
      rows: [rowFor(D1, { title: "Owner", schedule_source: "custom" })],
      moveDates: new Set([D1])
    })[0]!;
    expect(second.relationships.feedMove).toBeUndefined();
  });
});
