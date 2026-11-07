import { csvRecords, headerIndex } from "../csv-stream.js";
import { jsonArrayObjects } from "../json-stream.js";
import { eventKey, DupCounter } from "../keys.js";
import { parseTimestamp, plausible } from "../time.js";
import { skip, type ActivityEventDraft, type ByteSource, type Stats } from "../types.js";

/**
 * Google "Access Log Activity" from Takeout, UNVERIFIED against a real export: the activity log of account
 * accesses, a CSV (or JSON) with a timestamp, a product name and an activity type per row. Each row is an
 * `access`: the product and activity type are attributes, nothing else. The IP address and user-agent columns are
 * never read, so they cannot reach the store (no importer here reads an IP). A time is read only as ISO text with a
 * zone or as `YYYY-MM-DD HH:MM:SS UTC`; anything else is skipped and counted. Columns are found by header name, so
 * extra or reordered columns do not matter.
 */
const UTC_TEXT = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s*UTC$/i;
const LABEL = /^[\p{L}\p{N} ._:/()&+-]{1,80}$/u;

function accessTime(value: unknown, now: Date): Date | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  const utc = UTC_TEXT.exec(text);
  const parsed = parseTimestamp(utc ? `${utc[1]}T${utc[2]}Z` : text, { utcOffsetIsUnknown: true });
  return parsed && plausible(parsed.date, now) ? parsed.date : null;
}

function toEvent(
  row: { time: unknown; product: unknown; activity: unknown },
  dups: DupCounter,
  stats: Stats,
  now: Date
): ActivityEventDraft | null {
  const date = accessTime(row.time, now);
  if (!date) {
    skip(stats, "timestamp is missing, or not ISO text with a time zone or text ending in UTC");
    return null;
  }
  const label = (value: unknown) =>
    typeof value === "string" && LABEL.test(value.replace(/\s+/g, " ").trim()) ? value.replace(/\s+/g, " ").trim() : "";
  const product = label(row.product);
  const activity = label(row.activity);
  if (!product && !activity) {
    skip(stats, "row has neither a product nor an activity type");
    return null;
  }
  const iso = date.toISOString();
  const dup = dups.next(`${iso}\u001f${product}\u001f${activity}`);
  const attrs: Record<string, unknown> = {};
  if (product) attrs.product = product;
  if (activity) attrs.activity_type = activity;
  if (dup > 0) attrs.dup_index = dup;
  stats.emitted += 1;
  return {
    id: eventKey("google-access-log", iso, product, activity, dup),
    source: "google-access-log",
    kind: "access",
    start: iso,
    attrs
  };
}

const TIME_NAMES = ["activity timestamp", "timestamp", "time", "date", "activity time"];
const PRODUCT_NAMES = ["product name", "product", "service", "product / service"];
const ACTIVITY_NAMES = ["activity type", "activity", "event", "event name", "activity event"];

const firstOf = (columns: Map<string, number>, names: string[]) => {
  for (const name of names) if (columns.has(name)) return columns.get(name)!;
  return -1;
};

export async function* parseAccessLogCsv(
  source: ByteSource,
  stats: Stats,
  now: Date = new Date()
): AsyncGenerator<ActivityEventDraft> {
  const dups = new DupCounter();
  let positions: { time: number; product: number; activity: number } | null = null;
  for await (const record of csvRecords(
    source,
    (end) => {
      if (end.truncated) stats.truncated = true;
    },
    () => {
      stats.read += 1;
      skip(stats, "a field is larger than 1 MB");
    }
  )) {
    if (!positions) {
      const columns = headerIndex(record);
      positions = {
        time: firstOf(columns, TIME_NAMES),
        product: firstOf(columns, PRODUCT_NAMES),
        activity: firstOf(columns, ACTIVITY_NAMES)
      };
      if (positions.time < 0) {
        stats.read += 1;
        skip(stats, "header has no timestamp column");
        return;
      }
      continue;
    }
    stats.read += 1;
    const at = (position: number) => (position >= 0 ? record[position] : undefined);
    const event = toEvent(
      { time: at(positions.time), product: at(positions.product), activity: at(positions.activity) },
      dups,
      stats,
      now
    );
    if (event) yield event;
  }
}

export async function* parseAccessLogJson(
  source: ByteSource,
  stats: Stats,
  now: Date = new Date()
): AsyncGenerator<ActivityEventDraft> {
  const dups = new DupCounter();
  for await (const element of jsonArrayObjects(source, (end) => {
    if (end.truncated) stats.truncated = true;
  })) {
    stats.read += 1;
    const row = element.ok ? (element.value as Record<string, unknown>) : null;
    if (!row) {
      skip(stats, "row is not valid JSON");
      continue;
    }
    const byName = new Map<string, unknown>(
      Object.entries(row).map(([key, value]) => [key.trim().toLowerCase(), value])
    );
    const pick = (names: string[]) => names.map((name) => byName.get(name)).find((value) => value !== undefined);
    const event = toEvent(
      { time: pick(TIME_NAMES), product: pick(PRODUCT_NAMES), activity: pick(ACTIVITY_NAMES) },
      dups,
      stats,
      now
    );
    if (event) yield event;
  }
}
