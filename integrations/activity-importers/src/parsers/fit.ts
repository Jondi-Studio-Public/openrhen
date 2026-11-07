import { csvRecords, headerIndex } from "../csv-stream.js";
import { eventKey } from "../keys.js";
import { skip, type ActivityEventDraft, type ByteSource, type Stats } from "../types.js";

/**
 * Google Fit daily metrics from Takeout, best effort (Fit is being retired and the export has changed shape before).
 * Two shapes are read, both by header name and both for the `steps` kind:
 *  - `Daily activity metrics/2026-01-02.csv`: one row per interval, columns `Start time` and `End time`
 *    (`03:00:00.000+11:00`), the date taken from the file name; the offset becomes `tzOffsetMin`;
 *  - a summary file with a `Date` column and one row per day: the day has no time zone, so it is stored as the
 *    UTC day, flagged `approximate`, with `granularity: "day"`.
 * Rows with no step count, or a count that is not a whole number of zero or more, are skipped. Zero-step rows are
 * dropped as not-an-event (counted as ignored).
 */
const STEP_COLUMN = "step count";
const CLOCK = /^(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?\s*(Z|[+-]\d{2}:?\d{2})$/i;
const FILE_DATE = /(\d{4}-\d{2}-\d{2})\.csv$/i;

function clockToUtc(date: string, clock: string): { ms: number; offsetMin: number } | null {
  const match = CLOCK.exec(clock.trim());
  if (!match) return null;
  const zone = match[5]!;
  let offsetMin = 0;
  let zoneText = "Z";
  if (zone.toUpperCase() !== "Z") {
    const digits = zone.replace(":", "");
    offsetMin = (digits.startsWith("-") ? -1 : 1) * (Number(digits.slice(1, 3)) * 60 + Number(digits.slice(3, 5)));
    zoneText = `${digits[0]}${digits.slice(1, 3)}:${digits.slice(3, 5)}`;
  }
  const ms = Date.parse(
    `${date}T${match[1]}:${match[2]}:${match[3]}.${(match[4] ?? "").slice(0, 3).padEnd(3, "0")}${zoneText}`
  );
  return Number.isNaN(ms) ? null : { ms, offsetMin };
}

export async function* parseFitMetrics(
  source: ByteSource,
  fileName: string,
  stats: Stats
): AsyncGenerator<ActivityEventDraft> {
  let columns: Map<string, number> | null = null;
  const fileDate = FILE_DATE.exec(fileName)?.[1] ?? null;
  for await (const record of csvRecords(source, (end) => {
    if (end.truncated) stats.truncated = true;
  })) {
    if (!columns) {
      columns = headerIndex(record);
      if (!columns.has(STEP_COLUMN)) {
        stats.read += 1;
        skip(stats, 'file has no "Step count" column');
        return;
      }
      continue;
    }
    const stepsText = record[columns.get(STEP_COLUMN)!]?.trim() ?? "";
    if (stepsText === "") {
      stats.ignored += 1; // an interval with no step data is normal
      continue;
    }
    const steps = Number(stepsText);
    if (!Number.isFinite(steps) || steps < 0 || !Number.isInteger(steps)) {
      stats.read += 1;
      skip(stats, "step count is not a whole number");
      continue;
    }
    if (steps === 0) {
      stats.ignored += 1;
      continue;
    }
    stats.read += 1;
    const startIndex = columns.get("start time");
    const endIndex = columns.get("end time");
    const dateIndex = columns.get("date");
    if (startIndex !== undefined && endIndex !== undefined && fileDate) {
      const start = clockToUtc(fileDate, record[startIndex] ?? "");
      const end = clockToUtc(fileDate, record[endIndex] ?? "");
      if (!start || !end || end.ms < start.ms) {
        skip(stats, "start or end time is missing, has no offset, or ends before it starts");
        continue;
      }
      stats.emitted += 1;
      yield {
        id: eventKey("fit", "interval", new Date(start.ms).toISOString(), new Date(end.ms).toISOString()),
        source: "fit",
        kind: "steps",
        start: new Date(start.ms).toISOString(),
        end: new Date(end.ms).toISOString(),
        tzOffsetMin: start.offsetMin,
        attrs: { steps }
      };
      continue;
    }
    if (dateIndex !== undefined) {
      const day = (record[dateIndex] ?? "").trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) {
        skip(stats, "Date is not YYYY-MM-DD");
        continue;
      }
      const start = new Date(`${day}T00:00:00Z`);
      const end = new Date(start.getTime() + 24 * 3_600_000);
      stats.emitted += 1;
      yield {
        id: eventKey("fit", "day", day),
        source: "fit",
        kind: "steps",
        start: start.toISOString(),
        end: end.toISOString(),
        approximate: true,
        attrs: { steps, granularity: "day", date: day }
      };
      continue;
    }
    skip(stats, "row has neither a Date column nor Start/End times with the date in the file name");
  }
}
