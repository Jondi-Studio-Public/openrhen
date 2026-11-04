import { describe, expect, it } from "vitest";
import type { GoogleCalendarEvent } from "@openrhen/contracts";
import { calendarDiffRecords, profileFor, type CalendarDiffInput, type CalendarLinkRow } from "./calendar-diff";
import { toCalendarEvent } from "./calendar-profiles/google-event-fixtures";

/**
 * What the diff does with a linked commitment the source's removal closed (archive-removals design section 7, PR 7a): an
 * event that comes back reopens a commitment the import cancelled, even when none of its fields changed; one a person
 * cancelled stays cancelled and says so; and a person's restore sticks while the source stays cancelled.
 */

const CAL = "jon@example.com";
const MARKER = "Removed at source: Cancelled in Google Calendar";

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
    id: "link-1",
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

/** A link whose commitment the import cancelled (the source's removal), the way the close helper stamps it. */
const importClosed = (e: GoogleCalendarEvent, overrides: Partial<CalendarLinkRow> = {}) =>
  link(e, {
    status: "cancelled",
    closed_by: "system",
    closed_reason: MARKER,
    closed_from_status: "tentative",
    ...overrides
  });

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

const diff = (events: GoogleCalendarEvent[], links: CalendarLinkRow[]) =>
  calendarDiffRecords({ ...base, events: events.map(toCalendarEvent), links }, profileFor("google_calendar"));

describe("an event that comes back after the source's removal was applied", () => {
  const e = event({ externalEventId: "e1" });

  it("reopens a commitment the import cancelled, with its original status, though no field changed", () => {
    const records = diff([e], [importClosed(e)]);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      operation: "update",
      matchedEntityId: "commitment-e1",
      expectedVersion: 3,
      relationships: { sourceReopen: "true", sourceLinkId: "link-1" }
    });
    expect(records[0]!.fields.status).toMatchObject({ value: "tentative" });
    expect(records[0]!.fields.status!.evidence[0]).toContain("Back in Google Calendar");
  });

  it("falls back to confirmed when the close did not record the status it came from", () => {
    const [record] = diff([e], [importClosed(e, { closed_from_status: null })]);
    expect(record!.fields.status).toMatchObject({ value: "confirmed" });
  });

  it("reopens it to the original status, not to cancelled, when a field changed too", () => {
    const [record] = diff([{ ...e, title: "Dentist at 10" }], [importClosed(e)]);
    expect(record).toMatchObject({ operation: "update", relationships: { sourceReopen: "true" } });
    expect(record!.fields.title).toMatchObject({ value: "Dentist at 10" });
    expect(record!.fields.status).toMatchObject({ value: "tentative" });
  });

  it("does not reopen a commitment a person or an agent cancelled, and says so when something else changed", () => {
    for (const closedBy of ["person", "agent:claude", "agent:claude:confirmed", null]) {
      const person = link(e, {
        status: "cancelled",
        closed_by: closedBy,
        closed_reason: "Not going",
        closed_from_status: "confirmed"
      });
      expect(diff([e], [person])).toEqual([]);
      const [changed] = diff([{ ...e, title: "Dentist at 10" }], [person]);
      expect(changed!.fields.status).toMatchObject({ value: "cancelled" });
      expect(changed!.relationships.sourceReopen).toBeUndefined();
      expect(changed!.warnings).toContain("Still cancelled by you. Restore it from Review > Closed.");
    }
  });

  it("does not take a system close without the import marker (a dropdown cancel, a doctor fix) for the source's", () => {
    for (const reason of [
      null,
      "Not going",
      "Recurrence ended",
      "removed at source: lower case",
      "Prefix Removed at source: "
    ]) {
      const other = link(e, {
        status: "cancelled",
        closed_by: "system",
        closed_reason: reason,
        closed_from_status: "confirmed"
      });
      expect(diff([e], [other])).toEqual([]);
    }
    // and the marker is only the marker when the system wrote it
    const forged = link(e, {
      status: "cancelled",
      closed_by: "person",
      closed_reason: MARKER,
      closed_from_status: "confirmed"
    });
    expect(diff([e], [forged])).toEqual([]);
  });
});

describe("a linked event that goes away again", () => {
  const e = event({ externalEventId: "e1" });
  const remembered = (overrides: Partial<CalendarLinkRow> = {}) =>
    link(e, { last_remote_snapshot: { ...e, sourceClosed: "2026-10-05T00:00:00.000Z" }, ...overrides });

  it("proposes nothing for a commitment a person restored while the source stays cancelled or missing", () => {
    expect(diff([{ ...e, status: "cancelled" }], [remembered()])).toEqual([]);
    expect(diff([], [remembered()])).toEqual([]);
  });

  it("clears the memory when the event is back, even though no field changed, so a later cancel counts again", () => {
    const records = diff([e], [remembered()]);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      operation: "update",
      relationships: { sourceClear: "true", sourceLinkId: "link-1" }
    });
    expect(records[0]!.fields.status).toMatchObject({ value: "confirmed" });
    // with the memory gone, the next cancel is a delete again
    expect(diff([{ ...e, status: "cancelled" }], [link(e)])[0]).toMatchObject({ operation: "delete" });
  });

  it("proposes nothing when the commitment is already cancelled, whoever cancelled it, so a removal is not repeated", () => {
    expect(diff([{ ...e, status: "cancelled" }], [importClosed(e)])).toEqual([]);
    expect(diff([], [importClosed(e)])).toEqual([]);
    expect(diff([{ ...e, status: "cancelled" }], [link(e, { status: "cancelled", closed_by: "person" })])).toEqual([]);
    expect(diff([], [link(e, { status: "cancelled", closed_by: "person" })])).toEqual([]);
  });

  it("names the link on the delete it proposes, so the commit can remember the removal", () => {
    expect(diff([{ ...e, status: "cancelled" }], [link(e)])[0]!.relationships).toMatchObject({
      remoteCancelled: "true",
      sourceLinkId: "link-1"
    });
    const missing = diff([], [link(e)])[0]!;
    expect(missing.relationships.sourceLinkId).toBe("link-1");
    expect(missing.relationships.remoteCancelled).toBeUndefined();
  });

  it("says the review's confirm cancels the commitment, restorably, not that it deletes it", () => {
    const [record] = diff([{ ...e, status: "cancelled" }], [link(e)]);
    expect(record!.warnings.join(" ")).toContain("cancels the commitment");
    expect(record!.warnings.join(" ")).toContain("Review > Closed");
    expect(record!.warnings.join(" ")).not.toContain("permanently");
  });
});
