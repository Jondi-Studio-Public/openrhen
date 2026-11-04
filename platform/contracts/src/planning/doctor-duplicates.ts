/**
 * Doctor checks for duplicates and for plan links that point at finished work:
 * pure, over a plain slice. Type-only import of `DoctorItem` keeps this free of an import cycle with `doctor.ts`.
 *
 * Duplicates follow the rule behind plan-health `duplicate_captures` (same project and normalised title for open
 * actions; same type and normalised title for pending proposals). A group an *open* `duplicate_captures` finding
 * already names is not reported again: the open-findings count item covers it.
 */
import type { DoctorItem } from "./doctor.js";

const DAY = 24 * 60 * 60 * 1000;
/** A proposal pair younger than this is an inbox still filling, not a duplicate. */
export const DOCTOR_DUPLICATE_PROPOSAL_GRACE_DAYS = 1;
const HANDLE_CAP = 5;

export interface DoctorDuplicateAction {
  id: string;
  title: string;
  projectId: string;
  createdAt: string | null;
}
export interface DoctorDuplicateProposal {
  id: string;
  sourceId: string;
  proposalType: string;
  title: string | null;
  createdAt: string | null;
}
/** One end of one link whose item is present but finished. */
export interface DoctorDeadLinkEnd {
  linkId: string;
  kind: string;
  /** `suggested` or `confirmed`. */
  linkStatus: string;
  endType: string;
  endId: string;
  /** `done`, `cancelled` or `archived`. */
  endState: string;
}

export interface DoctorDuplicatesSlice {
  /** Open actions in active projects. */
  actions: DoctorDuplicateAction[];
  /** Pending proposals. */
  proposals: DoctorDuplicateProposal[];
  /** `itemIds` of every open `duplicate_captures` finding. */
  openDuplicateFindingItemIds: string[][];
  deadLinkEnds: DoctorDeadLinkEnd[];
  /** The reader hit its cap on links or ends, so the dead-link counts are a lower bound. */
  deadLinksTruncated?: boolean;
}

// Same rule as plan-health.ts `normalise` (not exported there).
const normalise = (text: string): string =>
  text
    .toLowerCase()
    .replace(/^(\s*(re|fwd?)\s*:\s*)+/g, "")
    .replace(/\s+/g, " ")
    .trim();

const clip = (text: string, max = 60): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function ms(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const t = Date.parse(value);
  return Number.isNaN(t) ? undefined : t;
}

function earliest(values: (string | null)[]): string | undefined {
  const times = values.map(ms).filter((t): t is number => t !== undefined);
  return times.length > 0 ? new Date(Math.min(...times)).toISOString() : undefined;
}

function group<T>(rows: T[], key: (row: T) => string | null): T[][] {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    if (k === null) continue;
    const list = map.get(k);
    if (list) list.push(row);
    else map.set(k, [row]);
  }
  return [...map.values()].filter((g) => g.length > 1);
}

/** The handles plan-health records for a group: sorted, first five. */
const covered = (handles: string[], findings: string[][]): boolean =>
  findings.some((itemIds) => handles.every((h) => itemIds.includes(h)));

export function duplicateItems(slice: DoctorDuplicatesSlice, nowMs: number): DoctorItem[] {
  const items: DoctorItem[] = [];

  for (const g of group(slice.actions, (a) =>
    normalise(a.title) ? `${a.projectId}\u0000${normalise(a.title)}` : null
  )) {
    const ids = g.map((a) => a.id).sort();
    const handles = ids.slice(0, HANDLE_CAP).map((id) => `action:${id}`);
    if (covered(handles, slice.openDuplicateFindingItemIds)) continue;
    const since = earliest(g.map((a) => a.createdAt));
    items.push({
      id: `duplicate_action:${ids[0]}`,
      check: "duplicate_action",
      tier: "tidy",
      area: "plan",
      title: `${g.length} open actions share the title "${clip(g[0]!.title)}"`,
      why: "The same work is counted and offered more than once, which inflates the load and the ranking.",
      handles,
      ...(since ? { since } : {}),
      fix: { who: "person", question: "Keep one of these actions and cancel the rest, or are they different work?" }
    });
  }

  for (const g of group(slice.proposals, (p) =>
    p.title && normalise(p.title) ? `${p.proposalType}\u0000${normalise(p.title)}` : null
  )) {
    const newest = Math.max(...g.map((p) => ms(p.createdAt) ?? 0));
    if (newest > nowMs - DOCTOR_DUPLICATE_PROPOSAL_GRACE_DAYS * DAY) continue;
    const ids = g.map((p) => p.id).sort();
    const sources = [...new Set(g.map((p) => p.sourceId))].sort();
    if (
      covered(
        sources.slice(0, HANDLE_CAP).map((id) => `source:${id}`),
        slice.openDuplicateFindingItemIds
      )
    )
      continue;
    const since = earliest(g.map((p) => p.createdAt));
    items.push({
      id: `duplicate_proposal:${ids[0]}`,
      check: "duplicate_proposal",
      tier: "tidy",
      area: "plan",
      title: `${g.length} pending ${g[0]!.proposalType} proposals look identical`,
      why: "Accepting more than one would create the same thing twice.",
      handles: ids.slice(0, HANDLE_CAP).map((id) => `proposal:${id}`),
      ...(since ? { since } : {}),
      fix: { who: "person", question: "Keep one proposal and ignore the rest?" }
    });
  }

  // Links whose item is present but finished. Grouped by kind, link status and end state, so a big plan
  // yields a handful of items, never one per link.
  const byGroup = new Map<string, DoctorDeadLinkEnd[]>();
  for (const end of slice.deadLinkEnds) {
    // A suggestion pointing at finished work is pointless; a confirmed link to done work is plain history.
    if (end.linkStatus === "confirmed" && end.endState === "done") continue;
    const key = `${end.kind}:${end.linkStatus}:${end.endState}`;
    const list = byGroup.get(key);
    if (list) list.push(end);
    else byGroup.set(key, [end]);
  }
  for (const [key, ends] of [...byGroup].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const links = new Set(ends.map((e) => e.linkId)).size;
    const handles = [...new Set(ends.map((e) => `${e.endType}:${e.endId}`))].sort().slice(0, HANDLE_CAP);
    const { kind, linkStatus, endState } = ends[0]!;
    items.push({
      id: `link_to_finished:${key}`,
      check: "link_to_finished",
      tier: "tidy",
      area: "plan",
      title: `${links}${slice.deadLinksTruncated ? "+" : ""} ${linkStatus} "${kind}" link${links === 1 ? "" : "s"} point${links === 1 ? "s" : ""} at ${endState} items`,
      why: `Links to finished work add noise to the map and can feed ranking and reminders.${slice.deadLinksTruncated ? " The list was cut short, so there may be more." : ""}`,
      handles,
      fix: {
        who: "person",
        question:
          linkStatus === "suggested"
            ? `Reject these suggested ${kind} links to ${endState} items?`
            : `Remove these ${kind} links to ${endState} items, or reopen the items?`
      }
    });
  }

  return items;
}
