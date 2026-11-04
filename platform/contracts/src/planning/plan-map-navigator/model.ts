/** The plan map's vocabulary: items, the edges between them, and the card that summarises one item. */

export const ITEM_TYPES = [
  "area",
  "outcome",
  "project",
  "deliverable",
  "step",
  "action",
  "criterion",
  "blocker",
  "commitment",
  "rule",
  "place",
  "contact",
  "context",
  "source",
  "subject"
] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

/**
 * Edge kinds the navigator computes from data it already has.
 * A shared place, contact or source is a hub item both ends point at, so ten items in one place need ten
 * edges rather than 45, and the cluster is reachable at depth 2.
 */
export const DERIVED_KINDS = [
  "parent_child",
  "depends_on",
  "criterion",
  "blocker",
  "prep",
  "same_source",
  "same_place",
  "same_contact"
] as const;

/** Stored kinds, version 1. Read through `StoredLinkSource` once the link store exists. */
export const STORED_KINDS = [
  "about",
  "counts_toward",
  "prepares",
  "before",
  "occurrence_of",
  "involves",
  "references"
] as const;

export type EdgeKind = (typeof DERIVED_KINDS)[number] | (typeof STORED_KINDS)[number];
export const ALL_KINDS: readonly string[] = [...DERIVED_KINDS, ...STORED_KINDS];

export interface MapItem {
  /** `<type>:<id>`, the stable name an agent passes back in. */
  handle: string;
  type: ItemType;
  id: string;
  title: string;
  status?: string | undefined;
  /** The next date or deadline that matters for this item, as the instant it carries. */
  when?: string | undefined;
  /** Handle of the tree parent, if any. */
  parent?: string | undefined;
  /** One line of detail for the card. */
  detail?: string | undefined;
}

export interface MapEdge {
  from: string;
  to: string;
  kind: string;
  origin: "derived" | "stored";
  /** Stored links only. A derived edge is always true by construction. */
  status?: "confirmed" | "suggested";
  evidence?: string;
}

export interface Card {
  handle: string;
  type: ItemType;
  title: string;
  status: string | null;
  when: string | null;
  parent: string | null;
  steps: number;
  openBlockers: number;
  links: number;
  detail: string | null;
}

/** A link read from the link store. Everything but `confirmed` and `suggested` is filtered out before it gets here. */
export interface StoredLink {
  from: string;
  to: string;
  kind: string;
  status: "confirmed" | "suggested";
  evidence?: string[];
}

/** Statuses after which an item is no longer open work; open items rank ahead of these. */
export const CLOSED_STATUSES = new Set([
  "done",
  "completed",
  "cancelled",
  "archived",
  "resolved",
  "dismissed",
  "satisfied",
  "not_applicable"
]);
