import type { CurrentDirective, PlanForecastRequest, TransportMode } from "@openrhen/contracts";
import { zonedDateTime } from "@openrhen/contracts";
import { addLocalDays, localDate } from "../recurrence/recurrence.js";
import { effectiveCommitmentEnd } from "../model/types.js";
import { ORDINARY_RANK } from "./score.js";
import type {
  CommitmentTravelLeg,
  FixedCommitment,
  PlanningResult,
  ProtectedCommitment,
  Recommendation,
  SleepPlan
} from "../model/types.js";
import { earliestRoutineWindowStarts, routineStepMootness } from "./routine-step-mootness.js";
import type { TravelLeg } from "./situation-projection.js";

/**
 * The hard-precedence chain that turns a ranking into the one thing to do now (§9 hard precedence).
 *
 * Kept in its own module because two callers must run exactly this function: the live directive in
 * `calculatePlanAndForecast`, and the forward day-plan simulation, which re-runs it at synthetic later
 * instants. Any plan-only variant of this precedence would let the projected day disagree with the
 * directive it claims to project.
 */

const MINUTE = 60_000;

export type WireState = PlanForecastRequest["state"];

/** Sleep that has already happened, or was called off. Neither can be the thing to do now. */
const FINISHED_SLEEP = new Set(["completed", "cancelled"]);

/**
 * The smallest planned sleep block worth directing when the plan itself admits its minimum cannot be
 * met. A wake-adjacent replan can truncate a night to a sliver — observed live as "Time to sleep
 * (5 min)" at 4:43 am and a zero-minute block 32 seconds wide — and
 * such a block is an artifact of the constraint cascade, not a rest anyone should be sent to.
 */
const SLEEP_DIRECTIVE_FLOOR_MINUTES = 30;

/**
 * Whether a planned sleep block is substantial enough to become "Time to sleep". Zero minutes never
 * is. Below the floor it still is when the plan is otherwise healthy — a deliberate short rest
 * carries no shortfall and no hard error — but a sliver that already fails its own minimum falls
 * through to the routine/recommendation path instead.
 */
function directableSleep(plan: SleepPlan): boolean {
  if (plan.allowedMinutes <= 0) return false;
  if (plan.allowedMinutes >= SLEEP_DIRECTIVE_FLOOR_MINUTES) return true;
  return (plan.minimumShortfallMinutes ?? 0) === 0 && plan.hardErrors.length === 0;
}

/**
 * What the chain needs to know about places in order to say "go there now". Supplied by the engine
 * and, in the projected day, re-supplied per step with the location the simulation has reached — so
 * the replayed precedence is the live one with a different `now` and a different place, nothing else.
 */
export interface DirectiveTravel {
  /** Where the decision is being made from; null when the location is unknown. */
  currentLocationId: string | null;
  homeLocationId?: string;
  travelBetween(fromLocationId: string | null, toLocationId: string): TravelLeg | undefined;
  locationName(locationId: string): string;
}

export interface SelectDirectiveInput {
  state: WireState;
  /**
   * Every commitment presently in force — literal fixed commitments plus materialized
   * recurring-commitment repeats — the same list `protectedCommitments()` (engine.ts) builds and
   * `RecommendArguments.protectedCommitments` carries the rest of the engine. Finding 18: the
   * per-step lookups below used to rebuild their own maps straight from `state.commitments`, which
   * carries only literal commitments; a routine step whose `commitmentId` named a recurring
   * commitment's materialized occurrence (an id that never appears in `state.commitments`) then found
   * nothing in any of the three maps, so arrival could never retire its steps early and its
   * directability window could never extend past its own scheduled end even while the occurrence it
   * belonged to was still running.
   */
  commitments: FixedCommitment[];
  now: Date;
  sleepPlans: SleepPlan[];
  recommendation: Recommendation;
  schedule: PlanningResult;
  travel?: DirectiveTravel;
  /**
   * Set only for the live directive, and only while a session is open past the point it can be
   * believed (`resolveFreshness`). It takes the place of everything that would be started, since
   * nothing can be started until the session is closed; the projected day never sets it, because it
   * already assumes that session has ended.
   */
  openSessionQuestion?: Extract<CurrentDirective, { kind: "answer" }>;
}

export function selectCurrentDirective(input: SelectDirectiveInput): CurrentDirective {
  const { state, commitments, now, sleepPlans, recommendation, schedule, travel, openSessionQuestion } = input;
  // Nothing can be started while a session is open, so no leg, commitment, sleep or work can be offered
  // until it is settled: the question comes before everything else.
  if (openSessionQuestion) return openSessionQuestion;
  // A journey the plan requires is not a competitor to the protected window it serves; it is part of
  // it (§9 hard precedence). So it is read off the protected commitment itself, before anything else.
  const leg = travel ? plannedLeg(recommendation.protectedCommitment, travel) : null;
  if (leg) return leg;
  // `recommendation.protectedCommitment` is already resolved (in `recommend()`) from the same
  // active/setup/transition-filtered list built by `protectedCommitments()`, which includes both
  // literal fixed commitments and materialized recurring-commitment repeats (neither tentative
  // nor routine-derived). Re-deriving membership from `state.commitments` alone missed recurring
  // occurrences entirely, since their ids never appear there — causing a currently-active recurring
  // commitment to fall through to the sleep/routine fallback below instead of taking priority. The
  // three lookups just below read the `commitments` parameter for exactly the same reason: it is the
  // one list, materialized occurrences included, that a step's `commitmentId` can actually resolve
  // against.
  //
  // A `late` commitment is the one deliberate exception: `resolveProtectedCommitment` still returns
  // it (so `plannedLeg` above can still route a late travel phase, and so the final "none" fallback
  // below still carries its "Running late for X" headline), but it must not itself gate out the
  // routine-step search — a late commitment's whole point is that its own before-phase step is the
  // overdue prerequisite that search exists to find. Without this, a late commitment
  // read as an ordinary protected one and the directive fell straight to "Preparing for X" (or, before
  // `openAnchorsNow` was taught about lateness too, further still — to an unrelated deliverable).
  //
  // But the exception must not open every branch below it, only the one it needs: a late
  // commitment is not weaker than an on-time one. `late` (below) narrows what runs while the exception
  // is in force — the sleep window, the stored `sleeping` status and the journey home for bedtime are
  // skipped outright (X, not sleep, is what's overdue), the routine-step search is limited to X's own
  // before-phase steps, and finding nothing due there ends the chain at "Running late for X" rather
  // than falling through to recovery or ordinary ranking.
  const late = Boolean(recommendation.protectedCommitment?.late);
  const protectedFixedCommitment = Boolean(recommendation.protectedCommitment) && !late;
  // Looked up by a step's `commitmentId` wherever "has this step's commitment finished" matters, so a
  // step is judged against what actually owns it rather than its own (possibly elapsed) window.
  // `effectiveCommitmentEnd` reads tracked overtime when there is any (`FixedCommitment.trackedEndedAt`),
  // so an after-phase step of a commitment still running late stays directable by the same
  // "commitment hasn't ended yet" fallback a before-phase step already gets.
  const commitmentEndsAtById = new Map(commitments.map((item) => [item.id, effectiveCommitmentEnd(item)]));
  // Same lookup, for arrival: a before-phase step's own commitment may already have been reached even
  // while `recommendation.protectedCommitment` still reports it `late` (or does not name it at all,
  // e.g. a plan snapshot computed a beat behind the location assertion, or the write-time skip in
  // `routine-step-arrival.ts` missed its one edge-triggered chance — the person arrived before the
  // commitment's window opened, or the assertion merely re-confirmed a place already asserted so
  // nothing there read as a *change*). A person already at class kept being offered "Pack Bag":
  // the write-time skip never fired, and this fallback search, having no notion of arrival at all,
  // freely re-offered "Pack Bag" forever. Checking arrival fresh here, on every selection, closes that
  // regardless of why the write-time skip missed its moment: there is no longer a single edge this can
  // be a beat behind. Deliberately narrow — arrival only ever *retires* a before-phase step early, and
  // never substitutes for it: "not arrived ⇒ direct the step" is untouched below.
  //
  // `routineStepMootness` (routine-step-mootness.ts) is the one predicate for this, shared in spirit
  // with the portal's read-time mirror and the write-time skip/sweep — see that module's own comment
  // for why literal import sharing across those packages is impossible. `travel.currentLocationId` has
  // already been through the settings' own staleness rule (`resolvePlaces`, engine.ts), so it is passed
  // through here as already-fresh rather than re-checked against a second staleness window.
  const commitmentLocationById = new Map(commitments.map((item) => [item.id, item.locationId ?? null]));
  const arrivedLocationId = travel?.currentLocationId ?? null;
  // A commitment whose before-phase steps carry no scheduled start has no preparation window of its
  // own, so it falls back to the commitment's own start. Treating "unscheduled" as "never moot"
  // instead would reinstate the arrived-at-class bug for
  // exactly the routines the scheduler has not placed yet.
  const commitmentStartsAtById = new Map(commitments.map((item) => [item.id, item.startsAt]));
  // One pass over the steps rather than one per commitment: the projected day re-selects the
  // directive at every block.
  const earliestStepStartByCommitmentId = earliestRoutineWindowStarts(state.routineSteps);
  const routineWindowStartByCommitmentId = new Map(
    [...commitmentLocationById.keys()]
      .map(
        (commitmentId) =>
          [
            commitmentId,
            earliestStepStartByCommitmentId.get(commitmentId) ?? commitmentStartsAtById.get(commitmentId)
          ] as const
      )
      .filter((entry): entry is [string, Date] => entry[1] !== undefined)
  );
  const stepMootOnArrival = (item: WireRoutineStep): boolean => {
    // A sleep-anchored step carries no `commitmentId` at all, so every lookup below misses
    // and this returns `false` (never moot on arrival) — arrival-driven mootness is a commitment-only
    // concept; a bedtime/wake step has nowhere to "arrive at".
    const commitmentId = item.commitmentId ?? "";
    const routineWindowStart = routineWindowStartByCommitmentId.get(commitmentId);
    const commitmentEndsAt = commitmentEndsAtById.get(commitmentId);
    if (!routineWindowStart || !commitmentEndsAt) return false;
    return routineStepMootness({
      step: { phase: item.phase },
      commitment: { locationId: commitmentLocationById.get(commitmentId) ?? null, endsAt: commitmentEndsAt },
      routineWindowStart,
      currentLocation: arrivedLocationId ? { locationId: arrivedLocationId, locationSetAt: now } : null,
      now,
      // Already staleness-filtered upstream (see comment above): a non-null `currentLocationId` here
      // is by construction fresh, so no additional staleness window applies at this layer.
      staleAfterMinutes: Number.POSITIVE_INFINITY
    }).moot;
  };
  if (!protectedFixedCommitment) {
    // The sleep window, the stored `sleeping` status and the journey home for bedtime all name sleep
    // as the thing to do now — but while late for X, X (not sleep) is what's overdue, and oversleeping
    // must not read as more urgent than the commitment being missed (lateness beats
    // a stored `sleeping` status; the sleep session itself stays open, and ending it is a separate
    // action). None of this block runs while late.
    if (!late) {
      // A slept or cancelled plan is history — but only if the stored outcome belongs to this night.
      // Identity is stable across recomputes, so a plan replanned into a new night keeps the row and
      // last night's `completed` with it; matching the window is what tells the two apart.
      const storedSleep = new Map(state.sleepPlans.map((item) => [item.id, item]));
      const sleep = sleepPlans.find((item) => {
        const stored = storedSleep.get(item.id);
        // An open sleep session is authoritative for its whole duration regardless of the originally
        // planned wake time: oversleeping past that stale boundary must not make the directive fall
        // through to routines or recommendations while the user is still asleep.
        if (stored?.status === "sleeping") return item.plannedStartAt <= now;
        if (!directableSleep(item)) return false;
        if (!(item.plannedStartAt <= now && item.plannedWakeAt > now)) return false;
        const sameNight = stored ? stored.plannedStartAt === item.plannedStartAt.toISOString() : false;
        return !(sameNight && FINISHED_SLEEP.has(stored!.status));
      });
      if (sleep)
        return {
          kind: "sleep",
          targetId: sleep.id,
          title: "Time to sleep",
          recommendedMinutes: sleep.allowedMinutes
        };
      // Sleep happens at home, so being elsewhere when bedtime is a journey away makes the journey the
      // thing to do — the same rule as a commitment's leg, for the one anchor that has no commitment.
      if (travel) {
        const home = travel.homeLocationId;
        const away = home !== undefined && travel.currentLocationId !== null && travel.currentLocationId !== home;
        const journey = away ? travel.travelBetween(travel.currentLocationId, home!) : undefined;
        const due =
          journey &&
          sleepPlans
            .filter((item) => {
              const stored = storedSleep.get(item.id);
              const sameNight = stored ? stored.plannedStartAt === item.plannedStartAt.toISOString() : false;
              return !(sameNight && FINISHED_SLEEP.has(stored!.status));
            })
            // A sliver too small to ever direct must not summon the journey home either.
            .filter((item) => directableSleep(item))
            .filter((item) => item.plannedStartAt > now)
            .sort((a, b) => a.plannedStartAt.getTime() - b.plannedStartAt.getTime())
            .find((item) => item.plannedStartAt.getTime() - journey.minutes * MINUTE <= now.getTime());
        if (journey && due)
          return travelDirective(
            home!,
            journey.minutes,
            journey.mode,
            journey.source,
            travel,
            {
              kind: "sleep",
              targetId: due.id,
              title: "Time to sleep",
              recommendedMinutes: due.allowedMinutes
            },
            {
              typicalMinutes: journey.typicalMinutes,
              sampleCount: journey.sampleCount,
              ...(journey.originAssumed ? { originAssumed: true } : {}),
              leaveBy: new Date(due.plannedStartAt.getTime() - journey.minutes * MINUTE)
            }
          );
      }
    }
    // A bedtime/wake step is a `routine_step` row now, so it is already covered by the
    // generic `state.routineSteps` walk just below — no separate instance-shaped lookup needed.
    // Bounded at both ends, and ordered by when the step is actually due.
    //
    // With only a lower bound, a step left `pending` after its commitment finished matched forever:
    // yesterday's "get drink bottle" was still the current directive the next afternoon. Sorting by
    // sequence alone compounded it, because sequence is per-commitment — step 0 of next week's shift
    // outranked step 2 of the one happening now.
    //
    // The upper bound (`directableStep`) is the step's own `scheduledEndAt` *or* its commitment's
    // `endsAt`, not the step's window alone: an after-phase step ("unpack bag") is still directable
    // in its own window once the commitment it follows has ended, and a before-phase step of a
    // commitment running late is still directable once its own static window has elapsed, for as
    // long as that commitment has not itself ended. Only when *both* have closed — a finished
    // commitment's own leftover, well past its own window too — does the invariant "a finished
    // commitment's leftovers stay invisible" apply, and it is judged per commitment, not globally.
    //
    // A sleep-anchored step has no commitment to fall back on, but the same idea applies:
    // the old bundled `routine_instance` was directable across its *whole* chain (`startsAt <= now <
    // endsAt`, `endsAt` = the sleep plan's own `plannedStartAt` for bedtime, or the chain's own final
    // step's end for wake), not just whichever one step's own slice `now` happened to fall in. Without
    // this, walking in mid-chain after an earlier step's own narrow window had already closed (e.g.
    // arriving at 09:12:41 to a chain of 5+1+8+10-minute steps whose first two slices closed at 09:11
    // and 09:12) fell through the whole routine instead of landing on the step actually due —
    // `sleepAnchorEndsAtByKey` gives every step in a chain the chain's own overall end as its
    // fallback bound, exactly mirroring `commitmentEndsAtById` for a commitment's own steps.
    const sleepAnchorEndsAtByKey = new Map<string, Date>();
    for (const item of state.routineSteps) {
      if (item.anchorType !== "sleep_plan" || !item.scheduledEndAt || item.status === "cancelled") continue;
      const key = `${item.anchorId}:${item.purpose}`;
      const endsAt = new Date(item.scheduledEndAt);
      const current = sleepAnchorEndsAtByKey.get(key);
      if (!current || endsAt > current) sleepAnchorEndsAtByKey.set(key, endsAt);
    }
    // While late for X, the search is narrowed to X's own before-phase steps:
    // X's overdue prerequisite is the whole point of the exception, but a due
    // bedtime step or another commitment's step is not — being late for X does not make anything
    // else more directable. Walking back to the earliest unmet prerequisite and retiring steps on
    // arrival both still apply, unchanged, to that narrowed set.
    const step = state.routineSteps
      .filter((item) => {
        if (late && item.commitmentId !== recommendation.protectedCommitment!.id) return false;
        const chainEndsAt = item.commitmentId
          ? commitmentEndsAtById.get(item.commitmentId)
          : sleepAnchorEndsAtByKey.get(`${item.anchorId}:${item.purpose}`);
        return !stepMootOnArrival(item) && directableStep(item, now, chainEndsAt, state.routineSteps);
      })
      .sort(byDueDate)[0];
    if (step) {
      // The in-window step may be gated by a prerequisite whose own static window has already
      // elapsed; direct the step that can actually be started (see `unmetPrerequisite`).
      const directed = unmetPrerequisite(state.routineSteps, step) ?? step;
      return {
        kind: "routine_step",
        targetId: directed.id,
        title: directed.title,
        recommendedMinutes: directed.durationMinutes
      };
    }
    // Nothing of X's own is due: the headline itself ("Running late for X") is the thing to do,
    // rather than falling through to recovery or ordinary ranking below — a commitment you're
    // missing outranks both.
    if (late) return { kind: "none", title: recommendation.headline, recommendedMinutes: 0 };
  }
  if (protectedFixedCommitment) return { kind: "none", title: recommendation.headline, recommendedMinutes: 0 };
  // A flexible commitment before-step offered early takes `primary`'s own place in the chain the
  // moment it would actually lead the ordinary ranking: no primary at all, or a primary the ordinary
  // (never deadline-critical) tier outscored (the routine step timing design note, "Flexible steps
  // offered early"). A deadline-critical primary — any tier `recommend()` did not rank as `ordinary` —
  // always wins regardless of score, since `recommendation.earlyStep` never enters a critical tier
  // itself and has no claim against one that did.
  //
  // A step whose own slot falls on a later local day is offered (Can do now) but never outranks real
  // work today: tomorrow-morning prep (lunch for an 8 am class) scored above an assessment task purely
  // on its low effort, and Now told the person to make lunch at 3 pm. It still leads when nothing else does.
  const earlyStepRow = recommendation.earlyStep
    ? state.routineSteps.find((item) => item.id === recommendation.earlyStep!.stepId)
    : undefined;
  const earlyIsLaterDay =
    earlyStepRow?.scheduledStartAt !== undefined &&
    earlyStepRow.scheduledStartAt !== null &&
    localDate(new Date(earlyStepRow.scheduledStartAt), state.settings.timezone) >
      localDate(now, state.settings.timezone);
  if (
    recommendation.earlyStep &&
    (!recommendation.primary ||
      (recommendation.primary.criticalRank === ORDINARY_RANK &&
        !earlyIsLaterDay &&
        recommendation.primary.totalScore < recommendation.earlyStep.totalScore))
  ) {
    const step = earlyStepRow;
    if (step)
      return { kind: "routine_step", targetId: step.id, title: step.title, recommendedMinutes: step.durationMinutes };
  }
  if (recommendation.primary) {
    const chosen = recommendation.primary.action;
    const work = {
      kind: chosen.deliverableId ? ("deliverable" as const) : ("action" as const),
      targetId: chosen.deliverableId ?? chosen.id,
      title: chosen.title,
      recommendedMinutes: recommendation.primary.recommendedMinutes ?? 0,
      // Deadline work still inside its break stays the pick, one tap away, but starts when it ends.
      ...(recommendation.primary.restUntil && recommendation.primary.restUntil.getTime() > now.getTime()
        ? { notBefore: recommendation.primary.restUntil.toISOString() }
        : {})
    };
    // The ranking chose work that is somewhere else, so the journey is what to do now and the work is
    // what it is for. Bounded by the next protected start, so it can never pre-empt one.
    const trip = recommendation.primary.trip;
    // A resting trip is break first, then the journey (the trip is measured from the break's end), so
    // the journey itself carries the wait; the nested work loses it to the `then` schema anyway.
    if (trip && travel) {
      const { notBefore, ...then } = work as typeof work & { notBefore?: string };
      return travelDirective(
        trip.toLocationId,
        trip.travelMinutes,
        trip.mode,
        trip.source,
        travel,
        then,
        notBefore ? { notBefore } : {}
      );
    }
    return work;
  }
  // MVP 8.1: when no work fits but recovery capacity is open, rest is the deliberate recommendation
  // rather than an empty screen. Recovery capacity is never converted into ordinary work capacity.
  const recovery = recoveryWindowMinutes(schedule, now);
  if (recovery > 0) return { kind: "recovery", title: "Take deliberate recovery", recommendedMinutes: recovery };
  // "Nothing fits" stated as what would resolve it: a question whose answer unlocks work now, or the
  // boundary that binds and the first thing that fits after it. Both are derived in `recommend()`
  // from structure the candidates carry, so this only translates.
  const noFit = recommendation.noFit;
  if (noFit?.kind === "answer") {
    return {
      kind: "answer",
      title: recommendation.headline,
      recommendedMinutes: 0,
      question: noFit.question,
      contextIds: noFit.contextIds,
      candidate: noFit.candidate
        ? {
            kind: noFit.candidate.deliverableId ? "deliverable" : "action",
            targetId: noFit.candidate.targetId,
            title: noFit.candidate.title,
            recommendedMinutes: noFit.candidate.recommendedMinutes
          }
        : null
    };
  }
  if (noFit?.kind === "boundary") {
    return {
      kind: "boundary",
      title: recommendation.headline,
      recommendedMinutes: 0,
      boundaryAt: noFit.boundaryAt.toISOString(),
      boundaryKind: noFit.boundaryKind,
      ...(noFit.boundaryTitle ? { boundaryTitle: noFit.boundaryTitle } : {}),
      ...(noFit.boundaryEdge ? { boundaryEdge: noFit.boundaryEdge } : {}),
      nextFit: noFit.nextFit
        ? {
            at: noFit.nextFit.at.toISOString(),
            kind: noFit.nextFit.deliverableId ? "deliverable" : "action",
            targetId: noFit.nextFit.targetId,
            title: noFit.nextFit.title,
            recommendedMinutes: noFit.nextFit.recommendedMinutes
          }
        : null
    };
  }
  return { kind: "none", title: recommendation.headline, recommendedMinutes: 0 };
}

type WireRoutineStep = WireState["routineSteps"][number];

/**
 * Whether a pending step is still fair game to direct: due (its own scheduled window has opened) and
 * — the upper bound — either its own window has not yet closed, or the commitment it belongs to has
 * not itself ended. The two are an "or", not a replacement: an after-phase step (e.g. "unpack bag")
 * is legitimately directable inside its own window even once the commitment it follows has ended, and
 * a before-phase step of a commitment still running late is legitimately directable even once its own
 * static window has elapsed. Only a step whose *both* bounds have closed — its own window and its
 * commitment's — is the finished-commitment leftover bcd354d6 excludes.
 */
function directableStep(
  step: WireRoutineStep,
  now: Date,
  commitmentEndsAt: Date | undefined,
  steps: readonly WireRoutineStep[]
): boolean {
  if (step.status !== "pending" || !step.scheduledStartAt || new Date(step.scheduledStartAt) > now) return false;
  const ownWindowOpen = !step.scheduledEndAt || new Date(step.scheduledEndAt) > now;
  const commitmentStillRunning = commitmentEndsAt !== undefined && commitmentEndsAt > now;
  if (!(ownWindowOpen || commitmentStillRunning)) return false;
  return !runningWaitPrerequisite(steps, step, now);
}

/**
 * Whether any of `step`'s immediate prerequisites is `completed` but its own wait has not yet ended
 * (`completedAt + waitAfterMinutes`) — the wait gate the routine step timing design note's "The
 * placer" names for `directive.ts`: a wait is not directed through. A completed prerequisite with no
 * recorded `completedAt` counts its wait as already ended (nothing to run it from), and a prerequisite
 * that is not `completed` gates nothing here — its own incompleteness is what `start_activity`'s
 * prerequisite gate is for, not a wait.
 */
function runningWaitPrerequisite(steps: readonly WireRoutineStep[], step: WireRoutineStep, now: Date): boolean {
  const byId = new Map(steps.map((item) => [item.id, item]));
  return step.dependencyIds.some((id) => {
    const prerequisite = byId.get(id);
    if (!prerequisite || prerequisite.status !== "completed" || !prerequisite.completedAt) return false;
    const waitMinutes = prerequisite.waitAfterMinutes ?? 0;
    if (waitMinutes <= 0) return false;
    return new Date(prerequisite.completedAt).getTime() + waitMinutes * MINUTE > now.getTime();
  });
}

/** Earliest scheduled start first, then declared sequence — the order steps are actually due in. */
function byDueDate(a: WireRoutineStep, b: WireRoutineStep): number {
  return (a.scheduledStartAt ?? "").localeCompare(b.scheduledStartAt ?? "") || a.sequence - b.sequence;
}

/**
 * The earliest still-pending prerequisite of a routine step, walked transitively over
 * `dependencyIds` — or null when every edge that gates a start is already satisfied.
 *
 * Step windows are static: back-chained from the commitment start and never re-flowed when the user
 * runs late. So an overdue prerequisite drops out of the in-window filter above while its dependent
 * comes into window — and directing the dependent names a step the `start_activity` gate is
 * guaranteed to refuse, since that gate requires every prerequisite `completed`. A dead end, at the
 * worst moment: right before a commitment. Walking back from the in-window step to the earliest
 * unmet prerequisite keeps the directive startable, elapsed window and all.
 *
 * This cannot revive a finished commitment's stale steps: `directableStep`'s per-commitment bound
 * already excludes them from `state.routineSteps` before this ever walks a dependency chain, so a
 * finished commitment has no in-window step to walk back from and its pending leftovers stay
 * invisible.
 */
function unmetPrerequisite(steps: WireRoutineStep[], step: WireRoutineStep): WireRoutineStep | null {
  const byId = new Map(steps.map((item) => [item.id, item]));
  const pending: WireRoutineStep[] = [];
  const seen = new Set([step.id]);
  const queue = [...step.dependencyIds];
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const prerequisite = byId.get(id);
    // A completed or skipped edge is satisfied — arrival wins, so a step the arrival made moot gates
    // nothing behind it either — and whatever sits behind it no longer gates this start.
    if (!prerequisite || prerequisite.status === "completed" || prerequisite.status === "skipped") continue;
    if (prerequisite.status === "pending") pending.push(prerequisite);
    queue.push(...prerequisite.dependencyIds);
  }
  return (
    pending.sort(
      (a, b) => a.sequence - b.sequence || (a.scheduledStartAt ?? "").localeCompare(b.scheduledStartAt ?? "")
    )[0] ?? null
  );
}

/**
 * The leg a protected commitment is currently in, as a directive. `travel` heads for the commitment
 * itself; `return` heads wherever the projection says you go next, which is usually home. Every other
 * phase is time to be waited through, and stays a `none` directive as it always was.
 *
 * A leg that ends where the day already is is not a journey, and `already` drops it. The phase is
 * computed from the plan's shape — a commitment at a place gets a travel phase before it — but the
 * plan cannot know the person arrived early, or that the projection itself placed work at that place
 * first. Without this the projected day leaves a location in order to travel to the location it is
 * standing in: a campus-to-campus leg with a real duration, which is what `travel.test.ts`'s F2 case
 * caught once ranking first made work at a commitment's location worth doing before the
 * commitment itself. Arrival retires the leg here exactly as it retires a moot before-phase step
 * above, and what to do with the freed time falls through to the search below.
 */
function plannedLeg(
  commitment: ProtectedCommitment | undefined,
  travel: DirectiveTravel
): Extract<CurrentDirective, { kind: "travel" }> | null {
  if (!commitment) return null;
  const already = (toLocationId: string) => travel.currentLocationId === toLocationId;
  if (commitment.phase === "travel" && commitment.locationId) {
    if (already(commitment.locationId)) return null;
    const leg = commitment.travelBefore;
    return travelDirective(
      commitment.locationId,
      leg?.minutes ?? 0,
      leg?.mode,
      leg?.source ?? "fallback",
      travel,
      {
        kind: "commitment",
        targetId: commitment.id,
        title: commitment.title,
        recommendedMinutes: Math.max(
          1,
          Math.round((commitment.endsAt.getTime() - commitment.startsAt.getTime()) / MINUTE)
        )
      },
      leg
        ? {
            typicalMinutes: leg.typicalMinutes,
            sampleCount: leg.sampleCount,
            ...(leg.originAssumed ? { originAssumed: true } : {}),
            // The travel phase starts exactly at leave-by (recommend.ts's phase arithmetic).
            leaveBy: commitment.phaseStartsAt
          }
        : undefined
    );
  }
  if (commitment.phase === "return" && commitment.travelAfter) {
    const leg: CommitmentTravelLeg = commitment.travelAfter;
    if (already(leg.toLocationId)) return null;
    return travelDirective(leg.toLocationId, leg.minutes, leg.mode, leg.source, travel, leg.anchor, {
      typicalMinutes: leg.typicalMinutes,
      sampleCount: leg.sampleCount,
      ...(leg.originAssumed ? { originAssumed: true } : {})
    });
  }
  return null;
}

function travelDirective(
  toLocationId: string,
  minutes: number,
  mode: TransportMode | undefined,
  source: Extract<CurrentDirective, { kind: "travel" }>["source"],
  travel: DirectiveTravel,
  then: Extract<CurrentDirective, { kind: "travel" }>["then"],
  extra?: {
    typicalMinutes?: number;
    sampleCount?: number;
    originAssumed?: boolean;
    leaveBy?: Date;
    notBefore?: string;
  }
): Extract<CurrentDirective, { kind: "travel" }> {
  return {
    kind: "travel",
    toLocationId,
    title: `${verbOf(mode)} to ${travel.locationName(toLocationId)}`,
    recommendedMinutes: Math.max(0, Math.round(minutes)),
    ...(mode ? { mode } : {}),
    source,
    ...(extra?.typicalMinutes !== undefined ? { typicalMinutes: Math.round(extra.typicalMinutes) } : {}),
    ...(extra?.sampleCount !== undefined ? { sampleCount: extra.sampleCount } : {}),
    ...(extra?.originAssumed ? { originAssumed: true } : {}),
    ...(extra?.leaveBy ? { leaveBy: extra.leaveBy.toISOString() } : {}),
    ...(extra?.notBefore ? { notBefore: extra.notBefore } : {}),
    // oxlint-disable-next-line unicorn/no-thenable -- `then` is a domain field of the travel directive, not a promise continuation
    ...(then ? { then } : {})
  };
}

/** How you get there, when the estimate knows. Otherwise the neutral verb, which claims nothing. */
function verbOf(mode: TransportMode | undefined): string {
  switch (mode) {
    case "car":
      return "Drive";
    case "bike":
      return "Cycle";
    case "walk":
      return "Walk";
    default:
      return "Travel";
  }
}

/**
 * Slots are quantised to 15 minutes, but most edges sit inside a homogeneous window where nothing
 * about the decision changes. Only edges where availability or energy actually changes are
 * boundaries worth recalculating at.
 */
export function capacityTransitions(schedule: PlanningResult): Date[] {
  const boundaries: Date[] = [];
  for (const [index, slot] of schedule.slots.entries()) {
    const next = schedule.slots[index + 1];
    if (
      !next ||
      next.startsAt.getTime() !== slot.endsAt.getTime() ||
      next.availability !== slot.availability ||
      next.energy !== slot.energy
    )
      boundaries.push(slot.endsAt);
  }
  return boundaries;
}

/** Contiguous protected recovery minutes available from now, if any. */
export function recoveryWindowMinutes(schedule: PlanningResult, now: Date): number {
  const current = schedule.slots.find(
    (slot) => slot.startsAt <= now && slot.endsAt > now && slot.availability === "protected"
  );
  if (!current) return 0;
  let minutes = Math.max(0, Math.round((current.endsAt.getTime() - now.getTime()) / MINUTE));
  let prior = current;
  for (const slot of schedule.slots.filter((slot) => slot.startsAt >= current.endsAt)) {
    if (slot.startsAt.getTime() !== prior.endsAt.getTime() || slot.availability !== "protected") break;
    minutes += Math.round((slot.endsAt.getTime() - slot.startsAt.getTime()) / MINUTE);
    prior = slot;
  }
  return minutes;
}

/**
 * MVP 7.5 bounds a session by the daily planning horizon as well as capacity and commitments.
 * A day whose horizon has already passed offers no window; Today's explicit override is the
 * escape hatch for deliberately working later.
 */
export function dailyHorizonEnd(state: WireState, now: Date): Date {
  const { timezone, preferredWakeTime, planningHorizonEnd } = state.settings;
  const today = localDate(now, timezone);
  const planningDate = activePlanningDate(state, now);
  // An override belongs to exactly one planning day: the one whose window it falls in, after that day's
  // start (its wake) and no later than the next wake. The save paths hold that invariant by clamping
  // an extension to the next wake (`clampHorizonOverride`), so "+3 hours" at 05:00 stores 07:00, not
  // 08:00, and cannot leak into the day that begins at 07:00. The window is the rule rather than the
  // row's date because an extension saved at 00:45 carries the new calendar date yet belongs to the
  // overnight day still in progress. A stored instant outside the window (an earlier day's, or one
  // that predates the clamp) is ignored, never trimmed, so it cannot blank or stretch another day.
  const planningDayStart = zonedDateTime(planningDate, preferredWakeTime || "00:00", timezone);
  const nextWake = zonedDateTime(addLocalDays(planningDate, 1), preferredWakeTime || "00:00", timezone);
  if (
    state.dailyPlan?.horizonOverrideAt &&
    (state.dailyPlan.localDate === today || state.dailyPlan.localDate === planningDate)
  ) {
    const override = new Date(state.dailyPlan.horizonOverrideAt);
    if (override > planningDayStart && override <= nextWake) return override;
  }
  return planningDayEnd(planningDate, preferredWakeTime, planningHorizonEnd, timezone);
}

/**
 * The local date of the planning day `now` belongs to. An overnight end (00:30 for a person who wakes
 * at 07:00) closes the day that began the previous calendar date, and that day is still the active
 * one until today's wake instant: at 00:01 the horizon is 00:30 tonight, 29 minutes away, and once
 * 00:30 has passed it stays passed until wake rather than rolling to the following night. An ordinary
 * evening end belongs to today's date.
 *
 * A day keeps its identity through an extension it was promised. With a 22:00 end, "+1 hour" at 23:30
 * saves 00:30, and after midnight the calendar says it is the next day; but while the previous day's
 * (or today's) row carries an override that is still ahead and no later than today's wake, the person
 * is still in that night, so the previous day stays active and the override is that day's horizon. The
 * override can never reach past the wake (the save paths clamp it there), so the next day starts at its
 * wake with nothing carried over.
 */
export function activePlanningDate(state: WireState, now: Date): string {
  const { timezone, preferredWakeTime, planningHorizonEnd } = state.settings;
  const today = localDate(now, timezone);
  const wakeToday = zonedDateTime(today, preferredWakeTime || "00:00", timezone);
  const overnight = zonedDateTime(today, planningHorizonEnd, timezone) <= wakeToday;
  if (now < wakeToday && overnight) return addLocalDays(today, -1);
  const previous = addLocalDays(today, -1);
  const plan = state.dailyPlan;
  if (
    plan?.horizonOverrideAt &&
    (plan.localDate === previous || plan.localDate === today) &&
    now < wakeToday &&
    new Date(plan.horizonOverrideAt) > now &&
    new Date(plan.horizonOverrideAt) <= wakeToday
  )
    return previous;
  return today;
}

/**
 * The instant the planning day that starts on `localDateValue` ends. An end at or before the day's
 * start (the preferred wake time) is an overnight end, such as 00:30 or 01:00 for a person who
 * works late, and belongs to the next local date: building it on the same date put it hours
 * before the day began and blanked the whole day. The same rollover as `resolvePlanningCapacity`
 * and the settings preview (`nextHorizonEnd`), compared as instants so a DST change on either
 * date cannot flip it.
 */
export function planningDayEnd(
  localDateValue: string,
  dayStartTime: string | undefined,
  endTime: string,
  timezone: string
) {
  const dayStart = zonedDateTime(localDateValue, dayStartTime || "00:00", timezone);
  const sameDayEnd = zonedDateTime(localDateValue, endTime, timezone);
  return sameDayEnd > dayStart ? sameDayEnd : zonedDateTime(addLocalDays(localDateValue, 1), endTime, timezone);
}
