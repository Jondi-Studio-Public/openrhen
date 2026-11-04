/**
 * Wall-clock helpers every daily trigger shares: a local date and time of day in a named timezone, a validated
 * `HH:MM` setting, and whether a portal answer shows a sync really ran. Kept apart from any one provider's schedule.
 */

/**
 * `now`'s wall-clock date and time-of-day in `timezone`, as `YYYY-MM-DD` and `HH:MM` (24-hour).
 * Goes through `Intl.DateTimeFormat` with a named zone rather than a fixed offset, so a date that
 * straddles a DST transition still reads the clock a person in that timezone would actually see.
 */
export function zonedDateAndTime(now: Date, timezone: string): { date: string; time: string } {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  });
  const parts = formatter.formatToParts(now);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return {
    date: `${value("year")}-${value("month")}-${value("day")}`,
    time: `${value("hour")}:${value("minute")}`
  };
}

/**
 * A configured time of day as zero-padded `HH:MM`, because the due checks compare it as text. `5:30` is
 * accepted and padded; anything that is not a valid 24-hour `H:MM`/`HH:MM` returns null so the caller can
 * log it and fall back to its default instead of a job that is silently never (or always) due.
 */
export function normalizeLocalTime(value: string | undefined): string | null {
  const match = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(value ?? "");
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/**
 * Whether a portal response to the sync trigger shows the sync actually ran: a parsed result carrying one
 * of the four sync statuses. A 403 from the host allowlist, a 5xx during a restart or a non-JSON body is
 * not an attempt (the portal recorded nothing), so the caller retries it like a network error.
 */
export function isSyncAttemptResult(result: unknown): boolean {
  if (!result || typeof result !== "object" || !("status" in result)) return false;
  const status = (result as { status: unknown }).status;
  return status === "synced" || status === "needs_review" || status === "failed" || status === "not_configured";
}
