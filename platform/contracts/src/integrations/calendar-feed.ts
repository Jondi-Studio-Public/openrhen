import { z } from "zod";
import { commitmentRepeatSchema } from "../planning/commitment-repeat.js";

// What the outbound proxy's calendar feed connection answers (`integrations/outbound-proxy/src/connections/calendar-feed/`).
// The feed's events travel as the generic `CalendarEvent`; what is feed-specific is the proof, the failure reasons and the
// `extras` that tell the portal whether the read is safe to treat as complete (design v4 (g)).

/** Every reason the feed connection fails with; a subset of `connectionFailureReasonSchema` (a contract test pins it). */
export const calendarFeedFailureReasonSchema = z.enum([
  "not_configured",
  "forbidden",
  "unreachable",
  "upstream_error",
  "invalid_response"
]);

/** The proof is DNS, the address deny check and a TLS handshake. It names the host and never the URL. */
export const calendarFeedProofResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("not_configured"), missing: z.array(z.string()) }),
  z.object({
    status: z.literal("connected"),
    checkedAt: z.string().datetime({ offset: true }),
    host: z.string().min(1)
  }),
  z.object({
    status: z.literal("failed"),
    checkedAt: z.string().datetime({ offset: true }),
    message: z.string(),
    reason: calendarFeedFailureReasonSchema.optional()
  })
]);

/** One event the parser left out. `idPrefix` is the encoded UID (null when the event has none); `reason` is fixed text. */
export const calendarFeedSkippedSchema = z.object({
  idPrefix: z.string().nullable(),
  reason: z.string()
});

/**
 * `calendarReadEventsResponse.extras` for the feed. `transportComplete` is the proxy's half of `complete`: the final hop
 * answered 200, `BEGIN` and `END:VCALENDAR` were both seen and no cap, ceiling or time budget was hit. The portal ANDs it
 * with its own checks (no skipped event matches a linked id; not zero events while in-window links exist).
 */
export { CALENDAR_FEED_SERIES_BATCH_MAX_CHARS, CALENDAR_FEED_SERIES_MAX_CHARS } from "./calendar-feed-limits.js";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const wallTime = z.string().regex(/^\d{2}:\d{2}$/);

/** One date of a series that differs from its rule. Wall-clock fields are in the series zone and come from the proxy only. */
export const calendarFeedSeriesExceptionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("cancelled"), date: isoDate }),
  z.object({
    kind: z.literal("changed"),
    /** The original occurrence date this replaces. */
    date: isoDate,
    title: z.string(),
    location: z.string(),
    startDate: isoDate,
    localStartTime: wallTime,
    endDate: isoDate,
    localEndTime: wallTime
  })
]);

/**
 * A repeating feed event the portal can hold as one rule (`attributes.series`, on the first event of its UID in a read).
 * The proxy still emits every expanded instance; this is an extra. `startDate` is the first instance (DTSTART), and
 * `endDate` the last instance when COUNT or UNTIL bounds the series (COUNT counts excluded instances). Exceptions older
 * than yesterday (in the series zone) are dropped. A series that cannot be described exactly has no descriptor and
 * appears in `extras.unrepresentableSeries` with a reason instead.
 */
export const calendarFeedSeriesSchema = z.object({
  uid: z.string(),
  /** The encoded UID, the same stem as the event ids (`id === idPrefix || id.startsWith(idPrefix + "#")`). */
  idPrefix: z.string(),
  timezone: z.string().min(1),
  status: z.enum(["confirmed", "tentative", "cancelled"]),
  title: z.string(),
  location: z.string(),
  startDate: isoDate,
  endDate: isoDate.nullable(),
  repeat: commitmentRepeatSchema,
  localStartTime: wallTime,
  localEndTime: wallTime,
  exceptions: z.array(calendarFeedSeriesExceptionSchema)
});

export const calendarFeedExtrasSchema = z.object({
  host: z.string().min(1),
  transportComplete: z.boolean(),
  veventCount: z.number().int().nonnegative(),
  skipped: z.array(calendarFeedSkippedSchema),
  veventCapHit: z.boolean(),
  occurrenceCapHit: z.boolean(),
  timeBudgetHit: z.boolean(),
  /** Repeating events not imported as a series, with a fixed reason each (plan path D). Absent from older proxies. */
  unrepresentableSeries: z.array(calendarFeedSkippedSchema).optional()
});

export type CalendarFeedFailureReason = z.infer<typeof calendarFeedFailureReasonSchema>;
export type CalendarFeedProofResult = z.infer<typeof calendarFeedProofResultSchema>;
export type CalendarFeedSeries = z.infer<typeof calendarFeedSeriesSchema>;
export type CalendarFeedSeriesException = z.infer<typeof calendarFeedSeriesExceptionSchema>;
export type CalendarFeedSkipped = z.infer<typeof calendarFeedSkippedSchema>;
export type CalendarFeedExtras = z.infer<typeof calendarFeedExtrasSchema>;
