/**
 * The `Intl.DateTimeFormat` shape the engine reads local dates through, built once
 * per timezone rather than once per call.
 *
 * Constructing a formatter resolves the locale and loads the zone's rules, and that cost dwarfed the
 * formatting itself: a six-month plan resolves thousands of local dates, and building a
 * fresh formatter for each was a fifth of the whole plan's time. A formatter is immutable once
 * built, so sharing one changes nothing about what it formats. An unknown timezone still throws on
 * first use, and is not cached.
 */
const localDateFormats = new Map<string, Intl.DateTimeFormat>();

/** `YYYY-MM-DD` in `timezone`. */
export function localDateFormat(timezone: string): Intl.DateTimeFormat {
  let format = localDateFormats.get(timezone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    });
    localDateFormats.set(timezone, format);
  }
  return format;
}
