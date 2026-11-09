import { wallClockFormat } from "../../zoned-time.js";
import { matchCommitment, type SourceCandidate, type SourceCommitment } from "../source-match.js";
import { breakTieByContact, contactForSender } from "../contact-map.js";
import { matchDeadline, RESCHEDULE_CUE } from "../deadline-match.js";
import { normalizeTitle, titleSimilarity } from "../title-similarity.js";
import {
  MAX_CANDIDATES,
  type Candidate,
  type FactType,
  type ReplayFact,
  type ReplayInput,
  type ReplayOutcome,
  type ReplayTarget,
  type Reconciler
} from "./replay-case.js";

/**
 * The resolver under test today: the matchers as they behave now, assembled behind the `Reconciler`
 * interface. Equal fits are a tie, asked and never picked; a deadline the same title names within two
 * weeks of another date is that deadline moved (an update). It is not a model of what should happen; the gold is.
 *
 * Lanes are the per-fact-type pieces, kept in `LANES` so the matcher changes that follow (a sender-to-contact map) each replace one entry without touching the
 * others or the cases.
 */

const RANK_EXACT = 3;
const RANK_STRONG = 2;
const RANK_POSSIBLE = 1;
const RANK_OF = { exact: RANK_EXACT, strong: RANK_STRONG, possible: RANK_POSSIBLE, none: 0 } as const;
/** Below a match but worth showing: the card list is built from similar titles, not only matches. */
const NEAR_SIMILARITY = 0.3;

const FILLER = new Set([
  "a",
  "an",
  "the",
  "to",
  "of",
  "for",
  "at",
  "in",
  "on",
  "and",
  "or",
  "please",
  "can",
  "could",
  "you",
  "we",
  "i",
  "will",
  "be",
  "is",
  "are",
  "was",
  "see",
  "reminder",
  "confirming",
  "confirm",
  "confirmed",
  "just",
  "kindly",
  "again",
  "still",
  "your",
  "our",
  "my",
  "that",
  "this",
  "it",
  "do",
  "have",
  "has",
  "need",
  "needs",
  "send",
  "sent",
  "reschedule",
  "rescheduled",
  "cancel",
  "cancelled",
  "canceled",
  "moved",
  "new",
  "now"
]);

/** Quote-derived title tokens: the quote without filler words. Facts carry no title of their own. */
export function probeTitle(quote: string): string {
  const kept = normalizeTitle(quote)
    .split(" ")
    .filter((token) => token !== "" && !FILLER.has(token));
  return kept.length > 0 ? kept.join(" ") : normalizeTitle(quote);
}

const isDateOnly = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);

function localDateOf(value: string, timezone: string): string {
  if (isDateOnly(value)) return value;
  // An instant in UTC already carries its local date; the formatter is for every other zone.
  if (timezone === "UTC" && value.endsWith("Z")) return value.slice(0, 10);
  const parts = wallClockFormat(timezone).formatToParts(new Date(value));
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
}

interface Scored {
  id: string;
  target: ReplayTarget;
  title: string;
  rank: number;
  score: number;
  /** The title matches but the dates differ: with strong or exact, the same deadline moved. */
  moved?: { from: string; to: string };
}

/** A lane's verdict: every target it looked at, scored. Rank 0 means near but not a match. */
type Lane = (input: ReplayInput, fact: ReplayFact) => Scored[];

function commitmentLane(input: ReplayInput, fact: ReplayFact): Scored[] {
  const start = fact.when![0]!;
  const title = probeTitle(fact.quote);
  const allDay = isDateOnly(start);
  const candidate: SourceCandidate = {
    provider: "email",
    externalId: fact.icsUid ?? `message:${fact.conversationKey}`,
    title,
    startsAt: allDay ? `${start}T00:00:00.000Z` : start,
    endsAt: fact.when?.[1] ?? null,
    allDay,
    localDate: localDateOf(start, input.timezone),
    description: null
  };
  const aliases = input.plan.aliases.map((alias) => ({ provider: "email" as const, ...alias }));
  const commitments: SourceCommitment[] = input.plan.commitments.map((c) => ({
    id: c.id,
    title: c.title,
    startsAt: c.startsAt,
    endsAt: c.endsAt,
    allDay: c.allDay,
    localDate: localDateOf(c.startsAt, input.timezone),
    status: c.status,
    links: []
  }));
  const scored: Scored[] = [];
  for (const commitment of commitments) {
    if (commitment.status === "cancelled") continue;
    const match = matchCommitment(candidate, [commitment], aliases);
    const rank =
      match.kind === "exact"
        ? RANK_EXACT
        : match.kind === "strong"
          ? RANK_STRONG
          : match.kind === "possible"
            ? RANK_POSSIBLE
            : 0;
    const score = titleSimilarity(title, commitment.title);
    if (rank === 0 && score < NEAR_SIMILARITY) continue;
    scored.push({
      id: commitment.id,
      target: { kind: "commitment", id: commitment.id },
      title: commitment.title,
      rank,
      score
    });
  }
  return scored;
}

function deadlineLane(input: ReplayInput, fact: ReplayFact): Scored[] {
  const title = probeTitle(fact.quote);
  const dueOn = fact.when?.[0] ? localDateOf(fact.when[0], input.timezone) : null;
  const probe = { kind: "deadline" as const, title, dueOn, rescheduled: RESCHEDULE_CUE.test(fact.quote) };
  const targets = [
    ...input.plan.actions.map((a) => ({ ...a, kind: "action" as const })),
    ...input.plan.projects.map((p) => ({ ...p, kind: "project" as const }))
  ].filter((t) => t.status === "open" && t.deadlineAt !== null);
  const scored: Scored[] = [];
  for (const t of targets) {
    const match = matchDeadline(probe, [
      { id: t.id, title: t.title, dueOn: localDateOf(t.deadlineAt!, input.timezone) }
    ]);
    const rank = RANK_OF[match.kind];
    const score = titleSimilarity(title, t.title);
    if (rank === 0 && score < NEAR_SIMILARITY) continue;
    scored.push({
      id: t.id,
      target: { kind: t.kind, id: t.id },
      title: t.title,
      rank,
      score,
      ...(match.moved ? { moved: match.moved } : {})
    });
  }
  return scored;
}

function askLane(input: ReplayInput, fact: ReplayFact): Scored[] {
  const title = probeTitle(fact.quote);
  const scored: Scored[] = [];
  for (const open of input.plan.openFacts) {
    const score = titleSimilarity(title, open.title);
    const sameThread = open.conversationKey === fact.conversationKey;
    const titleMatch = matchDeadline({ kind: "ask", title, dueOn: null }, [
      { id: open.id, title: open.title, dueOn: null }
    ]);
    let rank = 0;
    if (fact.icsUid !== undefined && open.icsUid === fact.icsUid) rank = RANK_EXACT;
    // An undated ask reaches only "possible" on its words; the same thread corroborates it.
    else if (titleMatch.kind !== "none") rank = sameThread ? RANK_STRONG : RANK_POSSIBLE;
    else if (sameThread) rank = RANK_POSSIBLE;
    if (rank === 0 && score < NEAR_SIMILARITY) continue;
    scored.push({ id: open.id, target: { kind: "fact", id: open.id }, title: open.title, rank, score });
  }
  return scored;
}

/** The lane for each fact type; a matcher change replaces its entry. */
export const LANES: Record<FactType, { name: string; run: Lane }> = {
  event: { name: "commitment", run: commitmentLane },
  commitment: { name: "commitment", run: commitmentLane },
  deadline: { name: "deadline", run: deadlineLane },
  ask: { name: "ask", run: askLane }
};

function candidatesOf(scored: readonly Scored[], lane: string): Candidate[] {
  return scored
    .map((s, index) => ({ s, index }))
    .sort((a, b) => b.s.rank - a.s.rank || b.s.score - a.s.score || a.index - b.index)
    .slice(0, MAX_CANDIDATES)
    .map(({ s }) => ({ id: s.id, rank: s.rank, score: Math.round(s.score * 1000) / 1000, lane }));
}

const noEffect = (reason: string): ReplayOutcome => ({
  endState: "no_effect",
  reason,
  candidates: [],
  tie: false,
  usedChooser: false
});

export const referenceReconciler: Reconciler = (input, { chooser }) => {
  const fact = input.message.facts[0];
  if (fact === undefined) return noEffect("no_facts");

  const when = fact.when?.[0];
  const timed = fact.type === "event" || fact.type === "commitment";
  if (timed && when === undefined) {
    return { endState: "unresolved", reason: "no_start_time", candidates: [], tie: false, usedChooser: false };
  }
  if (
    !fact.cancelled &&
    when !== undefined &&
    localDateOf(when, input.timezone) < localDateOf(input.now, input.timezone)
  ) {
    return noEffect("past");
  }

  const lane = LANES[fact.type];
  const scored = lane.run(input, fact);
  const candidates = candidatesOf(scored, lane.name);
  const top = candidates[0]?.rank ?? 0;
  const atTop = candidates.filter((c) => c.rank === top && top > 0);
  const tie = atTop.length > 1;
  const byId = new Map(scored.map((s) => [s.id, s]));
  const targetOf = (id: string): ReplayTarget => byId.get(id)!.target;

  // A tie between strong matches is settled when the sender is one known contact who owns exactly one of them.
  let tieBrokenBy: "contact" | undefined;
  let winnerId: string | undefined;
  if (tie && top >= RANK_STRONG) {
    winnerId =
      breakTieByContact(
        atTop.map((c) => c.id),
        input.plan.commitments,
        contactForSender(input.message.from, input.plan.contacts)
      ) ?? undefined;
    if (winnerId !== undefined) tieBrokenBy = "contact";
  }

  if (tie && winnerId === undefined) {
    // Several records fit equally: no pick, by code or by chooser. A chooser's answer between equals would be a
    // guess code cannot re-validate, so a tie is a question for the owner (`matchCommitment` returns it as
    // a tie; the deadline and ask lanes tie on equal rank until their own matchers land).
    return { endState: "asked", reason: "tie", candidates, tie, usedChooser: false };
  }

  if (top >= RANK_STRONG) {
    const winner = (winnerId !== undefined ? byId.get(winnerId) : undefined) ?? scored.find((s) => s.rank === top)!;
    const target = winner.target;
    const brokenBy = tieBrokenBy ? { tieBrokenBy } : {};
    // The same deadline on another date is an update, not a restatement.
    if (winner.moved && !fact.cancelled) {
      return { endState: "applied", op: "update", target, candidates, tie, usedChooser: false, ...brokenBy };
    }
    if (fact.cancelled) {
      return { endState: "applied", op: "cancel", target, candidates, tie, usedChooser: false, ...brokenBy };
    }
    return { endState: "duplicate", target, candidates, tie, usedChooser: false, ...brokenBy };
  }

  if (top === RANK_POSSIBLE) {
    // A held "same event / keep both" question. Only a judge can answer it.
    // A date that differs is not a restatement a card pick could confirm ("duplicate"); only the owner can say moved or new.
    const dateDiffers = scored.some((s) => s.rank === RANK_POSSIBLE && s.moved);
    if (chooser.unavailable || dateDiffers) return { endState: "asked", candidates, tie, usedChooser: false };
    const cards = candidates
      .filter((c) => c.rank >= RANK_POSSIBLE)
      .map((c, i) => ({ label: `c${i + 1}`, id: c.id, title: byId.get(c.id)!.title }));
    const raw = chooser({ quote: fact.quote, cards });
    const card = cards.find((c) => c.label === raw);
    const chooserPick = card ? raw : raw === "none" ? "none" : "unsure";
    const base = { candidates, tie, usedChooser: true, chooserPick };
    if (card) return { endState: "duplicate", target: targetOf(card.id), ...base };
    if (chooserPick === "none") return createOutcome(fact, base);
    return { endState: "asked", ...base };
  }

  return createOutcome(fact, { candidates, tie, usedChooser: false });
};

function createOutcome(
  fact: ReplayFact,
  rest: { candidates: Candidate[]; tie: boolean; usedChooser: boolean; chooserPick?: string }
): ReplayOutcome {
  // A cancellation with nothing to cancel changes nothing.
  if (fact.cancelled) return { endState: "no_effect", reason: "nothing_to_cancel", ...rest };
  return { endState: "applied", op: "create", ...rest };
}
