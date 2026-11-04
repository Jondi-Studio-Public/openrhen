import { describe, expect, it } from "vitest";
import { calendarEventSchema, importRecordSchema, type CalendarEvent, type ImportRecord } from "@openrhen/contracts";
import {
  FEED_EVENT_PREFIX,
  FEED_MAX_ID,
  FEED_MAX_KEY,
  FeedReadError,
  applyFeedDemotions,
  feedCommitmentCollisions,
  feedReadComplete,
  feedStemOf,
  splitSeriesOwnedLinks,
  FEED_SERIES_KEY_MAX,
  FEED_SERIES_MAX_STEM,
  FEED_SERIES_PREFIX,
  feedSyncSourceText,
  limitFeedRecords,
  prepareFeedRead
} from "./calendar-feed";
import { feedSeries } from "../calendar-feed-test-support";
import { fixedBlocksProfileFor } from "./fixed-blocks";

const STEM_HASH = `!${"a".repeat(32)}`;

function event(id: string, over: Partial<CalendarEvent> = {}): CalendarEvent {
  return calendarEventSchema.parse({
    externalEventId: id,
    calendarId: null,
    title: `Event ${id}`,
    description: null,
    startsAt: "2026-11-10T01:00:00.000Z",
    endsAt: "2026-11-10T02:00:00.000Z",
    allDay: false,
    timezone: null,
    location: null,
    status: "confirmed",
    seriesId: null,
    recurring: false,
    updatedAt: null,
    ...over
  });
}

const extras = (over: Record<string, unknown> = {}) => ({
  host: "calendar.example.com",
  transportComplete: true,
  veventCount: 1,
  skipped: [],
  veventCapHit: false,
  occurrenceCapHit: false,
  timeBudgetHit: false,
  ...over
});

const window = { timeMin: "2026-11-04T00:00:00.000Z", timeMax: "2027-02-02T00:00:00.000Z" };

describe("prepareFeedRead", () => {
  it("keeps non-recurring events and master-less overrides, which are per-instance", () => {
    const prepared = prepareFeedRead({
      events: [
        event("solo-uid"),
        event("orphan#20261112", { seriesId: "orphan", recurring: true, attributes: { uid: "orphan" } })
      ],
      extras: extras()
    });
    expect(prepared.events.map((e) => e.externalEventId)).toEqual(["solo-uid", "orphan#20261112"]);
    expect(prepared.rawEventCount).toBe(2);
    expect(prepared.notImported).toEqual({
      unrepresentableSeries: 0,
      seriesPending: 0,
      seriesChanged: 0,
      unreadable: 0,
      droppedForSize: 0
    });
    expect(prepared.host).toBe("calendar.example.com");
  });

  it("sets aside every instance of a UID that carries a series descriptor, wherever the descriptor sits", () => {
    const prepared = prepareFeedRead({
      events: [
        event("weekly#20261110", { recurring: true, seriesId: "weekly", attributes: { series: feedSeries("weekly") } }),
        event("weekly#20261117", { recurring: true, seriesId: "weekly" }),
        event("weekly#20261124", { recurring: true, seriesId: "weekly" }),
        event("plain")
      ],
      extras: extras()
    });
    expect(prepared.events.map((e) => e.externalEventId)).toEqual(["plain"]);
    expect([...prepared.seriesStems]).toEqual(["weekly"]);
    expect([...prepared.series.keys()]).toEqual(["weekly"]);
    expect(prepared.notImported).toMatchObject({ seriesPending: 1, unrepresentableSeries: 0, unreadable: 0 });
  });

  it("sets aside a descriptor it cannot read, or one for another UID, or a stem too long for a key, and counts it unreadable", () => {
    const long = "u".repeat(FEED_SERIES_MAX_STEM + 1);
    const prepared = prepareFeedRead({
      events: [
        event("junk#20261110", { attributes: { series: { freq: "WEEKLY" } } }),
        event("other#20261110", { attributes: { series: feedSeries("someone-else") } }),
        event(`${long}#20261110`, { attributes: { series: feedSeries(long) } }),
        event("fine#20261110", { attributes: { series: feedSeries("fine") } })
      ],
      extras: extras()
    });
    expect(prepared.events).toEqual([]);
    expect([...prepared.seriesStems].sort()).toEqual(["fine", "junk", long, "other"].sort());
    expect([...prepared.series.keys()]).toEqual(["fine"]);
    expect(prepared.notImported).toMatchObject({ seriesPending: 1, unreadable: 3 });
  });

  it("keeps the longest series key inside the 120-character import key, with a three-digit generation", () => {
    expect(FEED_SERIES_PREFIX.length + FEED_SERIES_MAX_STEM + ".999".length).toBeLessThanOrEqual(FEED_SERIES_KEY_MAX);
    expect(FEED_SERIES_KEY_MAX).toBeLessThanOrEqual(FEED_MAX_KEY);
  });

  it("sets aside every instance of a UID listed as unrepresentable, and counts it once", () => {
    const prepared = prepareFeedRead({
      events: [
        event("odd#20261110", { recurring: true, seriesId: "odd" }),
        event("odd#20261111", { recurring: true, seriesId: "odd" }),
        event("plain")
      ],
      extras: extras({ unrepresentableSeries: [{ idPrefix: "odd", reason: "shape unsupported" }] })
    });
    expect(prepared.events.map((e) => e.externalEventId)).toEqual(["plain"]);
    expect(prepared.notImported).toMatchObject({ unrepresentableSeries: 1, seriesPending: 0 });
  });

  it("does not count a UID twice when it is both listed and carries a descriptor", () => {
    const prepared = prepareFeedRead({
      events: [event("both#20261110", { attributes: { series: {} } })],
      extras: extras({ unrepresentableSeries: [{ idPrefix: "both", reason: "x" }] })
    });
    expect(prepared.notImported).toMatchObject({ unrepresentableSeries: 1, seriesPending: 0 });
  });

  it("fails on extras it cannot read rather than importing a series it cannot see", () => {
    expect(() => prepareFeedRead({ events: [], extras: {} })).toThrow(FeedReadError);
    expect(() => prepareFeedRead({ events: [], extras: extras({ unrepresentableSeries: [{ idPrefix: 4 }] }) })).toThrow(
      FeedReadError
    );
  });

  it("counts an unrepresentable series with no id and calls the read incomplete, so no absence is read from it", () => {
    const prepared = prepareFeedRead({
      events: [event("a")],
      extras: extras({ unrepresentableSeries: [{ idPrefix: null, reason: "no uid" }] })
    });
    expect(prepared.notImported.unrepresentableSeries).toBe(1);
    expect(prepared.readIncomplete).toBe(true);
    const link = { external_event_id: "other", last_remote_snapshot: { startsAt: "2026-11-12T00:00:00.000Z" } };
    expect(feedReadComplete(prepared, [link], window)).toBe(false);
  });

  it("gives an empty or blank title the wording the proxy uses, and bounds title and place", () => {
    const prepared = prepareFeedRead({
      events: [event("a", { title: "   " }), event("b", { title: "T".repeat(500), location: "L".repeat(500) })],
      extras: extras()
    });
    expect(prepared.events[0]!.title).toBe("(no title)");
    expect(prepared.events[1]!.title).toHaveLength(300);
    expect(prepared.events[1]!.location).toHaveLength(200);
  });

  it("sets aside an id that would not fit an import key, counts it and calls the read incomplete", () => {
    const prepared = prepareFeedRead({ events: [event("x".repeat(FEED_MAX_ID + 1)), event("ok")], extras: extras() });
    expect(prepared.events.map((e) => e.externalEventId)).toEqual(["ok"]);
    expect(prepared.notImported.unreadable).toBe(1);
    // An over-long id is never a link's id, so it is counted but does not hold the read incomplete on its own.
    expect(prepared.readIncomplete).toBe(false);
    expect(prepared.unreadableStems).toEqual(["x".repeat(FEED_MAX_ID + 1)]);
  });

  it("skips a repeated id and an end that is not after the start, and counts the proxy's own skips", () => {
    const prepared = prepareFeedRead({
      events: [event("dup"), event("dup"), event("flat", { endsAt: "2026-11-10T01:00:00.000Z" }), event("fine")],
      extras: extras({ skipped: [{ idPrefix: "bad", reason: "unreadable event" }] })
    });
    expect(prepared.events.map((e) => e.externalEventId)).toEqual(["dup", "fine"]);
    expect(prepared.notImported.unreadable).toBe(3);
    // The portal-side skips are named so a link behind one is found; a skip no link shares holds nothing back.
    expect(prepared.unreadableStems).toEqual(["dup", "flat"]);
    expect(prepared.skippedPrefixes).toEqual(["bad"]);
    expect(prepared.readIncomplete).toBe(false);
  });

  it("keeps every id the proxy can emit inside the 120-character import key", () => {
    // The proxy bounds an id at 89: an encoded stem of at most 80, '#' and YYYYMMDD. A hashed stem is 33.
    for (const id of ["u".repeat(80) + "#20261110", `${STEM_HASH}#20261110`, "u".repeat(80)]) {
      expect(`${FEED_EVENT_PREFIX}${id}`.length).toBeLessThanOrEqual(FEED_MAX_KEY);
      expect(prepareFeedRead({ events: [event(id)], extras: extras() }).events).toHaveLength(1);
    }
    expect(FEED_MAX_ID).toBe(100);
  });

  it("reads the stem of an id on its first '#', which a UID never carries unescaped", () => {
    expect(feedStemOf("abc#20261110")).toBe("abc");
    expect(feedStemOf("abc%23def#20261110")).toBe("abc%23def");
    expect(feedStemOf(STEM_HASH)).toBe(STEM_HASH);
  });
});

describe("feedReadComplete", () => {
  const base = {
    transportComplete: true,
    readIncomplete: false,
    skippedPrefixes: [] as (string | null)[],
    unreadableStems: [] as (string | null)[],
    rawEventCount: 3
  };
  const link = (id: string, startsAt = "2026-11-12T00:00:00.000Z") => ({
    external_event_id: id,
    last_remote_snapshot: { startsAt }
  });

  it("is complete when every part holds", () => {
    expect(feedReadComplete(base, [link("a")], window)).toBe(true);
  });

  it("is not complete when the proxy says the transport was not", () => {
    expect(feedReadComplete({ ...base, transportComplete: false }, [], window)).toBe(false);
    expect(feedReadComplete({ ...base, readIncomplete: true }, [], window)).toBe(false);
  });

  it("is not complete when a skipped event has no id, or shares one with a link (an instance too)", () => {
    expect(feedReadComplete({ ...base, skippedPrefixes: [null] }, [], window)).toBe(false);
    expect(feedReadComplete({ ...base, skippedPrefixes: ["a"] }, [link("a")], window)).toBe(false);
    expect(feedReadComplete({ ...base, skippedPrefixes: ["a"] }, [link("a#20261112")], window)).toBe(false);
    expect(feedReadComplete({ ...base, skippedPrefixes: ["a"] }, [link("b")], window)).toBe(true);
  });

  it("is not complete only for a portal-side skip that could be hiding a link, or has no id", () => {
    expect(feedReadComplete({ ...base, unreadableStems: [null] }, [], window)).toBe(false);
    expect(feedReadComplete({ ...base, unreadableStems: ["a"] }, [link("a#20261112")], window)).toBe(false);
    // The old behaviour was permanent: any portal-side skip held the read incomplete. One no link shares does not.
    expect(feedReadComplete({ ...base, unreadableStems: ["a"] }, [link("b")], window)).toBe(true);
    expect(feedReadComplete({ ...base, unreadableStems: ["a"] }, [], window)).toBe(true);
  });

  it("leaves the links behind a set-aside series to the series pass instead of holding the read incomplete", () => {
    const links = [link("s#20261112"), link("t"), link("u")];
    const split = splitSeriesOwnedLinks(links, new Set(["s", "u"]));
    expect(split.links.map((l) => l.external_event_id)).toEqual(["t"]);
    expect([...split.ownedStems].sort()).toEqual(["s", "u"]);
    expect(feedReadComplete(base, split.links, window)).toBe(true);
  });

  it("is not complete when the read is empty while links sit in the window", () => {
    expect(feedReadComplete({ ...base, rawEventCount: 0 }, [link("a")], window)).toBe(false);
    expect(feedReadComplete({ ...base, rawEventCount: 0 }, [link("a", "2025-01-01T00:00:00.000Z")], window)).toBe(true);
    expect(feedReadComplete({ ...base, rawEventCount: 0 }, [], window)).toBe(true);
  });
});

function record(key: string, operation: ImportRecord["operation"], extra: Partial<ImportRecord> = {}): ImportRecord {
  return {
    id: crypto.randomUUID(),
    importKey: key,
    entityType: "fixed_commitment",
    operation,
    expectedVersion: null,
    matchedEntityId: null,
    fields: {},
    relationships: {},
    errors: [],
    warnings: [],
    removed: false,
    sortOrder: 0,
    ...extra
  };
}

describe("feedSyncSourceText and limitFeedRecords", () => {
  const events = Array.from({ length: 40 }, (_, i) =>
    event(`e${String(i).padStart(2, "0")}`, {
      startsAt: new Date(Date.UTC(2026, 10, 10 + i)).toISOString(),
      endsAt: new Date(Date.UTC(2026, 10, 10 + i, 1)).toISOString(),
      description: "SECRET DESCRIPTION"
    })
  );
  const records = events.map((e, i) => record(`${FEED_EVENT_PREFIX}${e.externalEventId}`, "create", { sortOrder: i }));
  const startOf = (r: ImportRecord) => events.find((e) => r.importKey.endsWith(e.externalEventId))?.startsAt ?? "";
  const textFor = (subset: readonly ImportRecord[]) => feedSyncSourceText({ events, records: subset });

  it("keeps only the held events, sorted, with no description", () => {
    const text = feedSyncSourceText({ events, records: [records[3]!, records[1]!] });
    const parsed = JSON.parse(text) as { provider: string; frameId: string; events: Record<string, unknown> };
    expect(Object.keys(parsed.events)).toEqual(["e01", "e03"]);
    expect(parsed.provider).toBe("calendar_feed");
    expect(parsed.frameId).toBe("feed");
    expect(text).not.toContain("SECRET");
    expect(Object.keys(parsed.events.e01 as object)).toEqual([
      "externalEventId",
      "title",
      "startsAt",
      "endsAt",
      "allDay",
      "location",
      "status",
      "seriesId"
    ]);
    // Same held events in another order give the same text, so an unchanged batch is left alone.
    expect(feedSyncSourceText({ events, records: [records[1]!, records[3]!] })).toBe(text);
  });

  it("keeps everything that fits, unchanged and in order", () => {
    const { kept, dropped } = limitFeedRecords(records, startOf, textFor);
    expect(dropped).toBe(0);
    expect(kept).toEqual(records);
  });

  it("keeps the earliest-starting records that fit the record ceiling", () => {
    const shuffled = [...records].reverse();
    const { kept, dropped } = limitFeedRecords(shuffled, startOf, textFor, { records: 10, chars: 1_000_000 });
    expect(dropped).toBe(30);
    expect(kept.map((r) => r.importKey.slice(FEED_EVENT_PREFIX.length)).sort()).toEqual(
      events.slice(0, 10).map((e) => e.externalEventId)
    );
  });

  it("keeps the earliest-starting records that fit the source-text ceiling, and every subset fits too", () => {
    const ceiling = textFor(records.slice(0, 12)).length;
    const { kept, dropped } = limitFeedRecords(records, startOf, textFor, { records: 1000, chars: ceiling });
    expect(kept).toHaveLength(12);
    expect(dropped).toBe(28);
    expect(textFor(kept).length).toBeLessThanOrEqual(ceiling);
    expect(textFor(kept.slice(5)).length).toBeLessThanOrEqual(ceiling);
  });

  it("keeps a record with no known start last", () => {
    const stray = record("calendar_feed:event:zzz-unknown", "delete");
    const { kept } = limitFeedRecords([stray, ...records], startOf, textFor, { records: 5, chars: 1_000_000 });
    expect(kept.map((r) => r.importKey)).not.toContain(stray.importKey);
  });
});

describe("applyFeedDemotions", () => {
  it("replaces a demoted record with its plain create and drops one the re-diff no longer has", () => {
    const keep = record("calendar_feed:event:k", "update");
    const demoted = record("calendar_feed:event:d", "link", { matchedEntityId: "c1" });
    const lost = record("calendar_feed:event:l", "link", { matchedEntityId: "c1" });
    const plain = record("calendar_feed:event:d", "create");
    const out = applyFeedDemotions(
      [keep, demoted, lost],
      new Set(["calendar_feed:event:d", "calendar_feed:event:l"]),
      new Map([[plain.importKey, plain]])
    );
    expect(out).toEqual([keep, plain]);
  });
});

describe("feedCommitmentCollisions", () => {
  it("lets the first link win a commitment and demotes the other links", () => {
    const records = [
      record("calendar_feed:event:a", "link", { matchedEntityId: "c1" }),
      record("calendar_feed:event:b", "link", { matchedEntityId: "c1" }),
      record("calendar_feed:event:c", "link", { matchedEntityId: "c2" })
    ];
    expect([...feedCommitmentCollisions(records)]).toEqual(["calendar_feed:event:b"]);
  });

  it("gives a commitment to a link before a possible match, and to one possible match only", () => {
    const possible = (key: string, id: string) =>
      record(key, "conflict", { relationships: { sourceMatchKind: "possible", sourceMatchCommitmentId: id } });
    const records = [
      possible("calendar_feed:event:p1", "c1"),
      record("calendar_feed:event:l1", "link", { matchedEntityId: "c1" }),
      possible("calendar_feed:event:p2", "c2"),
      possible("calendar_feed:event:p3", "c2")
    ];
    expect([...feedCommitmentCollisions(records)].sort()).toEqual(["calendar_feed:event:p1", "calendar_feed:event:p3"]);
  });

  it("leaves an ordinary conflict and creates alone", () => {
    const records = [
      record("calendar_feed:event:u", "conflict", { matchedEntityId: "c1" }),
      record("calendar_feed:event:v", "create")
    ];
    expect(feedCommitmentCollisions(records).size).toBe(0);
  });
});

describe("the feed profile and the batch schema", () => {
  it("is the fixed_blocks profile keyed by the feed's own id, with no series grouping", () => {
    const profile = fixedBlocksProfileFor("calendar_feed", "Calendar feed");
    const e = event("solo");
    expect(profile.eventKey(e)).toBe("solo");
    expect(profile.seriesKey(e)).toBeNull();
    expect(profile.groupSeries).toBeUndefined();
    expect(profile.removal?.missingNeedsCompleteRead).toBe(true);
  });

  it("builds import keys that importRecordSchema accepts at the longest id", () => {
    const longest = "u".repeat(80) + "#20261110";
    expect(() =>
      importRecordSchema.parse({
        ...record(`${FEED_EVENT_PREFIX}${longest}`, "create"),
        fields: {}
      })
    ).not.toThrow();
  });
});
