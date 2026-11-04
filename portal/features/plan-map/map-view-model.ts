import { CLOSED_STATUSES, isClosedStatus } from "@openrhen/contracts";
import {
  buildPlanIndex,
  navigate,
  resolveItem,
  toStoredLinks,
  type Card,
  type MapEdge,
  type PlanIndex
} from "@openrhen/contracts/plan-map-navigator";
import type { PlanMap } from "@openrhen/contracts";
import { formatZonedDate } from "@/shared/date-format";
import { projectsForArea, sortedAreas } from "@/features/plan/area-grouping";
import type { PortalState } from "@/state/portal-state";

/**
 * The pure half of the map page. The neighbourhood comes from the same navigator the CLI's `map` command
 * uses (`@openrhen/contracts/plan-map-navigator`), so the page and an agent read one set of rules for
 * cards, ranking and edges. This file only adds what a picture needs: which controls feed the call, how
 * an edge is told apart by eye, and where each card sits. Nothing here writes.
 */

export interface MapControls {
  depth: 1 | 2 | 3;
  /** Suggested links, drawn dashed. On by default (owner decision, 2026-10-01). */
  showSuggested: boolean;
  /** Links computed from the plan itself: the tree, dependencies, shared places and so on. */
  showDerived: boolean;
}

export const DEFAULT_CONTROLS: MapControls = { depth: 1, showSuggested: true, showDerived: true };

/** A picture holds about this many cards before it stops being readable; the rest are counted, not drawn. */
export const MAP_BUDGET = 3500;

export type EdgeLook = "confirmed" | "suggested" | "derived";

/** How an edge is drawn and named. Solid and bold for confirmed, dashed for suggested, thin and quiet for derived. */
export const edgeLook = (edge: Pick<MapEdge, "origin" | "status">): EdgeLook =>
  edge.origin === "derived" ? "derived" : edge.status === "suggested" ? "suggested" : "confirmed";

export const EDGE_LOOK_LABELS: Record<EdgeLook, string> = {
  confirmed: "confirmed",
  suggested: "suggested",
  derived: "from the plan"
};

const KIND_LABELS: Record<string, string> = {
  parent_child: "contains",
  depends_on: "depends on",
  criterion: "counts toward criterion",
  blocker: "blocked by",
  prep: "prepares for",
  same_source: "shares a source with",
  same_place: "shares a place with",
  same_contact: "shares a contact with",
  about: "is about",
  counts_toward: "counts toward",
  prepares: "prepares",
  before: "comes before",
  occurrence_of: "is an occurrence of",
  involves: "involves",
  references: "references"
};
export const edgeKindLabel = (kind: string): string => KIND_LABELS[kind] ?? kind.replaceAll("_", " ");

export interface MapView {
  index: PlanIndex;
  rootHandle: string | null;
  /** Why there is no root: an item that is not in the plan any more, say. */
  problem: string | null;
  root: Card | null;
  cards: Card[];
  edges: MapEdge[];
  omitted: number;
}

const empty = (index: PlanIndex, rootHandle: string | null, problem: string | null): MapView => ({
  index,
  rootHandle,
  problem,
  root: null,
  cards: [],
  edges: [],
  omitted: 0
});

/** Everything the page draws, for one item, computed from the current plan and links on every call. */
export function buildMapView(
  state: object,
  planMap: Pick<PlanMap, "links" | "subjects"> | null,
  rootHandle: string | null,
  controls: MapControls,
  now: Date
): MapView {
  const index = buildPlanIndex(state, { subjects: planMap?.subjects ?? [] });
  if (!rootHandle) return empty(index, null, null);
  let item;
  try {
    item = resolveItem(index, rootHandle);
  } catch {
    return empty(index, rootHandle, "That item is not in the plan any more.");
  }
  const result = navigate(index, item, {
    depth: controls.depth,
    kinds: new Set(),
    budget: MAP_BUDGET,
    stored: toStoredLinks(planMap?.links ?? []),
    includeSuggested: controls.showSuggested,
    now
  });
  // Archived and cancelled items have left the plan: the map does not draw them around a live centre
  // (centring on one directly still works, so an old link can be looked up).
  const gone = new Set(result.cards.filter((card) => isClosedStatus(card.status)).map((card) => card.handle));
  const kept = result.edges.filter((edge) => !gone.has(edge.from) && !gone.has(edge.to));
  // A card reached only through a dropped one would float unjoined, so keep just what the root still reaches.
  const reached = new Set([item.handle]);
  for (let grew = true; grew;) {
    grew = false;
    for (const edge of kept) {
      const [near, far] = reached.has(edge.from) ? [edge.from, edge.to] : [edge.to, edge.from];
      if (reached.has(near) && !reached.has(far)) {
        reached.add(far);
        grew = true;
      }
    }
  }
  const cards = result.cards.filter((card) => reached.has(card.handle));
  const shown = controls.showDerived ? kept : kept.filter((edge) => edge.origin === "stored");
  const edges = shown.filter((edge) => reached.has(edge.from) && reached.has(edge.to));
  return {
    index,
    rootHandle: item.handle,
    problem: null,
    root: result.root,
    cards,
    edges,
    omitted: result.omitted
  };
}

export type MapStartGroup = "Areas" | "Outcomes" | "Projects" | "Subjects";

/** The plan's own tree first, broadest to narrowest, then the subjects that cut across it. */
export const START_GROUPS: readonly MapStartGroup[] = ["Areas", "Outcomes", "Projects", "Subjects"];

const START_TYPES: Record<string, MapStartGroup> = {
  area: "Areas",
  outcome: "Outcomes",
  project: "Projects",
  subject: "Subjects"
};

/**
 * The areas, outcomes, projects and subjects a person can start a map from, in that order. Archived
 * items are left out: they have left the plan, so they are not where anyone starts looking.
 */
export function mapStarts(view: Pick<MapView, "index">): { handle: string; title: string; group: MapStartGroup }[] {
  const starts: { handle: string; title: string; group: MapStartGroup }[] = [];
  for (const item of view.index.items.values()) {
    const group = START_TYPES[item.type];
    if (group && item.status !== "archived") starts.push({ handle: item.handle, title: item.title, group });
  }
  return starts.sort(
    (a, b) => START_GROUPS.indexOf(a.group) - START_GROUPS.indexOf(b.group) || a.title.localeCompare(b.title)
  );
}

const CLOSED = new Set(["done", ...CLOSED_STATUSES]);

/**
 * Where `/map` opens when no item is named: the live area with the most work still open in it — one
 * for each open project, plus one for each open action in those projects. Ties go to the area `/plan`
 * lists first. An empty plan, or one where nothing is open, has no busiest area, and the page starts
 * from its list instead.
 */
export function busiestAreaHandle(
  state: Pick<PortalState, "areas" | "outcomes" | "projects" | "actions">
): string | null {
  const openActions = new Map<string, number>();
  for (const action of state.actions)
    if (!CLOSED.has(action.status)) openActions.set(action.projectId, (openActions.get(action.projectId) ?? 0) + 1);
  let best: { id: string; score: number } | null = null;
  for (const area of sortedAreas(state.areas)) {
    if (area.status === "archived") continue;
    const score = projectsForArea(area.id, state.projects, state.outcomes, state.areas)
      .filter((project) => !CLOSED.has(project.status))
      .reduce((sum, project) => sum + 1 + (openActions.get(project.id) ?? 0), 0);
    if (score > 0 && (!best || score > best.score)) best = { id: area.id, score };
  }
  return best ? `area:${best.id}` : null;
}

export const CARD_WIDTH = 168;
export const CARD_HEIGHT = 52;
const COLUMN_GAP = 96;
const ROW_GAP = 14;
const PAD = 16;

export interface PlacedCard {
  card: Card;
  x: number;
  y: number;
  /** 0 for the root, otherwise how many links out it is. */
  distance: number;
  side: "left" | "right" | "centre";
}

export interface MapLayout {
  width: number;
  height: number;
  placed: PlacedCard[];
  byHandle: Map<string, PlacedCard>;
}

/**
 * Columns, not rings: the root in the middle, its neighbours in the columns either side, theirs further
 * out. A column stacks cards at a fixed height, so cards can never overlap however many there are, and a
 * card sits on the side of the neighbour it was reached through, which keeps the lines short.
 */
export function layoutMap(root: Card, cards: readonly Card[], edges: readonly MapEdge[]): MapLayout {
  const neighbours = new Map<string, string[]>();
  const connect = (a: string, b: string) => {
    neighbours.set(a, [...(neighbours.get(a) ?? []), b]);
    neighbours.set(b, [...(neighbours.get(b) ?? []), a]);
  };
  for (const edge of edges) connect(edge.from, edge.to);

  const distance = new Map<string, number>([[root.handle, 0]]);
  const via = new Map<string, string>();
  let frontier = [root.handle];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const handle of frontier)
      for (const other of neighbours.get(handle) ?? []) {
        if (distance.has(other)) continue;
        distance.set(other, (distance.get(handle) ?? 0) + 1);
        via.set(other, handle);
        next.push(other);
      }
    frontier = next;
  }

  // A card no drawn edge reaches (its only link was filtered out) hangs beside the root, one step out.
  const sideOf = new Map<string, "left" | "right">();
  let flip: "left" | "right" = "right";
  const columns = new Map<string, Card[]>();
  const place = (card: Card, d: number) => {
    const parentSide = via.has(card.handle) ? sideOf.get(via.get(card.handle)!) : undefined;
    let side = parentSide;
    if (!side) {
      side = flip;
      flip = flip === "right" ? "left" : "right";
    }
    sideOf.set(card.handle, side);
    const key = `${side}:${d}`;
    columns.set(key, [...(columns.get(key) ?? []), card]);
  };
  const ordered = [...cards].sort((a, b) => (distance.get(a.handle) ?? 1) - (distance.get(b.handle) ?? 1));
  for (const card of ordered) place(card, distance.get(card.handle) ?? 1);

  const maxDistance = Math.max(1, ...[...columns.keys()].map((key) => Number(key.split(":")[1])));
  const rows = Math.max(1, ...[...columns.values()].map((column) => column.length));
  const height = PAD * 2 + rows * CARD_HEIGHT + (rows - 1) * ROW_GAP;
  const step = CARD_WIDTH + COLUMN_GAP;
  const centreX = PAD + maxDistance * step;
  const placed: PlacedCard[] = [{ card: root, x: centreX, y: (height - CARD_HEIGHT) / 2, distance: 0, side: "centre" }];
  for (const [key, column] of columns) {
    const [side, d] = key.split(":") as ["left" | "right", string];
    const span = column.length * CARD_HEIGHT + (column.length - 1) * ROW_GAP;
    const top = (height - span) / 2;
    column.forEach((card, row) =>
      placed.push({
        card,
        x: side === "right" ? centreX + Number(d) * step : centreX - Number(d) * step,
        y: top + row * (CARD_HEIGHT + ROW_GAP),
        distance: Number(d),
        side
      })
    );
  }
  // Trim to the columns actually used, so a map with neighbours on one side only does not keep an empty
  // column on the other (which pushed the root off-screen on a phone), and pad both edges the same.
  const left = Math.min(...placed.map((entry) => entry.x));
  const right = Math.max(...placed.map((entry) => entry.x + CARD_WIDTH));
  for (const entry of placed) entry.x += PAD - left;
  const width = right - left + PAD * 2;
  return { width, height, placed, byHandle: new Map(placed.map((entry) => [entry.card.handle, entry])) };
}

/** An SVG path between two placed cards: facing sides when they are in different columns, a bulge round the outside when they share one. */
export function edgePath(from: PlacedCard, to: PlacedCard): string {
  const fy = from.y + CARD_HEIGHT / 2;
  const ty = to.y + CARD_HEIGHT / 2;
  if (from.x === to.x) {
    const right = from.side !== "left";
    const edgeX = right ? from.x + CARD_WIDTH : from.x;
    const bulge = right ? edgeX + 40 : edgeX - 40;
    return `M ${edgeX} ${fy} C ${bulge} ${fy}, ${bulge} ${ty}, ${edgeX} ${ty}`;
  }
  const fromRight = to.x > from.x;
  const sx = fromRight ? from.x + CARD_WIDTH : from.x;
  const tx = fromRight ? to.x : to.x + CARD_WIDTH;
  const mid = (sx + tx) / 2;
  return `M ${sx} ${fy} C ${mid} ${fy}, ${mid} ${ty}, ${tx} ${ty}`;
}

/** One line a person or a screen reader can read for a card. */
/** A stored word read as plain text: "in_progress" becomes "in progress". */
export const humanise = (value: string): string => value.replaceAll("_", " ");

export function describeCard(card: Card, timezone: string): string {
  const parts: string[] = [humanise(card.type)];
  if (card.status) parts.push(humanise(card.status));
  if (card.when) parts.push(`${card.type === "commitment" ? "at" : "due"} ${formatZonedDate(card.when, timezone)}`);
  return parts.join(", ");
}

/** The handle a map was opened for, from `?item=`; anything else is no item. */
export function itemFromSearch(search: string): string | null {
  const value = new URLSearchParams(search).get("item");
  return value && value.includes(":") ? value : null;
}
export const mapHref = (handle: string): string => `/map?item=${encodeURIComponent(handle)}`;

/**
 * The map's controls as the address carries them, so a bookmarked or shared map opens drawn the same
 * way: `depth=2|3`, `suggested=0`, `plan=0`. Anything absent or unreadable keeps its default.
 */
export function controlsFromSearch(search: string): MapControls {
  const params = new URLSearchParams(search);
  const depth = Number(params.get("depth"));
  return {
    depth: depth === 2 || depth === 3 ? depth : DEFAULT_CONTROLS.depth,
    showSuggested: params.get("suggested") !== "0",
    showDerived: params.get("plan") !== "0"
  };
}

/** The address for a map centred on `handle` (or on nothing) and drawn with `controls`; defaults are left out. */
export function mapAddress(handle: string | null, controls: MapControls): string {
  const params = new URLSearchParams();
  if (handle) params.set("item", handle);
  if (controls.depth !== DEFAULT_CONTROLS.depth) params.set("depth", String(controls.depth));
  if (!controls.showSuggested) params.set("suggested", "0");
  if (!controls.showDerived) params.set("plan", "0");
  const query = params.toString();
  return query ? `/map?${query}` : "/map";
}
