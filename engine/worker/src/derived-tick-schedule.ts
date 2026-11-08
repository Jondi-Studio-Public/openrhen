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
