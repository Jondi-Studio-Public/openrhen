import { csvRecords, headerIndex } from "../csv-stream.js";
import { jsonArrayObjects } from "../json-stream.js";
import { eventKey } from "../keys.js";
import { parseTimestamp } from "../time.js";
import { skip, type ActivityEventDraft, type ByteSource, type Stats } from "../types.js";

/**
 * A Discord data package: `messages/c<channel id>/messages.csv` (columns ID, Timestamp, Contents, Attachments) or
 * `messages.json` (an array of `{ID, Timestamp, Contents, Attachments}`). The package holds only the messages its
 * owner sent, so every row is a `message` with `from_self: true` and `direction: "out"`; the channel id is
 * `attrs.thread_id`, the same shape the Gmail source uses. The text is the content; attachment links are not kept,
 * only whether there was one. Timestamps look like `2026-01-02 03:04:05.123456+00:00` (UTC, so the local offset
 * is left unknown). The key is the message id, a Discord snowflake that is unique on its own.
 */
const SNOWFLAKE = /^\d{5,25}$/;

interface RawMessage {
  id: unknown;
  timestamp: unknown;
  contents: unknown;
  attachments: unknown;
}

function toEvent(channelId: string, raw: RawMessage, stats: Stats): ActivityEventDraft | null {
  const id = typeof raw.id === "number" ? String(raw.id) : raw.id;
  if (typeof id !== "string" || !SNOWFLAKE.test(id.trim())) {
    skip(stats, "message ID is missing or not a Discord id");
    return null;
  }
  const time = parseTimestamp(raw.timestamp, { utcOffsetIsUnknown: true });
  if (!time) {
    skip(stats, "Timestamp is missing or has no time zone");
    return null;
  }
  const text = typeof raw.contents === "string" ? raw.contents : "";
  const attachments =
    typeof raw.attachments === "string"
      ? raw.attachments.trim() !== ""
      : Array.isArray(raw.attachments) && raw.attachments.length > 0;
  stats.emitted += 1;
  return {
    id: eventKey("discord-package", id.trim()),
    source: "discord-package",
    kind: "message",
    start: time.date.toISOString(),
    attrs: {
      thread_id: channelId,
      message_id: id.trim(),
      from_self: true,
      direction: "out",
      has_attachments: attachments
    },
    ...(text.trim() === "" ? {} : { content: text })
  };
}

export async function* parseDiscordMessagesCsv(
  source: ByteSource,
  channelId: string,
  stats: Stats
): AsyncGenerator<ActivityEventDraft> {
  let columns: Map<string, number> | null = null;
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
    if (!columns) {
      columns = headerIndex(record);
      if (!columns.has("id") || !columns.has("timestamp")) {
        stats.read += 1;
        skip(stats, "messages.csv header has no ID and Timestamp columns");
        return;
      }
      continue;
    }
    stats.read += 1;
    const at = (name: string) => (columns!.has(name) ? record[columns!.get(name)!] : undefined);
    const event = toEvent(
      channelId,
      { id: at("id"), timestamp: at("timestamp"), contents: at("contents"), attachments: at("attachments") },
      stats
    );
    if (event) yield event;
  }
}

export async function* parseDiscordMessagesJson(
  source: ByteSource,
  channelId: string,
  stats: Stats
): AsyncGenerator<ActivityEventDraft> {
  for await (const element of jsonArrayObjects(source, (end) => {
    if (end.truncated) stats.truncated = true;
  })) {
    stats.read += 1;
    const row = element.ok ? (element.value as Record<string, unknown>) : null;
    if (!row) {
      skip(stats, "row is not valid JSON");
      continue;
    }
    const pick = (name: string) => row[name] ?? row[name.toLowerCase()];
    const event = toEvent(
      channelId,
      { id: pick("ID"), timestamp: pick("Timestamp"), contents: pick("Contents"), attachments: pick("Attachments") },
      stats
    );
    if (event) yield event;
  }
}

/** The channel id of a package folder name: `c1234567890` (current) or `1234567890` (older), else null. */
export function channelIdFromFolder(folder: string): string | null {
  const match = /^c?(\d{5,25})$/.exec(folder);
  return match ? match[1]! : null;
}
