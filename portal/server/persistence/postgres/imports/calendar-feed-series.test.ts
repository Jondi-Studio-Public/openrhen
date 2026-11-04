import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { importRecordSchema } from "@openrhen/contracts";
import type { CalendarFeedSeries } from "@openrhen/contracts/integrations/calendar-feed";
import {
  feedLinkSnapshot,
  feedRuleSnapshot,
  feedSeriesDismissalId,
  feedSeriesKey,
  feedSeriesPass,
  feedSeriesUnchanged,
  stemOfRuleLink,
  type FeedRuleLinkRow,
  type FeedSeriesPassInput
} from "./calendar-feed-series";
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
    expect(out).toEqual({ records: [], pending: 0, changed: 0 });
  });

  it("proposes nothing for a cancelled master that was never imported, or a series that has already ended", () => {
    expect(pass({ series: [feedSeries("a", { status: "cancelled" })] }).records).toEqual([]);
    expect(pass({ series: [feedSeries("a", { endDate: "2026-11-03" })] }).records).toEqual([]);
    expect(pass({ series: [feedSeries("a", { endDate: "2026-11-04" })] }).records).toHaveLength(1);
  });

  it("leaves a new series that already has changed dates unproposed and counts it pending: its dates could not be applied", () => {
    const out = pass({
      series: [
        feedSeries("a", { exceptions: [{ kind: "cancelled", date: "2026-11-17" }] }),
        feedSeries("b"),
        feedSeries("c", {
          exceptions: [
            {
              kind: "changed",
              date: "2026-11-24",
              title: "Moved",
              location: "",
              startDate: "2026-11-24",
              localStartTime: "10:00",
              endDate: "2026-11-24",
              localEndTime: "11:00"
            }
          ]
        })
      ]
    });
    expect(out.records.map((r) => r.importKey)).toEqual(["calendar_feed:series:b"]);
    expect(out.pending).toBe(2);
  });

  it("orders records by stem so the same read gives the same batch", () => {
    const out = pass({ series: [feedSeries("zeta"), feedSeries("alpha")] });
    expect(out.records.map((r) => r.importKey)).toEqual(["calendar_feed:series:alpha", "calendar_feed:series:zeta"]);
  });
});

describe("a series already linked to a rule", () => {
  const base = feedSeries("w");

  it("is steady when the feed still says what the link recorded: zero records, nothing counted", () => {
    expect(pass({ series: [base], ruleLinks: [linkFor(base)] })).toEqual({ records: [], pending: 0, changed: 0 });
  });

  it("does not take the owner's edit of the rule for a change in the feed", () => {
    const edited = linkFor(base, { title: "Owner renamed it", location: "Elsewhere" });
    expect(pass({ series: [base], ruleLinks: [edited] }).changed).toBe(0);
  });

  it.each([
    ["an EXDATE", { exceptions: [{ kind: "cancelled" as const, date: "2026-11-17" }] }],
    ["an UNTIL / COUNT end", { endDate: "2026-12-29" }],
    ["a new start time", { localStartTime: "09:30" }],
    ["a new title", { title: "Other" }],
    ["a new place", { location: "Room 9" }],
    ["a new repeat", { repeat: { unit: "weeks" as const, intervalWeeks: 2, weekdays: [2] } }],
    ["a new zone", { timezone: "Europe/London" }],
    ["a cancelled master", { status: "cancelled" as const }]
  ])("is counted changed, and writes nothing, when the feed gains %s", (_name, over) => {
    const out = pass({ series: [feedSeries("w", over)], ruleLinks: [linkFor(base)] });
    expect(out).toEqual({ records: [], pending: 0, changed: 1 });
  });

  it("reads a tentative master as the same series", () => {
    expect(pass({ series: [feedSeries("w", { status: "tentative" })], ruleLinks: [linkFor(base)] }).changed).toBe(0);
  });

  it("never recreates, or counts, a rule that has been ended", () => {
    const ended = linkFor(base, { status: "ended" });
    expect(pass({ series: [feedSeries("w", { title: "Changed" })], ruleLinks: [ended] })).toEqual({
      records: [],
      pending: 0,
      changed: 0
    });
  });

  it("counts a rule whose UID is still a series in the read but has no usable descriptor (its shape changed)", () => {
    const out = pass({ series: [], seriesStems: new Set(["w"]), ruleLinks: [linkFor(base)] });
    expect(out).toEqual({ records: [], pending: 0, changed: 1 });
  });

  it("is quiet about a rule whose UID has no event in the read: out of the window is not a change", () => {
    expect(pass({ series: [], seriesStems: new Set(), ruleLinks: [linkFor(base)] })).toEqual({
      records: [],
      pending: 0,
      changed: 0
    });
  });

  it("counts a one-off link whose UID became a series once, together with a changed rule of the same UID", () => {
    const out = pass({
      series: [feedSeries("w", { title: "Other" })],
      ruleLinks: [linkFor(base)],
      ownedLinkStems: new Set(["w", "x"])
    });
    expect(out.changed).toBe(2);
  });

  it("does not propose a series create for a UID that already has one-off links on the plan, and counts it", () => {
    const out = pass({ series: [feedSeries("w")], ownedLinkStems: new Set(["w"]) });
    expect(out).toEqual({ records: [], pending: 0, changed: 1 });
  });

  it("ignores a link that is not a series link", () => {
    expect(stemOfRuleLink({ external_event_id: "series:abc" })).toBe("abc");
    expect(stemOfRuleLink({ external_event_id: "abc#20261110" })).toBeNull();
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
      timezone: "Australia/Sydney",
      occurrences: {}
    });
    expect(snapshot).not.toHaveProperty("rule");
    expect(snapshot).not.toHaveProperty("submissionId");
  });

  it("is what an unchanged series compares equal to, and notices a snapshot it cannot read", () => {
    const series = feedSeries("w");
    expect(feedSeriesUnchanged(series, { last_remote_snapshot: feedLinkSnapshot(series) })).toBe(true);
    expect(feedSeriesUnchanged(series, { last_remote_snapshot: null })).toBe(false);
    expect(feedSeriesUnchanged(series, { last_remote_snapshot: { title: "x" } })).toBe(false);
    // A snapshot that already holds recorded dates is a later change's to judge, not this one's.
    expect(
      feedSeriesUnchanged(series, {
        last_remote_snapshot: { ...feedLinkSnapshot(series), occurrences: { "2026-11-17": { status: "cancelled" } } }
      })
    ).toBe(false);
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
