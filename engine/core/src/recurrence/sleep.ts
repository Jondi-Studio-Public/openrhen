import { commitmentProtection } from "../model/types.js";
import { localDateFormat } from "../model/zoned-formats.js";
import { zonedDateTime } from "@openrhen/contracts";
import { addLocalDays } from "./recurrence.js";
import type {
  FixedCommitment,
  SleepDeviationOption,
  SleepDeviationOptions,
  SleepPlan,
  SleepPreferences,
  SleepWakeConstraint
} from "../model/types.js";

const MINUTE = 60_000;
const STEP = 15 * MINUTE;
/**
 * How far under `minimumSleepMinutes` a completed night may fall and still count as the slept night
 * rather than a nap. A flat 30 minutes (rather than a percentage) because the slack it forgives is
 * manual-entry rounding and drifting off a few minutes late, which does not scale with the minimum.
 * Observed live: a manually logged 298-minute night against a 300-minute minimum
 * was classified as a nap, which re-armed the missed bedtime and prescribed "sleep 5 minutes" at
 * 4:43 am, eight minutes after the user woke up.
 */
const NAP_TOLERANCE_MINUTES = 30;

/** One retained night (`sleeping`, or an overridden `planned` row) `planSleep` must plan around. */
export interface KeptNight {
  id: string;
  startsAt: Date;
  wakesAt: Date;
}

export interface SleepPlanningInput {
  now: Date;
  timezone: string;
  preferences: SleepPreferences;
  lastWokeAt: Date;
  /**
   * `lastWokeAt` is not a recorded wake but `assumedWakeAt`'s stand-in, because the real one is unknown or
   * too old to believe. The first night then plans from the sleep
   * preferences alone: the stand-in puts no awake limit on it, though a preferred bedtime already past is
   * still a missed start.
   */
  assumedWake?: boolean;
  commitments: FixedCommitment[];
  /**
   * How long the sleep that ended at lastWokeAt actually lasted. Distinguishes a night already slept
   * from a nap, which look identical from the wake time alone. Absent means unknown — and an unknown
   * duration behind a wake the user recorded at or after the cycle's bedtime anchor cancels that
   * cycle's bedtime, the same as a full night would. Only a *known* nap leaves the bedtime standing:
   * the old rule ("unknown must not cancel") converted one corrupted completed row — duration
   * unknowable — into a full sleep obligation pinned to the instant of calculation, at 4:47 am,
   * minutes after the user got up.
   */
  lastSleepMinutes?: number;
  /** The total length of tonight's included bedtime routine steps (`deriveBedtimeSteps`'s own count). */
  bedtimeRoutineMinutes?: number;
  /** Nights already decided elsewhere (`sleeping`, or an overridden `planned` row) — see "Placing a night". */
  keptNights?: KeptNight[];
  /** How many consecutive nights to plan; a week unless a caller (assumed nights past the plan) wants fewer. */
  nights?: number;
  /** A stored `placementChoice` for a cycle's raw (pre-hash) id, when one has been recorded. */
  answers?: (rawKey: string) => { placementChoice?: "early" | "near" } | undefined;
  /** Whether a cycle's raw (pre-hash) id already belongs to a `completed` row (the nap discriminator). */
  isCompleted?: (rawKey: string) => boolean;
}
export interface SleepWindowInput {
  startAt: Date;
  targetMinutes: number;
  preferences: Pick<SleepPreferences, "minimumSleepMinutes" | "desiredSleepMinutes" | "arrivalMarginMinutes">;
  commitments: FixedCommitment[];
}
export interface SleepWindowResolution {
  startsAt: Date;
  wakesAt: Date;
  plannedMinutes: number;
  minimumShortfallMinutes: number;
  wakeConstraint?: SleepWakeConstraint;
}

export function resolveSleepWindow(input: SleepWindowInput): SleepWindowResolution {
  const startsAt = new Date(input.startAt);
  const unconstrainedWake = new Date(startsAt.getTime() + input.targetMinutes * MINUTE);
  // A flexible routine step whose lead window opened at or before this bedtime can be done the
  // evening before instead of forcing an early rise, so it never truncates the wake. Contiguous
  // steps (and flexible ones whose window only opens mid-sleep) still gate the wake as ever.
  const constraint = protectedRanges(input.commitments, input.preferences.arrivalMarginMinutes).find(
    (range) =>
      range.startsAt > startsAt &&
      range.startsAt < unconstrainedWake &&
      !(range.flexibleLeadOpensAt !== undefined && range.flexibleLeadOpensAt <= startsAt)
  );
  const wakesAt = constraint ? new Date(constraint.startsAt) : unconstrainedWake;
  const plannedMinutes = Math.max(0, Math.floor((wakesAt.getTime() - startsAt.getTime()) / MINUTE));
  return {
    startsAt,
    wakesAt,
    plannedMinutes,
    minimumShortfallMinutes: Math.max(0, input.preferences.minimumSleepMinutes - plannedMinutes),
    ...(constraint
      ? {
          wakeConstraint: {
            commitmentId: constraint.id,
            ...(constraint.title ? { title: constraint.title } : {}),
            protectedStartAt: new Date(constraint.startsAt)
          }
        }
      : {})
  };
}

interface Conflict {
  id: string;
  title?: string | undefined;
  startsAt: Date;
  endsAt: Date;
  flexibleLeadOpensAt?: Date | undefined;
}

/**
 * The old single-pass conflict walk, parameterised on the seed window instead
 * of always starting at the untouched anchor. Given a seed `(start, end)`, walks the fixed, ascending
 * conflict list once, skipping any entry the resolution has already cleared, and returns the resolved
 * window. See `sleep.ts`'s git history / the design note for why the ordering and the "already
 * cleared" skip matter: walking back to (or truncating at) a conflict's own start always yields an
 * `end` at or before every later entry's start too, so one resolution clears a whole contiguous chain.
 */
function walkConflicts(args: {
  seedStart: Date;
  seedEnd: Date;
  conflicts: Conflict[];
  awakeFrom: Date;
  now: Date;
  latestStart: Date;
  targetMinutes: number;
  missedStart: boolean;
}): { start: Date; end: Date } {
  let { start, end } = { start: args.seedStart, end: args.seedEnd };
  for (const conflict of args.conflicts.filter(
    (range) =>
      range.startsAt < end &&
      range.endsAt > start &&
      !(range.flexibleLeadOpensAt !== undefined && range.flexibleLeadOpensAt <= start)
  )) {
    if (!(conflict.startsAt < end && conflict.endsAt > start)) continue;
    const earlier = new Date(conflict.startsAt.getTime() - args.targetMinutes * MINUTE);
    const clampedToNow = new Date(Math.max(args.now.getTime(), args.awakeFrom.getTime()));
    if (!args.missedStart && earlier >= args.awakeFrom && earlier >= args.now && earlier <= args.latestStart) {
      start = roundDown(earlier);
      end = new Date(start.getTime() + args.targetMinutes * MINUTE);
    } else if (
      !args.missedStart &&
      earlier < args.now &&
      clampedToNow < start &&
      clampedToNow < conflict.startsAt &&
      clampedToNow <= args.latestStart
    ) {
      start = clampedToNow;
      end = new Date(Math.min(start.getTime() + args.targetMinutes * MINUTE, conflict.startsAt.getTime()));
    } else if (conflict.startsAt > start) {
      end = new Date(conflict.startsAt);
    } else {
      start = roundUp(conflict.endsAt);
      end = new Date(start.getTime() + args.targetMinutes * MINUTE);
    }
  }
  return { start, end };
}

/** The latest preferred wake time at or before `now`: the wake a night is planned from while the real one is unknown. */
export function assumedWakeAt(now: Date, timezone: string, preferredWakeTime: string): Date {
  const today = zonedTarget(now, timezone, preferredWakeTime, 0);
  return today <= now ? today : zonedTarget(now, timezone, preferredWakeTime, -1);
}

export function planSleep(input: SleepPlanningInput): SleepPlan[] {
  const targetMinutes = input.preferences.desiredSleepMinutes;
  const bedtimeRoutineMinutes = input.bedtimeRoutineMinutes ?? 0;
  const keptNights = [...(input.keptNights ?? [])].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  const answers = input.answers ?? (() => undefined);
  const isCompleted = input.isCompleted ?? (() => false);
  const plans: SleepPlan[] = [];
  const usedCycleIds = new Set<string>();
  let awakeFrom = input.lastWokeAt;
  const bedtimeMinutes = wallMinutes(input.preferences.preferredBedtime);
  const wakeMinutes = wallMinutes(input.preferences.preferredWakeTime);
  const bedtimeFor = (forWakeDay: number) =>
    zonedTarget(
      input.now,
      input.timezone,
      input.preferences.preferredBedtime,
      forWakeDay - (bedtimeMinutes >= wakeMinutes ? 1 : 0)
    );
  /**
   * Which bedtime/wake cycle a night after the first is anchored to: the first preferred bedtime at
   * or after the previous plan's wake. See the design note's "Night identity" decision and the
   * long-standing comment this replaces in git history for why this is anchored on the previous
   * wake rather than a calendar offset from `now`.
   */
  const cycleAfter = (wokeAt: Date) => {
    let wakeDay = localDayOffset(input.now, input.timezone, wokeAt) - 1;
    for (let attempt = 0; attempt < 4 && bedtimeFor(wakeDay) < wokeAt; attempt += 1) wakeDay += 1;
    return wakeDay;
  };
  for (let day = 0; day < (input.nights ?? 7); day += 1) {
    let wakeDay = day === 0 ? 0 : cycleAfter(awakeFrom);
    let targetWake = zonedTarget(input.now, input.timezone, input.preferences.preferredWakeTime, wakeDay);
    if (targetWake <= input.now) {
      wakeDay += 1;
      targetWake = zonedTarget(input.now, input.timezone, input.preferences.preferredWakeTime, wakeDay);
    }
    let targetBedtime = bedtimeFor(wakeDay);
    if (
      day === 0 &&
      awakeFrom >= targetBedtime &&
      (input.lastSleepMinutes === undefined ||
        input.lastSleepMinutes >= input.preferences.minimumSleepMinutes - NAP_TOLERANCE_MINUTES)
    ) {
      wakeDay += 1;
      targetWake = zonedTarget(input.now, input.timezone, input.preferences.preferredWakeTime, wakeDay);
      targetBedtime = bedtimeFor(wakeDay);
    }

    // A kept night (`sleeping`, or an overridden `planned` row) already decides this cycle: skip
    // generating a competing plan for it, and chain the next cycle from its real wake instead of a
    // calculated wake that was thrown away (finding 4).
    const covering = keptNights.find((night) => night.startsAt < targetWake && night.wakesAt > targetBedtime);
    if (covering) {
      awakeFrom = covering.wakesAt;
      continue;
    }

    const anchorSpan = targetWake.getTime() - targetBedtime.getTime();
    const anchorCompromise = roundToStep(new Date(targetBedtime.getTime() + (anchorSpan - targetMinutes * MINUTE) / 2));
    let anchorStart = anchorCompromise;
    let anchorEnd = new Date(anchorStart.getTime() + targetMinutes * MINUTE);
    // An assumed wake is a guess at when the day began, so it cannot make the night late: the limit
    // only binds from a wake somebody recorded, and from the planned wakes the later nights chain from.
    const assumed = day === 0 && input.assumedWake === true;
    const latestStart = assumed
      ? new Date(targetWake)
      : new Date(awakeFrom.getTime() + input.preferences.maxAwakeHours * 60 * MINUTE);
    const missedStart = day === 0 && anchorStart < input.now;
    if (missedStart) {
      anchorStart = new Date(input.now);
      anchorEnd = new Date(anchorStart.getTime() + targetMinutes * MINUTE);
    } else if (anchorStart > latestStart) {
      anchorStart = roundDown(latestStart);
      anchorEnd = new Date(anchorStart.getTime() + targetMinutes * MINUTE);
    }

    const floor = new Date(Math.max(input.now.getTime(), awakeFrom.getTime()));
    // The candidate conflicts are fixed once here, against the untouched anchor window widened to
    // cover the bedtime-deviation range and tonight's routine, so an early-placement or after-conflict
    // candidate can see every commitment it needs to. An unrelated daytime commitment
    // must never pull a night back, so this is still the same bounded window, just wider on both ends.
    const searchFrom = new Date(
      Math.min(anchorStart.getTime(), targetBedtime.getTime() - input.preferences.bedtimeDeviationMinutes * MINUTE) -
        bedtimeRoutineMinutes * MINUTE
    );
    const searchTo = new Date(Math.max(anchorEnd.getTime(), latestStart.getTime() + targetMinutes * MINUTE));
    const conflicts = protectedRanges(input.commitments, input.preferences.arrivalMarginMinutes).filter(
      (range) => range.startsAt < searchTo && range.endsAt > searchFrom
    );

    // `walkConflicts` filters its conflict list once, against the SEED window it is given, so a walk
    // that moves `start`/`end` away from that seed (walking back to clear a later conflict, say) can
    // land inside an earlier conflict the filter never considered — `toCandidate`'s own `startClear`
    // check (below) catches this and marks the candidate invalid, but on its own that only reports the
    // collision, it does not resolve it. Re-seeding the walk with its own prior result, until it stops
    // moving or a bound is hit, lets the next pass's filter pick up whatever conflict the previous
    // pass's move newly overlapped — turning the single pass into a convergent one without changing
    // `walkConflicts` itself (found by the property test's own fuzzing: an "after this conflict" walk
    // that itself walks back into an earlier, unrelated one it had already stepped past).
    const runSeed = (seedStart: Date, seedEnd: Date) => {
      let result = { start: seedStart, end: seedEnd };
      for (let pass = 0; pass < 8; pass += 1) {
        const next = walkConflicts({
          seedStart: result.start,
          seedEnd: result.end,
          conflicts,
          awakeFrom,
          now: input.now,
          latestStart,
          targetMinutes,
          missedStart
        });
        if (next.start.getTime() === result.start.getTime() && next.end.getTime() === result.end.getTime()) {
          return next;
        }
        result = next;
      }
      return result;
    };

    type Candidate = {
      start: Date;
      end: Date;
      deviation: number;
      valid: boolean;
      routineClear: boolean;
      meetsMinimum: boolean;
    };
    const toCandidate = (start: Date, end: Date): Candidate => {
      const deviation = Math.round(
        (Math.abs(start.getTime() - targetBedtime.getTime()) + Math.abs(end.getTime() - targetWake.getTime())) / MINUTE
      );
      const withinLimit = missedStart || (start >= floor && start <= latestStart);
      const routineClear = !conflicts.some(
        (conflict) =>
          conflict.startsAt < start && conflict.endsAt > new Date(start.getTime() - bedtimeRoutineMinutes * MINUTE)
      );
      // A candidate that was walked back (or started after) one conflict can still have its start
      // pulled back inside a different, earlier conflict that a later conflict's own resolution walked
      // it into — the exact hazard this guards against for a single chain, here across two
      // independently-seeded moves. Checking the final start against the whole conflict list, rather
      // than trusting the seed's own walk, catches it; the end is left to `resolveSleepWindow`'s own
      // (legitimate) wake-truncation, so a normal future conflict never invalidates a candidate here.
      const startClear = !conflicts.some((conflict) => conflict.startsAt < start && conflict.endsAt > start);
      const meetsMinimum = (end.getTime() - start.getTime()) / MINUTE >= input.preferences.minimumSleepMinutes;
      return { start, end, deviation, valid: withinLimit && routineClear && startClear, routineClear, meetsMinimum };
    };

    // The old single-pass cascading walk is still the default answer: it already
    // prefers starting as soon as possible over delaying bedtime, which the tests it was built from
    // require. It only gets replaced when its OWN start ends up deviating from the preferred bedtime
    // by more than the configured deviation — an evening commitment walked back into the middle of the
    // day is exactly that: nothing this far from bedtime should win just because a walk-back
    // technically reaches it. In that case alone, "start after the conflict (plus the routine)" and
    // "truncate at the conflict" are tried too, and the smallest-deviation, minimum-meeting candidate
    // among all three wins instead — "after" reads as "near bedtime" precisely
    // because it no longer deviates, so no further warning is needed for it.
    let chosen: Candidate;
    let evaluated: Candidate[];
    if (missedStart) {
      // A missed start is not a placement search — the back-walking branches inside `walkConflicts`
      // are themselves gated off by `missedStart`, so nothing here ever walks bedtime earlier than
      // now — but the seed still needs the SAME conflict walk, not a short-circuit straight to "sleep
      // right now": a routine chain or commitment already under way right now (the very next thing on
      // the calendar) must still walk `start` forward past it, the same as any
      // other candidate, rather than reporting a token few minutes squeezed in before it.
      const missedResolved = runSeed(anchorStart, anchorEnd);
      chosen = toCandidate(missedResolved.start, missedResolved.end);
      evaluated = [chosen];
    } else {
      const anchorResolved = runSeed(anchorStart, anchorEnd);
      const anchorCandidate = toCandidate(anchorResolved.start, anchorResolved.end);
      const deviatesFromAnchor =
        Math.abs(anchorResolved.start.getTime() - targetBedtime.getTime()) / MINUTE >
        input.preferences.bedtimeDeviationMinutes;
      // A nearby chain of routine steps and a commitment can clamp the anchor's own walk-back to a
      // stub of a few minutes (the `now`-clamped branch of `walkConflicts` truncating hard against the
      // very first thing in the chain) without its *start* reading as deviating at all — 13 minutes
      // starting 2 hours before bedtime is numerically "close", but is not a night. Trying the
      // alternatives below whenever the anchor cannot even meet the minimum, not only when it
      // deviates, is what sends this case to "after" (past the whole chain) instead of accepting the
      // stub.
      //
      // `anchorCandidate.routineClear` also gates this fast path (found by the property test's own
      // fuzzing, `sleep-placement-property.test.ts` "routine awareness"): `walkConflicts`'s own
      // forward-walk branch (used when the raw anchor lands inside a conflict it must step past, as
      // opposed to walking back from it) lands exactly on the conflict's end with no routine buffer
      // added — only the alternatives search's dedicated "after" candidate adds
      // `bedtimeRoutineMinutes` to its own seed. Accepting the anchor outright whenever it merely
      // "doesn't deviate and meets the minimum" let that bare, buffer-less landing through unchecked,
      // silently overlapping the bedtime routine with the very commitment it just stepped past
      // (finding 8). Requiring `routineClear` too sends that case to the alternatives below instead,
      // the same as an anchor that fails the minimum already does. Deliberately narrower than the
      // full `valid` (which also folds in `withinLimit` and `startClear`): several named fixtures
      // legitimately accept an anchor whose walk-back lands inside an EARLIER conflict's own
      // resolution boundary (`startClear`'s own hazard check, there for a different, two-independent-
      // seeds case) or right at the awake limit's own edge — neither is finding 8's problem, and
      // routing those into the alternatives search too regressed them (`sleep-walks-back-before-a-
      // routine-chain.json` and others).
      if (!deviatesFromAnchor && anchorCandidate.meetsMinimum && anchorCandidate.routineClear) {
        chosen = anchorCandidate;
        evaluated = [anchorCandidate];
      } else {
        const alternatives: Candidate[] = [anchorCandidate];
        // Widened to `anchorStart - bedtimeRoutineMinutes` (matching `routineClear`'s own check
        // above), not just `anchorStart`: a commitment can end exactly where the anchor's sleep
        // window begins — no overlap with the sleep window itself — while still overlapping the
        // routine minutes that must run just before it. That case is invisible to a filter anchored
        // on the sleep window alone, so `anchorCandidate` comes back invalid (`routineClear: false`)
        // with no conflict ever identified to search around, and no "after" candidate ever gets
        // generated for it (found by the property test's own fuzzing, same finding-8 case as above).
        const firstConflict = conflicts
          .filter(
            (conflict) =>
              conflict.startsAt < anchorEnd &&
              conflict.endsAt > new Date(anchorStart.getTime() - bedtimeRoutineMinutes * MINUTE)
          )
          .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())[0];
        if (firstConflict) {
          if (firstConflict.startsAt > anchorStart) {
            const truncateResolved = runSeed(anchorStart, firstConflict.startsAt);
            alternatives.push(toCandidate(truncateResolved.start, truncateResolved.end));
          }
          // Step past `firstConflict` (buffer already included in the very first candidate, not
          // added only once at the end), then keep stepping past whichever conflict still overlaps
          // the routine buffer ahead of the new start — always the LATEST-ending one still blocking,
          // so one step clears it for good — until none does. This is a bounded, strictly
          // forward-only walk (each step's candidate already has the buffer built in, so it can
          // never re-trigger the very conflict it just stepped past) that always terminates, unlike
          // re-seeding the general `runSeed`/`walkConflicts` walk here: two conflicts placed back to
          // back (one ending exactly where the next begins) can send that walk oscillating forever
          // between "step back to clear the second" and "step forward to clear the first," neither of
          // which is a real fixed point (found by the property test's own fuzzing) — and building the
          // buffer in only at the very end, after the loop, left the loop itself checking an
          // un-buffered candidate that could still overlap the very conflict it had just stepped past
          // (its own routine buffer landing back in that conflict's last few minutes), which sent the
          // loop right back to re-resolving the SAME conflict on every pass instead of ever reaching a
          // later one.
          let afterStart = new Date(roundUp(firstConflict.endsAt).getTime() + bedtimeRoutineMinutes * MINUTE);
          for (let guard = 0; guard < conflicts.length; guard += 1) {
            // `<=`, not `<`, on `startsAt`: a conflict that starts exactly when this candidate would
            // (found by the property test's own fuzzing) still occupies that instant, so it blocks
            // the start outright, not only the routine buffer before it — `resolveSleepWindow`'s own
            // wake-truncation (used for the final end below) only ever applies to a conflict that
            // starts strictly AFTER the sleep begins, which is the real distinction between "blocks
            // the start" and "just trims the wake."
            const stillBlocking = conflicts
              .filter(
                (conflict) =>
                  conflict.startsAt <= afterStart &&
                  conflict.endsAt > new Date(afterStart.getTime() - bedtimeRoutineMinutes * MINUTE)
              )
              .sort((a, b) => b.endsAt.getTime() - a.endsAt.getTime())[0];
            if (!stillBlocking) break;
            afterStart = new Date(roundUp(stillBlocking.endsAt).getTime() + bedtimeRoutineMinutes * MINUTE);
          }
          // From here, walk forward exactly as `runSeed` would for any LATER conflict still inside
          // the raw target window — a real evening chain can hold more than one, and that forward
          // walk (and the truncate-at-a-conflict's-own-start branch) is still the right tool for it.
          // The one thing it must never do, seeded from an already-cleared `afterStart` instead of
          // the true anchor, is walk EARLIER than `afterStart` itself: that only happens through the
          // "walk back toward now" branches, both of which compare against `now`/`awakeFrom` to decide
          // whether an earlier slot is on offer — passing `afterStart` itself as the floor for both
          // (instead of the real `now`/`awakeFrom`) makes any such branch clamp to `afterStart`, never
          // past it, while leaving every forward-only branch untouched. Without this floor, a THIRD,
          // later conflict inside the raw target window could send the walk all the way back to the
          // real `now` — hours before the conflicts `afterStart` was built to step past (found by the
          // property test's own fuzzing).
          const afterResolved = walkConflicts({
            seedStart: afterStart,
            seedEnd: new Date(afterStart.getTime() + targetMinutes * MINUTE),
            conflicts,
            awakeFrom: afterStart,
            now: afterStart,
            latestStart,
            targetMinutes,
            missedStart
          });
          alternatives.push(toCandidate(afterResolved.start, afterResolved.end));
        }
        // Placement order once this far in: valid beats
        // invalid, meeting the minimum beats not, more sleep wins next (an evening commitment's
        // "after" reaching the full night beats a walk-back that only reaches a truncated one), and
        // the smallest deviation breaks a genuine tie in sleep length — which is what lets "after"
        // (near bedtime) beat a walk-back that reaches noon whenever both get the same duration.
        alternatives.sort((a, b) => {
          if (a.valid !== b.valid) return a.valid ? -1 : 1;
          if (a.meetsMinimum !== b.meetsMinimum) return a.meetsMinimum ? -1 : 1;
          const durationA = a.end.getTime() - a.start.getTime();
          const durationB = b.end.getTime() - b.start.getTime();
          if (durationA !== durationB) return durationB - durationA;
          return a.deviation - b.deviation;
        });
        chosen = alternatives[0]!;
        evaluated = alternatives;
      }
    }

    // Finding 7's second cause: no start is ever rounded down to before `now`. Every candidate above
    // was already checked against `floor` for VALIDITY, but an invalid candidate can still win when
    // nothing else is on offer (the same "always return a plan" guarantee the old code gave) — so this
    // is a last safety net, not a gate on the search itself, and it only ever fires on night 0.
    // The design's own statement of finding 7 ("If the awake limit has already passed
    // (`awakeFrom + maxAwake < now`), night 0 is a missed start too") is a structural fact about `now`
    // versus `latestStart`, independent of which direction an invalid `chosen` candidate missed by: a
    // walked-back candidate that starts too EARLY (before `floor`) is caught by the check below, but an
    // "after the conflict" candidate that starts too LATE (past `latestStart`, yet still in the future
    // relative to `now`) used to slip through ungoverned — the binary `valid` flag no longer distinguishes
    // it from a merely-deviating-but-legal candidate once every alternative is invalid, so `meetsMinimum`
    // alone picked "after", regardless of how far past the awake limit its start fell. Once the limit has
    // structurally passed, no candidate the search can produce is honoring it, so the safety net must fire
    // regardless of which alternative the sort happened to prefer — UNLESS starting now is not actually
    // available, because a protected range is already under way at `now` itself (report/test "starts
    // right after a conflict that ends past the awake limit": a commitment straddling `now` makes
    // walking forward past it, and reporting the violation, the only honest answer; nothing was ever
    // skipped by choosing "after" there, since "now" itself was never on offer).
    const nowBlockedByActiveConflict = conflicts.some(
      (conflict) =>
        conflict.startsAt.getTime() <= input.now.getTime() && conflict.endsAt.getTime() > input.now.getTime()
    );
    const awakeLimitAlreadyPassed =
      day === 0 && latestStart.getTime() < input.now.getTime() && !nowBlockedByActiveConflict;
    const stillStale =
      day === 0 && !missedStart && (chosen.start.getTime() < input.now.getTime() || awakeLimitAlreadyPassed);
    const resolution = resolveSleepWindow({
      startAt: stillStale ? input.now : chosen.start,
      targetMinutes,
      preferences: input.preferences,
      commitments: input.commitments
    });

    // The bedtime-deviation choice: when the winning candidate starts more than the configured
    // deviation before the preferred bedtime, offer the near night (the best candidate that does not
    // deviate) alongside it.
    const deviatesEarly =
      !stillStale &&
      chosen.start.getTime() < targetBedtime.getTime() - input.preferences.bedtimeDeviationMinutes * MINUTE;
    let finalStart = resolution.startsAt;
    let finalEnd = resolution.wakesAt;
    let deviationOptions: SleepDeviationOptions | undefined;
    let placementChoice: "early" | "near" | undefined;
    let replannedNowFromLapse = false;

    const baseCycleId = `sleep:${localDateString(targetWake, input.timezone)}`;
    const cycleId = isCompleted(baseCycleId) ? `${baseCycleId}:after:${input.lastWokeAt.toISOString()}` : baseCycleId;

    if (deviatesEarly && !missedStart) {
      const nonDeviating = evaluated.filter(
        (candidate) =>
          candidate.valid &&
          candidate.start.getTime() >= targetBedtime.getTime() - input.preferences.bedtimeDeviationMinutes * MINUTE
      );
      const validOnly = evaluated.filter((candidate) => candidate.valid);
      const nearSource = (nonDeviating[0] ?? validOnly[0] ?? evaluated[0])!;
      const nearResolution = resolveSleepWindow({
        startAt: nearSource.start,
        targetMinutes,
        preferences: input.preferences,
        commitments: input.commitments
      });
      const early: SleepDeviationOption = {
        startsAt: resolution.startsAt,
        wakesAt: resolution.wakesAt,
        minutes: resolution.plannedMinutes
      };
      const near: SleepDeviationOption = {
        startsAt: nearResolution.startsAt,
        wakesAt: nearResolution.wakesAt,
        minutes: nearResolution.plannedMinutes
      };
      const answer = answers(cycleId)?.placementChoice;
      if (answer === "near") {
        finalStart = near.startsAt;
        finalEnd = near.wakesAt;
        placementChoice = "near";
        deviationOptions = { early, near, warn: false };
      } else if (answer === "early") {
        placementChoice = "early";
        deviationOptions = { early, near, warn: false };
      } else if (day === 0 && input.now.getTime() >= early.startsAt.getTime()) {
        // The lapse: the early night's start has passed with no answer. Compare starting now, running
        // to the required (preferred) wake, against the near night.
        const nowStart = new Date(Math.max(input.now.getTime(), awakeFrom.getTime()));
        const nowResolution = resolveSleepWindow({
          startAt: nowStart,
          targetMinutes: Math.max(0, Math.round((targetWake.getTime() - nowStart.getTime()) / MINUTE)),
          preferences: input.preferences,
          commitments: input.commitments
        });
        if (nowResolution.plannedMinutes > near.minutes) {
          finalStart = nowResolution.startsAt;
          finalEnd = nowResolution.wakesAt;
          replannedNowFromLapse = true;
          deviationOptions = { early, near, warn: true };
        } else {
          finalStart = near.startsAt;
          finalEnd = near.wakesAt;
          placementChoice = "near";
          deviationOptions = { early, near, warn: false };
        }
      } else {
        deviationOptions = { early, near, warn: true };
      }
    }

    const duration = Math.max(0, Math.floor((finalEnd.getTime() - finalStart.getTime()) / MINUTE));
    const minimumShortfallMinutes = Math.max(0, input.preferences.minimumSleepMinutes - duration);
    const hardErrors: string[] = [];
    if (!assumed && finalStart.getTime() - awakeFrom.getTime() > input.preferences.maxAwakeHours * 60 * MINUTE)
      hardErrors.push(`Sleep starts after the ${input.preferences.maxAwakeHours}-hour awake limit.`);
    if (stillStale && !assumed) hardErrors.push("The awake limit has already passed.");
    if (minimumShortfallMinutes > 0) {
      const cause = resolution.wakeConstraint?.title ? ` for ${resolution.wakeConstraint.title}` : "";
      hardErrors.push(`Minimum sleep cannot be met${cause}: ${minimumShortfallMinutes} minutes short.`);
    }
    const anchorDeviationMinutes = Math.round(
      (Math.abs(finalStart.getTime() - targetBedtime.getTime()) + Math.abs(finalEnd.getTime() - targetWake.getTime())) /
        MINUTE
    );
    // A real commitment (`resolution.wakeConstraint`) that forces a visible shortfall names itself
    // even when the safety net also fired: "the awake limit passed" is true but not the proximate,
    // actionable cause the user needs — the commitment is. `stillStale` with no shortfall (nothing to
    // truncate against, or the night still meets the minimum) keeps the generic safety-net wording.
    const baseExplanation =
      stillStale && !assumed && !(minimumShortfallMinutes > 0 && resolution.wakeConstraint)
        ? "The awake limit has already passed, so sleep starts now and the wake time moves later to protect the configured minimum."
        : minimumShortfallMinutes > 0
          ? `A confirmed commitment constrains this sleep block to ${duration} minutes, ${minimumShortfallMinutes} minutes below the configured minimum.`
          : hardErrors.length
            ? `${hardErrors.join(" ")} Earliest safe sleep guidance is ${finalStart.toISOString()}.`
            : resolution.wakeConstraint
              ? `A confirmed commitment constrains this sleep block to ${duration} minutes while preserving the configured minimum.`
              : missedStart
                ? `The planned start was missed, so the wake time moved later to protect ${targetMinutes} minutes of sleep.`
                : replannedNowFromLapse
                  ? "The early night's start passed unanswered, so sleep starts now while that still gives more sleep than the near night."
                  : deviationOptions?.warn
                    ? `Starts more than ${input.preferences.bedtimeDeviationMinutes} minutes before the preferred bedtime to get more sleep. Sleeping ${deviationOptions.near.startsAt.toISOString()}–${deviationOptions.near.wakesAt.toISOString()} instead gives ${deviationOptions.near.minutes} minutes.`
                    : "Protects the desired sleep duration as close as possible to the preferred bedtime and wake time.";
    const explanation = assumed
      ? `${baseExplanation} Planned from the sleep preferences because the last wake is unknown.`
      : baseExplanation;

    // A cycle forced to realize now by `stillStale` (widened above to catch a structurally-passed
    // awake limit, not only a candidate that happened to fall in the past) keeps its own `targetWake`
    // anchor pointed at the ordinary "ideal" wake for tonight's night — the same anchor the very next
    // chained cycle (chained from this one's early, post-truncation `awakeFrom`) then legitimately
    // targets too: a short sleep this morning and a full one later tonight are two distinct, real
    // nights that happen to share one calendar cycle's nominal wake. Left keyed by the shared
    // `cycleId`, both got the same id and the second upsert silently clobbered the first
    // (state-store-c.integration.test.ts "lets confirmed but not tentative commitments force a visible
    // minimum-sleep shortfall"). `usedCycleIds` (populated below as each cycle is pushed) catches this
    // in general, whichever day the reuse falls on, and disambiguates only the later, colliding one —
    // not every `stillStale` night on principle, which would also rewrite an already-correct,
    // never-colliding `stillStale` case (`overdue-external-outranks-unknown-forecast.json`'s "sleep is
    // a wall").
    //
    // `missedStart` is deliberately NOT its own id branch (the sleep placement design note "Night
    // identity": "Moving the start, crossing bedtime, or a missed start never changes the id" —
    // fixes finding 6). It used to be `sleep:missed:${lastWokeAt}`, which reads as a fresh identity
    // every time `now` ticks past the anchor between two runs of the SAME tonight's cycle — one call
    // a minute before bedtime sees an ordinary, not-yet-missed candidate and gets the plain
    // `cycleId`; the very next call, a minute after, reads the identical cycle as a missed start and
    // got a completely different id keyed on `lastWokeAt` instead. Everything keyed on a night's id
    // (bedtime/wake routine steps, `reconcileSleepRoutineSteps`, the directive's `targetId`) then
    // treated it as a brand-new cycle mid-evening, recreating already-derived bedtime steps under
    // fresh ids and losing track of ones already completed or skipped. Routing it through the same
    // `cycleId`/`usedCycleIds` disambiguation as every other cycle keeps the id keyed on the night
    // (the target wake day) the whole time, exactly like an ordinary or `stillStale` night.
    const id = usedCycleIds.has(cycleId) ? `${cycleId}:day:${day}` : cycleId;
    usedCycleIds.add(cycleId);
    plans.push({
      id,
      plannedStartAt: finalStart,
      plannedWakeAt: finalEnd,
      desiredMinutes: input.preferences.desiredSleepMinutes,
      targetMinutes,
      allowedMinutes: duration,
      sleepDeficitMinutes: Math.max(0, input.preferences.desiredSleepMinutes - duration),
      minimumShortfallMinutes,
      replannedFromMissedStart: missedStart || stillStale || replannedNowFromLapse,
      ...(resolution.wakeConstraint ? { wakeConstraint: resolution.wakeConstraint } : {}),
      anchorDeviationMinutes,
      hardErrors,
      explanation,
      ...(deviationOptions ? { deviationOptions } : {}),
      ...(placementChoice ? { placementChoice } : {})
    });
    awakeFrom = finalEnd;
  }
  return plans;
}

export function protectedRanges(commitments: FixedCommitment[], arrivalMarginMinutes: number) {
  return (
    commitments
      // `sleep-routine:`-prefixed entries are the engine's own bedtime/wake steps, derived
      // FROM the sleep plans this function computes the protected ranges for — feeding them back in
      // here would be circular, and one recompute stale besides (walking a bedtime back, below, could
      // walk straight into a now-superseded window and truncate against it). A commitment's own
      // before/after routine steps (`routine:`-prefixed) are unaffected and still gate exactly as
      // intended.
      .filter((item) => !item.id.startsWith("sleep-routine:"))
      .map((item) => ({
        id: item.id,
        title: item.title,
        ...(item.flexibleLeadOpensAt !== undefined ? { flexibleLeadOpensAt: item.flexibleLeadOpensAt } : {}),
        ...commitmentProtection(item, arrivalMarginMinutes)
      }))
      .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
  );
}
function roundDown(date: Date) {
  return new Date(Math.floor(date.getTime() / STEP) * STEP);
}
function roundUp(date: Date) {
  return new Date(Math.ceil(date.getTime() / STEP) * STEP);
}
function roundToStep(date: Date) {
  return new Date(Math.round(date.getTime() / STEP) * STEP);
}
function wallMinutes(wallTime: string) {
  const [hour, minute] = wallTime.split(":").map(Number) as [number, number];
  return hour * 60 + minute;
}
const DAY_MS = 86_400_000;
/** Whole local calendar days from the local date of `now` to the local date of `date`. */
function localDayOffset(now: Date, timezone: string, date: Date): number {
  return localDayNumber(date, timezone) - localDayNumber(now, timezone);
}
function localDayNumber(date: Date, timezone: string): number {
  const parts = localDateFormat(timezone).formatToParts(date);
  const take = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  return Math.round(Date.UTC(take("year"), take("month") - 1, take("day")) / DAY_MS);
}
/** The local calendar date (`YYYY-MM-DD`) of `date` in `timezone` — the raw material for a cycle's id. */
function localDateString(date: Date, timezone: string): string {
  return localDateFormat(timezone).format(date);
}
function zonedTarget(now: Date, timezone: string, wallTime: string, dayOffset: number): Date {
  // Same resolver as recurrence anchors, so a DST gap or ambiguous wall time lands on one instant.
  return zonedDateTime(addLocalDays(localDateString(now, timezone), dayOffset), wallTime, timezone);
}
