import type { PlanChangeSummary } from "@/features/planning/plan-diff";
import type { PortalState } from "@/state/portal-state";

/**
 * The renegotiation-worthy consequences of a disruption, read off the server's own before/after
 * diff. This is the second half of the two-tier split (`plan-diff.ts` is the first): a disruption
 * that only nudges the schedule around is left to reflow quietly, and one that actually costs
 * something — a target the plan no longer reaches, or a meaningfully later bedtime — gets a prompt.
 * Nothing here re-derives planning truth; every fact comes from `summary`, and the only new work is
 * resolving `newlyDisplaced`'s bare target ids against portal state so the prompt can name names.
 */
export type DisruptionImpactTier = "absorbed" | "renegotiate";

export interface DisruptionImpactTarget {
  targetId: string;
  title: string;
  /** "action" and "deliverable" resolve against portal state; "commitment" and "unknown" do not. */
  kind: "action" | "deliverable" | "commitment" | "unknown";
  /** Whether this target could plausibly move to make room — an action or deliverable can; a fixed
   * commitment, or anything the portal cannot even identify, cannot. */
  movable: boolean;
  /**
   * The displaced commitment's own contact, when it resolves (`commitment-contact.ts`). Only ever
   * set for `kind: "commitment"` — an action or a deliverable never carries one
   *
   */
  contactId?: string;
}

export interface DisruptionImpact {
  tier: DisruptionImpactTier;
  newlyDisplaced: DisruptionImpactTarget[];
  /** `after − before` for the upcoming night, straight from the diff. 0 when unchanged. */
  bedtimeShiftMinutes: number;
  movable: DisruptionImpactTarget[];
  immovable: DisruptionImpactTarget[];
}

/**
 * A bedtime shift at or under this many minutes is ordinary night-to-night variance and is absorbed
 * without a prompt; the diff panel on Today still shows it. Above it, the person is losing enough
 * sleep that "nobody asked me" would be a fair complaint, so it earns a renegotiation prompt of its
 * own even when nothing was displaced.
 */
export const BEDTIME_SHIFT_RENEGOTIATE_THRESHOLD_MINUTES = 20;

/**
 * The deadline that would make `targetId` overdue, when the portal can name one — an action's own
 * `deadlineAt`, or a deliverable's `externalDeadlineAt` (the real-world commitment; `internalDeadlineAt`
 * is a personal target and can sit on either side of it). A commitment or an unresolvable target
 * carries no deadline of its own, so `undefined` here is "no opinion", not "not overdue".
 */
function deadlineFor(targetId: string, state: PortalState): Date | undefined {
  const action = state.actions.find((item) => item.id === targetId);
  if (action?.deadlineAt) return new Date(action.deadlineAt);
  const deliverable = state.deliverables.find((item) => item.id === targetId);
  if (deliverable?.externalDeadlineAt) return new Date(deliverable.externalDeadlineAt);
  return undefined;
}

function resolveTarget(targetId: string, state: PortalState): DisruptionImpactTarget {
  const action = state.actions.find((item) => item.id === targetId);
  if (action) return { targetId, title: action.title, kind: "action", movable: true };
  const deliverable = state.deliverables.find((item) => item.id === targetId);
  if (deliverable) return { targetId, title: deliverable.title, kind: "deliverable", movable: true };
  const commitment = state.commitments.find((item) => item.id === targetId);
  if (commitment)
    return {
      targetId,
      title: commitment.title,
      kind: "commitment",
      movable: false,
      ...(commitment.contactId ? { contactId: commitment.contactId } : {})
    };
  // Unresolvable is treated the same as commitment-like: there is nothing offer-able to do about a
  // target the portal cannot even name, so it goes in the immovable bucket rather than being dropped.
  return { targetId, title: "something no longer in the plan", kind: "unknown", movable: false };
}

/**
 * `available:false` means the server found no earlier run to compare against — no evidence, so no
 * claim of a consequence either, whatever `newlyDisplaced` and `sleepShiftMinutes` happen to hold
 * (they are the empty defaults on that response, but the emptiness is checked explicitly rather than
 * trusted, since "empty" and "unknown" must never collapse into the same tier).
 *
 * `landedAt` excludes a `newlyDisplaced` target whose own deadline was already behind it: that target
 * was lost before the disruption ever landed, so the disruption cannot be why the plan no longer
 * reaches it — `diffDayPlans` only sees "not displaced before, displaced after" and has no notion of
 * the disruption itself, so this is where the misattribution actually gets caught (
 * three long-overdue trip actions, all deadlined before a disruption that landed at local midnight,
 * dropped out of the plan the same day from ordinary day-shrinkage and were blamed on it forever).
 * A target with no resolvable deadline (a commitment, or one the portal cannot name at all) is never
 * excluded on this basis — absence of a deadline is not evidence it was already overdue.
 *
 * A second exclusion catches a different kind of false attribution: a `newlyDisplaced` entry whose
 * `firstPlannedAt` is null never held a slot in the plan at all, in either run — the plan simply never
 * reached it, which is ordinary capacity/priority pressure, not something the disruption moved. Left
 * unfiltered, this flickers a low-priority recurring action (five-a-day, one minute each, no deadline)
 * in and out of `displaced` every few minutes as the schedule fills up through the hours after a
 * disruption landed, changing `newlyDisplaced`'s composition — and with it the dismissal signature —
 * with no user action in between (a repeated "displaced something" warning
 * with no change made). A target that *did* get a slot and lost it (`firstPlannedAt` non-null) is real
 * evidence of something the plan moved, and stays in.
 *
 * A third exclusion does the same job for `bedtimeShiftMinutes` that the first two do for
 * `newlyDisplaced`: a shift only counts as the disruption's doing when `before`'s own upcoming night
 * was still ahead of the disruption at the moment it landed — `beforeNightPlannedStartAt > landedAt`.
 * A night whose `plannedStartAt` was already at or before `landedAt` was already due to start (or in
 * progress) when the disruption landed, so the disruption cannot be why it moved; `diffDayPlans` has
 * no notion of the disruption itself and will report whatever the next matching night in `after`
 * happens to be, however far off. `landedAt` fell in the small hours while the plan
 * was mid-night, `before`'s "upcoming night" was that same in-progress night (`plannedStartAt` just
 * before `landedAt`), and `after`'s matching-night lookup found nothing until the *following* night —
 * 488 minutes away, none of it caused by the disruption. The raw number still reaches Today's own
 * "What changed" panel, which reads `summary.sleepShiftMinutes` directly rather than through here.
 */
export function assessDisruption(summary: PlanChangeSummary, state: PortalState, landedAt: Date): DisruptionImpact {
  if (!summary.available)
    return { tier: "absorbed", newlyDisplaced: [], bedtimeShiftMinutes: 0, movable: [], immovable: [] };

  const bedtimeMovedByDisruption =
    summary.beforeNightPlannedStartAt !== null &&
    new Date(summary.beforeNightPlannedStartAt).getTime() > landedAt.getTime();
  const bedtimeShiftMinutes = bedtimeMovedByDisruption ? summary.sleepShiftMinutes : 0;

  const newlyDisplaced = summary.newlyDisplaced
    .filter((item) => item.firstPlannedAt !== null)
    .filter((item) => {
      const deadline = deadlineFor(item.targetId, state);
      return !deadline || deadline.getTime() >= landedAt.getTime();
    })
    .map((item) => resolveTarget(item.targetId, state));
  const tier: DisruptionImpactTier =
    newlyDisplaced.length > 0 || Math.abs(bedtimeShiftMinutes) > BEDTIME_SHIFT_RENEGOTIATE_THRESHOLD_MINUTES
      ? "renegotiate"
      : "absorbed";

  return {
    tier,
    newlyDisplaced,
    bedtimeShiftMinutes,
    movable: newlyDisplaced.filter((item) => item.movable),
    immovable: newlyDisplaced.filter((item) => !item.movable)
  };
}
