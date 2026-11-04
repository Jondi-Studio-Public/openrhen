import { z } from "zod";
import { connectionIdSchema } from "../connections/connection-id.js";
import { intervalCalendarSourceIds } from "../connections/registry.js";

/**
 * Read-only Google Calendar, normalised by the outbound proxy from the Calendar API's `events.list`
 * (with `singleEvents=true`, so a recurring event arrives as one instance per occurrence carrying its
 * series id). Nothing here is ever written back to Google; see the calendar sync design note.
 */
export const googleCalendarEventSchema = z.object({
  /** The instance id Google returns; stable across edits, and distinct per occurrence of a series. */
  externalEventId: z.string().min(1),
  calendarId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().nullable(),
  /** Timed events: the instant with offset. All-day events: local midnight of the first day, in `timezone`. */
  startsAt: z.string().datetime({ offset: true }),
  /** Exclusive end, the same convention as `startsAt`. */
  endsAt: z.string().datetime({ offset: true }),
  allDay: z.boolean(),
  /** The event's own zone when Google gives one, otherwise the calendar's. */
  timezone: z.string().min(1).max(100),
  location: z.string().nullable(),
  status: z.enum(["confirmed", "tentative", "cancelled"]),
  /** `recurringEventId`: shared by every instance of one series, null for a one-off event. */
  seriesId: z.string().nullable(),
  updatedAt: z.string().datetime({ offset: true })
});

export const googleCalendarSummarySchema = z.object({
  calendarId: z.string().min(1),
  summary: z.string().min(1),
  primary: z.boolean(),
  /** `owner`, `writer`, `reader` or `freeBusyReader`, as Google reports it; holiday and subscribed calendars are `reader`. */
  accessRole: z.string().min(1),
  timezone: z.string().min(1).max(100)
});

export const googleCalendarListResponseSchema = z.object({
  calendars: z.array(googleCalendarSummarySchema)
});

export const googleCalendarEventsRequestSchema = z.object({
  calendarIds: z.array(z.string().min(1)).min(1).max(50),
  /** Inclusive lower bound, exclusive upper bound, both instants. */
  timeMin: z.string().datetime({ offset: true }),
  timeMax: z.string().datetime({ offset: true })
});

export const googleCalendarEventsResponseSchema = z.object({
  events: z.array(googleCalendarEventSchema)
});

export const googleCalendarFailureReasonSchema = z.enum([
  "not_configured",
  "invalid_grant",
  "calendar_not_found",
  "rate_limited",
  "upstream_error",
  "invalid_response",
  "network_error"
]);

export const googleCalendarProofResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("not_configured"), missing: z.array(z.string()) }),
  z.object({
    status: z.literal("connected"),
    checkedAt: z.string().datetime({ offset: true }),
    calendarCount: z.number().int().nonnegative()
  }),
  z.object({
    status: z.literal("failed"),
    checkedAt: z.string().datetime({ offset: true }),
    message: z.string(),
    reason: googleCalendarFailureReasonSchema.optional()
  })
]);

/** The calendar sources scheduled on an interval (not a daily run): the automatic sync runs for these, and it is the `provider` on their links and sync runs. */
export const calendarSyncProviderSchema = connectionIdSchema.refine((id) => intervalCalendarSourceIds().includes(id), {
  message: "not an interval-scheduled calendar source"
});

/** What one run of the calendar feed left out; only that connection reports it. */
export const calendarSyncNotImportedSchema = z.object({
  /** Repeating events the proxy could not express as a rule: not imported, by design. */
  unrepresentableSeries: z.number().int().nonnegative(),
  /** Repeating events with a rule descriptor the series pass left alone for now (a new series that already has changed dates). */
  seriesPending: z.number().int().nonnegative(),
  /**
   * Repeating entries already on the plan whose feed side has changed (a date cancelled or moved, a new end, a new
   * time, a shape the portal can no longer follow) and which the plan has not followed, or a linked one-off event whose
   * UID has become a repeating series (it stays as it is). The rule keeps materialising from its old shape until a
   * later change applies the new one.
   */
  seriesChanged: z.number().int().nonnegative().default(0),
  /** Events that could not be read. */
  unreadable: z.number().int().nonnegative(),
  /** Records past the batch ceilings, left for a later run. */
  droppedForSize: z.number().int().nonnegative()
});
export type CalendarSyncNotImported = z.infer<typeof calendarSyncNotImportedSchema>;

/**
 * The outcome of one calendar sync, the worker's hourly run or a "Sync now". Changes to events already
 * linked to a commitment commit on their own; new events and conflicts wait in the Inbox as one open
 * batch per provider (`heldForReview`), which is what the Calendars badge counts.
 */
export const calendarSyncResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("not_configured"), missing: z.array(z.string()) }),
  z.object({
    status: z.enum(["synced", "needs_review"]),
    provider: calendarSyncProviderSchema,
    syncedAt: z.string().datetime({ offset: true }),
    timeMin: z.string().datetime({ offset: true }),
    timeMax: z.string().datetime({ offset: true }),
    eventCount: z.number().int().nonnegative(),
    updated: z.number().int().nonnegative(),
    deleted: z.number().int().nonnegative(),
    heldForReview: z.number().int().nonnegative(),
    reviewBatchId: z.string().uuid().nullable(),
    committedBatchId: z.string().uuid().nullable(),
    /** Only the calendar feed sets this: what a run left out (the card that words it is a later change). */
    notImported: calendarSyncNotImportedSchema.optional()
  }),
  z.object({
    status: z.literal("failed"),
    provider: calendarSyncProviderSchema,
    syncedAt: z.string().datetime({ offset: true }),
    message: z.string(),
    reason: googleCalendarFailureReasonSchema.optional()
  }),
  /** The provider is not in `CALENDAR_SYNC_PROVIDERS`: refused before anything is read, and no run is recorded. */
  z.object({ status: z.literal("not_enabled"), provider: calendarSyncProviderSchema, message: z.string() }),
  /** Another sync of this provider holds the lock: this one did nothing and no run is recorded. */
  z.object({ status: z.literal("already_running"), provider: calendarSyncProviderSchema, message: z.string() })
]);

export type GoogleCalendarEvent = z.infer<typeof googleCalendarEventSchema>;
export type GoogleCalendarSummary = z.infer<typeof googleCalendarSummarySchema>;
export type GoogleCalendarListResponse = z.infer<typeof googleCalendarListResponseSchema>;
export type GoogleCalendarEventsRequest = z.infer<typeof googleCalendarEventsRequestSchema>;
export type GoogleCalendarEventsResponse = z.infer<typeof googleCalendarEventsResponseSchema>;
export type GoogleCalendarFailureReason = z.infer<typeof googleCalendarFailureReasonSchema>;
export type GoogleCalendarProofResult = z.infer<typeof googleCalendarProofResultSchema>;
export type CalendarSyncProvider = z.infer<typeof calendarSyncProviderSchema>;
export type CalendarSyncResult = z.infer<typeof calendarSyncResultSchema>;
