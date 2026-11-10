import { describe, expect, it } from "vitest";
import type { GoogleCalendarEvent } from "@openrhen/contracts";
import { validateImportRecords } from "@/features/imports/import-validation";
import { calendarDiffRecords, profileFor, type CalendarDiffInput, type CalendarLinkRow } from "../calendar-diff";
import {
  googleCalendarDismissals,
  googleCalendarSourceText,
  googleEventKey,
  googleSeriesDismissalId,
  type GoogleCalendarSource
} from "./calendar";
import { toCalendarEvent } from "./calendar-event-fixtures";

const CAL = "jon@example.com";

function event(overrides: Partial<GoogleCalendarEvent> & { externalEventId: string }): GoogleCalendarEvent {
  return {
    calendarId: CAL,
    title: "Dentist",
    description: null,
    startsAt: "2026-10-10T09:00:00.000Z",
    endsAt: "2026-10-10T10:00:00.000Z",
    allDay: false,
    timezone: "Australia/Sydney",
    location: "Campus",
    status: "confirmed",
    seriesId: null,
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...overrides
  };
}

function link(e: GoogleCalendarEvent, overrides: Partial<CalendarLinkRow> = {}): CalendarLinkRow {
  return {
    frame_id: e.calendarId,
    external_event_id: e.externalEventId,
    commitment_id: `commitment-${e.externalEventId}`,
    version: 3,
    last_remote_snapshot: e,
    title: e.title,
    starts_at: new Date(e.startsAt),
    ends_at: new Date(e.endsAt),
    status: "confirmed",
    location: e.location,
    setup_before_minutes: 0,
    transition_after_minutes: 0,
    ...overrides
  };
}

const base: Omit<CalendarDiffInput, "events" | "links"> = {
  timezone: "Australia/Sydney",
  timeMin: "2026-10-01T00:00:00.000Z",
  timeMax: "2026-12-30T00:00:00.000Z",
  calendarNames: { [CAL]: "Jon" },
  importedSeriesKeys: new Set(),
  dismissals: [],
  locations: [{ id: "campus", name: "Campus", setup_before_minutes: 15, transition_after_minutes: 10 }],
  presetSteps: [],
  presetDependencies: [],
  defaults: { default_setup_buffer_minutes: 5, default_transition_buffer_minutes: 5 }
};

const sourceText = (
  args: Omit<Parameters<typeof googleCalendarSourceText>[0], "events"> & { events: GoogleCalendarEvent[] }
) => googleCalendarSourceText({ ...args, events: args.events.map(toCalendarEvent) });

const diff = (events: GoogleCalendarEvent[], links: CalendarLinkRow[] = [], extra: Partial<CalendarDiffInput> = {}) =>
  calendarDiffRecords({ ...base, events: events.map(toCalendarEvent), links, ...extra }, profileFor("google_calendar"));

describe("googleCalendarDiffRecords", () => {
  it("proposes an unlinked event as a create, with the saved place's buffers applied", () => {
    const records = diff([event({ externalEventId: "e1" })]);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      importKey: "google_calendar:event:jon@example.com:e1",
      operation: "create",
      removed: false,
      expectedVersion: null,
      matchedEntityId: null
    });
    expect(records[0]!.fields.title).toMatchObject({ value: "Dentist" });
    expect(records[0]!.fields.startsAt!.value).toBe("2026-10-10T09:00:00.000Z");
    expect(records[0]!.fields.locationId).toMatchObject({ value: "campus", confidence: "high" });
    expect(records[0]!.fields.setupBeforeMinutes).toMatchObject({ value: 15 });
    expect(records[0]!.fields.title!.evidence[0]).toBe("Google Calendar · Jon");
    expect(validateImportRecords(records).every((record) => record.errors.length === 0)).toBe(true);
  });

  it("normalises an offset instant so it compares and stores as UTC", () => {
    const [record] = diff([
      event({
        externalEventId: "e1",
        startsAt: "2026-10-10T19:00:00.000+10:00",
        endsAt: "2026-10-10T20:00:00.000+10:00"
      })
    ]);
    expect(record!.fields.startsAt!.value).toBe("2026-10-10T09:00:00.000Z");
  });

  it("skips an event carrying a OpenRhen round-trip marker, but not one that merely mentions the word", () => {
    expect(diff([event({ externalEventId: "e1", description: "Shift cover\nOpenRhen:7c1f-22" })])).toEqual([]);
    expect(diff([event({ externalEventId: "e2", description: "OpenRhen: sort out the dentist" })])).toHaveLength(1);
    expect(diff([event({ externalEventId: "e3", description: "OpenRhen:" })])).toHaveLength(1);
  });

  it("proposes an update only when the remote value changed since the link's last snapshot", () => {
    const prior = event({ externalEventId: "e1" });
    // OpenRhen changed the title locally; Google is unchanged since the snapshot: nothing to propose.
    expect(diff([prior], [link(prior, { title: "Renamed here" })])).toEqual([]);
    // Google changed only the description, which is not a commitment field: nothing to propose.
    expect(diff([{ ...prior, description: "new notes" }], [link(prior)])).toEqual([]);
    // Google changed the location: proposed, and the title kept from OpenRhen.
    const [record] = diff([{ ...prior, location: "Elsewhere" }], [link(prior, { title: "Renamed here" })]);
    expect(record).toMatchObject({ operation: "update" });
    expect(record!.fields.title).toMatchObject({ value: "Renamed here" });
    expect(record!.fields.location).toMatchObject({ value: "Elsewhere" });
  });

  it("skips a cancelled event that was never linked", () => {
    expect(diff([event({ externalEventId: "e1", status: "cancelled" })])).toEqual([]);
  });

  it("proposes nothing when a linked event is unchanged, even when Google writes the instant with an offset", () => {
    const e = event({ externalEventId: "e1" });
    const offset = { ...e, startsAt: "2026-10-10T19:00:00.000+10:00", endsAt: "2026-10-10T20:00:00.000+10:00" };
    expect(diff([offset], [link(e)])).toEqual([]);
  });

  it("proposes an update when Google moved a linked event and OpenRhen did not", () => {
    const prior = event({ externalEventId: "e1" });
    const moved = event({
      externalEventId: "e1",
      startsAt: "2026-10-10T11:00:00.000Z",
      endsAt: "2026-10-10T12:00:00.000Z",
      title: "Dentist (moved)"
    });
    const [record] = diff([moved], [link(prior)]);
    expect(record).toMatchObject({
      operation: "update",
      matchedEntityId: "commitment-e1",
      expectedVersion: 3,
      importKey: "google_calendar:event:jon@example.com:e1",
      errors: []
    });
    expect(record!.fields.title).toMatchObject({ value: "Dentist (moved)" });
    expect(record!.fields.startsAt).toMatchObject({ value: "2026-10-10T11:00:00.000Z" });
    expect(record!.fields.location).toMatchObject({ value: "Campus" });
    expect(record!.fields.status).toMatchObject({ value: "confirmed" });
    expect(record!.fields.title!.evidence[0]).toContain("Updated in Google Calendar");
  });

  it("proposes a conflict when a field changed on both sides since the last snapshot", () => {
    const prior = event({ externalEventId: "e1" });
    const remote = event({ externalEventId: "e1", title: "Dentist at 10" });
    const [record] = diff([remote], [link(prior, { title: "Dentist (renamed here)" })]);
    expect(record).toMatchObject({ operation: "conflict", relationships: { googleConflictFields: "title" } });
    expect(record!.relationships["googleRemote:title"]).toBe(JSON.stringify("Dentist at 10"));
    expect(record!.fields.title).toMatchObject({ value: "Dentist (renamed here)" });
    expect(record!.errors[0]).toContain("title changed in both Google Calendar and OpenRhen");
  });

  it("does not call it a conflict when both sides made the same change", () => {
    const prior = event({ externalEventId: "e1" });
    const remote = event({ externalEventId: "e1", title: "Same" });
    const [record] = diff([remote], [link(prior, { title: "Same" })]);
    expect(record!.operation).toBe("update");
  });

  it("proposes a delete when a linked event was cancelled, even outside the window", () => {
    const prior = event({
      externalEventId: "e1",
      startsAt: "2026-01-01T09:00:00.000Z",
      endsAt: "2026-01-01T10:00:00.000Z"
    });
    const [record] = diff([{ ...prior, status: "cancelled" }], [link(prior)]);
    expect(record).toMatchObject({ operation: "delete", matchedEntityId: "commitment-e1", expectedVersion: 3 });
    expect(record!.fields.title!.evidence[0]).toBe("Cancelled in Google Calendar");
    expect(record!.relationships).toEqual({ remoteCancelled: "true" });
  });

  it("proposes a delete when a linked event has gone missing inside the window", () => {
    const prior = event({ externalEventId: "e1" });
    const [record] = diff([], [link(prior)]);
    expect(record).toMatchObject({ operation: "delete", matchedEntityId: "commitment-e1" });
    // Missing is not cancelled: nothing marks it safe to apply on its own.
    expect(record!.relationships.remoteCancelled).toBeUndefined();
  });

  it("does not ask again about a plain delete the owner declined while the link still describes that event", () => {
    const prior = event({ externalEventId: "e1" });
    const dismissals = [
      { external_event_id: "delete:jon@example.com:e1", title: prior.title, starts_at: new Date(prior.startsAt) }
    ];
    expect(diff([], [link(prior)], { dismissals })).toEqual([]);
    // A real cancellation after a declined missing-event delete is still a delete.
    expect(diff([{ ...prior, status: "cancelled" }], [link(prior)], { dismissals })[0]).toMatchObject({
      operation: "delete",
      relationships: { remoteCancelled: "true" }
    });
    // A decline about a different version of the event does not silence this one.
    const stale = [{ ...dismissals[0]!, title: "Something else" }];
    expect(diff([], [link(prior)], { dismissals: stale })[0]!.operation).toBe("delete");
    // A delete held because the commitment was edited here is still asked: keeping it drops the link.
    expect(diff([], [link(prior, { title: "Mine now" })], { dismissals })[0]!.operation).toBe("conflict");
  });

  it("proposes a conflict, not a delete, when the commitment was edited here since the link's snapshot", () => {
    const prior = event({ externalEventId: "e1" });
    const [cancelled] = diff([{ ...prior, status: "cancelled" }], [link(prior, { title: "Retitled by Jon" })]);
    expect(cancelled).toMatchObject({
      operation: "conflict",
      relationships: { remoteCancelled: "true", remoteCancelEdited: "title" }
    });
    expect(cancelled!.errors[0]).toContain("Cancelled in Google Calendar, but title changed in OpenRhen since");
    const [missing] = diff([], [link(prior, { location: "Elsewhere" })]);
    expect(missing).toMatchObject({ operation: "conflict" });
    expect(missing!.errors[0]).toContain("location changed in OpenRhen since");
    // A moved-on-Google-only commitment is still a plain delete.
    expect(diff([{ ...prior, status: "cancelled" }], [link(prior)])[0]!.operation).toBe("delete");
  });

  it("leaves a linked event alone when it is missing because it sits outside the window", () => {
    const before = event({
      externalEventId: "old",
      startsAt: "2026-09-01T09:00:00.000Z",
      endsAt: "2026-09-01T10:00:00.000Z"
    });
    const after = event({
      externalEventId: "far",
      startsAt: "2027-03-01T09:00:00.000Z",
      endsAt: "2027-03-01T10:00:00.000Z"
    });
    expect(diff([], [link(before), link(after)])).toEqual([]);
  });

  it("keeps events on different calendars apart even when their ids match", () => {
    const a = event({ externalEventId: "same", calendarId: "a@example.com" });
    const b = event({ externalEventId: "same", calendarId: "b@example.com", title: "Other" });
    const records = diff([a, b], [link(a)], { calendarNames: {} });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ operation: "create", importKey: "google_calendar:event:b@example.com:same" });
  });

  it("shortens a very long key so it fits an import key", () => {
    const long = "x".repeat(200);
    const [record] = diff([event({ externalEventId: long })]);
    expect(record!.importKey.length).toBeLessThanOrEqual(120);
    expect(record!.importKey).toBe(`google_calendar:event:${googleEventKey(CAL, long)}`);
  });

  describe("series", () => {
    const weekly = (id: string, day: number, overrides: Partial<GoogleCalendarEvent> = {}) =>
      event({
        externalEventId: `${id}_${day}`,
        seriesId: id,
        title: "Standup",
        startsAt: `2026-10-${String(day).padStart(2, "0")}T09:00:00.000Z`,
        endsAt: `2026-10-${String(day).padStart(2, "0")}T09:30:00.000Z`,
        ...overrides
      });

    it("groups a uniformly repeating series into one recurring create", () => {
      const records = diff([weekly("s1", 5), weekly("s1", 12), weekly("s1", 19)]);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        entityType: "fixed_commitment_recurrence",
        operation: "create",
        importKey: "google_calendar:series:jon@example.com:s1",
        removed: false
      });
      expect(records[0]!.fields.intervalDays).toMatchObject({ value: 7 });
      expect(records[0]!.fields.title!.evidence[0]).toContain("3 occurrences seen");
    });

    it("imports a weekday-set series as a weeks rule that passes validation", () => {
      const onDay = (day: number) =>
        weekly("s3", day, { title: "Class", endsAt: `2026-10-${String(day).padStart(2, "0")}T10:00:00.000Z` });
      const records = diff([6, 8, 13, 15, 20, 22].map(onDay));
      expect(records).toHaveLength(1);
      const fields = records[0]!.fields;
      expect(fields.intervalUnit).toMatchObject({ value: "weeks" });
      expect(fields.intervalWeeks).toMatchObject({ value: 1 });
      expect(fields.weekdays).toMatchObject({ value: [2, 4] });
      expect(fields.intervalDays).toBeUndefined();
      expect(fields.title!.evidence[0]).toContain("6 occurrences seen, every week on Tue, Thu");
      expect(validateImportRecords(records).every((record) => record.errors.length === 0)).toBe(true);
    });

    it("falls back to one create per occurrence when the series is irregular", () => {
      const records = diff([weekly("s1", 5), weekly("s1", 12), weekly("s1", 21)]);
      expect(records).toHaveLength(3);
      expect(records.every((record) => record.entityType === "fixed_commitment")).toBe(true);
    });

    it("does not propose a series again once it was imported as a recurrence rule", () => {
      const records = diff([weekly("s1", 5), weekly("s1", 12)], [], {
        importedSeriesKeys: new Set(["google_calendar:series:jon@example.com:s1"])
      });
      expect(records).toEqual([]);
    });

    it("does not propose a series again when its series dismissal still matches by title", () => {
      const dismissals = [
        {
          external_event_id: googleSeriesDismissalId(CAL, "s1"),
          title: "Standup",
          starts_at: new Date("2026-10-05T09:00:00.000Z")
        }
      ];
      // A later occurrence rolls into the window: the first occurrence moved, the title did not.
      expect(diff([weekly("s1", 12), weekly("s1", 19)], [], { dismissals })).toEqual([]);
      // Renamed: it is proposed again.
      expect(
        diff([weekly("s1", 12, { title: "Standup v2" }), weekly("s1", 19, { title: "Standup v2" })], [], { dismissals })
      ).toHaveLength(1);
    });
  });

  describe("all-day events", () => {
    const allDay = (id: string, day: number, overrides: Partial<GoogleCalendarEvent> = {}) =>
      event({
        externalEventId: id,
        title: "Holiday",
        allDay: true,
        startsAt: `2026-10-${String(day).padStart(2, "0")}T00:00:00.000+11:00`,
        endsAt: `2026-10-${String(day + 1).padStart(2, "0")}T00:00:00.000+11:00`,
        location: null,
        ...overrides
      });

    it("proposes them but leaves them unselected", () => {
      const [record] = diff([allDay("a1", 12)]);
      expect(record).toMatchObject({ operation: "create", removed: true });
      expect(record!.fields.title!.evidence[0]).toContain("all-day");
    });

    it("leaves an all-day series unselected too, and a timed event selected beside it", () => {
      const records = diff([
        allDay("a1", 5, { seriesId: "s2" }),
        allDay("a2", 12, { seriesId: "s2" }),
        event({ externalEventId: "t1" })
      ]);
      const series = records.find((record) => record.entityType === "fixed_commitment_recurrence");
      const timed = records.find((record) => record.importKey.endsWith(":t1"));
      expect(series?.removed).toBe(true);
      expect(timed?.removed).toBe(false);
    });

    it("does not deselect an update to an already-linked all-day event", () => {
      const prior = allDay("a1", 12);
      const [record] = diff([{ ...prior, title: "Public holiday" }], [link(prior)]);
      expect(record).toMatchObject({ operation: "update", removed: false });
    });
  });

  describe("dismissed events", () => {
    const e = event({ externalEventId: "e1" });
    const dismissal = {
      external_event_id: googleEventKey(CAL, "e1"),
      title: "Dentist",
      starts_at: new Date("2026-10-10T09:00:00.000Z")
    };

    it("is not proposed again while its title and start are unchanged", () => {
      expect(diff([e], [], { dismissals: [dismissal] })).toEqual([]);
      // The same instant written with an offset is still the same start.
      expect(diff([{ ...e, startsAt: "2026-10-10T19:00:00.000+10:00" }], [], { dismissals: [dismissal] })).toEqual([]);
    });

    it("comes back when the title changes", () => {
      expect(diff([{ ...e, title: "Dentist (new time)" }], [], { dismissals: [dismissal] })).toHaveLength(1);
    });

    it("comes back when the start changes", () => {
      expect(
        diff([{ ...e, startsAt: "2026-10-11T09:00:00.000Z", endsAt: "2026-10-11T10:00:00.000Z" }], [], {
          dismissals: [dismissal]
        })
      ).toHaveLength(1);
    });

    it("only hides the event that was dismissed", () => {
      const other = event({ externalEventId: "e2" });
      expect(diff([e, other], [], { dismissals: [dismissal] }).map((record) => record.importKey)).toEqual([
        "google_calendar:event:jon@example.com:e2"
      ]);
    });

    it("never hides an update or delete to an already-linked event", () => {
      const moved = { ...e, title: "Dentist (moved)" };
      expect(diff([moved], [link(e)], { dismissals: [dismissal] })).toHaveLength(1);
    });
  });
});

describe("googleCalendarDismissals", () => {
  const first = event({
    externalEventId: "s1_5",
    seriesId: "s1",
    title: "Standup",
    startsAt: "2026-10-05T09:00:00.000Z"
  });
  const second = event({
    externalEventId: "s1_12",
    seriesId: "s1",
    title: "Standup",
    startsAt: "2026-10-12T09:00:00.000Z"
  });
  const single = event({ externalEventId: "e1" });
  const events = [first, second, single];
  const records = diff(events);
  const source = JSON.parse(sourceText({ events, calendarNames: { [CAL]: "Jon" }, records })) as GoogleCalendarSource;

  it("remembers only what was left unselected on a commit", () => {
    const withRemoved = records.map((record) => ({ ...record, removed: record.importKey.endsWith(":e1") }));
    expect(googleCalendarDismissals(withRemoved, source, "deselected")).toEqual([
      { externalEventId: googleEventKey(CAL, "e1"), title: "Dentist", startsAt: "2026-10-10T09:00:00.000Z" }
    ]);
  });

  it("remembers a deselected series by its series key, with its first occurrence's title", () => {
    const withRemoved = records.map((record) => ({
      ...record,
      removed: record.entityType === "fixed_commitment_recurrence"
    }));
    expect(googleCalendarDismissals(withRemoved, source, "deselected")).toEqual([
      { externalEventId: googleSeriesDismissalId(CAL, "s1"), title: "Standup", startsAt: "2026-10-05T09:00:00.000Z" }
    ]);
  });

  it("remembers every create on a discard, selected or not", () => {
    expect(
      googleCalendarDismissals(records, source, "all")
        .map((row) => row.externalEventId)
        .sort()
    ).toEqual([googleEventKey(CAL, "e1"), googleSeriesDismissalId(CAL, "s1")].sort());
  });

  it("ignores updates and deletes", () => {
    const linked = diff([{ ...single, title: "Changed" }], [link(single)]);
    const linkedSource = JSON.parse(
      sourceText({ events: [{ ...single, title: "Changed" }], calendarNames: {}, records: linked })
    ) as GoogleCalendarSource;
    expect(googleCalendarDismissals(linked, linkedSource, "all")).toEqual([]);
  });
});

describe("googleCalendarSourceText", () => {
  it("is the same text for the same records and events, whatever order they arrive in", () => {
    const a = event({ externalEventId: "a" });
    const b = event({ externalEventId: "b" });
    const recordsAB = diff([a, b]);
    const recordsBA = diff([b, a]);
    expect(sourceText({ events: [a, b], calendarNames: { [CAL]: "Jon" }, records: recordsAB })).toBe(
      sourceText({ events: [b, a], calendarNames: { [CAL]: "Jon" }, records: recordsBA })
    );
  });

  it("changes when an event it carries changes", () => {
    const a = event({ externalEventId: "a" });
    const changed = { ...a, updatedAt: "2026-10-02T00:00:00.000Z" };
    expect(sourceText({ events: [a], calendarNames: {}, records: diff([a]) })).not.toBe(
      sourceText({ events: [changed], calendarNames: {}, records: diff([changed]) })
    );
  });

  it("carries only the events its records read from", () => {
    const a = event({ externalEventId: "a" });
    const unrelated = event({ externalEventId: "z" });
    const text = sourceText({ events: [a, unrelated], calendarNames: {}, records: diff([a]) });
    expect(Object.keys((JSON.parse(text) as GoogleCalendarSource).events)).toEqual(["jon@example.com:a"]);
  });
});
