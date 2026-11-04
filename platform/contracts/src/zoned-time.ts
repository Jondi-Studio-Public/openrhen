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

/**
 * A stable uuid derived from any string (four FNV-style hashes laid out as a version-4 uuid). The engine converts the raw
 * ids it builds, such as `commitmentOccurrenceId`, with this before they reach the database, so the portal must use the
 * same function to name a row the planner will later find. Moved verbatim from engine-core; the output is pinned by test.
 */
export function deterministicUuid(value: string): string {
  let a = 0x811c9dc5,
    b = 0x9e3779b9,
    c = 0x85ebca6b,
    d = 0xc2b2ae35;
  for (const character of value) {
    const code = character.codePointAt(0)!;
    a = Math.imul(a ^ code, 16777619);
    b = Math.imul(b + code, 2246822519);
    c = Math.imul(c ^ code, 3266489917);
    d = Math.imul(d + code, 668265263);
  }
  const hex = [a, b, c, d]
    .map((part) => (part >>> 0).toString(16).padStart(8, "0"))
    .join("")
    .split("");
  hex[12] = "4";
  hex[16] = ["8", "9", "a", "b"][parseInt(hex[16]!, 16) & 3]!;
  return `${hex.slice(0, 8).join("")}-${hex.slice(8, 12).join("")}-${hex.slice(12, 16).join("")}-${hex.slice(16, 20).join("")}-${hex.slice(20).join("")}`;
}

/**
 * The id of the stored row of one occurrence of a recurring commitment rule: `deterministicUuid` of the raw
 * `commitmentOccurrenceId`. This is what `commitments.id` holds for a generated or exception date, and a row written under
 * any other id collides on the `(recurrence_rule_id, local_date)` unique index at the first replan.
 */
export function commitmentOccurrenceRowId(ruleId: string, localDateValue: string): string {
  return deterministicUuid(commitmentOccurrenceId(ruleId, localDateValue));
}
