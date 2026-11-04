import { z } from "zod";

// The calendar sink wire: what the portal sends a `calendar_sink` connection and reads back. Neutral names; a sink
// connection maps its own API to these shapes.

/** The remote system's id shape: a plain numeric id for a one-off event, `${seriesId}-${epoch}` for a series instance. Always coerced to a string, since JSON:API can return either. */
const remoteEventId = z.union([z.string().min(1), z.number()]).transform((value) => String(value));

/**
 * The write fields the design's reverse-engineered table names, in the remote's own snake_case field
 * names since these routes mirror the hypothesised upstream shape almost verbatim (unlike the read
 * schema above, which normalises into a portal-facing camelCase shape). Shared by create (all
 * required except `rrule`) and update (all optional, since the remote keeps omitted fields unchanged).
 */
const calendarSinkWriteFields = {
  summary: z.string().min(1),
  starts_at: z.string().datetime({ offset: true }),
  ends_at: z.string().datetime({ offset: true }),
  all_day: z.literal(false),
  timezone: z.string().min(1).max(100),
  location: z.string().nullable(),
  description: z.string().nullable(),
  category_ids: z.array(z.string()),
  /** Never sent by us (recurring commitments publish one one-off event per occurrence) but the reverse-engineered API accepts it, so the schema allows it rather than silently dropping an unexpected field. */
  rrule: z.string().nullable().optional()
};

export const calendarSinkCreateRequestSchema = z.object(calendarSinkWriteFields);

export const calendarSinkUpdateRequestSchema = z.object(
  Object.fromEntries(Object.entries(calendarSinkWriteFields).map(([key, schema]) => [key, schema.optional()])) as {
    [K in keyof typeof calendarSinkWriteFields]: z.ZodOptional<(typeof calendarSinkWriteFields)[K]>;
  }
);

/** JSON:API shape; only `data.id` is used downstream, but the rest of the envelope is allowed through untouched. */
export const calendarSinkWriteResponseSchema = z.object({
  data: z.object({ id: remoteEventId }).passthrough()
});

export const calendarSinkRemoveResponseSchema = z.object({ ok: z.literal(true) });

/** One field of the write-proof's create-vs-read-back comparison. */
const calendarSinkWriteProofFieldEchoSchema = z.object({
  field: z.string().min(1),
  sent: z.unknown(),
  echoed: z.unknown(),
  matched: z.boolean()
});

export const calendarSinkWriteProofRequestSchema = z.object({
  frameId: z.string().min(1).optional()
});

/**
 * One flat report rather than a passed/failed union: the design asks for "each field echo" plus
 * "which step failed if any", and a run can fail partway through with some fields already echoed
 * (e.g. the update fails after create-then-read succeeded) — those echoes are worth keeping.
 */
export const calendarSinkWriteProofResultSchema = z.object({
  status: z.enum(["passed", "failed"]),
  checkedAt: z.string().datetime({ offset: true }),
  remoteEventId: z.string().min(1).nullable(),
  fields: z.array(calendarSinkWriteProofFieldEchoSchema),
  failedStep: z.enum(["create", "read", "update", "read_after_update", "delete"]).nullable(),
  message: z.string().nullable(),
  /** The raw remote response body for the failing step, so an operator can see exactly what came back — see the design's "Write proof" row. Never populated for an auth failure, which can echo a submitted password. */
  responseBody: z.unknown().optional(),
  deleted: z.boolean()
});

/** What the proxy reports about its own write gate and frame, so the portal can refuse to sweep before planning anything. */
export const calendarSinkStatusSchema = z.object({
  writeEnabled: z.boolean(),
  frameId: z.string().min(1).nullable()
});

export type CalendarSinkCreateRequest = z.infer<typeof calendarSinkCreateRequestSchema>;
export type CalendarSinkUpdateRequest = z.infer<typeof calendarSinkUpdateRequestSchema>;
export type CalendarSinkWriteResponse = z.infer<typeof calendarSinkWriteResponseSchema>;
export type CalendarSinkRemoveResponse = z.infer<typeof calendarSinkRemoveResponseSchema>;
export type CalendarSinkWriteProofRequest = z.infer<typeof calendarSinkWriteProofRequestSchema>;
export type CalendarSinkWriteProofResult = z.infer<typeof calendarSinkWriteProofResultSchema>;
export type CalendarSinkStatus = z.infer<typeof calendarSinkStatusSchema>;
