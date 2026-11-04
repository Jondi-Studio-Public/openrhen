import type { CaptureItem } from "@/state/portal-state";
import { mailSource } from "@/state/extensions";

/** A pending change from a reasoned thread of the registered mail source: what the Emails window owns. */
export function isEmailThreadChange(item: CaptureItem): boolean {
  return item.proposalType === "email_change" && Boolean(item.sourceId) && Boolean(mailSource()?.claims(item));
}

/** Changes that share a source become one thread card, in the position of the thread's first change. */
export function groupEmailThreads(items: CaptureItem[]): { sourceId: string; items: CaptureItem[] }[] {
  const groups = new Map<string, CaptureItem[]>();
  for (const item of items) {
    if (!item.sourceId) continue;
    const bucket = groups.get(item.sourceId);
    if (bucket) bucket.push(item);
    else groups.set(item.sourceId, [item]);
  }
  return [...groups].map(([sourceId, grouped]) => ({ sourceId, items: grouped }));
}
