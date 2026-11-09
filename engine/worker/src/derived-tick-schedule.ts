/**
 * Pure pacing for the derived-rows tick (communication understanding, slice 2a-2c). The worker only POSTs to the
 * portal's tick route; this decides how long to wait before the next POST from what the last answer said. It has no
 * off setting: the loop always runs, and an idle tick costs one cheap request a minute.
 */

export const DERIVED_TICK_IDLE_MS = 60_000;
/** A run that filled a batch has probably more to do: go again almost at once, so a backlog drains and live mail never waits long. */
export const DERIVED_TICK_MORE_MS = 1_000;
/** Another run (or a delete of source rows) held the lock: look again soon. */
export const DERIVED_TICK_BUSY_MS = 5_000;
/** The request failed or the portal answered an error: back off to the idle pace rather than hammer it. */
export const DERIVED_TICK_FAILED_MS = 60_000;

export interface DerivedTickOutcome {
  /** Whether the portal answered 2xx. */
  ok: boolean;
  /** The parsed JSON body, when there was one. */
  body: unknown;
}

export function derivedTickDelayMs(outcome: DerivedTickOutcome): number {
  if (!outcome.ok) return DERIVED_TICK_FAILED_MS;
  const body = outcome.body as { status?: unknown; more?: unknown } | null;
  if (body?.status === "busy") return DERIVED_TICK_BUSY_MS;
  if (body?.status === "ok" && body.more === true) return DERIVED_TICK_MORE_MS;
  return DERIVED_TICK_IDLE_MS;
}

/** The work-label loop's idle and failure pace: areas change rarely, and a model that is down should not be asked every minute. */
export const WORK_LABEL_TICK_IDLE_MS = 300_000;

/** How long the work-label loop waits after an answer: soon when another area waits or the store was busy, else the slow pace. */
export function workLabelTickDelayMs(outcome: DerivedTickOutcome): number {
  if (!outcome.ok) return WORK_LABEL_TICK_IDLE_MS;
  const body = outcome.body as { status?: unknown; more?: unknown } | null;
  if (body?.status === "busy") return DERIVED_TICK_BUSY_MS;
  if ((body?.status === "ok" || body?.status === "discarded") && body.more === true) return DERIVED_TICK_MORE_MS * 5;
  return WORK_LABEL_TICK_IDLE_MS;
}

/** The reason-tag loop's idle and failure pace: reasons arrive a few a day, and a model that is down should not be asked every minute. */
export const REASON_TAG_TICK_IDLE_MS = 300_000;

/** How long the reason-tag loop waits after an answer: soon when more reasons wait or the store was busy, else the slow pace. A failure waits the slow pace, so a reason that keeps failing is not hammered. */
export function reasonTagTickDelayMs(outcome: DerivedTickOutcome): number {
  if (!outcome.ok) return REASON_TAG_TICK_IDLE_MS;
  const body = outcome.body as { status?: unknown; more?: unknown; tagged?: unknown } | null;
  if (body?.status === "failed" && (body.tagged === 0 || body.tagged === undefined)) return REASON_TAG_TICK_IDLE_MS;
  if (body?.status === "busy") return DERIVED_TICK_BUSY_MS;
  if ((body?.status === "ok" || body?.status === "discarded") && body.more === true) return DERIVED_TICK_MORE_MS * 5;
  return REASON_TAG_TICK_IDLE_MS;
}
