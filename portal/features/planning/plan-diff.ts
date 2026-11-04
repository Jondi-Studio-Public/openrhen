import type { DayPlanBlock, PlanForecastResponse } from "@openrhen/contracts";
import { zonedDayBounds } from "@/features/today/local-datetime";
import { localDayKey } from "@/features/today/today-view";

/**
 * "What changed" between the plan that was current when a disruption landed and the plan current
 * now — a pure diff over two `PlanForecastResponse` runs, restricted to one local day. No DB, no
 * engine: the portal boundary test forbids importing `@openrhen/engine-core` anywhere on this
 * side, and this module treats both runs as already-fetched, already-parsed data.
 */
export interface PlanChangeSummary {
  /** False when either run is missing or unparseable — every list is empty and nothing else is claimed. */
  available: boolean;
  moved: Array<{
    kind: DayPlanBlock["kind"];
    targetId: string;
    title: string;
    fromStartsAt: string;
    toStartsAt: string;
    deltaMinutes: number;
  }>;
  dropped: Array<{ kind: DayPlanBlock["kind"]; targetId: string; title: string; startsAt: string }>;
  added: Array<{ kind: DayPlanBlock["kind"]; targetId: string; title: string; startsAt: string }>;
  /** Shift of the upcoming night's `plannedStartAt`, `after − before`, in minutes. 0 when unchanged or absent. */
  sleepShiftMinutes: number;
  /**
   * `before`'s own upcoming-night `plannedStartAt`, straight through with no comparison against
   * `after` — the raw fact `disruption-impact.ts` needs to tell "this night was already due to start
   * before the disruption landed" (not the disruption's doing) from a real disruption-caused shift.
   * `null` when `before` had no upcoming night at all.
   */
  beforeNightPlannedStartAt: string | null;
  newlyDisplaced: Array<{ targetId: string; firstPlannedAt: string | null }>;
}

export interface PlanDiffOptions {
  /** The local day (`YYYY-MM-DD`, `local-datetime.ts` convention) the diff is restricted to. */
  dayKey: string;
  timezone: string;
}

/** A block moved by more than this many minutes counts as `moved`; at or under is noise. */
const MOVE_THRESHOLD_MINUTES = 5;

function emptySummary(): PlanChangeSummary {
  return {
    available: false,
    moved: [],
    dropped: [],
    added: [],
    sleepShiftMinutes: 0,
    beforeNightPlannedStartAt: null,
    newlyDisplaced: []
  };
}

/**
 * The blocks of one run that fall on the given local day and name a real target — gaps, recovery,
 * and travel legs carry no `targetId` and cannot be matched between runs, so they are left out
 * rather than diffed as spurious drops/adds every time the schedule around them reflows.
 */
function blocksOnDay(response: PlanForecastResponse, dayKey: string, timezone: string): DayPlanBlock[] {
  if (!response.dayPlan) return [];
  const bounds = zonedDayBounds(dayKey, timezone);
  const dayStart = bounds.startsAt.getTime();
  const dayEnd = bounds.endsAt.getTime();
  return response.dayPlan.blocks.filter((block) => {
    if (block.targetId === null) return false;
    const startsAt = new Date(block.startsAt).getTime();
    return startsAt >= dayStart && startsAt < dayEnd;
  });
}

function keyFor(block: DayPlanBlock): string {
  return `${block.kind}:${block.targetId}`;
}

interface SleepPlanLike {
  id: string;
  plannedStartAt: string;
}

/** `derivedState.sleepPlans` is untyped JSON in the contract; duck-type the two fields this needs. */
function asSleepPlans(value: PlanForecastResponse["derivedState"]["sleepPlans"]): SleepPlanLike[] {
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    return typeof record.id === "string" && typeof record.plannedStartAt === "string"
      ? [{ id: record.id, plannedStartAt: record.plannedStartAt }]
      : [];
  });
}

/** The first sleep plan whose `plannedStartAt` falls on or after the local day the diff is scoped to. */
function upcomingNight(response: PlanForecastResponse, dayStart: number): SleepPlanLike | undefined {
  return asSleepPlans(response.derivedState.sleepPlans)
    .filter((plan) => new Date(plan.plannedStartAt).getTime() >= dayStart)
    .sort((a, b) => a.plannedStartAt.localeCompare(b.plannedStartAt))[0];
}

/**
 * The local calendar night a sleep block belongs to. A block starting in the small hours (say 02:52)
 * is the tail end of the *previous* evening's sleep, not the start of a new one, so night identity is
 * the local day of `plannedStartAt − 12h`, not of `plannedStartAt` itself: 02:52 shifts back to the
 * previous local day, 23:00 stays on its own day. Two plans with the same night key are the same
 * night's sleep even though a replan gives them different ids (see `sleepShift`).
 */
function nightKeyFor(plannedStartAt: string, timezone: string): string {
  const shiftedBack = new Date(new Date(plannedStartAt).getTime() - 12 * 60 * 60_000);
  return localDayKey(shiftedBack, timezone);
}

/**
 * The bedtime shift between the two runs, restricted to the *same* night. Sleep rows are keyed by a
 * hash of `plannedStartAt`, so a shifted night gets a fresh id — matching used to be "the first plan
 * on or after local-midnight-of-the-scoped-day in each run", which silently compared two different
 * nights whenever `landedAt` fell in the small hours: the before-run's still-in-progress night (its
 * `plannedStartAt` sits just before `landedAt`, but is still `>= dayStart` because the night started
 * after local midnight) against the after-run's genuinely next night. That produced shifts of several
 * hundred minutes that were really "two different bedtimes, diffed against each other" (a
 * "Bedtime moves 488 min later" warning, where 488 min was exactly `landedAt` to the after-run's actual
 * next bedtime, not any real movement of one night's plan).
 *
 * Now: find the night `before` was pointing at, then look for that *same* night (by `nightKeyFor`,
 * not position) in `after`. 0 when `before` has no upcoming night, or `after` has none for that same
 * night — the night was slept, completed, or dropped, so there is nothing left to renegotiate against.
 */
function sleepShift(beforeNight: SleepPlanLike | undefined, after: PlanForecastResponse, timezone: string): number {
  if (!beforeNight) return 0;
  const nightKey = nightKeyFor(beforeNight.plannedStartAt, timezone);
  const afterNight = asSleepPlans(after.derivedState.sleepPlans).find(
    (plan) => nightKeyFor(plan.plannedStartAt, timezone) === nightKey
  );
  if (!afterNight) return 0;
  return Math.round(
    (new Date(afterNight.plannedStartAt).getTime() - new Date(beforeNight.plannedStartAt).getTime()) / 60_000
  );
}

/**
 * Diffs two engine runs restricted to one local day, keyed by (kind, targetId):
 * - `moved`: same key in both, `startsAt` differs by more than {@link MOVE_THRESHOLD_MINUTES}.
 * - `dropped` / `added`: key present in only one side.
 * - `sleepShiftMinutes`: see {@link sleepShift}.
 * - `newlyDisplaced`: `after.dayPlan.displaced` minus `before.dayPlan.displaced`, by `targetId` —
 *   not restricted to the local day, since a displaced deadline is not itself a scheduled block.
 *   Carries `firstPlannedAt` through from the after-run's entry (a target the plan
 *   never placed anywhere flickers in and out of `displaced` as ordinary capacity ebbs and flows over
 *   the hours after a disruption, unrelated to the disruption itself — `assessDisruption` is where
 *   that gets told apart from a target that actually held a slot and lost it).
 */
export function diffDayPlans(
  before: PlanForecastResponse | undefined,
  after: PlanForecastResponse | undefined,
  opts: PlanDiffOptions
): PlanChangeSummary {
  if (!before || !after) return emptySummary();

  const dayStart = zonedDayBounds(opts.dayKey, opts.timezone).startsAt.getTime();
  const beforeByKey = new Map(blocksOnDay(before, opts.dayKey, opts.timezone).map((block) => [keyFor(block), block]));
  const afterByKey = new Map(blocksOnDay(after, opts.dayKey, opts.timezone).map((block) => [keyFor(block), block]));

  const moved: PlanChangeSummary["moved"] = [];
  const dropped: PlanChangeSummary["dropped"] = [];
  const added: PlanChangeSummary["added"] = [];

  for (const [key, beforeBlock] of beforeByKey) {
    const afterBlock = afterByKey.get(key);
    if (!afterBlock) {
      dropped.push({
        kind: beforeBlock.kind,
        targetId: beforeBlock.targetId!,
        title: beforeBlock.title,
        startsAt: beforeBlock.startsAt
      });
      continue;
    }
    const deltaMinutes = Math.round(
      (new Date(afterBlock.startsAt).getTime() - new Date(beforeBlock.startsAt).getTime()) / 60_000
    );
    if (Math.abs(deltaMinutes) > MOVE_THRESHOLD_MINUTES)
      moved.push({
        kind: beforeBlock.kind,
        targetId: beforeBlock.targetId!,
        title: afterBlock.title,
        fromStartsAt: beforeBlock.startsAt,
        toStartsAt: afterBlock.startsAt,
        deltaMinutes
      });
  }
  for (const [key, afterBlock] of afterByKey) {
    if (!beforeByKey.has(key))
      added.push({
        kind: afterBlock.kind,
        targetId: afterBlock.targetId!,
        title: afterBlock.title,
        startsAt: afterBlock.startsAt
      });
  }

  const beforeDisplaced = new Set((before.dayPlan?.displaced ?? []).map((item) => item.targetId));
  const newlyDisplaced = (after.dayPlan?.displaced ?? [])
    .filter((item) => !beforeDisplaced.has(item.targetId))
    .map((item) => ({ targetId: item.targetId, firstPlannedAt: item.firstPlannedAt }));

  const beforeNight = upcomingNight(before, dayStart);

  return {
    available: true,
    moved,
    dropped,
    added,
    sleepShiftMinutes: sleepShift(beforeNight, after, opts.timezone),
    beforeNightPlannedStartAt: beforeNight?.plannedStartAt ?? null,
    newlyDisplaced
  };
}
