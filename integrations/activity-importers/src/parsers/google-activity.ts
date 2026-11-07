import { eventKey, DupCounter } from "../keys.js";
import { jsonArrayObjects } from "../json-stream.js";
import { parseTimestamp } from "../time.js";
import { skip, type ActivityEventDraft, type ByteSource, type Stats } from "../types.js";

/**
 * Google My Activity from Takeout: `My Activity/<product>/MyActivity.json`, a top-level array of
 * `{header, title, titleUrl?, time, products}`. The product is the folder the file sits in. The title's verb is
 * stripped and decides the kind: "Searched for x" is a `search`, "Visited x" or "Viewed x" a `view`, "Prompted x"
 * or "Said x" an `ask`. The stripped text is the content. Any other title (a verb this importer does not know) is
 * skipped and counted under its reason, because guessing its kind would put wrong rows in the store.
 * YouTube and YouTube Music folders are ignored: their history is imported by the watch-history route.
 */
const PREFIXES: readonly (readonly [string, "search" | "view" | "ask"])[] = [
  ["Searched for ", "search"],
  ["Visited ", "view"],
  ["Viewed ", "view"],
  ["Prompted ", "ask"],
  ["Said ", "ask"]
];

const YOUTUBE_PRODUCTS = new Set(["youtube", "youtube music"]);

export async function* parseGoogleActivity(
  source: ByteSource,
  product: string,
  stats: Stats
): AsyncGenerator<ActivityEventDraft> {
  const productName = product.trim();
  const dups = new DupCounter();
  for await (const element of jsonArrayObjects(source, (end) => {
    if (end.truncated) stats.truncated = true;
  })) {
    if (YOUTUBE_PRODUCTS.has(productName.toLowerCase())) {
      stats.ignored += 1;
      continue;
    }
    stats.read += 1;
    const row = element.ok ? (element.value as Record<string, unknown>) : null;
    if (!row) {
      skip(stats, "row is not valid JSON");
      continue;
    }
    const time = parseTimestamp(row.time, { utcOffsetIsUnknown: true });
    if (!time) {
      skip(stats, "time is missing or has no time zone");
      continue;
    }
    const title = typeof row.title === "string" ? row.title.replace(/[\u00a0\u202f]/g, " ") : "";
    const match = PREFIXES.find(([prefix]) => title.startsWith(prefix));
    if (!match) {
      skip(stats, "title starts with a verb this importer does not know");
      continue;
    }
    const text = title.slice(match[0].length).replace(/\s+/g, " ").trim();
    if (!text) {
      skip(stats, "nothing follows the verb in the title");
      continue;
    }
    const dup = dups.next(`${productName}\u001f${time.date.getTime()}\u001f${title}`);
    const attrs: Record<string, unknown> = { product: productName };
    if (dup > 0) attrs.dup_index = dup;
    stats.emitted += 1;
    yield {
      id: eventKey("google-activity", productName, time.date.toISOString(), title, dup),
      source: "google-activity",
      kind: match[1],
      start: time.date.toISOString(),
      attrs,
      content: text
    };
  }
}
