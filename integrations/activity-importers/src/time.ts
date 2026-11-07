/** Time parsing shared by the importers. A time without a zone is never read as local time: it is skipped or marked approximate. */

const RFC3339 = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d+))?\s*(Z|[+-]\d{2}:?\d{2})$/i;

export interface ParsedTime {
  date: Date;
  /** Minutes east of UTC from the string's own offset; null for `Z`/`+00:00` forms that say nothing about local time. */
  offsetMin: number | null;
}

/** `2026-01-02T03:04:05.123Z`, `2026-01-02 03:04:05.123456+00:00` and `2026-01-02 03:04:05 +1100`. Needs a zone. */
export function parseTimestamp(value: unknown, options: { utcOffsetIsUnknown?: boolean } = {}): ParsedTime | null {
  if (typeof value !== "string") return null;
  const match = RFC3339.exec(value.trim());
  if (!match) return null;
  const [, day, clock, fraction, zone] = match as unknown as [string, string, string, string | undefined, string];
  const millis = (fraction ?? "").slice(0, 3).padEnd(3, "0");
  let offsetMin = 0;
  let zoneText = "Z";
  if (zone.toUpperCase() !== "Z") {
    const digits = zone.replace(":", "");
    const sign = digits.startsWith("-") ? -1 : 1;
    const hours = Number(digits.slice(1, 3));
    const minutes = Number(digits.slice(3, 5));
    if (hours > 23 || minutes > 59) return null;
    offsetMin = sign * (hours * 60 + minutes);
    zoneText = `${digits[0]}${digits.slice(1, 3)}:${digits.slice(3, 5)}`;
  }
  const date = new Date(`${day}T${clock}.${millis}${zoneText}`);
  if (Number.isNaN(date.getTime())) return null;
  // A day that does not exist (February 30) rolls over in Date; refuse it rather than shift the row.
  const [year, month, dayOfMonth] = day.split("-").map(Number) as [number, number, number];
  const local = new Date(Date.UTC(year, month - 1, dayOfMonth));
  if (local.getUTCMonth() !== month - 1 || local.getUTCDate() !== dayOfMonth) return null;
  const unknown = offsetMin === 0 && (options.utcOffsetIsUnknown ?? true);
  return { date, offsetMin: unknown ? null : offsetMin };
}

export function iso(date: Date): string {
  return date.toISOString();
}

/** Epoch seconds or milliseconds-as-number to a date, bounded to a plausible span (1995 to a day from now). */
export function plausible(date: Date, now: Date = new Date()): boolean {
  const time = date.getTime();
  return time >= Date.UTC(1995, 0, 1) && time <= now.getTime() + 24 * 3_600_000;
}

/** Epoch milliseconds as a number or a 12 to 13 digit string, within the plausible span; anything else (seconds, microseconds, text) is null, never rescaled. */
export function fromEpochMillis(value: unknown, now: Date = new Date()): Date | null {
  const millis =
    typeof value === "number" && Number.isInteger(value)
      ? value
      : typeof value === "string" && /^\d{12,13}$/.test(value.trim())
        ? Number(value)
        : NaN;
  if (!Number.isFinite(millis) || millis <= 0) return null;
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) || !plausible(date, now) ? null : date;
}

/** Epoch seconds as a number or a 9 to 11 digit string, within the plausible span; anything else is null, never rescaled. */
export function fromEpochSeconds(value: unknown, now: Date = new Date()): Date | null {
  const seconds =
    typeof value === "number" && Number.isInteger(value)
      ? value
      : typeof value === "string" && /^\d{9,11}$/.test(value.trim())
        ? Number(value)
        : NaN;
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 99_999_999_999) return null;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) || !plausible(date, now) ? null : date;
}
