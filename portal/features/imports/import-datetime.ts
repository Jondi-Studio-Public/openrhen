import { DEFAULT_TIMEZONE } from "@openrhen/contracts";
/**
 * A spreadsheet cell and an offset-less CSV timestamp both carry a wall clock with no zone attached.
 * Excel stores `20/08/2026 17:00` as a serial number and ExcelJS hands it back as a Date whose *UTC*
 * face reads 17:00, so calling `toISOString()` on it published a local five o'clock as three in the
 * morning the next day, and a bare `14:00` as a timestamp in 1899. The batch records the timezone the
 * file was uploaded under; that is the zone these readings belong to, so the wall clock is resolved
 * there instead of being read as UTC.
 */

/** How a column's text is meant to be read: an instant, a calendar day, a clock time, or plain text. */
export type ImportDateKind = "datetime" | "date" | "time" | "text";

export type WallClock = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

/** The date Excel puts on a cell formatted as a time alone. */
const EXCEL_TIME_EPOCH = "1899-12-30";
const OFFSETLESS_DATETIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

const pad = (value: number, width = 2) => String(value).padStart(width, "0");

function zonedParts(at: Date, timezone: string): WallClock {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(at);
  const take = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  return {
    year: take("year"),
    month: take("month"),
    day: take("day"),
    hour: take("hour") % 24,
    minute: take("minute"),
    second: take("second")
  };
}

/**
 * The instant at which a zone's clocks read the given wall time. Found by correcting a UTC guess
 * against what the zone actually shows there, which converges in one step away from a transition and
 * settles on a consistent instant across one; a wall time that never occurs, inside a spring-forward
 * gap, lands within an hour of the jump rather than throwing.
 */
export function zonedWallClockToInstant(wall: WallClock, timezone: string): Date {
  const desired = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  let stamp = desired;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = zonedParts(new Date(stamp), timezone);
    const shown = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
    if (shown === desired) break;
    stamp += desired - shown;
  }
  return new Date(stamp);
}

/** The wall clock ExcelJS wrote into the UTC face of a date cell. */
export function excelCellWallClock(value: Date): WallClock {
  return {
    year: value.getUTCFullYear(),
    month: value.getUTCMonth() + 1,
    day: value.getUTCDate(),
    hour: value.getUTCHours(),
    minute: value.getUTCMinutes(),
    second: value.getUTCSeconds()
  };
}

/**
 * The text a Date-typed workbook cell should stand for in its column: an instant for a timestamp
 * column, `HH:MM` for a time column, `YYYY-MM-DD` for a date column. A timestamp column holding a
 * bare time keeps its `HH:MM` shape so validation names it, rather than committing a 19th-century
 * deadline that reads as valid.
 */
export function excelDateCellText(value: Date, kind: ImportDateKind, timezone: string): string {
  const wall = excelCellWallClock(value);
  const date = `${pad(wall.year, 4)}-${pad(wall.month)}-${pad(wall.day)}`;
  const time = `${pad(wall.hour)}:${pad(wall.minute)}`;
  if (kind === "time") return time;
  if (kind === "date") return date;
  if (date === EXCEL_TIME_EPOCH) return time;
  if (kind === "datetime") return zonedWallClockToInstant(wall, timezone).toISOString();
  // An unclassified column: keep the shape the cell had rather than inventing a precision it lacks.
  return wall.hour || wall.minute || wall.second ? zonedWallClockToInstant(wall, timezone).toISOString() : date;
}

/** Excel counts days from 1899-12-30, its 1900 leap-year bug included; the fraction is the clock. */
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);
const BARE_NUMBER = /^\d{1,7}(?:\.\d+)?$/;
/** 1954-10-03. Below this a bare number in a date column is likelier a typo than a serial. */
const EARLIEST_PLAUSIBLE_SERIAL = 20_000;
/** 9999-12-31, the last date Excel will represent. */
const LATEST_SERIAL = 2_958_465;

/**
 * A date column holding a bare number is a serial the sheet never had a date format applied to, so
 * ExcelJS hands back `46293.58` rather than a Date and the reading published that text — which
 * validation then rejects as an invalid timestamp, taking the whole row with it. In a column that
 * means a date, the number is one. Exported for a workbook cell that arrives as text, and applied
 * to every source, since the same sheet saved as CSV carries the same serials.
 *
 * A number outside the plausible range is left alone: `2026` in a deadline column is a year someone
 * typed, not 1905, and the error it earns says more than a silently wrong date would.
 */
export function excelSerialDateText(value: string, kind: ImportDateKind, timezone: string | undefined): string | null {
  if (kind === "text" || !BARE_NUMBER.test(value)) return null;
  const serial = Number(value);
  if (!Number.isFinite(serial)) return null;
  const plausible =
    kind === "time" ? serial >= 0 && serial < 1 : serial >= EARLIEST_PLAUSIBLE_SERIAL && serial <= LATEST_SERIAL;
  if (!plausible) return null;
  return excelDateCellText(
    new Date(EXCEL_EPOCH_MS + Math.round(serial * 86_400) * 1000),
    kind,
    timezone ?? DEFAULT_TIMEZONE
  );
}

/**
 * Reads an offset-less timestamp in the batch's timezone. Text that already carries an offset, a `Z`,
 * or anything that is not a plain ISO reading is returned untouched: only a value with no zone of its
 * own needs one supplied. With no timezone known the text is left exactly as written.
 */
export function normaliseImportDateText(value: string, kind: ImportDateKind, timezone: string | undefined): string {
  const serial = excelSerialDateText(value, kind, timezone);
  if (serial !== null) return serial;
  if (!timezone || kind !== "datetime") return value;
  const datetime = OFFSETLESS_DATETIME.exec(value);
  if (datetime)
    return zonedWallClockToInstant(
      {
        year: Number(datetime[1]),
        month: Number(datetime[2]),
        day: Number(datetime[3]),
        hour: Number(datetime[4]),
        minute: Number(datetime[5]),
        second: Number(datetime[6] ?? 0)
      },
      timezone
    ).toISOString();
  const dateOnly = DATE_ONLY.exec(value);
  if (dateOnly)
    return zonedWallClockToInstant(
      {
        year: Number(dateOnly[1]),
        month: Number(dateOnly[2]),
        day: Number(dateOnly[3]),
        hour: 0,
        minute: 0,
        second: 0
      },
      timezone
    ).toISOString();
  return value;
}

/** Excel's "CSV UTF-8" prefixes the file with a byte-order mark that would ride into the first header. */
export function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}
