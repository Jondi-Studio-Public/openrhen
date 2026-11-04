import {
  ON_OFF_ONLY_ADDONS,
  SWITCHABLE_ADDONS,
  PLAN_MAP_MODES,
  effectiveMode,
  validateLink,
  type PlanFinding,
  type PlanItemType,
  type PlanLink,
  type PlanLinkInput,
  type PlanLinkKind,
  type PlanMap,
  type PlanMapMode,
  type SwitchableAddon
} from "@openrhen/contracts";
import { isWithinHandledWindow, newestFirst, type HandledRow } from "@/shared/recently-handled";

/**
 * The pure half of the plan map surfaces: turning ids into titles, grouping suggestions for the Inbox
 * window, and working out which connections an item may be offered. Nothing here fetches or renders, so
 * the Inbox window and the item pages agree on it by construction. What a link may join is not decided
 * here; `validateLink` in the contracts is, and every choice offered is run through it.
 */

export interface ItemRef {
  type: PlanItemType;
  id: string;
}

export const itemHandle = (type: PlanItemType, id: string) => `${type}:${id}`;

/** Splits a `<type>:<id>` handle (an id may itself contain colons). */
export function parseHandle(handle: string): ItemRef | null {
  const split = handle.indexOf(":");
  if (split <= 0) return null;
  return { type: handle.slice(0, split) as PlanItemType, id: handle.slice(split + 1) };
}

/** The slice of portal state titles are read from, kept structural so tests need no full state. */
export interface TitleSource {
  areas?: { id: string; name: string }[];
  outcomes?: { id: string; title: string }[];
  projects?: { id: string; title: string }[];
  /** A deliverable's steps are actions stored with a `deliverable_id`, so they are not in `actions` (`readers/actions.ts`). */
  deliverables?: { id: string; title: string; steps?: { id: string; title: string }[] | undefined }[];
  actions?: { id: string; title: string }[];
  commitments?: { id: string; title: string; recurrenceRuleId?: string | undefined }[];
  commitmentRecurrenceRules?: { id: string; title: string }[];
  contacts?: { id: string; name: string }[];
}

/** Resolves a link end to something a person can read; an id nobody can resolve is shown as is. */
export function buildTitleResolver(source: TitleSource, map: Pick<PlanMap, "subjects"> | null) {
  const lookups: Record<PlanItemType, Map<string, string>> = {
    area: new Map((source.areas ?? []).map((item) => [item.id, item.name])),
    outcome: new Map((source.outcomes ?? []).map((item) => [item.id, item.title])),
    project: new Map((source.projects ?? []).map((item) => [item.id, item.title])),
    deliverable: new Map((source.deliverables ?? []).map((item) => [item.id, item.title])),
    action: new Map([
      ...(source.actions ?? []).map((item) => [item.id, item.title] as const),
      // A deliverable's steps are actions too (a link end of type `action` may name one), but the portal
      // state lists them under their deliverable and not in `actions`.
      ...(source.deliverables ?? []).flatMap((deliverable) =>
        (deliverable.steps ?? []).map((step) => [step.id, step.title] as const)
      )
    ]),
    commitment: new Map([
      ...(source.commitments ?? []).map((item) => [item.id, item.title] as const),
      // A series is linked through its rule, so the rule's id resolves as a commitment too.
      ...(source.commitmentRecurrenceRules ?? []).map((item) => [item.id, item.title] as const)
    ]),
    contact: new Map((source.contacts ?? []).map((item) => [item.id, item.name])),
    place: new Map(),
    source: new Map(),
    subject: new Map((map?.subjects ?? []).map((item) => [item.id, item.name]))
  };
  const titleOf = (type: PlanItemType, id: string): string => lookups[type]?.get(id) ?? id;
  const handleTitle = (handle: string): string => {
    const ref = parseHandle(handle);
    return ref ? titleOf(ref.type, ref.id) : handle;
  };
  return { titleOf, handleTitle };
}
export type TitleResolver = ReturnType<typeof buildTitleResolver>;

export const LINK_KIND_LABELS: Record<PlanLinkKind, string> = {
  about: "about",
  counts_toward: "counts toward",
  prepares: "prepares",
  before: "comes before",
  occurrence_of: "is an occurrence of",
  involves: "involves",
  references: "references"
};

const byNewest = (a: PlanLink, b: PlanLink) => b.createdAt.localeCompare(a.createdAt);

export interface LinkGroup {
  key: string;
  label: string;
  links: PlanLink[];
}

/**
 * Suggested links grouped for review: by subject when either end is one, else by project when either
 * end is one (the "from" end first), else together under "Other links". Subjects come first, then
 * projects, each alphabetically; a group's links run newest first.
 */
export function groupSuggestedLinks(links: readonly PlanLink[], titleOf: TitleResolver["titleOf"]): LinkGroup[] {
  const groups = new Map<string, LinkGroup & { rank: number }>();
  for (const link of links) {
    if (link.status !== "suggested") continue;
    let key = "other";
    let label = "Other links";
    let rank = 2;
    const subjectEnd =
      link.toType === "subject" ? { id: link.toId } : link.fromType === "subject" ? { id: link.fromId } : null;
    const projectEnd =
      link.fromType === "project" ? { id: link.fromId } : link.toType === "project" ? { id: link.toId } : null;
    if (subjectEnd) {
      key = `subject:${subjectEnd.id}`;
      label = `Subject: ${titleOf("subject", subjectEnd.id)}`;
      rank = 0;
    } else if (projectEnd) {
      key = `project:${projectEnd.id}`;
      label = `Project: ${titleOf("project", projectEnd.id)}`;
      rank = 1;
    }
    const group = groups.get(key) ?? { key, label, links: [], rank };
    group.links.push(link);
    groups.set(key, group);
  }
  return [...groups.values()]
    .sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label))
    .map(({ rank: _rank, links: grouped, ...rest }) => ({ ...rest, links: grouped.slice().sort(byNewest) }));
}

export interface BulkGroup {
  proposer: string;
  kind: PlanLinkKind;
  count: number;
}

/** Proposer and kind pairs with more than one suggestion waiting, the ones worth a bulk confirm. */
export function bulkConfirmGroups(links: readonly PlanLink[]): BulkGroup[] {
  const counts = new Map<string, BulkGroup>();
  for (const link of links) {
    if (link.status !== "suggested") continue;
    const key = `${link.proposer}\u0000${link.kind}`;
    const group = counts.get(key) ?? { proposer: link.proposer, kind: link.kind, count: 0 };
    group.count += 1;
    counts.set(key, group);
  }
  return [...counts.values()]
    .filter((group) => group.count > 1)
    .sort((a, b) => a.proposer.localeCompare(b.proposer) || a.kind.localeCompare(b.kind));
}

export const openFindings = (findings: readonly PlanFinding[]) => findings.filter((item) => item.status === "open");

/**
 * Links and findings decided in the last seven days, newest first, for the room's "Recently handled".
 * A link that was only ever confirmed by hand has no decision time and is not a decision here.
 */
export function recentlyDecided(
  map: Pick<PlanMap, "links" | "findings"> | null,
  titleOf: TitleResolver["titleOf"],
  now: number
): HandledRow[] {
  if (!map) return [];
  const links = map.links
    .filter(
      (link) =>
        (link.status === "confirmed" || link.status === "rejected") && isWithinHandledWindow(link.decidedAt, now)
    )
    .map((link): HandledRow => ({
      id: `link:${link.id}`,
      title: `${titleOf(link.fromType, link.fromId)} ${LINK_KIND_LABELS[link.kind]} ${titleOf(link.toType, link.toId)}`,
      detail: `link · ${link.proposer.replaceAll("_", " ")}`,
      outcome: link.status,
      at: link.decidedAt!
    }));
  const findings = map.findings
    .filter((item) => item.status !== "open" && isWithinHandledWindow(item.decidedAt, now))
    .map((item): HandledRow => ({
      id: `finding:${item.id}`,
      title: item.text,
      detail: `finding · ${item.checkName.replaceAll("_", " ")}`,
      outcome: item.status,
      at: item.decidedAt!
    }));
  return newestFirst([...links, ...findings]);
}

/** What the Inbox badge counts: suggestions and findings still waiting for a decision. */
export function openCount(map: Pick<PlanMap, "links" | "findings"> | null): number {
  if (!map) return 0;
  return map.links.filter((link) => link.status === "suggested").length + openFindings(map.findings).length;
}

/** One line for a suggested change a finding carries; the contract leaves its shape open. */
export function describeSuggestedChange(change: unknown): string {
  if (typeof change === "string") return change;
  if (change && typeof change === "object") {
    const record = change as Record<string, unknown>;
    for (const key of ["summary", "text", "title", "description"]) {
      const value = record[key];
      if (typeof value === "string" && value) return value;
    }
    const text = JSON.stringify(change);
    return text.length > 140 ? `${text.slice(0, 137)}...` : text;
  }
  return String(change);
}

export const ADDON_LABELS: Record<SwitchableAddon, { name: string; blurb: string }> = {
  executor: {
    name: "Suggest links automatically",
    blurb:
      "Once a helper that searches your plan is set up, turns what it finds into suggested links and findings for you to review. Test only records what it would add and adds nothing."
  },
  nudge: {
    name: "Deadline nudge (test only)",
    blurb:
      "A small, capped boost for actions that prepare for a subject's deadline. Test only records how rankings would change. On does not change rankings yet: the boost is not built."
  },
  jev_subjects: {
    name: "Suggest subjects (AI)",
    blurb: "A hosted AI model suggests which subject an item belongs to, reading titles only. Off or on only."
  },
  capture_placement: {
    name: "Suggest a project for captures",
    blurb:
      "Suggests which project a captured note belongs to, by rules and then a local model; asks you when unsure. Test only records the choice without putting it on the proposal."
  },
  email_needs_reply: {
    name: "Needs-reply list",
    blurb: "Lets agents read the email threads that probably need your reply. Off or on only."
  }
};

export { ON_OFF_ONLY_ADDONS };

export const MODE_LABELS: Record<PlanMapMode, string> = { off: "Off", shadow: "Test only", on: "On" };

/** The modes the panel offers for an add-on: off and on only where `ON_OFF_ONLY_ADDONS` says so. */
export function modeOptions(addon: SwitchableAddon): readonly PlanMapMode[] {
  return ON_OFF_ONLY_ADDONS.includes(addon) ? PLAN_MAP_MODES.filter((mode) => mode !== "shadow") : PLAN_MAP_MODES;
}

/** The switches in a fixed order, as `effectiveMode` reads them; an add-on the server did not report reads as off. */
export function switchRows(map: Pick<PlanMap, "switches"> | null): { addon: SwitchableAddon; mode: PlanMapMode }[] {
  return SWITCHABLE_ADDONS.map((addon) => ({
    addon,
    mode: effectiveMode(addon, map?.switches.find((entry) => entry.addon === addon)?.mode)
  }));
}

// ---- Connections on one item -------------------------------------------------------------------

export interface ItemLinkView {
  link: PlanLink;
  /** `out` when this item is the link's "from" end. */
  direction: "out" | "in";
  other: ItemRef;
}

/** Confirmed and suggested links that touch an item; rejected and expired ones are history. */
export function linksForItem(map: Pick<PlanMap, "links"> | null, item: ItemRef): ItemLinkView[] {
  const views: ItemLinkView[] = [];
  for (const link of map?.links ?? []) {
    if (link.status !== "confirmed" && link.status !== "suggested") continue;
    if (link.fromType === item.type && link.fromId === item.id) {
      views.push({ link, direction: "out", other: { type: link.toType, id: link.toId } });
    } else if (link.toType === item.type && link.toId === item.id) {
      views.push({ link, direction: "in", other: { type: link.fromType, id: link.fromId } });
    }
  }
  return views.sort(
    (a, b) => Number(a.link.status !== "confirmed") - Number(b.link.status !== "confirmed") || byNewest(a.link, b.link)
  );
}

/** "prepares Maths exam" / "is prepared by Practice paper", read from this item's side. */
export function describeItemLink(view: ItemLinkView, titleOf: TitleResolver["titleOf"]): string {
  const relation = RELATIONS.find((entry) => entry.kind === view.link.kind && entry.direction === view.direction);
  const phrase = relation?.label ?? LINK_KIND_LABELS[view.link.kind];
  return `${phrase} ${titleOf(view.other.type, view.other.id)}`;
}

export interface Relation {
  kind: PlanLinkKind;
  direction: "out" | "in";
  label: string;
}

/** The kinds a person may add by hand, each from this item's side. `about` first: it is the default. */
export const RELATIONS: readonly Relation[] = [
  { kind: "about", direction: "out", label: "is about" },
  { kind: "prepares", direction: "out", label: "prepares" },
  { kind: "prepares", direction: "in", label: "is prepared by" },
  { kind: "counts_toward", direction: "out", label: "counts toward" },
  { kind: "counts_toward", direction: "in", label: "is counted toward by" },
  { kind: "before", direction: "out", label: "comes before" },
  { kind: "before", direction: "in", label: "comes after" },
  { kind: "occurrence_of", direction: "out", label: "is an occurrence of" },
  { kind: "occurrence_of", direction: "in", label: "has occurrence" }
];

export interface ConnectionCandidate extends ItemRef {
  title: string;
}

/** Everything a link by hand may point at: the plan's work items and the stored subjects. */
export function connectionCandidates(
  state: TitleSource & {
    outcomes?: { id: string; title: string }[];
  },
  map: Pick<PlanMap, "subjects"> | null
): ConnectionCandidate[] {
  const out: ConnectionCandidate[] = [];
  for (const subject of map?.subjects ?? []) {
    if ("status" in subject && subject.status === "archived") continue;
    out.push({ type: "subject", id: subject.id, title: subject.name });
  }
  for (const item of state.outcomes ?? []) out.push({ type: "outcome", id: item.id, title: item.title });
  for (const item of state.projects ?? []) out.push({ type: "project", id: item.id, title: item.title });
  for (const item of state.deliverables ?? []) out.push({ type: "deliverable", id: item.id, title: item.title });
  for (const item of state.actions ?? []) out.push({ type: "action", id: item.id, title: item.title });
  // A series is linked by its rule, never by its occurrences, so occurrences are offered only when
  // they belong to no rule.
  for (const item of state.commitmentRecurrenceRules ?? [])
    out.push({ type: "commitment", id: item.id, title: item.title });
  for (const item of state.commitments ?? []) {
    if (!item.recurrenceRuleId) out.push({ type: "commitment", id: item.id, title: item.title });
  }
  return out;
}

/** The ref an item's links hang from: a commitment in a series is its rule. */
export function itemRefFor(type: PlanItemType, id: string, recurrenceRuleId?: string): ItemRef {
  return type === "commitment" && recurrenceRuleId ? { type, id: recurrenceRuleId } : { type, id };
}

const endsOf = (item: ItemRef, other: ItemRef, direction: "out" | "in") =>
  direction === "out"
    ? { fromType: item.type, fromId: item.id, toType: other.type, toId: other.id }
    : { fromType: other.type, fromId: other.id, toType: item.type, toId: item.id };

/**
 * The candidates that may stand at the other end of `relation` from `item`: valid by the contract's
 * end rules, not the item itself, and not already linked (suggested or confirmed) the same way.
 */
export function candidatesFor(
  relation: Relation,
  item: ItemRef,
  candidates: readonly ConnectionCandidate[],
  links: readonly PlanLink[]
): ConnectionCandidate[] {
  return candidates.filter((candidate) => {
    const ends = endsOf(item, candidate, relation.direction);
    if (!validateLink({ kind: relation.kind, ...ends }).ok) return false;
    return !links.some(
      (link) =>
        (link.status === "confirmed" || link.status === "suggested") &&
        link.kind === relation.kind &&
        link.fromType === ends.fromType &&
        link.fromId === ends.fromId &&
        link.toType === ends.toType &&
        link.toId === ends.toId
    );
  });
}

/** The relations with at least one candidate, so the form never offers a kind with nothing to pick. */
export function availableRelations(
  item: ItemRef,
  candidates: readonly ConnectionCandidate[],
  links: readonly PlanLink[]
): Relation[] {
  return RELATIONS.filter((relation) => candidatesFor(relation, item, candidates, links).length > 0);
}

export function linkInputFor(relation: Relation, item: ItemRef, other: ItemRef): PlanLinkInput {
  return { kind: relation.kind, ...endsOf(item, other, relation.direction) };
}
