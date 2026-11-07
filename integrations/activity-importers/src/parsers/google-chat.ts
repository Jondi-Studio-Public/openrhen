import { eventKey } from "../keys.js";
import { jsonArrayObjects } from "../json-stream.js";
import { readText } from "../chunks.js";
import { plausible } from "../time.js";
import { skip, type ActivityEventDraft, type ByteSource, type Stats } from "../types.js";

/**
 * Google Chat from Takeout, UNVERIFIED against a real export: `Google Chat/Groups/<space folder>/messages.json`,
 * `{"messages": [{creator: {name, email, user_type}, created_date, message_id, topic_id?, text?, attached_files?}]}`.
 * The folder name is `Space <id>` or `DM <id>`; the id is `attrs.thread_id` (the shape Gmail and Discord use). Each
 * message is a `message`: text is the content (and only the text; annotations and attachment names are never
 * kept), the sender's address is `from`. The owner is known only from `Google Chat/Users/<id>/user_info.json`; when
 * it is not in the export `from_self` and `direction` are left out rather than guessed.
 * `created_date` is English text ("Monday, January 2, 2023 at 3:04:05 PM UTC"). Only that form and the
 * day-month-year form, with the zone written as UTC, are read; any other wording or zone is skipped and counted,
 * because reading it would mean guessing the language or the zone.
 */
const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december"
];

const MDY = /^(?:[a-z]+,\s+)?([a-z]+)\s+(\d{1,2}),\s+(\d{4})\s+at\s+(\d{1,2}):(\d{2}):(\d{2})\s*([ap]m)?\s+utc$/i;
const DMY = /^(?:[a-z]+,\s+)?(\d{1,2})\s+([a-z]+)\s+(\d{4})\s+at\s+(\d{1,2}):(\d{2}):(\d{2})\s*([ap]m)?\s+utc$/i;

/** Chat's `created_date`, or null for any wording or zone this does not know. */
export function parseChatDate(value: unknown, now: Date = new Date()): Date | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/[  \s]+/g, " ").trim();
  let monthName: string;
  let day: string;
  let year: string;
  let hour: string;
  let minute: string;
  let second: string;
  let meridiem: string | undefined;
  const mdy = MDY.exec(text);
  const dmy = mdy ? null : DMY.exec(text);
  if (mdy) [, monthName = "", day = "", year = "", hour = "", minute = "", second = "", meridiem] = mdy;
  else if (dmy) [, day = "", monthName = "", year = "", hour = "", minute = "", second = "", meridiem] = dmy;
  else return null;
  const month = MONTHS.indexOf(monthName.toLowerCase());
  if (month < 0) return null;
  let h = Number(hour);
  if (meridiem) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (meridiem.toLowerCase() === "pm" ? 12 : 0);
  }
  const [d, mi, s, y] = [Number(day), Number(minute), Number(second), Number(year)];
  if (h > 23 || mi > 59 || s > 59 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, month, d, h, mi, s));
  // A day that does not exist (31 February) rolls over; refuse it.
  if (date.getUTCMonth() !== month || date.getUTCDate() !== d) return null;
  return plausible(date, now) ? date : null;
}

/** The owner's address from `Google Chat/Users/<id>/user_info.json` (`{"user": {"name", "email", "user_type"}}`), or null. */
export async function parseChatOwner(source: ByteSource): Promise<string | null> {
  try {
    const document = JSON.parse(await readText(source, 1024 * 1024)) as { user?: { email?: unknown } } | null;
    const email = document?.user?.email;
    return typeof email === "string" && email.includes("@") ? email.trim().toLowerCase() : null;
  } catch {
    return null;
  }
}

/** `Space AAAA1234` and `DM AAAA1234` give the id; any other folder name is used whole. */
export function chatSpaceId(folder: string): string | null {
  const id = folder.replace(/^(?:space|dm|group)\s+/i, "").trim();
  return id && id.length <= 120 ? id : null;
}

export async function* parseGoogleChatMessages(
  source: ByteSource,
  spaceId: string,
  ownerEmail: string | null,
  stats: Stats,
  now: Date = new Date()
): AsyncGenerator<ActivityEventDraft> {
  for await (const element of jsonArrayObjects(source, (end) => {
    if (end.truncated) stats.truncated = true;
  })) {
    stats.read += 1;
    const row =
      element.ok && element.value !== null && typeof element.value === "object"
        ? (element.value as Record<string, unknown>)
        : null;
    if (!row) {
      skip(stats, "row is not valid JSON");
      continue;
    }
    const messageId = typeof row.message_id === "string" ? row.message_id.trim() : "";
    if (!messageId || messageId.length > 150) {
      skip(stats, "message_id is missing");
      continue;
    }
    const date = parseChatDate(row.created_date, now);
    if (!date) {
      skip(stats, "created_date is missing, in a form this importer does not read, or not in UTC");
      continue;
    }
    const creator = (row.creator ?? {}) as Record<string, unknown>;
    const email =
      typeof creator.email === "string" && creator.email.includes("@") ? creator.email.trim().toLowerCase() : "";
    const attrs: Record<string, unknown> = { thread_id: spaceId, message_id: messageId };
    if (email) attrs.from = email;
    if (email && ownerEmail) {
      attrs.from_self = email === ownerEmail;
      attrs.direction = email === ownerEmail ? "out" : "in";
    }
    if (typeof row.topic_id === "string" && row.topic_id.length <= 150) attrs.topic_id = row.topic_id;
    attrs.has_attachments = Array.isArray(row.attached_files) && row.attached_files.length > 0;
    const text = typeof row.text === "string" ? row.text : "";
    stats.emitted += 1;
    yield {
      id: eventKey("google-chat", spaceId, messageId),
      source: "google-chat",
      kind: "message",
      start: date.toISOString(),
      attrs,
      ...(text.trim() === "" ? {} : { content: text })
    };
  }
}
