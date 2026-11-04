import { z } from "zod";

/**
 * A span is a labelled block of days on the History calendar. It is
 * calendar-only: nothing in planning, estimates or the engine reads it. Dates are plain calendar days in
 * the person's own time zone, inclusive at both ends.
 */

/** Spans reach portal state when they overlap this many days either side of today. */
export const SPAN_STATE_BOUND_DAYS = 365;

const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a 24-hour HH:MM time.");

/**
 * The daily window is a clock window, the `localStartTime`/`localEndTime` part of a recurrence window and
 * nothing else. `wake` and `sleep_start` anchors need that day's wake, which a future span does not have,
 * so `.strict()` refuses an `anchor` (or any other key) rather than ignoring it.
 */
export const spanWindowSchema = z
  .object({ localStartTime: clockTime, localEndTime: clockTime })
  .strict()
  .refine((window) => window.localStartTime < window.localEndTime, {
    message: "The window must end after it starts (a window cannot cross midnight in v1).",
    path: ["localEndTime"]
  });

const calendarDay = z.string().date();

const spanFields = {
  title: z.string().trim().min(1, "A span needs a title.").max(200),
  startDate: calendarDay,
  endDate: calendarDay,
  window: spanWindowSchema.nullish(),
  projectId: z.string().min(1).nullish()
};

const endNotBeforeStart = (value: { startDate: string; endDate: string }, context: z.RefinementCtx) => {
  if (value.endDate < value.startDate)
    context.addIssue({ code: "custom", path: ["endDate"], message: "The end date cannot be before the start date." });
};

/** The `entity` of a `save_entity` command with `entityType: "span"` that adds or edits a span. */
export const spanEntitySchema = z
  .object({ id: z.string().min(1).optional(), ...spanFields })
  .superRefine(endNotBeforeStart);

/** The `entity` of a `save_entity` command that removes a span. */
export const spanRemoveEntitySchema = z.object({ id: z.string().min(1), remove: z.literal(true) });

/** A span as portal state carries it. */
export const spanWireSchema = z
  .object({
    id: z.string(),
    version: z.number().int().positive().optional(),
    title: z.string(),
    startDate: calendarDay,
    endDate: calendarDay,
    window: spanWindowSchema.optional(),
    projectId: z.string().optional()
  })
  .superRefine(endNotBeforeStart);

export type SpanWindow = z.infer<typeof spanWindowSchema>;
export type SpanEntity = z.infer<typeof spanEntitySchema>;
export type SpanWire = z.infer<typeof spanWireSchema>;
