// The size caps for a calendar feed series descriptor. Schema-free on purpose: the parser worker imports these, and it
// should not load zod for two numbers. `calendar-feed.ts` re-exports them.

/** A series descriptor is bounded: 8,000 characters of JSON for one series. */
export const CALENDAR_FEED_SERIES_MAX_CHARS = 8000;
/** ...and 30,000 across one read. */
export const CALENDAR_FEED_SERIES_BATCH_MAX_CHARS = 30_000;
