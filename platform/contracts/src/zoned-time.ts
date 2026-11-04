/**
 * Wall-clock-to-instant resolution and the recurring-occurrence id, shared by the engine, the portal and
 * the integrations so every layer resolves a local date and time to the same instant and builds the
 * same commitment id. Moved verbatim from engine-core; behaviour is unchanged.
 */

const wallClockFormats = new Map<string, Intl.DateTimeFormat>();

/**
 * Year to second, 24-hour, in `timezone`: the parts a wall-clock-to-instant search compares against.
 *
 * Built once per timezone rather than once per call: constructing a formatter resolves the locale and
 * loads the zone's rules, and a six-month plan resolves thousands of wall times. A formatter is
 * immutable once built, so sharing one changes nothing about what it formats. An unknown timezone
 * still throws on first use, and is not cached.
 */
export function wallClockFormat(timezone: string): Intl.DateTimeFormat {
  let format = wallClockFormats.get(timezone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23"
    });
    wallClockFormats.set(timezone, format);
  }
  return format;
}

export function zonedDateTime(localDateValue: string, wallTime: string, timezone: string): Date {
  const [year, month, day] = localDateValue.split("-").map(Number) as [number, number, number];
  const [hour, minute] = wallTime.split(":").map(Number) as [number, number];
  const desired = Date.UTC(year, month - 1, day, hour, minute);
  let stamp = desired;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = wallClockFormat(timezone).formatToParts(new Date(stamp));
    const take = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
    const correction =
      desired - Date.UTC(take("year"), take("month") - 1, take("day"), take("hour"), take("minute"), take("second"));
    // Settled: another pass would format the same instant and correct by nothing again.
    if (correction === 0) break;
    stamp += correction;
  }
  return new Date(stamp);
}

/** The id of one generated occurrence of a recurring commitment rule: `<ruleId>:<YYYY-MM-DD>`. */
export function commitmentOccurrenceId(ruleId: string, localDateValue: string): string {
  return `${ruleId}:${localDateValue}`;
}
