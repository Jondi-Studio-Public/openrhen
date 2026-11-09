import type { AttentionItem } from "@openrhen/contracts";

/**
 * Keeps the open-facts read from being hammered. `rhen_status` reads the counts on every call, and a slow or failing
 * read would otherwise start a new multi-query read each time (a timeout abandons the promise, not the query). So:
 * concurrent callers of one user and kind share one read, a read that outruns `FACTS_READ_TIMEOUT_MS` stays the one in
 * flight until it settles (no second is started beside it), and a failure or timeout is answered from memory for
 * `FACTS_FAILURE_MEMO_MS` without reading. A success is never remembered here (the counts memoise their own number).
 */
export const FACTS_FAILURE_MEMO_MS = 45_000;

/** How long the facts read may take before it counts as a failed source: shorter than the CLI's wait on status. */
export const FACTS_READ_TIMEOUT_MS = 10_000;

/** The facts read, abandoned (not cancelled; the guard keeps it as the one in flight) when it outruns the timeout. */
export function withFactsTimeout<T>(read: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("The open-facts read timed out.")), FACTS_READ_TIMEOUT_MS);
  });
  return Promise.race([read, late]).finally(() => clearTimeout(timer));
}

const inflight = new Map<string, Promise<AttentionItem[]>>();
const failedAt = new Map<string, number>();

export function resetFactsGuard(): void {
  inflight.clear();
  failedAt.clear();
}

export function guardedFactsRead(
  user: string,
  now: Date,
  quotes: boolean,
  run: () => Promise<AttentionItem[]>
): Promise<AttentionItem[]> {
  const failed = failedAt.get(user);
  const age = failed === undefined ? Number.NaN : now.getTime() - failed;
  if (failed !== undefined && age >= 0 && age < FACTS_FAILURE_MEMO_MS)
    return Promise.reject(new Error("The open-facts read failed a moment ago; it is not retried for 45 seconds."));
  const key = `${user}:${quotes ? "quotes" : "counts"}`;
  let flight = inflight.get(key);
  if (flight === undefined) {
    const started = run();
    flight = started;
    inflight.set(key, started);
    const clear = () => {
      if (inflight.get(key) === started) inflight.delete(key);
    };
    started.then(clear, clear);
  }
  return withFactsTimeout(flight).catch((error: unknown) => {
    failedAt.set(user, now.getTime());
    throw error;
  });
}
