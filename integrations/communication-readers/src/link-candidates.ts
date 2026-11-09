/** The most earlier facts a link prompt may list. The model picks one by label; it never writes an id. */
export const MAX_LINK_CANDIDATES = 5;
/** Mirrors DERIVED_LINK_RELATIONS in platform/contracts (this package imports no workspace package). */
export const LINK_RELATIONS = ["cancel", "reschedule", "repeat"] as const;
export type LinkRelation = (typeof LINK_RELATIONS)[number];

const LABELS = ["c1", "c2", "c3", "c4", "c5"] as const;
export type LinkLabel = (typeof LABELS)[number];
/** Stored facts considered per call. A conversation has nowhere near this many; the bound keeps a bad pool cheap. */
const POOL_LIMIT = 2000;

export interface LinkTarget {
  conversationKey: string;
  /** Epoch milliseconds of the message the new fact comes from. */
  tsStart: number;
  /** The new fact's own id, so it is never offered as its own target. */
  factId?: string | undefined;
  icsUid?: string | null | undefined;
}

export interface LinkPoolFact {
  factId: string;
  conversationKey: string;
  factType: string;
  /** Epoch milliseconds of the message this fact row came from. */
  tsStart: number;
  icsUid?: string | null | undefined;
  /** A short quote of the fact, shown to the model as untrusted data. */
  quote?: string | null | undefined;
  /** True when a status already closed it (done, cancelled, superseded): nothing is left to cancel or move. */
  closed?: boolean | undefined;
  /** True for a fact row that itself cancels, moves or repeats another: links never point at links. */
  isLink?: boolean | undefined;
}

export interface LinkCandidate {
  label: LinkLabel;
  factId: string;
  factType: string;
  quote: string | null;
}

/**
 * Up to 5 earlier facts of the same conversation that a cancel, reschedule or repeat could point at, enumerated `c1` to
 * `c5` in the order offered: the same calendar `ics_uid` first, then the newest. A fact qualifies only if it comes from
 * a strictly earlier message (a link never points forward), is not the new fact itself, not a link row, and not already
 * closed; each fact id appears once, by its latest row. The model answers with a label, and `linkFromChoice` turns that
 * back into an id, so the model never produces or alters one. Deterministic: ties break on fact id.
 */
export function linkCandidates(target: LinkTarget, pool: readonly LinkPoolFact[]): LinkCandidate[] {
  const latest = new Map<string, LinkPoolFact>();
  for (const fact of pool.slice(0, POOL_LIMIT)) {
    if (fact.conversationKey !== target.conversationKey) continue;
    if (!Number.isFinite(fact.tsStart) || fact.tsStart >= target.tsStart) continue;
    if (fact.factId === target.factId) continue;
    const seen = latest.get(fact.factId);
    if (!seen || fact.tsStart > seen.tsStart) latest.set(fact.factId, fact);
  }
  // The latest row decides: a fact whose newest row is closed (or is a link) is out, even if an older row was open.
  for (const [factId, fact] of latest) if (fact.isLink === true || fact.closed === true) latest.delete(factId);
  const sameUid = (fact: LinkPoolFact) =>
    typeof target.icsUid === "string" && target.icsUid !== "" && fact.icsUid === target.icsUid ? 0 : 1;
  return [...latest.values()]
    .sort((a, b) => sameUid(a) - sameUid(b) || b.tsStart - a.tsStart || (a.factId < b.factId ? -1 : 1))
    .slice(0, MAX_LINK_CANDIDATES)
    .map((fact, index) => ({
      label: LABELS[index]!,
      factId: fact.factId,
      factType: fact.factType,
      quote: typeof fact.quote === "string" ? fact.quote : null
    }));
}

/** A link row's `links` entry for the model's choice, or null if the label is not one offered or the relation is unknown. */
export function linkFromChoice(
  candidates: readonly LinkCandidate[],
  relation: unknown,
  label: unknown
): { relation: LinkRelation; target_fact_id: string } | null {
  if (typeof relation !== "string" || !(LINK_RELATIONS as readonly string[]).includes(relation)) return null;
  const chosen = candidates.find((candidate) => candidate.label === label);
  return chosen ? { relation: relation as LinkRelation, target_fact_id: chosen.factId } : null;
}
