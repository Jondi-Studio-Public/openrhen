import { z } from "zod";

export {
  calendarSinkCreateRequestSchema,
  calendarSinkRemoveResponseSchema,
  calendarSinkStatusSchema,
  calendarSinkUpdateRequestSchema,
  calendarSinkWriteProofRequestSchema,
  calendarSinkWriteProofResultSchema,
  calendarSinkWriteResponseSchema
} from "./sink.js";

const instant = z.string().datetime({ offset: true });

/** One calendar event, normalised inside the connection. Field names follow `googleCalendarEventSchema`. */
export const calendarEventSchema = z.object({
  externalEventId: z.string().min(1),
  /** The source system's calendar id, when it has one. */
  calendarId: z.string().min(1).nullable(),
  title: z.string().min(1),
  description: z.string().nullable(),
  startsAt: instant,
  endsAt: instant,
  allDay: z.boolean(),
  timezone: z.string().min(1).max(100).nullable(),
  location: z.string().nullable(),
  status: z.enum(["confirmed", "tentative", "cancelled"]),
  seriesId: z.string().nullable(),
  recurring: z.boolean().default(false),
  updatedAt: instant.nullable(),
  profileLabel: z.string().min(1).nullable().default(null),
  attributes: z.record(z.string(), z.unknown()).default({})
});

/** The portal fills both the instant and the local-date window; each connection uses the one it needs. */
export const calendarReadEventsRequestSchema = z.object({
  timeMin: instant,
  timeMax: instant,
  dateStart: z.string().min(1),
  dateEnd: z.string().min(1),
  calendarIds: z.array(z.string().min(1)).max(50).optional(),
  /** The owner's IANA zone, for a source that must place floating or all-day times itself (the calendar feed). */
  timezone: z.string().min(1).max(100).optional()
});

export const calendarReadEventsResponseSchema = z.object({
  events: z.array(calendarEventSchema),
  scope: z.object({ frameId: z.string().nullable(), timezone: z.string().nullable() }),
  extras: z.record(z.string(), z.unknown()).default({})
});

export type CalendarEvent = z.infer<typeof calendarEventSchema>;
export type CalendarReadEventsRequest = z.infer<typeof calendarReadEventsRequestSchema>;
export type CalendarReadEventsResponse = z.infer<typeof calendarReadEventsResponseSchema>;
