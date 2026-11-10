import { createHash } from "node:crypto";
import type { CalendarEvent, GoogleCalendarEvent, ImportRecord } from "@openrhen/contracts";
import { groupCalendarSeries, type CalendarSeriesGroup } from "@/features/imports/calendar-series";
import { hasOpenRhenMarker } from "@/server/imports/publish-marker";
import type { Sql } from "@/server/persistence/postgres/sql-pool";
import type {
  CalendarCreateContext,
  CalendarDiffProfile,
  CalendarDismissalRow,
  CalendarSource,
  RemoteViewInput
} from "@/server/persistence/postgres/imports/calendar-diff";
import {
  importField,
  linkCalendarEventCommitment,
  savedPlaceMatching,
  type CalendarDismissalInsert
} from "@/server/persistence/postgres/imports/calendar-diff-core";
import { isProposal, primaryOwnedFields } from "@/server/persistence/postgres/imports/source-match-records";

/**
 * The `calendar` diff profile: a read-only calendar that OpenRhen only reads from (Google Calendar).
 * Its event keys, stored snapshot and remote hash keep the formats `calendar_event_links` already holds
 * so every linked event compares as unchanged after the move
 * from the Google-only diff. Events arrive normalised as `CalendarEvent`; what a link and a batch store
 * is still the Google event shape, so those bytes do not move.
 */

export const GOOGLE_CALENDAR_PROVIDER = "google_calendar";

/** The fields a Google event can change on a commitment; the buffers and status stay OpenRhen'. */
const remoteFields = ["title", "startsAt", "endsAt", "location"] as const;
type RemoteField = (typeof remoteFields)[number];

/** A key short enough for an import key (120 characters at most), stable for the same text. */
function shortKey(text: string): string {
  return text.length <= 80 ? text : `~${createHash("sha256").update(text).digest("hex").slice(0, 32)}`;
}

/** What identifies one event across calendars: the same event id can sit on several calendars. */
export function googleEventKey(calendarId: string, externalEventId: string): string {
  return shortKey(`${calendarId}:${externalEventId}`);
}

export function googleSeriesKey(calendarId: string, seriesId: string): string {
  return shortKey(`${calendarId}:${seriesId}`);
}

/** The `externalEventId` a series-level dismissal is stored under; compared by title only. */
export function googleSeriesDismissalId(calendarId: string, seriesId: string): string {
  return `series:${googleSeriesKey(calendarId, seriesId)}`;
}

/** A Google event always names its calendar; the normalised shape allows a source with no frame. */
function calendarIdOf(event: Pick<CalendarEvent, "calendarId">): string {
  return event.calendarId ?? "";
}

function eventKeyOf(event: CalendarEvent): string {
  return googleEventKey(calendarIdOf(event), event.externalEventId);
}

/** The event as Google's own schema has it, which is what links and batch sources have always stored. */
function googleShape(event: CalendarEvent): GoogleCalendarEvent {
  return {
    externalEventId: event.externalEventId,
    calendarId: calendarIdOf(event),
    title: event.title,
    description: event.description,
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    allDay: event.allDay,
    timezone: event.timezone ?? "",
    location: event.location,
    status: event.status,
    seriesId: event.seriesId,
    updatedAt: event.updatedAt ?? ""
  };
}

function instant(value: string | null | undefined): string | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

/** The commitment-shaped view of a Google event, instants normalised to UTC so they compare. */
function remoteSnapshot(event: Pick<GoogleCalendarEvent, RemoteField>): Record<RemoteField, string | null> {
  return {
    title: event.title,
    startsAt: instant(event.startsAt),
    endsAt: instant(event.endsAt),
    location: event.location ?? null
  };
}

function remoteHash(event: CalendarEvent) {
  return JSON.stringify([...remoteFields.map((name) => remoteSnapshot(event)[name]), event.allDay, event.status]);
}

/** The full normalised event, as the next diff's "last seen" side. */
function storedSnapshot(event: CalendarEvent): GoogleCalendarEvent {
  const shaped = googleShape(event);
  return {
    ...shaped,
    startsAt: instant(event.startsAt) ?? event.startsAt,
    endsAt: instant(event.endsAt) ?? event.endsAt
  };
}

/** Whether a person already rejected this event and nothing about it has changed since. */
function isDismissed(event: CalendarEvent, dismissals: Map<string, CalendarDismissalRow>): boolean {
  if (event.seriesId) {
    const series = dismissals.get(googleSeriesDismissalId(calendarIdOf(event), event.seriesId));
    if (series && series.title === event.title) return true;
  }
  const own = dismissals.get(eventKeyOf(event));
  return Boolean(own && own.title === event.title && instant(event.startsAt) === own.starts_at.toISOString());
}

function createFields(event: CalendarEvent, context: CalendarCreateContext): ImportRecord["fields"] {
  const evidence = [`Google Calendar · ${context.calendarName}${event.allDay ? " · all-day" : ""}`];
  const snapshot = remoteSnapshot(event);
  return {
    title: importField(snapshot.title, evidence),
    startsAt: importField(snapshot.startsAt, evidence),
    endsAt: importField(snapshot.endsAt, evidence),
    status: importField("confirmed", evidence),
    location: importField(snapshot.location, evidence),
    setupBeforeMinutes: importField(0, evidence),
    transitionAfterMinutes: importField(0, evidence)
  };
}

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function seriesCreateFields(
  group: CalendarSeriesGroup<CalendarEvent>,
  context: CalendarCreateContext
): ImportRecord["fields"] {
  const { repeat } = group;
  const spacing =
    repeat.unit === "weeks"
      ? `every ${repeat.intervalWeeks === 1 ? "week" : `${repeat.intervalWeeks} weeks`} on ${repeat.weekdays.map((day) => WEEKDAY_NAMES[day]).join(", ")}`
      : `every ${group.intervalDays} day${group.intervalDays === 1 ? "" : "s"}`;
  const evidence = [`Google Calendar · ${context.calendarName} · ${group.events.length} occurrences seen, ${spacing}`];
  // A weekday-set series is a weeks rule: it carries its unit, interval and weekdays, never a days interval.
  const repeatFields: ImportRecord["fields"] =
    repeat.unit === "weeks"
      ? {
          intervalUnit: importField("weeks", evidence),
          intervalWeeks: importField(repeat.intervalWeeks, evidence),
          weekdays: importField(repeat.weekdays, evidence)
        }
      : { intervalDays: importField(group.intervalDays, evidence) };
  return {
    title: importField(group.title, evidence),
    timezone: importField(context.timezone, evidence),
    startDate: importField(group.startDate, evidence),
    endDate: importField(null, evidence),
    ...repeatFields,
    localStartTime: importField(group.localStartTime, evidence),
    localEndTime: importField(group.localEndTime, evidence),
    location: importField(group.location, evidence),
    setupBeforeMinutes: importField(0, evidence),
    transitionAfterMinutes: importField(0, evidence)
  };
}

/**
 * The dismissals a batch's create records call for, from its stored source text. A single event is
 * remembered by its own key with the title and start it had; a series by its series key with the title
 * of its first occurrence (compared by title only, since its first occurrence moves as the window rolls).
 * `mode: "deselected"` is a commit, where only the records the person left unselected were rejected;
 * `mode: "all"` is a discard, where every create was.
 */
export function googleCalendarDismissals(
  records: Pick<ImportRecord, "importKey" | "operation" | "removed" | "entityType" | "relationships">[],
  source: CalendarSource,
  mode: "deselected" | "all"
): CalendarDismissalInsert[] {
  const events = Object.entries(source.events);
  const out: CalendarDismissalInsert[] = [];
  for (const record of records) {
    // A create, or a match to an existing commitment (link, or a possible match held as a conflict) that
    // was declined: either way the event is not proposed again until it changes.
    if (!isProposal(record) || (mode === "deselected" && !record.removed)) continue;
    if (record.entityType === "fixed_commitment" && record.importKey.startsWith("google_calendar:event:")) {
      const key = record.importKey.slice("google_calendar:event:".length);
      const event = source.events[key];
      if (event) out.push({ externalEventId: key, title: event.title, startsAt: event.startsAt });
    }
    if (record.entityType === "fixed_commitment_recurrence" && record.importKey.startsWith("google_calendar:series:")) {
      const key = record.importKey.slice("google_calendar:series:".length);
      const occurrences = events
        .map(([, event]) => event)
        .filter((event) => event.seriesId && googleSeriesKey(event.calendarId ?? "", event.seriesId) === key)
        .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
      const first = occurrences[0];
      if (first) out.push({ externalEventId: `series:${key}`, title: first.title, startsAt: first.startsAt });
    }
  }
  return out;
}

export const calendarProfile: CalendarDiffProfile = {
  provider: GOOGLE_CALENDAR_PROVIDER,
  sourceLabel: "Google Calendar",
  relationshipPrefix: "google",
  missingWhy: "No longer on this Google calendar for this date range",
  remoteFields,
  allDayStartsUnselected: true,
  frameOf: calendarIdOf,
  eventKey: eventKeyOf,
  linkKey: googleEventKey,
  seriesKey: (event) => (event.seriesId ? googleSeriesKey(calendarIdOf(event), event.seriesId) : null),
  remoteView: remoteSnapshot,
  priorView: (snapshot) => {
    const raw = (snapshot ?? {}) as Partial<RemoteViewInput>;
    return remoteSnapshot({
      title: raw.title ?? "",
      startsAt: raw.startsAt ?? "",
      endsAt: raw.endsAt ?? "",
      location: raw.location ?? null
    });
  },
  storedSnapshot,
  remoteHash,
  createFields,
  groupSeries: {
    group: (events, timezone) =>
      groupCalendarSeries(
        events.map((event) => ({ ...event, recurring: event.seriesId !== null })),
        timezone
      ),
    createFields: seriesCreateFields
  },
  isRemoved: (event) => event.status === "cancelled",
  isEcho: (event) => hasOpenRhenMarker(event.description),
  dismissals: { isDismissed, inserts: googleCalendarDismissals },
  ownedFields: primaryOwnedFields,
  locationMatching: savedPlaceMatching
};

/** The events an import record set reads from: each record's own event, or every member of its series. */
export function googleCalendarSourceEvents(
  records: Pick<ImportRecord, "importKey">[],
  events: CalendarEvent[]
): CalendarEvent[] {
  const eventKeys = new Set<string>();
  const seriesKeys = new Set<string>();
  for (const record of records) {
    if (record.importKey.startsWith("google_calendar:event:"))
      eventKeys.add(record.importKey.slice("google_calendar:event:".length));
    if (record.importKey.startsWith("google_calendar:series:"))
      seriesKeys.add(record.importKey.slice("google_calendar:series:".length));
  }
  return events.filter(
    (event) =>
      eventKeys.has(eventKeyOf(event)) ||
      Boolean(event.seriesId && seriesKeys.has(googleSeriesKey(calendarIdOf(event), event.seriesId)))
  );
}

/**
 * The source text a Google batch keeps, so commit can link each written commitment back to its event.
 * Deterministic for the same records and events (keys sorted, no clock, no window), so the sync can tell
 * that a fresh diff would hold exactly what an open review batch already holds and leave that batch, and
 * whatever the person has already ticked in it, alone. `heldKeys` covers records with no event to carry,
 * such as a delete held for review.
 */
export function googleCalendarSourceText(args: {
  events: CalendarEvent[];
  calendarNames: Record<string, string>;
  records: Pick<ImportRecord, "importKey" | "operation">[];
}): string {
  const events = googleCalendarSourceEvents(args.records, args.events).sort((a, b) =>
    eventKeyOf(a).localeCompare(eventKeyOf(b))
  );
  const usedCalendars = new Set(events.map((event) => calendarIdOf(event)));
  return JSON.stringify({
    provider: GOOGLE_CALENDAR_PROVIDER,
    calendarNames: Object.fromEntries(
      Object.entries(args.calendarNames)
        .filter(([id]) => usedCalendars.has(id))
        .sort(([a], [b]) => a.localeCompare(b))
    ),
    heldKeys: args.records.map((record) => `${record.importKey}:${record.operation}`).sort(),
    events: Object.fromEntries(events.map((event) => [eventKeyOf(event), googleShape(event)]))
  });
}

export interface GoogleCalendarSource {
  provider: "google_calendar";
  calendarNames: Record<string, string>;
  events: Record<string, GoogleCalendarEvent>;
}

/**
 * After a Google-sourced commitment is written: records the event as a source, points the commitment
 * at it, and upserts the calendar link with the snapshot the next diff will compare to. The link's
 * `frame_id` is the Google calendar id. `event` is the stored Google-shaped event from the batch source.
 */
export async function linkGoogleCalendarCommitment(
  sql: Sql,
  userId: string,
  commitmentId: string,
  key: string,
  event: GoogleCalendarEvent,
  calendarName: string,
  /** Joining a commitment other sources already describe: its first source stays its `source_id`. */
  joining = false
) {
  const normalised: CalendarEvent = {
    ...event,
    recurring: event.seriesId !== null,
    profileLabel: null,
    attributes: {}
  };
  const snapshot = storedSnapshot(normalised);
  const hash = remoteHash(normalised);
  await linkCalendarEventCommitment(
    sql,
    userId,
    {
      commitmentId,
      provider: "google_calendar",
      role: "secondary",
      sourceType: "google_calendar_event",
      sourceExternalId: key,
      linkExternalId: event.externalEventId,
      frameId: event.calendarId,
      profileLabel: calendarName,
      sourceCalendarId: event.calendarId,
      capturedText: JSON.stringify(snapshot),
      snapshot,
      hash,
      title: event.title,
      occurredAt: new Date(event.startsAt)
    },
    joining
  );
}
