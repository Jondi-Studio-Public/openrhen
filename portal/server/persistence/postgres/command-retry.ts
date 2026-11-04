/**
 * Retry for a command whose transaction Postgres aborted as a deadlock victim (40P01) or a
 * serialization failure (40001). Either error rolls the whole transaction back, so nothing the failed
 * attempt did is visible and running the command again is the standard remedy.
 *
 * A retry cannot apply a command twice: every command claims its `writes` receipt (see
 * `claimCommandReceipt`) inside the same transaction as its changes, so an aborted attempt leaves no
 * receipt either. The next attempt runs the handler from the top with the same command id: it
 * replays if a racing attempt landed, otherwise it applies once. This is only valid for a handler
 * that opens its own top-level transaction (`PoolSql`); inside a caller's transaction the whole
 * outer transaction is the unit that would have to be retried.
 */
export const COMMAND_RETRY_ATTEMPTS = 3;
const BACKOFF_MIN_MS = 25;
const BACKOFF_MAX_MS = 100;

const RETRYABLE_SQLSTATES = new Set(["40P01", "40001"]);

export function isRetryableTransactionError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && RETRYABLE_SQLSTATES.has(code);
}

export interface CommandRetryOptions {
  attempts?: number;
  /** Test seam: the pause between attempts, given the attempt that just failed (1-based). */
  sleep?: (attempt: number) => Promise<void>;
}

const jitteredSleep = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, BACKOFF_MIN_MS + Math.random() * (BACKOFF_MAX_MS - BACKOFF_MIN_MS)));

export async function withCommandRetry<T>(run: () => Promise<T>, options: CommandRetryOptions = {}): Promise<T> {
  const attempts = options.attempts ?? COMMAND_RETRY_ATTEMPTS;
  const sleep = options.sleep ?? jitteredSleep;
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (attempt >= attempts || !isRetryableTransactionError(error)) throw error;
      await sleep(attempt);
    }
  }
}
