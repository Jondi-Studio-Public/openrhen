import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { importRecordSchema, type ImportBatch } from "@openrhen/contracts";
import type { CalendarFeedSeries } from "@openrhen/contracts/integrations/calendar-feed";
import {
  feedLinkSnapshot,
  feedRuleSnapshot,
  feedSeriesDismissalId,
  feedSeriesKey,
  feedSeriesPass,
  ruleLinkIdentity,
  stemOfRuleLink,
  type FeedRuleLinkRow,
  type FeedSeriesPassInput
} from "./calendar-feed-series";
import { validateImportRecords } from "@/features/imports/import-validation";
import { conflictedFields } from "@/features/imports/calendar-conflict";
import { resolveRecordSharedCalendarConflict } from "@/features/imports/import-batch-edits";
import { feedMoveEventId, parseFeedMoveEventId } from "./calendar-feed-moves";
import { feedDateDismissalId, feedDateFingerprint } from "./calendar-feed-dates";
import { feedSeries } from "./calendar-feed-test-support";
import { FEED_MAX_KEY, FEED_SERIES_MAX_STEM, feedSyncSourceText } from "./calendar-profiles/calendar-feed";
import { fixedBlocksProfileFor } from "./calendar-profiles/fixed-blocks";

/** A rule link as the loader reads it, written from what the series says (so it is "unchanged" until a field moves). */
function linkFor(series: CalendarFeedSeries, over: Partial<FeedRuleLinkRow> = {}): FeedRuleLinkRow {
  const snapshot = feedLinkSnapshot(series);
  return {
    external_event_id: `series:${series.idPrefix}`,
    recurrence_rule_id: "rule-1",
    last_remote_snapshot: snapshot,
    version: 1,
    status: "active",
    title: series.title,
    timezone: series.timezone,
    start_date: series.startDate,
    end_date: series.endDate,
    interval_unit: series.repeat.unit,
    interval_days: series.repeat.unit === "days" ? series.repeat.intervalDays : null,
    interval_weeks: series.repeat.unit === "weeks" ? series.repeat.intervalWeeks : null,
    weekdays: series.repeat.unit === "weeks" ? series.repeat.weekdays : null,
    interval_months: series.repeat.unit === "months" ? series.repeat.intervalMonths : null,
    month_anchor: series.repeat.unit === "months" ? series.repeat.anchor : null,
    local_start_time: `${series.localStartTime}:00`,
    local_end_time: `${series.localEndTime}:00`,
    location: null,
    location_id: null,
    setup_before_minutes: 0,
    transition_after_minutes: 0,
    ...over
  };
}

function pass(over: Partial<Omit<FeedSeriesPassInput, "series">> & { series?: CalendarFeedSeries[] } = {}) {
  const { series = [], ...rest } = over;
  const map = new Map(series.map((entry) => [entry.idPrefix, entry]));
  return feedSeriesPass({
    series: map,
    seriesStems: new Set(map.keys()),
    ownedLinkStems: new Set(),
    ruleLinks: [],
    dismissals: [],
    today: "2026-11-04",
    host: "calendar.example.com",
    locations: [],
    ...rest
  });
}

describe("a series with no changed dates", () => {
  it("becomes one held rule create keyed by its stem, with every rule column and the stem on the record", () => {
    const out = pass({ series: [feedSeries("weekly", { title: "Standup", location: "Room 4" })] });
    expect(out).toMatchObject({ pending: 0, changed: 0 });
    expect(out.records).toHaveLength(1);
    const record = out.records[0]!;
    expect(record).toMatchObject({
      importKey: "calendar_feed:series:weekly",
      entityType: "fixed_commitment_recurrence",
      operation: "create",
      removed: false,
      relationships: { feedSeries: "weekly" }
    });
    const value = (name: string) => record.fields[name]?.value;
    expect(value("title")).toBe("Standup");
    expect(value("timezone")).toBe("Australia/Sydney");
    expect(value("startDate")).toBe("2026-11-10");
    expect(value("endDate")).toBeNull();
    expect(value("intervalUnit")).toBe("weeks");
    expect(value("intervalWeeks")).toBe(1);
    expect(value("weekdays")).toEqual([2]);
    expect(value("intervalDays")).toBeNull();
    expect(value("localStartTime")).toBe("09:00");
    expect(value("localEndTime")).toBe("10:00");
    expect(value("location")).toBe("Room 4");
    expect(value("setupBeforeMinutes")).toBe(0);
    expect(record.fields.title!.evidence[0]).toBe("Calendar feed · calendar.example.com · repeating event");
    // The record is what the batch schema takes.
    expect(() => importRecordSchema.parse(record)).not.toThrow();
  });

  it("writes the columns of each repeat unit, and a bounded rule's end date", () => {
    const monthly = pass({
      series: [
        feedSeries("m", {
          startDate: "2026-11-10",
          endDate: "2027-05-10",
          repeat: { unit: "months", intervalMonths: 1, anchor: "day_of_month" }
        }),
        feedSeries("d", { repeat: { unit: "days", intervalDays: 3 } })
      ]
    }).records;
    const byKey = Object.fromEntries(monthly.map((r) => [r.importKey, r]));
    const m = byKey["calendar_feed:series:m"]!;
    expect(m.fields.intervalUnit!.value).toBe("months");
    expect(m.fields.intervalMonths!.value).toBe(1);
    expect(m.fields.monthAnchor!.value).toBe("day_of_month");
    expect(m.fields.endDate!.value).toBe("2027-05-10");
    expect(m.fields.weekdays!.value).toBeNull();
    const d = byKey["calendar_feed:series:d"]!;
    expect(d.fields.intervalUnit!.value).toBe("days");
    expect(d.fields.intervalDays!.value).toBe(3);
  });

  it("words an empty title and bounds a long one the way a one-off event is", () => {
    const records = pass({
      series: [feedSeries("a", { title: "  " }), feedSeries("b", { title: "T".repeat(500) })]
    }).records;
    expect(records[0]!.fields.title!.value).toBe("(no title)");
    expect(String(records[1]!.fields.title!.value)).toHaveLength(300);
  });

  it("takes the saved place a location names, and its buffers", () => {
    const out = pass({
      series: [feedSeries("a", { location: "Gym" })],
      locations: [
        {
          id: "gym-1",
          name: "Gym",
          setup_before_minutes: 10,
          transition_after_minutes: 5
        } as never
      ]
    });
    expect(out.records[0]!.fields.setupBeforeMinutes!.value).toBe(10);
    expect(out.records[0]!.fields.transitionAfterMinutes!.value).toBe(5);
  });

  it("proposes nothing for a declined UID, whatever its title now says", () => {
    const out = pass({
      series: [feedSeries("a", { title: "Renamed since" })],
      dismissals: [{ external_event_id: feedSeriesDismissalId("a") }]
    });
    expect(out).toEqual({ records: [], pending: 0, changed: 0, moveEvents: [], clearKeep: [] });
  });

  it("proposes nothing for a cancelled master that was never imported, or a series that has already ended", () => {
    expect(pass({ series: [feedSeries("a", { status: "cancelled" })] }).records).toEqual([]);
    expect(pass({ series: [feedSeries("a", { endDate: "2026-11-03" })] }).records).toEqual([]);
    expect(pass({ series: [feedSeries("a", { endDate: "2026-11-04" })] }).records).toHaveLength(1);
  });

  it("creates a new series that already has changed dates too: its dates are inserted with it, not left pending", () => {
    const out = pass({
      series: [feedSeries("a", { exceptions: [{ kind: "cancelled", date: "2026-11-17" }] }), feedSeries("b")]
    });
    expect(out.records.map((r) => r.importKey)).toEqual(["calendar_feed:series:a", "calendar_feed:series:b"]);
    expect(out.pending).toBe(0);
  });

  it("orders records by stem so the same read gives the same batch", () => {
    const out = pass({ series: [feedSeries("zeta"), feedSeries("alpha")] });
    expect(out.records.map((r) => r.importKey)).toEqual(["calendar_feed:series:alpha", "calendar_feed:series:zeta"]);
  });
});

describe("a series already linked to a rule", () => {
  const base = feedSeries("w");

  it("is steady when the feed still says what the link recorded: zero records, nothing counted", () => {
    expect(pass({ series: [base], ruleLinks: [linkFor(base)] })).toEqual({
      records: [],
      pending: 0,
      changed: 0,
      moveEvents: [],
      clearKeep: []
    });
  });

  it("does not take the owner's edit of the rule for a change in the feed", () => {
    const edited = linkFor(base, { title: "Owner renamed it", location: "Elsewhere" });
    expect(pass({ series: [base], ruleLinks: [edited] })).toEqual({
      records: [],
      pending: 0,
      changed: 0,
      moveEvents: [],
      clearKeep: []
    });
  });

  it.each([
    ["an UNTIL / COUNT end", { endDate: "2026-12-29" }, ["endDate"]],
    ["a new start time", { localStartTime: "09:30" }, ["localStartTime"]],
    ["a new title", { title: "Other" }, ["title"]],
    ["a new place", { location: "Room 9" }, ["location"]],
    ["a new repeat", { repeat: { unit: "weeks" as const, intervalWeeks: 2, weekdays: [2] } }, ["intervalWeeks"]],
    ["a new zone", { timezone: "Europe/London" }, ["timezone"]]
  ])("proposes one held rule update when the feed gains %s", (_name, over, _fields) => {
    const out = pass({ series: [feedSeries("w", over)], ruleLinks: [linkFor(base)] });
    expect(out).toMatchObject({ pending: 0, changed: 0 });
    expect(out.records).toHaveLength(1);
    const record = out.records[0]!;
    expect(record).toMatchObject({
      importKey: "calendar_feed:series:w",
      entityType: "fixed_commitment_recurrence",
      operation: "update",
      matchedEntityId: "rule-1",
      expectedVersion: 1,
      relationships: { feedSeries: "w", feedRuleUpdate: "true" }
    });
    expect(() => importRecordSchema.parse(record)).not.toThrow();
  });

  it("puts every changed rule field in the one update and leaves a field the owner edited alone when the feed did not change it", () => {
    const owner = linkFor(base, { title: "Owner renamed it" });
    const out = pass({
      series: [feedSeries("w", { localStartTime: "09:30", location: "Room 9" })],
      ruleLinks: [owner]
    });
    expect(out.records).toHaveLength(1);
    const fields = out.records[0]!.fields;
    expect(fields.localStartTime!.value).toBe("09:30");
    expect(fields.location!.value).toBe("Room 9");
    expect(fields.title!.value).toBe("Owner renamed it");
  });

  it("is a conflict, not an overwrite, when the owner and the feed both changed the title", () => {
    const owner = linkFor(base, { title: "Owner renamed it" });
    const out = pass({ series: [feedSeries("w", { title: "Feed renamed it" })], ruleLinks: [owner] });
    expect(out.records).toHaveLength(1);
    expect(out.records[0]).toMatchObject({
      operation: "conflict",
      relationships: { calendar_feedConflictFields: "title" }
    });
    expect(out.records[0]!.fields.title!.value).toBe("Owner renamed it");
    expect(out.records[0]!.errors[0]).toContain("title changed in both Calendar feed and OpenRhen");
  });

  it("shows its conflicted fields to the review and resolves them with the feed's value", () => {
    const owner = linkFor(base, { title: "Owner renamed it" });
    const record = pass({ series: [feedSeries("w", { title: "Feed renamed it" })], ruleLinks: [owner] }).records[0]!;
    expect(conflictedFields(record)).toEqual(["title"]);
    const batch = { id: "b", records: [record] } as unknown as ImportBatch;
    expect(resolveRecordSharedCalendarConflict(batch, record.id, "title", true).records[0]!.fields.title!.value).toBe(
      "Feed renamed it"
    );
    expect(resolveRecordSharedCalendarConflict(batch, record.id, "title", false).records[0]!.fields.title!.value).toBe(
      "Owner renamed it"
    );
  });

  it("names the repeat fields that differ when the owner and the feed both changed the repeat", () => {
    const owner = linkFor(base, { interval_weeks: 2 });
    const record = pass({
      series: [feedSeries("w", { repeat: { unit: "weeks", intervalWeeks: 1, weekdays: [2, 4] } })],
      ruleLinks: [owner]
    }).records[0]!;
    expect(record.operation).toBe("conflict");
    expect(conflictedFields(record).length).toBeGreaterThan(0);
    for (const name of conflictedFields(record)) expect(record.fields[name]).toBeDefined();
  });

  it("resolves a weekdays conflict to the list, whichever side is chosen", () => {
    const owner = linkFor(base, { weekdays: [1, 3] });
    const record = pass({
      series: [feedSeries("w", { repeat: { unit: "weeks", intervalWeeks: 1, weekdays: [2, 4] } })],
      ruleLinks: [owner]
    }).records[0]!;
    expect(conflictedFields(record)).toContain("weekdays");
    const batch = { id: "b", records: [record] } as unknown as ImportBatch;
    const take = resolveRecordSharedCalendarConflict(batch, record.id, "weekdays", true).records[0]!;
    expect(take.fields.weekdays!.value).toEqual([2, 4]);
    const keep = resolveRecordSharedCalendarConflict(batch, record.id, "weekdays", false).records[0]!;
    expect(keep.fields.weekdays!.value).toEqual([1, 3]);
  });

  it("carries the buffers a rule record is checked for, so editing it in the review shows no false error", () => {
    const record = pass({ series: [feedSeries("w", { title: "Feed" })], ruleLinks: [linkFor(base)] }).records[0]!;
    expect(record.fields.setupBeforeMinutes!.value).toBe(0);
    expect(record.fields.transitionAfterMinutes!.value).toBe(0);
    expect(validateImportRecords([record])[0]!.errors).toEqual([]);
  });

  it("reads a tentative master as the same series", () => {
    expect(pass({ series: [feedSeries("w", { status: "tentative" })], ruleLinks: [linkFor(base)] }).records).toEqual(
      []
    );
  });

  it("proposes a held end, never an automatic one, for a cancelled master", () => {
    const out = pass({ series: [feedSeries("w", { status: "cancelled" })], ruleLinks: [linkFor(base)] });
    expect(out.records).toHaveLength(1);
    expect(out.records[0]).toMatchObject({
      operation: "delete",
      entityType: "fixed_commitment_recurrence",
      relationships: { feedSeries: "w", feedReasonKind: "cancelled" }
    });
    expect(out.records[0]!.relationships.feedReason).toContain("cancelled");
  });

  it("does not propose to end a cancelled master whose rule has already run out", () => {
    const over = linkFor(base, { end_date: "2026-11-01" });
    expect(pass({ series: [feedSeries("w", { status: "cancelled" })], ruleLinks: [over] }).records).toEqual([]);
  });

  it("never recreates, follows or counts a rule that has been ended", () => {
    const ended = linkFor(base, { status: "ended" });
    expect(pass({ series: [feedSeries("w", { title: "Changed" })], ruleLinks: [ended] })).toEqual({
      records: [],
      pending: 0,
      changed: 0,
      moveEvents: [],
      clearKeep: []
    });
  });

  it("holds a visible end, with its reason, for a rule whose UID is still a series in the read but has no usable descriptor", () => {
    const out = pass({ series: [], seriesStems: new Set(["w"]), ruleLinks: [linkFor(base)] });
    expect(out.records).toHaveLength(1);
    expect(out.records[0]).toMatchObject({
      operation: "delete",
      relationships: { feedSeries: "w", feedReasonKind: "shape" }
    });
    expect(out.records[0]!.relationships.feedReason).toContain("cannot follow");
  });

  it("is quiet about a rule whose UID has no event in the read when the read cannot speak for absence", () => {
    const window = { startDate: "2026-11-04", endDate: "2027-02-02" };
    expect(pass({ series: [], seriesStems: new Set(), ruleLinks: [linkFor(base)], window })).toMatchObject({
      records: []
    });
    expect(
      pass({ series: [], seriesStems: new Set(), ruleLinks: [linkFor(base)], window, absenceKnown: () => false })
    ).toMatchObject({ records: [] });
  });

  describe("a UID missing from a complete read", () => {
    const window = { startDate: "2026-11-04", endDate: "2027-02-02" };
    const gone = (over: Partial<Parameters<typeof pass>[0]> = {}, link: Partial<FeedRuleLinkRow> = {}) =>
      pass({
        series: [],
        seriesStems: new Set(),
        ruleLinks: [linkFor(base, link)],
        window,
        absenceKnown: () => true,
        presentStems: new Set(),
        ...over
      });

    it("is a held end when the rule should have produced an instance well inside the window", () => {
      const out = gone();
      expect(out.records).toHaveLength(1);
      expect(out.records[0]).toMatchObject({ operation: "delete", relationships: { feedReasonKind: "gone" } });
    });

    it("is not an end when any event of the UID is in the read (an invitee copy, an override)", () => {
      expect(gone({ presentStems: new Set(["w"]) }).records).toEqual([]);
    });

    it("is not an end when the rule would not have produced an instance in the window (this is the window, not absence)", () => {
      expect(gone({}, { start_date: "2027-06-01" }).records).toEqual([]);
    });

    it("is not an end when the rule has already ended by its own end date", () => {
      expect(gone({}, { end_date: "2026-11-03" }).records).toEqual([]);
    });

    it("is not an end when the only instances in the window are dates the feed cancelled", () => {
      const cancelled = Object.fromEntries(
        Array.from({ length: 14 }, (_, week) => {
          const d = new Date(Date.UTC(2026, 10, 10 + week * 7)).toISOString().slice(0, 10);
          return [d, { status: "cancelled" }];
        })
      );
      const snapshot = { ...feedLinkSnapshot(base), occurrences: cancelled };
      expect(gone({}, { last_remote_snapshot: snapshot }).records).toEqual([]);
    });
  });

  it("counts a one-off link whose UID became a series the pass cannot adopt, not one whose UID already has a rule", () => {
    const out = pass({
      series: [feedSeries("w", { title: "Other" })],
      ruleLinks: [linkFor(base)],
      ownedLinkStems: new Set(["w", "x"])
    });
    // "w" has its rule (its one-off links are that rule's business); "x" is a set-aside UID with no rule to adopt it.
    expect(out.changed).toBe(1);
  });

  describe("adoption of a UID that already has one-off events on the plan", () => {
    it("proposes the rule starting after the last one-off event, with a note, and does not count the UID as changed", () => {
      const out = pass({
        series: [feedSeries("w")],
        ownedLinkStems: new Set(["w"]),
        ownedLatestStart: new Map([["w", "2026-11-23T22:00:00.000Z"]])
      });
      // The last event is Tuesday 2026-11-24 in the feed zone; the rule begins on the next Tuesday.
      expect(out.changed).toBe(0);
      expect(out.records).toHaveLength(1);
      expect(out.records[0]!.fields.startDate!.value).toBe("2026-12-01");
      expect(out.records[0]!.relationships.feedNote).toContain(
        "already has single events on your plan (the last on 2026-11-24)"
      );
      expect(out.records[0]!.importKey).toBe("calendar_feed:series:w");
    });

    it("starts at the first real instance from today when the events are all in the past", () => {
      const out = pass({
        series: [feedSeries("w")],
        ownedLinkStems: new Set(["w"]),
        ownedLatestStart: new Map([["w", "2026-10-26T22:00:00.000Z"]])
      });
      expect(out.records[0]!.fields.startDate!.value).toBe("2026-11-10");
    });

    it("skips a date the feed cancels when choosing the start", () => {
      const out = pass({
        series: [feedSeries("w", { exceptions: [{ kind: "cancelled", date: "2026-11-10" }] })],
        ownedLinkStems: new Set(["w"])
      });
      expect(out.records[0]!.fields.startDate!.value).toBe("2026-11-17");
    });

    it("proposes nothing, and counts it, when a bounded series has no instance left after the events", () => {
      const out = pass({
        series: [feedSeries("w", { endDate: "2026-11-17" })],
        ownedLinkStems: new Set(["w"]),
        ownedLatestStart: new Map([["w", "2026-11-23T22:00:00.000Z"]])
      });
      expect(out).toMatchObject({ records: [], changed: 1 });
    });

    it("respects a decline", () => {
      const out = pass({
        series: [feedSeries("w")],
        ownedLinkStems: new Set(["w"]),
        dismissals: [{ external_event_id: feedSeriesDismissalId("w") }]
      });
      expect(out.records).toEqual([]);
    });
  });

  it("ignores a link that is not a series link", () => {
    expect(stemOfRuleLink({ external_event_id: "series:abc", last_remote_snapshot: null })).toBe("abc");
    expect(stemOfRuleLink({ external_event_id: "abc#20261110", last_remote_snapshot: null })).toBeNull();
  });

  it("reads a later generation's stem from its snapshot, never out of its id", () => {
    expect(
      stemOfRuleLink({
        external_event_id: "series:abc.2",
        last_remote_snapshot: { feedStem: "abc", feedGeneration: 2 }
      })
    ).toBe("abc");
    expect(ruleLinkIdentity({ external_event_id: "series:abc.2", last_remote_snapshot: null })).toEqual({
      stem: "abc.2",
      generation: 1
    });
  });
});

describe("generations, revival and kept ends", () => {
  const base = feedSeries("w");
  /** A rule link of a given generation of "w", ended by whom the test says. */
  const gen = (generation: number, over: Partial<FeedRuleLinkRow> = {}, snapshot: Record<string, unknown> = {}) =>
    linkFor(base, {
      external_event_id: generation > 1 ? `series:w.${generation}` : "series:w",
      recurrence_rule_id: `rule-${generation}`,
      last_remote_snapshot: { ...feedLinkSnapshot(base, generation, "w"), ...snapshot },
      ...over
    });
  const ended = (generation: number, endedBy?: string) =>
    gen(generation, { status: "ended" }, endedBy ? { endedBy } : {});

  it("keys a later generation's update and end by its own generation, and follows only the newest", () => {
    const links = [ended(1, "feed"), gen(2)];
    const update = pass({ series: [feedSeries("w", { title: "New name" })], ruleLinks: links }).records;
    expect(update).toHaveLength(1);
    expect(update[0]).toMatchObject({
      importKey: "calendar_feed:series:w.2",
      matchedEntityId: "rule-2",
      operation: "update"
    });
    const end = pass({ series: [feedSeries("w", { status: "cancelled" })], ruleLinks: links }).records;
    expect(end[0]).toMatchObject({
      importKey: "calendar_feed:series:w.2",
      matchedEntityId: "rule-2",
      operation: "delete"
    });
  });

  it("proposes the next generation for a rule the feed ended, from its first real instance, with the feed's own bound", () => {
    const out = pass({ series: [feedSeries("w", { endDate: "2026-12-29" })], ruleLinks: [ended(1, "feed")] });
    expect(out.records).toHaveLength(1);
    expect(out.records[0]).toMatchObject({
      operation: "create",
      importKey: "calendar_feed:series:w.2",
      relationships: { feedSeries: "w", feedGeneration: "2" }
    });
    expect(out.records[0]!.fields.startDate!.value).toBe("2026-11-10");
    expect(out.records[0]!.fields.endDate!.value).toBe("2026-12-29");
    expect(
      pass({ series: [feedSeries("w")], ruleLinks: [ended(1, "feed"), ended(2, "feed")] }).records[0]!.importKey
    ).toBe("calendar_feed:series:w.3");
  });

  it("does not revive a rule the owner or a shape change ended, one with no recorded end, or a declined UID", () => {
    for (const endedBy of ["owner", "shape", undefined])
      expect(pass({ series: [feedSeries("w")], ruleLinks: [ended(1, endedBy)] }).records).toEqual([]);
    expect(
      pass({
        series: [feedSeries("w")],
        ruleLinks: [ended(1, "feed")],
        dismissals: [{ external_event_id: feedSeriesDismissalId("w") }]
      }).records
    ).toEqual([]);
  });

  it("does not revive into a cancelled master, an unrepresentable shape, or a series with nothing left to hold", () => {
    expect(pass({ series: [feedSeries("w", { status: "cancelled" })], ruleLinks: [ended(1, "feed")] }).records).toEqual(
      []
    );
    expect(pass({ series: [], seriesStems: new Set(["w"]), ruleLinks: [ended(1, "feed")] }).records).toEqual([]);
    expect(
      pass({ series: [feedSeries("w", { endDate: "2026-11-03" })], ruleLinks: [ended(1, "feed")] }).records
    ).toEqual([]);
  });

  it("starts a revival or an adoption at the next real instance when today's has already started", () => {
    // 2026-11-10 is the series' Tuesday, 09:00 in the series zone (22:00 UTC the day before).
    const early = new Date("2026-11-09T12:00:00Z");
    const late = new Date("2026-11-10T05:00:00Z");
    const revive = (now: Date) =>
      pass({ series: [feedSeries("w")], ruleLinks: [ended(1, "feed")], today: "2026-11-10", now }).records[0]!;
    expect(revive(early).fields.startDate!.value).toBe("2026-11-10");
    expect(revive(late).fields.startDate!.value).toBe("2026-11-17");
    const adopt = (now: Date) =>
      pass({ series: [feedSeries("w")], ownedLinkStems: new Set(["w"]), today: "2026-11-10", now }).records[0]!;
    expect(adopt(early).fields.startDate!.value).toBe("2026-11-10");
    expect(adopt(late).fields.startDate!.value).toBe("2026-11-17");
  });

  it("says a shape end removes the dates still to come, because the new shape is not imported, and Keep leaves them", () => {
    const reason = pass({ series: [], seriesStems: new Set(["w"]), ruleLinks: [gen(1)] }).records[0]!.relationships
      .feedReason!;
    expect(reason).toContain("removes the dates still to come");
    expect(reason).toContain("new shape is not imported");
    expect(reason).toContain("Keeping it leaves those meetings on your plan");
  });

  it("stops at generation 999", () => {
    expect(pass({ series: [feedSeries("w")], ruleLinks: [ended(999, "feed")] }).records).toEqual([]);
  });

  it("words the shape-change card with the title and the proxy's reason, and names the calls for an agent", () => {
    const out = pass({
      series: [],
      seriesStems: new Set(["w"]),
      ruleLinks: [gen(1)],
      unrepresentableReasons: new Map([["w", "its rule has BYSETPOS"]])
    });
    const rel = out.records[0]!.relationships;
    expect(rel.feedReasonKind).toBe("shape");
    expect(rel.feedReason).toContain('"Series w"');
    expect(rel.feedReason).toContain("its rule has BYSETPOS");
    expect(rel.feedReason).toContain("Keep it");
    expect(rel.feedNextCall).toContain("PUT /api/imports/{batchId}");
    expect(rel.feedNextCall).toContain("POST /api/imports/{batchId}/commit-ready");
    expect(importRecordSchema.parse(out.records[0]).fields.title!.evidence.every((line) => line.length <= 500)).toBe(
      true
    );
  });

  it("keeps the evidence of a long title within the schema", () => {
    const long = feedSeries("w", { title: "t".repeat(300) });
    const out = pass({
      series: [],
      seriesStems: new Set(["w"]),
      ruleLinks: [linkFor(long)],
      unrepresentableReasons: new Map([["w", "r".repeat(120)]])
    });
    expect(() => importRecordSchema.parse(out.records[0])).not.toThrow();
  });

  describe("a kept end", () => {
    const kept = (kind: string) => gen(1, {}, { feedKeep: kind });
    it("is not proposed again while its condition holds, for each kind", () => {
      expect(pass({ series: [], seriesStems: new Set(["w"]), ruleLinks: [kept("shape")] })).toMatchObject({
        records: [],
        clearKeep: []
      });
      expect(
        pass({ series: [feedSeries("w", { status: "cancelled" })], ruleLinks: [kept("cancelled")] })
      ).toMatchObject({ records: [], clearKeep: [] });
      const window = { startDate: "2026-11-04", endDate: "2027-02-02" };
      expect(
        pass({ series: [], ruleLinks: [kept("gone")], window, absenceKnown: () => true, presentStems: new Set() })
      ).toMatchObject({ records: [], clearKeep: [] });
    });

    it("is proposed for a different condition, and forgotten once the condition has gone", () => {
      // Kept as a shape change, but now the master is cancelled: a new question, and the old keep is forgotten.
      const out = pass({ series: [feedSeries("w", { status: "cancelled" })], ruleLinks: [kept("shape")] });
      expect(out.records[0]!.relationships.feedReasonKind).toBe("cancelled");
      expect(out.clearKeep).toEqual(["series:w"]);
      // The shape is representable again.
      expect(pass({ series: [feedSeries("w")], ruleLinks: [kept("shape")] }).clearKeep).toEqual(["series:w"]);
      // The UID is back in the read.
      expect(pass({ series: [], ruleLinks: [kept("gone")], presentStems: new Set(["w"]) }).clearKeep).toEqual([
        "series:w"
      ]);
    });

    it("is not forgotten by a read that cannot speak for absence", () => {
      const window = { startDate: "2026-11-04", endDate: "2027-02-02" };
      expect(
        pass({ series: [], ruleLinks: [kept("gone")], window, absenceKnown: () => false, presentStems: new Set() })
      ).toMatchObject({ records: [], clearKeep: [] });
    });
  });

  describe("a kept date", () => {
    const row = {
      id: "row-1",
      recurrence_rule_id: "rule-1",
      local_date: "2026-11-17",
      title: "Series w",
      starts_at: new Date("2026-11-16T22:00:00.000Z"),
      ends_at: new Date("2026-11-16T23:00:00.000Z"),
      status: "confirmed",
      location: null,
      location_id: null,
      setup_before_minutes: 0,
      transition_after_minutes: 0,
      schedule_source: "inherit",
      version: 1
    };
    const change = {
      kind: "changed" as const,
      date: "2026-11-17",
      title: "Retimed",
      location: "",
      startDate: "2026-11-17",
      localStartTime: "14:00",
      endDate: "2026-11-17",
      localEndTime: "15:00"
    };
    const run = (dismissals: FeedSeriesPassInput["dismissals"]) =>
      pass({
        series: [feedSeries("w", { exceptions: [change] })],
        ruleLinks: [linkFor(base)],
        occurrences: [row],
        dismissals,
        now: new Date("2026-11-04T00:00:00Z")
      });

    it("is not asked again for the same ask, and is for another", () => {
      expect(run([]).records).toHaveLength(1);
      const id = feedDateDismissalId("rule-1", "2026-11-17");
      expect(run([{ external_event_id: id, title: feedDateFingerprint(change) }]).records).toEqual([]);
      expect(
        run([{ external_event_id: id, title: feedDateFingerprint({ ...change, localStartTime: "09:30" }) }]).records
      ).toHaveLength(1);
    });
  });
});

describe("the snapshot", () => {
  it("is the rule's flat fields plus the zone, with an empty occurrences object and no nested rule", () => {
    const snapshot = feedLinkSnapshot(feedSeries("w", { location: "Room 4" }));
    expect(snapshot).toEqual({
      title: "Series w",
      startDate: "2026-11-10",
      endDate: null,
      intervalUnit: "weeks",
      intervalDays: null,
      intervalWeeks: 1,
      weekdays: [2],
      intervalMonths: null,
      monthAnchor: null,
      localStartTime: "09:00",
      localEndTime: "10:00",
      location: "Room 4",
      feedStem: "w",
      feedGeneration: 1,
      timezone: "Australia/Sydney",
      occurrences: {}
    });
    expect(snapshot).not.toHaveProperty("rule");
    expect(snapshot).not.toHaveProperty("submissionId");
  });

  it("bounds the title and place the way the plan keeps them", () => {
    expect(feedRuleSnapshot(feedSeries("w", { title: " ", location: "   " }))).toMatchObject({
      title: "(no title)",
      location: null
    });
  });
});

describe("keys and the batch source", () => {
  it("builds the series key from the stem and keeps the longest inside importKey", () => {
    expect(feedSeriesKey("abc")).toBe("calendar_feed:series:abc");
    expect(feedSeriesKey("u".repeat(FEED_SERIES_MAX_STEM)).length).toBeLessThanOrEqual(FEED_MAX_KEY);
    expect(`${feedSeriesKey("u".repeat(FEED_SERIES_MAX_STEM))}.999`.length).toBeLessThanOrEqual(FEED_MAX_KEY);
  });

  it("keeps only the descriptors of the series creates a subset names, in stem order, and none for a batch without one", () => {
    const a = feedSeries("a");
    const b = feedSeries("b");
    const series = new Map([
      ["a", a],
      ["b", b]
    ]);
    const records = [
      { importKey: "calendar_feed:series:b", operation: "create" as const },
      { importKey: "calendar_feed:series:a", operation: "create" as const }
    ];
    const both = JSON.parse(feedSyncSourceText({ events: [], records, series }));
    expect(Object.keys(both.series)).toEqual(["a", "b"]);
    expect(both.series.a).toEqual(a);
    expect(
      Object.keys(JSON.parse(feedSyncSourceText({ events: [], records: records.slice(0, 1), series })).series)
    ).toEqual(["b"]);
    expect(JSON.parse(feedSyncSourceText({ events: [], records: [], series }))).not.toHaveProperty("series");
  });
});

describe("the dismissal of a declined series", () => {
  const inserts = fixedBlocksProfileFor("calendar_feed", "Calendar feed").dismissals!.inserts;
  const record = (key: string, over: object = {}) => ({
    importKey: key,
    operation: "create" as const,
    removed: false,
    entityType: "fixed_commitment_recurrence" as const,
    relationships: {},
    ...over
  });
  const source = { provider: "calendar_feed", events: {}, series: { w: feedSeries("w", { title: "Standup" }) } };

  it("is remembered by stem with the title and first date, when the batch is discarded or the record left unticked", () => {
    const expected = [{ externalEventId: "series:w", title: "Standup", startsAt: "2026-11-10T00:00:00.000Z" }];
    expect(inserts([record("calendar_feed:series:w")], source, "all")).toEqual(expected);
    expect(inserts([record("calendar_feed:series:w", { removed: true })], source, "deselected")).toEqual(expected);
  });

  it("is not made for a ticked record on a commit, or a series the source does not describe", () => {
    expect(inserts([record("calendar_feed:series:w")], source, "deselected")).toEqual([]);
    expect(inserts([record("calendar_feed:series:other", { removed: true })], source, "all")).toEqual([]);
  });
});

// The seam's name is spelled in two halves so this guard file does not itself trip the structure check it mirrors.
const SEAM = ["contrib", "utor"].join("");

describe("the feed's core files stay clear of the owner-side seam the OpenRhen export drops", () => {
  // The export drops every `<seam>-*` file, so core feed code importing one would break it (the repository structure
  // check names it too). This catches the import before CI's structure step does.
  it.each([
    "calendar-feed-series.ts",
    "calendar-feed-dates.ts",
    "calendar-feed-import-extension.ts",
    "calendar-feed-test-support.ts",
    "calendar-profiles/calendar-feed.ts",
    "calendar-profiles/fixed-blocks.ts"
  ])("%s imports nothing from it", (file) => {
    const text = readFileSync(resolve(__dirname, file), "utf8");
    expect(text).not.toMatch(new RegExp(`from\\s+["'][^"']*${SEAM}`));
    expect(text.toLowerCase()).not.toContain(SEAM);
  });
});

describe("a date the feed moves to another day", () => {
  const NOW = new Date("2026-11-03T14:00:00.000Z");
  const move = {
    kind: "changed",
    date: "2026-11-10",
    title: "Moved meeting",
    location: "Room 2",
    startDate: "2026-11-12",
    localStartTime: "14:00",
    endDate: "2026-11-12",
    localEndTime: "15:00"
  } as const;
  const moved = () => feedSeries("w", { exceptions: [move] });

  it("is a one-off event at the new time and the original date's cancel, both named as one pair", () => {
    const base = feedSeries("w");
    const out = pass({ series: [moved()], ruleLinks: [linkFor(base)], now: NOW });
    expect(out.moveEvents).toHaveLength(1);
    const { event, date } = out.moveEvents[0]!;
    expect(date).toBe("2026-11-10");
    expect(event).toMatchObject({
      externalEventId: "w#move20261110",
      title: "Moved meeting",
      location: "Room 2",
      allDay: false
    });
    expect(event.startsAt).toBe("2026-11-12T03:00:00.000Z");
    const cancel = out.records.find((r) => r.importKey.startsWith("calendar_feed:occ:"))!;
    expect(cancel.relationships).toMatchObject({ feedCancel: "true", feedMove: "mv:w:2026-11-10" });
  });

  it("is not proposed from a partial read, but a replacement already on the plan is kept so it is never read as absent", () => {
    const base = feedSeries("w");
    const partial = pass({ series: [moved()], ruleLinks: [linkFor(base)], now: NOW, trusted: false });
    expect(partial.moveEvents).toEqual([]);
    const kept = pass({
      series: [moved()],
      ruleLinks: [linkFor(base)],
      now: NOW,
      trusted: false,
      moveDates: new Map([["w", new Set(["2026-11-10"])]])
    });
    expect(kept.moveEvents.map((m) => m.event.externalEventId)).toEqual(["w#move20261110"]);
  });

  it("is nothing for a date the rule does not produce, and the event id round-trips", () => {
    const base = feedSeries("w");
    const off = feedSeries("w", { exceptions: [{ ...move, date: "2026-11-11" }] });
    expect(pass({ series: [off], ruleLinks: [linkFor(base)], now: NOW }).moveEvents).toEqual([]);
    expect(parseFeedMoveEventId(feedMoveEventId("w", "2026-11-10"))).toEqual({ stem: "w", date: "2026-11-10" });
    expect(parseFeedMoveEventId("w#20261110")).toBeNull();
  });
});
