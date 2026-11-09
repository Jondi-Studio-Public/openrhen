import { sourceRoleOf } from "../connections/registry.js";
import type { SourceId } from "../connections/connection-id.js";
import { normalizeTitle, titlesMatch } from "./title-similarity.js";

/**
 * Cross-source event matching: decides whether an
 * event arriving from a calendar-like source is one OpenRhen already holds. Pure: callers load
 * the commitments and aliases and act on the answer.
 */

/** Any source id; the registry says which are connections and what role they play. */
export type SourceProvider = SourceId;
export type SourceRole = "primary" | "secondary";

/** A source whose manifest says primary (the roster provider: the employer's record of shifts) is definitive; every other source is equal. */
export function sourceRole(provider: SourceProvider): SourceRole {
  return sourceRoleOf(provider);
}

export interface SourceCandidate {
  provider: SourceProvider;
  externalId: string;
  title: string;
  startsAt: string;
  endsAt: string | null;
  allDay: boolean;
  /** YYYY-MM-DD in the user's timezone. */
  localDate: string;
  description: string | null;
}

export interface SourceCommitment {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string | null;
  allDay: boolean;
  localDate: string;
  status: string;
  links: { provider: SourceProvider; externalId: string }[];
}

/** A remembered "Same event" decision, in the normalized form `aliasTitleNorm` produces. */
export interface SourceAlias {
  provider: SourceProvider;
  remoteTitleNorm: string;
  localTitleNorm: string;
}

export type SourceMatchKind = "exact" | "strong" | "possible" | "none";

export interface SourceMatch {
  kind: SourceMatchKind;
  /** The one commitment matched; on a tie, the earliest of the tied ones (a stable stand-in, never a pick). */
  commitmentId?: string;
  reason: string;
  /**
   * Set when several commitments matched equally at `kind`. Callers that act on a single id must check it:
   * a tie is a question, not an answer. Absent on every non-tie result, so readers of `kind` and
   * `commitmentId` keep working and see a deterministic id instead of whichever came first in the list.
   */
  tie?: true;
  /** The tied commitments, earliest first (start, then id), at most `MAX_TIE_CANDIDATES`; present only with `tie`. */
  candidates?: string[];
}

/** The most commitments a tie lists, so a card list stays short. */
export const MAX_TIE_CANDIDATES = 5;

const CLOSE_MINUTES = 10;
const MIN_OVERLAP_SHARE = 0.5;
const MINUTE_MS = 60_000;
const RANK: Record<SourceMatchKind, number> = { none: 0, possible: 1, strong: 2, exact: 3 };

/** The stored form of an alias title, so writers and `matchCommitment` agree. */
export function aliasTitleNorm(title: string): string {
  return normalizeTitle(title);
}

function withinMinutes(a: string, b: string): boolean {
  return Math.abs(Date.parse(a) - Date.parse(b)) <= CLOSE_MINUTES * MINUTE_MS;
}

/** Overlap as a share of the shorter event; 0 when either end is unknown or the overlap is empty. */
function overlapShare(candidate: SourceCandidate, commitment: SourceCommitment): number {
  if (candidate.endsAt === null || commitment.endsAt === null) return 0;
  const startA = Date.parse(candidate.startsAt);
  const endA = Date.parse(candidate.endsAt);
  const startB = Date.parse(commitment.startsAt);
  const endB = Date.parse(commitment.endsAt);
  const shorter = Math.min(endA - startA, endB - startB);
  if (shorter <= 0) return 0;
  return Math.max(0, Math.min(endA, endB) - Math.max(startA, startB)) / shorter;
}

function matchOne(
  candidate: SourceCandidate,
  commitment: SourceCommitment,
  aliases: readonly SourceAlias[]
): SourceMatch {
  const id = commitment.id;
  if (
    candidate.description?.includes(`OpenRhen:${id}`) ||
    commitment.links.some((l) => l.provider === candidate.provider && l.externalId === candidate.externalId)
  ) {
    return { kind: "exact", commitmentId: id, reason: "Already linked to this commitment" };
  }

  const remoteNorm = aliasTitleNorm(candidate.title);
  const localNorm = aliasTitleNorm(commitment.title);
  const aliased = aliases.some(
    (a) => a.provider === candidate.provider && a.remoteTitleNorm === remoteNorm && a.localTitleNorm === localNorm
  );
  const titles = aliased || titlesMatch(candidate.title, commitment.title);

  if (candidate.allDay || commitment.allDay) {
    return candidate.localDate === commitment.localDate && titles
      ? { kind: "strong", commitmentId: id, reason: "All-day event on the same date with a matching title" }
      : { kind: "none", reason: "No match" };
  }

  const startClose = withinMinutes(candidate.startsAt, commitment.startsAt);
  const endClose =
    candidate.endsAt === null || commitment.endsAt === null || withinMinutes(candidate.endsAt, commitment.endsAt);
  const timesClose = startClose && endClose;

  if (timesClose && titles) {
    return {
      kind: "strong",
      commitmentId: id,
      reason: aliased ? "Same times and a remembered alias" : "Same times and a matching title"
    };
  }
  if (timesClose) return { kind: "possible", commitmentId: id, reason: "Same times, different title" };
  if (titles && candidate.localDate === commitment.localDate) {
    return { kind: "possible", commitmentId: id, reason: "Matching title on the same day at a different time" };
  }
  if (titles && overlapShare(candidate, commitment) >= MIN_OVERLAP_SHARE) {
    return { kind: "possible", commitmentId: id, reason: "Matching title and overlapping times" };
  }
  return { kind: "none", reason: "No match" };
}

/**
 * The best match for `candidate` among non-cancelled `existing` commitments (exact over strong over
 * possible). When two or more commitments match equally at the best rank the result is a tie
 * (`tie: true`, `candidates`), the same whatever the order of `existing`; nothing is picked.
 */
export function matchCommitment(
  candidate: SourceCandidate,
  existing: readonly SourceCommitment[],
  aliases: readonly SourceAlias[]
): SourceMatch {
  let best: SourceMatch = { kind: "none", reason: "No match" };
  let atBest: SourceCommitment[] = [];
  for (const commitment of existing) {
    if (commitment.status === "cancelled") continue;
    const match = matchOne(candidate, commitment, aliases);
    if (RANK[match.kind] > RANK[best.kind]) {
      best = match;
      atBest = [commitment];
    } else if (match.kind !== "none" && RANK[match.kind] === RANK[best.kind]) {
      atBest.push(commitment);
    }
  }
  if (atBest.length < 2) return best;
  const ordered = [...atBest].sort(
    (a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
  return {
    kind: best.kind,
    commitmentId: ordered[0]!.id,
    reason: `${ordered.length} commitments fit equally`,
    tie: true,
    candidates: ordered.slice(0, MAX_TIE_CANDIDATES).map((c) => c.id)
  };
}

/**
 * A repeating commitment as series matching sees it over an import window: its occurrences, one or
 * more per local date the rule falls on (the rule's own time, and a materialised occurrence moved
 * elsewhere), and the providers whose series already link it (one link per provider per rule).
 */
export interface SourceRule {
  id: string;
  title: string;
  version: number;
  linkedProviders: SourceProvider[];
  occurrences: SourceCommitment[];
}

export interface SeriesRuleMatch {
  ruleId: string;
  reason: string;
}

/**
 * The one rule a remote series stands for, or `null`. Every
 * occurrence of the series must be a Strong match for an occurrence of that rule on the same local
 * date, so one rule occurrence never answers for two, and exactly one rule may agree: two rules that
 * both fit are a question for the per-occurrence rows, not a guess. A rule this provider's series
 * already links is never a candidate.
 */
export function matchSeriesToRule(
  candidates: readonly SourceCandidate[],
  rules: readonly SourceRule[],
  aliases: readonly SourceAlias[]
): SeriesRuleMatch | null {
  const provider = candidates[0]?.provider;
  if (candidates.length < 2 || !provider) return null;
  const agreeing = rules.filter(
    (rule) =>
      !rule.linkedProviders.includes(provider) &&
      candidates.every((candidate) => {
        const sameDay = rule.occurrences.filter((occurrence) => occurrence.localDate === candidate.localDate);
        const kind = matchCommitment(candidate, sameDay, aliases).kind;
        return kind === "strong" || kind === "exact";
      })
  );
  if (agreeing.length !== 1) return null;
  return {
    ruleId: agreeing[0]!.id,
    reason: `All ${candidates.length} occurrences match this repeating commitment`
  };
}

/** What the commitment editor knows about a one-off being typed in by hand. */
export interface HandEntry {
  title: string;
  startsAt: string;
  endsAt: string;
  /** YYYY-MM-DD in the user's timezone. */
  localDate: string;
}

/**
 * The best match for a commitment being entered by hand (the source matching design note, "Hand
 * entry"). The same rules as `matchCommitment`, without its source-specific parts: a hand entry has
 * no provider, external id, marker or alias, so no answer is ever exact and none is remembered.
 */
export function matchHandEntry(input: HandEntry, existing: readonly SourceCommitment[]): SourceMatch {
  return matchCommitment(
    {
      provider: "email",
      externalId: "\u0000hand-entry",
      title: input.title,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      allDay: false,
      localDate: input.localDate,
      description: null
    },
    existing,
    []
  );
}

const PUBLISH_MARKER = /OpenRhen:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * True when a remote event carries the `OpenRhen:<commitmentId>` marker the calendar provider publishing
 * writes: it is OpenRhen' own write, so every import skips it and the publish sweep's orphan
 * adoption owns it, whether or not the commitment still exists.
 */
export function carriesPublishMarker(description: string | null): boolean {
  return description !== null && PUBLISH_MARKER.test(description);
}
