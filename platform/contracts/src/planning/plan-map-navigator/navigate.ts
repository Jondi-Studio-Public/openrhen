import type { PlanIndex } from "./derive.js";
import {
  ALL_KINDS,
  CLOSED_STATUSES,
  ITEM_TYPES,
  type Card,
  type MapEdge,
  type MapItem,
  type StoredLink
} from "./model.js";
import { resolveStoredEnd } from "./stored.js";

/** A lookup or option the caller got wrong; `code` lets each caller map it to its own error type. */
export class PlanMapQueryError extends Error {
  constructor(
    message: string,
    readonly code: "ambiguous" | "not_found" | "unknown_kind"
  ) {
    super(message);
  }
}

export interface NavigateOptions {
  depth: number;
  /** Only follow and show these edge kinds. Empty means every kind. */
  kinds: ReadonlySet<string>;
  /** Approximate token budget for the whole answer; the root card is always kept. */
  budget: number;
  /** Stored links, already read from the link store. Suggested ones are dropped unless `includeSuggested`. */
  stored?: readonly StoredLink[];
  includeSuggested?: boolean;
  now: Date;
}

export interface Neighbourhood {
  root: Card;
  cards: Card[];
  edges: MapEdge[];
  /** Neighbours found within the depth but cut by the budget. */
  omitted: number;
  approxTokens: number;
}

/** Rough token cost of a string: four characters a token is close enough to trim a budget. */
export const approxTokens = (text: string): number => Math.ceil(text.length / 4);

/**
 * Finds one item from what an agent might type: its handle (`project:project-thesis`), a bare id, a
 * unique id prefix, or an exact title. Several matches is a usage error listing the handles, so the
 * caller can pick one.
 */
export function resolveItem(index: PlanIndex, query: string): MapItem {
  const wanted = query.trim();
  const direct = index.items.get(wanted);
  if (direct) return direct;
  const lowered = wanted.toLowerCase();
  const all = [...index.items.values()];
  const typed = ITEM_TYPES.find((type) => lowered.startsWith(`${type}:`));
  const pool = typed ? all.filter((item) => item.type === typed) : all;
  const text = typed ? lowered.slice(typed.length + 1) : lowered;
  for (const matches of [
    pool.filter((item) => item.id.toLowerCase() === text),
    pool.filter((item) => item.id.toLowerCase().startsWith(text)),
    pool.filter((item) => item.title.toLowerCase() === text)
  ]) {
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1)
      throw new PlanMapQueryError(
        `"${query}" matches several items: ${matches
          .slice(0, 8)
          .map((item) => item.handle)
          .join(", ")}${matches.length > 8 ? ", ..." : ""}. Pass a full handle.`,
        "ambiguous"
      );
  }
  throw new PlanMapQueryError(`No plan item matches "${query}".`, "not_found");
}

export function parseKinds(raw: string | undefined): Set<string> {
  const kinds = new Set<string>();
  for (const part of (raw ?? "").split(",")) {
    const kind = part.trim();
    if (kind === "") continue;
    if (!ALL_KINDS.includes(kind))
      throw new PlanMapQueryError(`Unknown link kind "${kind}". Kinds: ${ALL_KINDS.join(", ")}.`, "unknown_kind");
    kinds.add(kind);
  }
  return kinds;
}

const EDGE_TOKENS = 12;

/** Stored links that can be shown: both ends exist, and suggested ones only when asked. */
function usableStored(index: PlanIndex, options: NavigateOptions, includeSuggested: boolean): MapEdge[] {
  return (options.stored ?? [])
    .filter((link) => includeSuggested || link.status === "confirmed")
    .map((link) => ({ ...link, from: resolveStoredEnd(index, link.from), to: resolveStoredEnd(index, link.to) }))
    .filter((link) => index.items.has(link.from) && index.items.has(link.to))
    .map((link) => ({
      from: link.from,
      to: link.to,
      kind: link.kind,
      origin: "stored" as const,
      status: link.status,
      ...(link.evidence?.length ? { evidence: link.evidence.join("; ") } : {})
    }));
}

function byHandle(edges: readonly MapEdge[]): Map<string, MapEdge[]> {
  const map = new Map<string, MapEdge[]>();
  const add = (handle: string, edge: MapEdge) => {
    const list = map.get(handle);
    if (list) list.push(edge);
    else map.set(handle, [edge]);
  };
  for (const edge of edges) {
    add(edge.from, edge);
    add(edge.to, edge);
  }
  return map;
}

/** Lower sorts first: confirmed before suggested before derived judgement. */
const originRank = (edge: MapEdge): number => (edge.origin === "stored" ? (edge.status === "confirmed" ? 0 : 1) : 2);

/** Then open before done, then the nearer date. */
function itemRank(item: MapItem, now: Date): [number, number] {
  const closed = item.status !== undefined && CLOSED_STATUSES.has(item.status) ? 1 : 0;
  const date = item.when ? Math.abs(new Date(item.when).getTime() - now.getTime()) : Number.POSITIVE_INFINITY;
  return [closed, Number.isNaN(date) ? Number.POSITIVE_INFINITY : date];
}

/**
 * A card's counts come from every derived edge plus confirmed stored links, so they read the same
 * whatever `--kinds` or `--suggested` show. `own` is that item's edges only.
 */
function cardFor(item: MapItem, index: PlanIndex, own: readonly MapEdge[]): Card {
  let steps = 0;
  let openBlockers = 0;
  let links = 0;
  for (const edge of own) {
    if (edge.kind !== "parent_child") links += 1;
    else if (edge.from === item.handle) {
      if (edge.to.startsWith("step:") || edge.to.startsWith("action:")) steps += 1;
      else if (edge.to.startsWith("blocker:")) {
        const status = index.items.get(edge.to)?.status;
        if (status !== undefined && !CLOSED_STATUSES.has(status)) openBlockers += 1;
      }
    }
  }
  const parent = item.parent ? index.items.get(item.parent) : undefined;
  return {
    handle: item.handle,
    type: item.type,
    title: item.title,
    status: item.status ?? null,
    when: item.when ?? null,
    parent: parent ? parent.title : null,
    steps,
    openBlockers,
    links,
    detail: item.detail ?? null
  };
}

/** What a card will cost, estimated from the item alone so a card is only built once it is known to fit. */
function itemCost(item: MapItem, index: PlanIndex): number {
  const parent = item.parent ? index.items.get(item.parent)?.title : undefined;
  const text = [item.handle, item.title, item.status, item.when, parent, item.detail].filter(Boolean).join(" ");
  return approxTokens(text) + 8;
}

export function navigate(index: PlanIndex, root: MapItem, options: NavigateOptions): Neighbourhood {
  // Counts use the unfiltered edges; traversal and display use the filtered ones.
  const countEdges = byHandle([...index.edges, ...usableStored(index, options, false)]);
  const shownEdges = [...index.edges, ...usableStored(index, options, options.includeSuggested ?? false)].filter(
    (edge) => options.kinds.size === 0 || options.kinds.has(edge.kind)
  );
  const adjacency = byHandle(shownEdges);

  const cardOf = (item: MapItem): Card => cardFor(item, index, countEdges.get(item.handle) ?? []);
  const rootCard = cardOf(root);
  const included = new Map<string, Card>([[root.handle, rootCard]]);
  let used = itemCost(root, index);
  let omitted = 0;
  let frontier = [root.handle];
  const seen = new Set(frontier);

  for (let layer = 1; layer <= options.depth && frontier.length > 0; layer += 1) {
    // Each neighbour is ranked by the best edge that reaches it from the frontier, not the first one found.
    const found = new Map<string, number>();
    for (const handle of frontier)
      for (const edge of adjacency.get(handle) ?? []) {
        const other = edge.from === handle ? edge.to : edge.from;
        if (seen.has(other)) continue;
        found.set(other, Math.min(found.get(other) ?? Number.POSITIVE_INFINITY, originRank(edge)));
      }
    for (const handle of found.keys()) seen.add(handle);
    const ranked = [...found]
      .map(([handle, origin]) => ({
        item: index.items.get(handle)!,
        origin,
        rest: itemRank(index.items.get(handle)!, options.now)
      }))
      .sort(
        (a, b) =>
          a.origin - b.origin ||
          a.rest[0] - b.rest[0] ||
          a.rest[1] - b.rest[1] ||
          a.item.handle.localeCompare(b.item.handle)
      );
    const next: string[] = [];
    let full = false;
    for (const { item } of ranked) {
      // The edge lines this neighbour adds to the answer count against the budget with its card.
      const joining = (adjacency.get(item.handle) ?? []).filter((edge) =>
        included.has(edge.from === item.handle ? edge.to : edge.from)
      ).length;
      const cost = itemCost(item, index) + joining * EDGE_TOKENS;
      if (full || used + cost > options.budget) {
        full = true;
        omitted += 1;
        continue;
      }
      used += cost;
      included.set(item.handle, cardOf(item));
      next.push(item.handle);
    }
    frontier = next;
  }

  return {
    root: rootCard,
    cards: [...included.values()].filter((card) => card.handle !== root.handle),
    edges: shownEdges.filter((edge) => included.has(edge.from) && included.has(edge.to)),
    omitted,
    approxTokens: used
  };
}
