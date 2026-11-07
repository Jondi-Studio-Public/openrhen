import { eventKey, DupCounter } from "../keys.js";
import { jsonArrayObjects } from "../json-stream.js";
import { plausible } from "../time.js";
import { skip, type ActivityEventDraft, type ByteSource, type Stats } from "../types.js";

/**
 * Chrome history from Google Takeout: `Chrome/BrowserHistory.json`, `{"Browser History": [ {...} ]}`.
 * Each row is a `visit`: an instant at `time_usec` (microseconds since the Unix epoch). The page URL and title are
 * content (line one the URL, line two the title); the navigation type (`LINK`, `TYPED`, ...) is an attribute.
 * Two visits with the same microsecond and URL get a `dup_index` in their key, so both survive and a re-import
 * still matches. A time outside 1995 to tomorrow is skipped, not converted: a value in Chrome's own 1601 epoch
 * would land in the far future, and guessing the epoch would shift every row.
 */
const TRANSITION = /^[A-Z][A-Z0-9_]{0,39}$/;

export async function* parseChromeHistory(
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
    const raw = row.time_usec;
    const micros =
      typeof raw === "number" ? raw : typeof raw === "string" && /^\d{10,20}$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isFinite(micros) || micros <= 0) {
      skip(stats, "time_usec is missing or not a number");
      continue;
    }
    const date = new Date(Math.floor(micros / 1000));
    if (Number.isNaN(date.getTime()) || !plausible(date, now)) {
      skip(stats, "time_usec is outside 1995 to tomorrow (expected microseconds since 1970)");
      continue;
    }
    const url = typeof row.url === "string" ? row.url.trim() : "";
    if (!url) {
      skip(stats, "url is missing");
      continue;
    }
    const identity = `${micros}\u001f${url}`;
    const dup = dups.next(identity);
    const title = typeof row.title === "string" ? row.title.replace(/\s+/g, " ").trim() : "";
    const attrs: Record<string, unknown> = {};
    if (typeof row.page_transition === "string" && TRANSITION.test(row.page_transition))
      attrs.transition = row.page_transition;
    if (dup > 0) attrs.dup_index = dup;
    stats.emitted += 1;
    yield {
      id: eventKey("chrome-takeout", micros, url, dup),
      source: "chrome-takeout",
      kind: "visit",
      start: date.toISOString(),
      attrs,
      content: title ? `${url}\n${title}` : url
    };
  }
}
