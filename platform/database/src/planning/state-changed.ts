import type postgres from "postgres";

/**
 * The one Postgres channel every writer signals on so every open portal tab can learn a write
 * happened without polling for it. `portal/server/events/state-events.ts` is the only listener; it
 * fans a single `LISTEN` connection out to every subscribed browser tab's SSE stream.
 */
export const STATE_CHANGED_CHANNEL = "state_changed";

/**
 * What changed, loosely — enough for a listening tab to decide which cheap follow-up read is worth
 * making, without carrying the changed data itself (a NOTIFY payload is capped at 8000 bytes, and the
 * listener would still have to re-read the row to trust it over the wire):
 *   - "state": an ordinary command went through `PostgresStateStore` or a location ping — the kind of
 *     write `/api/state` reflects.
 *   - "planning": a forecast just persisted (`persistPlanForecastResult`) — exactly the event
 *     `/api/planning/status` polling already exists to notice, just pushed instead of pulled.
 *   - "check_in": the scheduler inserted a fresh `check_in` row — what `/api/check-ins/current`
 *     polling already exists to notice.
 *   - any other string: a private feature's own kind (a message inserted, a reply claimed), raised and
 *     listened for by that feature alone.
 */
export type StateChangedKind = "state" | "planning" | "check_in" | (string & {});

export interface StateChangedNotification {
  userId: string;
  kind: StateChangedKind;
  /** ISO instant the notification was raised, so a listener can order bursts even if delivery reorders. */
  at: string;
}

/**
 * Fire-and-forget: `NOTIFY` (via `pg_notify`, so the payload can be a bound parameter rather than a
 * string literal spliced into the SQL) on the shared channel. A caller must invoke this only after
 * its own write has committed — inside a transaction, `NOTIFY` is deferred until commit by Postgres
 * itself, but calling it *after* a transaction that goes on to roll back would still fire it, since
 * this call would then be a separate statement outside that transaction entirely. Every call site in
 * this codebase calls it once its `sql.begin(...)` has already resolved.
 *
 * A `NOTIFY` failure (a dead connection, a channel-name typo) must never fail the write it is
 * reporting — the write already succeeded — so any error here is only logged, never thrown.
 */
export function notifyStateChanged(sql: postgres.Sql, notification: Omit<StateChangedNotification, "at">): void {
  const payload: StateChangedNotification = { ...notification, at: new Date().toISOString() };
  void sql`SELECT pg_notify(${STATE_CHANGED_CHANNEL}, ${JSON.stringify(payload)})`.catch((error: unknown) => {
    console.error("notifyStateChanged: NOTIFY failed", error);
  });
}
