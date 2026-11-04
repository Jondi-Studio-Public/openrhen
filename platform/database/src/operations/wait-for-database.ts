import postgres from "postgres";
import { describeError } from "./migrate-helpers.js";

export type WaitForDatabaseOptions = {
  /** Total time to keep trying before giving up. */
  timeoutMs: number;
  /** Pause between attempts. */
  intervalMs: number;
  /** One `select 1` against `url`; throws when the database does not accept it. Replaceable in tests. */
  connect?: (url: string) => Promise<void>;
  /** Called about every `logEveryMs` while waiting; never given the URL. */
  onWaiting?: (waitedMs: number) => void;
  logEveryMs?: number;
  /** Strings scrubbed from the timeout message (the URL and its password). */
  secrets?: readonly string[];
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

/** Seconds to wait when `MIGRATE_DB_WAIT_SECONDS` is unset. */
export const DEFAULT_DB_WAIT_SECONDS = 90;

/** `MIGRATE_DB_WAIT_SECONDS` as milliseconds: unset or blank is the default; anything but a positive integer is an error. */
export function dbWaitMs(value: string | undefined): number {
  const text = (value ?? "").trim();
  if (text === "") return DEFAULT_DB_WAIT_SECONDS * 1000;
  if (!/^[1-9][0-9]*$/.test(text)) {
    throw new Error(`MIGRATE_DB_WAIT_SECONDS must be a positive integer, not "${text.slice(0, 40)}"`);
  }
  return Number(text) * 1000;
}

async function defaultConnect(url: string): Promise<void> {
  const sql = postgres(url, { max: 1, connect_timeout: 3, onnotice: () => undefined });
  try {
    await sql`select 1`;
  } finally {
    await sql.end({ timeout: 1 }).catch(() => undefined);
  }
}

/**
 * Waits until the database accepts a connection, so a `migrate` that starts beside a bundled Postgres that is
 * still initialising does not fail on its first try. Resolves at once on a healthy database (one round trip).
 * Throws, naming the last error with the URL and password scrubbed, once `timeoutMs` has passed.
 */
export async function waitForDatabase(url: string, options: WaitForDatabaseOptions): Promise<void> {
  const connect = options.connect ?? defaultConnect;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const logEveryMs = options.logEveryMs ?? 10_000;
  const started = now();
  let lastLogged = started;
  for (;;) {
    try {
      await connect(url);
      return;
    } catch (error) {
      const waited = now() - started;
      if (waited + options.intervalMs > options.timeoutMs) {
        const reason = describeError(error, options.secrets ?? [url]);
        throw new Error(
          `The database did not accept connections within ${Math.round(options.timeoutMs / 1000)} s (MIGRATE_DB_WAIT_SECONDS): ${reason.cause ?? reason.message}`
        );
      }
      if (now() - lastLogged >= logEveryMs) {
        lastLogged = now();
        options.onWaiting?.(waited);
      }
    }
    await sleep(options.intervalMs);
  }
}
