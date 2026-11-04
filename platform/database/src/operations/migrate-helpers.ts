/**
 * Pure helpers for `migrate-on-deploy.ts`, kept free of I/O so they can be unit-tested: the libpq environment
 * for pg_dump, error descriptions that keep the real cause, the connect retry, and the free-space check.
 */

/**
 * The connection parameters of a `postgres://` URL as libpq environment variables, so the password never
 * appears in pg_dump's argument list (visible to every process on the host through /proc and `docker top`).
 * Only `sslmode` is carried over from the query string (`ssl=true`/`require` become `sslmode=require`); the
 * other query parameters are postgres-js options libpq would reject.
 */
export function pgEnvFromUrl(databaseUrl: string): Record<string, string> {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error("DATABASE_URL is not a valid postgres:// URL");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must start with postgres:// or postgresql://");
  }
  const env: Record<string, string> = {};
  if (url.hostname) env.PGHOST = url.hostname.replace(/^\[|\]$/g, "");
  if (url.port) env.PGPORT = url.port;
  if (url.username) env.PGUSER = decodeURIComponent(url.username);
  if (url.password) env.PGPASSWORD = decodeURIComponent(url.password);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (database) env.PGDATABASE = database;
  const sslmode = url.searchParams.get("sslmode");
  const ssl = url.searchParams.get("ssl");
  if (sslmode) env.PGSSLMODE = sslmode;
  else if (ssl === "true" || ssl === "require") env.PGSSLMODE = "require";
  return env;
}

export type ErrorDescription = { message: string; cause?: string; code?: string; detail?: string };

/** Longest any one part of an error description may be; each part is cut on its own so none hides another. */
export const ERROR_PART_MAX = 600;

function clip(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) if (secret) out = out.split(secret).join("[secret]");
  return out.length > ERROR_PART_MAX ? `${out.slice(0, ERROR_PART_MAX)}...` : out;
}

/**
 * An error as separate, individually truncated and scrubbed parts. Drizzle wraps a failed statement as
 * `Failed query: <sql>` and keeps the real Postgres error (message, SQLSTATE `code`, `detail`) in `cause`,
 * so the message alone says what ran but never why it failed. `secrets` (the database URL, its password)
 * are replaced wherever they appear.
 */
export function describeError(error: unknown, secrets: readonly string[]): ErrorDescription {
  const message = clip(error instanceof Error ? error.message : String(error), secrets);
  const cause = error instanceof Error ? error.cause : undefined;
  if (typeof cause !== "object" || cause === null) {
    return typeof cause === "string" && cause ? { message, cause: clip(cause, secrets) } : { message };
  }
  const part = (key: string): string | undefined => {
    const value = (cause as Record<string, unknown>)[key];
    return typeof value === "string" && value !== "" ? clip(value, secrets) : undefined;
  };
  const description: ErrorDescription = { message };
  const causeMessage = part("message");
  const code = part("code");
  const detail = part("detail");
  if (causeMessage) description.cause = causeMessage;
  if (code) description.code = code;
  if (detail) description.detail = detail;
  return description;
}

export type RetryOptions = {
  /** Wait in milliseconds before each retry; the number of attempts is one more than its length. */
  delaysMs: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
};

/** Five attempts spaced 2, 4, 8 and 16 seconds apart: about 30 seconds of patience for a database that is restarting. */
export const CONNECT_RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 16_000] as const;

/** Run `task`, retrying after each failure per `delaysMs`; the last failure is thrown. */
export async function withRetry<T>(task: () => Promise<T>, options: RetryOptions): Promise<T> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; ; attempt++) {
    try {
      return await task();
    } catch (error) {
      const delay = options.delaysMs[attempt];
      if (delay === undefined) throw error;
      options.onRetry?.(error, attempt + 1, delay);
      await sleep(delay);
    }
  }
}

/** Free space below which no dump is attempted: a full disk fails the dump late and leaves the deploy down. */
export const MIN_FREE_BYTES_FOR_DUMP = 1024 ** 3;

/** Why a dump should not start with `freeBytes` free, or null when there is room. */
export function freeSpaceProblem(freeBytes: number, floorBytes = MIN_FREE_BYTES_FOR_DUMP): string | null {
  if (freeBytes >= floorBytes) return null;
  const mib = (bytes: number) => Math.floor(bytes / 1024 ** 2);
  return `only ${mib(freeBytes)} MiB free in the backup folder, under the ${mib(floorBytes)} MiB floor; free space or prune old dumps`;
}

/**
 * Session settings for the migrator connection, so a migration blocked behind another session's lock (the
 * nightly pg_dump, a stuck transaction) fails the deploy fast and clearly instead of hanging until the job's
 * timeout. Sent as startup parameters by postgres.js, which types them as numbers (milliseconds): 30 s, 15 min, 5 min.
 */
export const MIGRATOR_CONNECTION_OPTIONS = {
  lock_timeout: 30_000,
  statement_timeout: 15 * 60_000,
  idle_in_transaction_session_timeout: 5 * 60_000
};
