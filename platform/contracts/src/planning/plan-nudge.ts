import type { PlanItemType, PlanLink } from "./plan-map.js";

/**
 * The plan-map ranking nudge. Pure and shadow-only: it reads the
 * ranking the engine already produced plus confirmed links, and returns what a capped boost *would* have
 * done at each cap. It never mutates its input and nothing here feeds the live ranking, so the engine's
 * output is the same whether the `nudge` switch is off or in shadow. The model never sets a weight.
 */

/** The three caps the shadow pass computes side by side (owner decision, 2026-10-01): half a day, one day, two days of deadline urgency. */
export const NUDGE_CAPS_DAYS = [0.5, 1, 2] as const;
export type NudgeCapDays = (typeof NUDGE_CAPS_DAYS)[number];

/**
 * What one day of deadline urgency adds to the engine's weighted score: the engine's capacity-pressure
 * weight (30) times its latest-safe-start share (0.3) over a 72-hour ramp, so a day is 30 × 0.3 × 24/72.
 * Kept as a literal so a change to the engine's weights is a visible edit here, not a silent drift.
 */
export const NUDGE_POINTS_PER_DAY = 3;

/** An item due or examined inside this many days triggers the nudge. */
export const NUDGE_HORIZON_DAYS = 7;

const DAY_MS = 86_400_000;

/** A ranked candidate, as read from the persisted ranking. `rank` is 1-based in the live order. */
export interface NudgeCandidate {
  targetType: "action" | "deliverable";
  targetId: string;
  title: string;
  rank: number;
  totalScore: number;
  eligible: boolean;
  /** The engine's critical rank: below `ordinaryRank` is a deadline tier, which the nudge never touches. */
  criticalRank: number;
  /** Recurring or cadence work, which gets the fallback boost when nothing `prepares` a trigger. */
  recurring: boolean;
  /** The nearest external or internal deadline of the candidate's project, if any. */
  dueAt: string | null;
}

/** An item whose date makes the nudge apply: a deadline or an exam commitment. */
export interface NudgeTrigger {
  type: PlanItemType;
  id: string;
  title: string;
  dueAt: string;
  kind: "deadline" | "exam";
}

export interface NudgeInput {
  now: Date;
  candidates: readonly NudgeCandidate[];
  triggers: readonly NudgeTrigger[];
  /** Any status; only `confirmed` links are read. */
  links: readonly PlanLink[];
  /** The engine's `ordinary` critical rank. */
  ordinaryRank: number;
}

export interface NudgeMove {
  targetType: "action" | "deliverable";
  targetId: string;
  title: string;
  rankBefore: number;
  rankAfter: number;
  scoreBefore: number;
  boost: number;
  reason: string;
}

export interface NudgeDisplaced {
  targetType: "action" | "deliverable";
  targetId: string;
  title: string;
  rankBefore: number;
  rankAfter: number;
  dueAt: string | null;
  /** True when this candidate's own project is due inside the horizon: the slip the weekly comparison watches for. */
  dueWithinHorizon: boolean;
}

export interface NudgeCapResult {
  capDays: NudgeCapDays;
  capPoints: number;
  /** Every boosted candidate, including those whose boost changed no rank. */
  boosted: { targetType: "action" | "deliverable"; targetId: string; boost: number; reason: string }[];
  /** Candidates that would have risen. */
  moves: NudgeMove[];
  /** Candidates that would have fallen as a result. */
  displaced: NudgeDisplaced[];
}

export const handleOf = (type: string, id: string) => `${type}:${id}`;

function inHorizon(dueAt: string, now: Date): boolean {
  const ms = new Date(dueAt).getTime() - now.getTime();
  return ms >= 0 && ms <= NUDGE_HORIZON_DAYS * DAY_MS;
}

/** Why each candidate is boosted at full cap, independent of the cap. Computed once and scaled per cap. */
function qualifying(input: NudgeInput): Map<string, string[]> {
  const confirmed = input.links.filter((link) => link.status === "confirmed");
  const subjectsOf = new Map<string, Set<string>>();
  for (const link of confirmed) {
    if (link.kind !== "about" || link.toType !== "subject") continue;
    const set = subjectsOf.get(handleOf(link.fromType, link.fromId)) ?? new Set<string>();
    set.add(link.toId);
    subjectsOf.set(handleOf(link.fromType, link.fromId), set);
  }
  const candidateByHandle = new Map(input.candidates.map((c) => [handleOf(c.targetType, c.targetId), c]));
  const why = new Map<string, string[]>();
  const note = (handle: string, text: string) => {
    const list = why.get(handle) ?? [];
    if (!list.includes(text)) list.push(text);
    why.set(handle, list);
  };

  for (const trigger of input.triggers) {
    if (!inHorizon(trigger.dueAt, input.now)) continue;
    const triggerHandle = handleOf(trigger.type, trigger.id);
    const subjects = subjectsOf.get(triggerHandle);
    if (!subjects || subjects.size === 0) continue;
    const text = `${trigger.title} (${trigger.kind === "exam" ? "exam" : "due"} ${trigger.dueAt.slice(0, 10)})`;

    const preparers = confirmed.filter(
      (link) => link.kind === "prepares" && handleOf(link.toType, link.toId) === triggerHandle
    );
    if (preparers.length > 0) {
      for (const link of preparers) {
        const handle = handleOf(link.fromType, link.fromId);
        if (candidateByHandle.has(handle)) note(handle, text);
      }
      continue;
    }
    // No `prepares` link: recurring and cadence work about the same subject gets the boost instead.
    for (const candidate of input.candidates) {
      if (!candidate.recurring) continue;
      const handle = handleOf(candidate.targetType, candidate.targetId);
      const own = subjectsOf.get(handle);
      if (own && [...subjects].some((id) => own.has(id))) note(handle, text);
    }
  }
  return why;
}

export function computeNudge(input: NudgeInput): NudgeCapResult[] {
  const why = qualifying(input);
  return NUDGE_CAPS_DAYS.map((capDays) => {
    const capPoints = capDays * NUDGE_POINTS_PER_DAY;
    const boosts = new Map<string, { boost: number; reason: string }>();
    for (const candidate of input.candidates) {
      const handle = handleOf(candidate.targetType, candidate.targetId);
      const reasons = why.get(handle);
      // A deadline tier or an ineligible candidate is never moved: the nudge cannot outrank a real deadline.
      if (!reasons || !candidate.eligible || candidate.criticalRank < input.ordinaryRank) continue;
      boosts.set(handle, {
        boost: capPoints,
        reason: `Prepares or recurs for ${reasons.slice(0, 3).join("; ")}.`
      });
    }

    // Reorder only the eligible ordinary block, and only by lifting boosted candidates past lower scores,
    // so any tie-break the engine applied among unboosted candidates is left exactly as it was.
    const live = [...input.candidates].sort((a, b) => a.rank - b.rank);
    const blockHandles = live
      .filter((c) => c.eligible && c.criticalRank >= input.ordinaryRank)
      .map((c) => handleOf(c.targetType, c.targetId));
    const byHandle = new Map(live.map((c) => [handleOf(c.targetType, c.targetId), c]));
    const order = [...blockHandles];
    for (const handle of blockHandles) {
      const boost = boosts.get(handle);
      if (!boost) continue;
      const lifted = byHandle.get(handle)!.totalScore + boost.boost;
      const from = order.indexOf(handle);
      let to = from;
      for (let i = 0; i < from; i++) {
        if (byHandle.get(order[i]!)!.totalScore < lifted) {
          to = i;
          break;
        }
      }
      if (to < from) {
        order.splice(from, 1);
        order.splice(to, 0, handle);
      }
    }

    // Ranks of the block's slots in the live list, reassigned in the new order.
    const slots = blockHandles.map((h) => byHandle.get(h)!.rank);
    const rankAfter = new Map(order.map((handle, i) => [handle, slots[i]!]));

    const moves: NudgeMove[] = [];
    const displaced: NudgeDisplaced[] = [];
    for (const handle of blockHandles) {
      const candidate = byHandle.get(handle)!;
      const after = rankAfter.get(handle)!;
      if (after < candidate.rank) {
        const boost = boosts.get(handle)!;
        moves.push({
          targetType: candidate.targetType,
          targetId: candidate.targetId,
          title: candidate.title,
          rankBefore: candidate.rank,
          rankAfter: after,
          scoreBefore: candidate.totalScore,
          boost: boost.boost,
          reason: boost.reason
        });
      } else if (after > candidate.rank) {
        displaced.push({
          targetType: candidate.targetType,
          targetId: candidate.targetId,
          title: candidate.title,
          rankBefore: candidate.rank,
          rankAfter: after,
          dueAt: candidate.dueAt,
          dueWithinHorizon: candidate.dueAt !== null && inHorizon(candidate.dueAt, input.now)
        });
      }
    }
    return {
      capDays,
      capPoints,
      boosted: [...boosts.entries()].map(([handle, value]) => {
        const candidate = byHandle.get(handle)!;
        return { targetType: candidate.targetType, targetId: candidate.targetId, ...value };
      }),
      moves,
      displaced
    };
  });
}

/** What the weekly comparison reads back per cap. */
export interface NudgeCapSummary {
  capDays: NudgeCapDays;
  runs: number;
  /** Distinct candidates that would have risen at least once. */
  actionsMoved: number;
  /** Total would-be rank places gained. */
  placesGained: number;
  /** Of those moved, how many were later done. */
  movedThenDone: number;
  /** Distinct candidates that would have fallen. */
  displaced: number;
  /** Of those, how many are due inside the horizon: anything above zero is the slip to look at. */
  slippedDue: number;
}
