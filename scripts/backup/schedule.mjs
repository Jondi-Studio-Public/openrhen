// Pure helpers for the daily backup loop (scheduled.mjs). Kept apart so they can be tested without a clock or a child process.

/** Parses "HH:mm" (24-hour); throws on anything else so a typo fails the container at start, not silently at 03:30. */
export function parseTime(value) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value ?? "").trim());
  if (!match) throw new Error(`BACKUP_TIME must be 24-hour HH:mm, for example 03:30; got "${value}".`);
  return { hours: Number(match[1]), minutes: Number(match[2]) };
}

/** Milliseconds from `now` until the next HH:mm in the process's local time zone (TZ); always positive. */
export function msUntilNext(now, time) {
  const next = new Date(now);
  next.setHours(time.hours, time.minutes, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

/** True when BACKUP_COPY is the explicit opt-out "off" (case-insensitive): local-only backups, chosen on purpose. BACKUP_COPY_DIR stays a plain host path. */
export function copyDisabled(env) {
  return env.BACKUP_COPY?.trim().toLowerCase() === "off";
}

/** True when there is no monitor: BACKUP_PING_URL is blank or "off" (case-insensitive). Backups still run. */
export function pingDisabled(env) {
  const value = env.BACKUP_PING_URL?.trim().toLowerCase();
  return !value || value === "off";
}

/** Host and port of a database URL, or null when it cannot be read. Used to wait for the database, never logged. */
export function databaseEndpoint(url) {
  try {
    const parsed = new URL(url);
    if (!parsed.hostname) return null;
    return { host: parsed.hostname.replace(/^\[|\]$/g, ""), port: Number(parsed.port) || 5432 };
  } catch {
    return null;
  }
}

/** healthchecks.io-style ping URLs: base for success, base/start, base/fail. Returns null when unset or "off". */
export function pingUrl(base, kind) {
  const trimmed = base?.trim().replace(/\/+$/, "");
  if (!trimmed || trimmed.toLowerCase() === "off") return null;
  return kind === "success" ? trimmed : `${trimmed}/${kind}`;
}

/** backup-and-copy.mjs exits with this when the backup completed but something needs attention. */
export const EXIT_WARNINGS = 3;

/** Last JSON line of a run's combined stdout and stderr (the summary, ok or failed), or null. */
export function parseSummary(output) {
  const line = output
    .split(/\r?\n/)
    .reverse()
    .find((candidate) => candidate.trim().startsWith("{"));
  try {
    return line ? JSON.parse(line) : null;
  } catch {
    return null;
  }
}

/** Which ping a finished run earns, and the body that carries the backup size. Anything but a clean run is /fail. Null when pings are off. */
export function pingForRun(code, summary, env = process.env) {
  if (pingDisabled(env)) return null;
  const clean = code === 0 && !summary?.warnings?.length;
  const body = [
    clean ? "ok" : code === 0 || code === EXIT_WARNINGS ? "completed with warnings" : `failed (exit ${code})`,
    summary?.backupBytes != null ? `backup size: ${summary.backupBytes} bytes` : null,
    ...(summary?.warnings ?? []).map((warning) => `warning: ${warning}`),
    summary?.error ? `error: ${summary.error}` : null
  ]
    .filter(Boolean)
    .join("\n");
  return { kind: clean ? "success" : "fail", body };
}
