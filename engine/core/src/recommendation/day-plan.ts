import type { CurrentDirective, CurrentSituation, DayPlan, DayPlanBlock, EnergyType } from "@openrhen/contracts";
import { zonedDateTime } from "@openrhen/contracts";
import { addLocalDays, localDate } from "../recurrence/recurrence.js";
import {
  commitmentProtection,
  defaultPlanningConfig,
  protectedLegEdges,
  SESSION_BREAK_MINUTES
} from "../model/types.js";
import type { Action, PlanningResult, Recommendation, RecommendationCandidate, SleepPlan } from "../model/types.js";
import { formatTime } from "./format.js";
import { choice, recommend, targetIdOf, type RecommendArguments } from "./recommend.js";
import {
  capacityTransitions,
  activePlanningDate,
  dailyHorizonEnd,
  selectCurrentDirective,
  type DirectiveTravel,
  type WireState
} from "./directive.js";

/**
 * The forward-simulated day (logic design §12, "Day plan").
 *
 * A block says: if, from `calculatedAt`, you follow the current directive policy and the day goes as
 * expected — each session takes the wall-clock minutes the policy recommends at that moment, focused
 * minutes reduce remaining effort one-for-one, commitments, sleep and routines occur as scheduled —
 * this is when each thing would happen. It is an execution projection of the policy that produces
 * `currentDirective`; the ALAP allocations remain the feasibility reservation and are never moved.
 *
 * Nothing here ranks, filters or bounds a session. Every step calls the same `recommend()` and
 * `selectCurrentDirective()` the live directive is made from, against the run's own schedule, with a
 * synthetic `now`, deducted remaining effort, and no active session. Block 0 is not simulated at all:
 * it is the already-computed recommendation and directive, so `blocks[0]` is the live directive by
 * construction. Any plan-only logic added here would let the projected day disagree with the
 * directive it claims to project — that is the one rule this module exists to keep.
 *
 * `policy_replay` keeps slots and forecasts frozen at calculation, so the only known divergence from a
 * live recompute after perfect compliance is forecast drift: another project's margin shrinking as the
 * day passes can flip its health or tier. A `full_replay` mode that re-plans at every step is left to
 * a later engine version behind the same `mode` field.
 */

const MINUTE = 60_000;
/** Most blocks one simulated day may hold. Fifteen is typical; the cap only bounds a runaway loop. */
export const DAY_PLAN_STEP_CAP = 64;
/** The fallback advance when nothing else can move the clock, so the loop always terminates. */
const MINIMUM_ADVANCE_MS = 15 * MINUTE;

/** What the simulation knows about where it is when it asks for the situation at a later instant. */
export interface SituationContext {
  /** The location the simulated day is at going into this step; loop state, re-seeded by blocks that move it. */
  locationId: string | null;
}

/**
 * The situation the simulation assumes at a later instant.
 *
 * This is the one seam through which the plan learns anything about the future beyond the schedule,
 * and it is injected — the loop never reads the live situation from anywhere else. When the current
 * location is known the engine supplies the projection: home base, commitment locations and the
 * journeys between them, read at the synthetic instant and overlaid with `context.locationId`, which
 * is where the simulated day has actually reached and therefore wins — a directed trip takes it
 * somewhere the projection never foresaw. When the location is unknown there is nothing honest to
 * project, and `frozenSituation` stands in: wherever you are and however you feel now persists for
 * the day, with the location re-asserted at each step so the staleness rule cannot turn the evening
 * into "answer" gaps.
 */
export type SituationAt = (
  t: Date,
  context: SituationContext
) => { currentSituation?: CurrentSituation; currentEnergy?: EnergyType };

export function frozenSituation(situation: CurrentSituation | undefined, energy: EnergyType | undefined): SituationAt {
  return (t, context) => ({
    ...(situation
      ? { currentSituation: { ...situation, locationId: context.locationId, locationSetAt: t.toISOString() } }
      : {}),
    ...(energy ? { currentEnergy: energy } : {})
  });
}

export interface DayPlanSimulationInput {
  /** The derived state the live directive was selected from (routine instances already derived). */
  state: WireState;
  now: Date;
  sleepPlans: SleepPlan[];
  schedule: PlanningResult;
  /** The exact arguments the live recommendation was computed from. */
  recommendArguments: RecommendArguments;
  recommendation: Recommendation;
  currentDirective: CurrentDirective;
  /** Defaults to freezing the live situation and energy for the whole day. */
  situationAt?: SituationAt;
  /**
   * What the precedence chain needs to know about places. Re-supplied at every step with the location
   * the simulation has reached, so a leg the live directive would call for is called for here too.
   */
  travel?: DirectiveTravel;
  /** Defaults to `defaultPlanningConfig.dayPlanDays`. */
  dayPlanDays?: number;
}

interface SimulatedBlock extends DayPlanBlock {
  /** The forecast unit a work block advances, for the displaced-deadline read. */
  unitId?: string;
}

export function simulateDayPlan(input: DayPlanSimulationInput): DayPlan {
  const { state, now, schedule, sleepPlans, recommendArguments } = input;
  const situationAt =
    input.situationAt ?? frozenSituation(recommendArguments.currentSituation, recommendArguments.currentEnergy);
  const timezone = state.settings.timezone;
  const days = Math.max(1, Math.round(input.dayPlanDays ?? defaultPlanningConfig.dayPlanDays));
  // Each simulated day ends at its own daily planning horizon (an override applies only to its day).
  // Counted from the active planning day (yesterday's date between midnight and wake for an overnight
  // end). A later day is read at its wake instant so its own end is the one `dailyHorizonEnd` answers;
  // the active day is read at `now`, the same call the live directive makes, because an extension saved
  // after midnight carries today's calendar date and matches neither date at yesterday's wake instant.
  const activeDate = activePlanningDate(state, now);
  const lastDate = addLocalDays(activeDate, days - 1);
  const lastDayEnd =
    lastDate === activeDate
      ? dailyHorizonEnd(state, now)
      : dailyHorizonEnd(state, zonedDateTime(lastDate, state.settings.preferredWakeTime || "00:00", timezone));
  const through = new Date(
    Math.max(now.getTime(), Math.min(lastDayEnd.getTime(), recommendArguments.horizonEnd.getTime()))
  );
  const stepCap = DAY_PLAN_STEP_CAP * days;

  // Instants at which an empty stretch can end: capacity or protection edges, protected commitment
  // starts, actions becoming available, a pending routine step's own due time, the next local day
  // (whose own horizon reopens planning), and the bound itself. Sorted once; the clock only moves
  // forward.
  //
  // A step's own `scheduledStartAt` matters here for a reason that only shows up once a flexible
  // step can be offered early:
  // pulling one step out of its chain's original contiguous order opens a stretch, ahead of it, in
  // which nothing is yet due — the next due step's own static placement (frozen at the run that built
  // `recommendArguments`, never re-placed mid-simulation) no longer lines up with `now` the moment the
  // pulled step finishes. Without this, that stretch had no transition to stop at and the gap ran all
  // the way to whatever boundary came next, silently swallowing every step still to come.
  const transitions = [
    ...capacityTransitions(schedule),
    ...(recommendArguments.protectedCommitments ?? recommendArguments.commitments).map(
      (item) => commitmentProtection(item, state.settings.arrivalMarginMinutes).startsAt
    ),
    ...recommendArguments.actions.flatMap((action) => (action.availableFrom ? [action.availableFrom] : [])),
    ...(recommendArguments.routineSteps ?? []).flatMap((step) =>
      step.status === "pending" && step.scheduledStartAt ? [new Date(step.scheduledStartAt)] : []
    ),
    // A maximum-session break already in force when this simulation starts (inherited from the live
    // `lastEndedSessions`, not one the loop below creates itself) still needs its own end as a
    // transition, or block 0's own boundary gap — computed by the live `recommend()` before this
    // function ever runs — has nothing to stop at until whatever unrelated transition comes next.
    ...(recommendArguments.lastEndedSessions ?? []).flatMap((session) => {
      const action = recommendArguments.actions.find((item) => (item.deliverableId ?? item.id) === session.targetId);
      if (!action || session.focusedMinutes < action.maximumSessionMinutes) return [];
      const breakMinutes = recommendArguments.sessionBreakMinutes ?? SESSION_BREAK_MINUTES;
      return [new Date(session.endedAt.getTime() + breakMinutes * MINUTE)];
    }),
    // When the bound spans more than the active planning day, each later day begins at its own wake.
    // Without it, a replay that starts after an overnight horizon has passed (00:45, wake at 07:00) has
    // nothing to stop at until the next midnight, and skips wake to midnight, the day's whole working time.
    ...Array.from({ length: days - 1 }, (_, index) =>
      zonedDateTime(addLocalDays(activeDate, index + 1), state.settings.preferredWakeTime || "00:00", timezone)
    ).filter((wake) => wake.getTime() <= through.getTime()),
    through
  ]
    .map((date) => date.getTime())
    .filter((ms) => ms > now.getTime())
    .sort((a, b) => a - b);
  // A break the replay itself creates (deduct, below) is a transition too: without it, a gap after a
  // full session runs straight through the break's own end to whatever comes next, silently
  // absorbing the moment the action would become offerable again.
  const addTransition = (at: Date) => {
    if (at.getTime() <= now.getTime()) return;
    transitions.push(at.getTime());
    transitions.sort((a, b) => a - b);
  };
  const nextTransition = (t: Date) => {
    const nextDay = zonedDateTime(addLocalDays(localDate(t, timezone), 1), "00:00", timezone).getTime();
    const next = transitions.find((ms) => ms > t.getTime());
    const soonest = Math.min(
      next ?? Number.MAX_SAFE_INTEGER,
      nextDay > t.getTime() ? nextDay : Number.MAX_SAFE_INTEGER
    );
    return new Date(
      soonest === Number.MAX_SAFE_INTEGER ? Math.max(through.getTime(), t.getTime() + MINIMUM_ADVANCE_MS) : soonest
    );
  };

  // From block 1 on there is no running session: the live one has ended (block 0 is it). Neither
  // `activeActionId` nor `lastActionId` is passed, because the live recompute after a finished
  // session passes neither — a just-finished action keeps only what `lastWorkedAt` gives it. Passing
  // the previous target would be a plan-only stickiness the live directive does not have.
  //
  // `freeAnchorIds` goes for a stronger reason. It says these anchors' windows are open *at this instant*,
  // on the strength of the person being there with nothing engaging them; a replay of the rest of the
  // day knows no such thing about any hour it has not reached. Every anchor is therefore as protected
  // in the plan as a blocking commitment, and the slots below — this function's own `schedule` — are
  // the pessimistic ones regardless of what the live call ranked against.
  const {
    activeActionId: _liveActive,
    lastActionId: _liveLast,
    freeAnchorIds: _liveFreeAnchors,
    ...baseArguments
  } = recommendArguments;
  let t = now;
  let actions = recommendArguments.actions;
  let simulatedState = state;
  // The replay's own copy of the maximum-session break ledger, seeded from the live one and updated
  // as `deduct` records each simulated session's end — otherwise the replay would re-offer an action
  // one step after its own full session, never having heard that it just happened.
  let lastEndedSessions = recommendArguments.lastEndedSessions ?? [];
  const sessionBreakMinutes = recommendArguments.sessionBreakMinutes ?? SESSION_BREAK_MINUTES;
  // Where the simulated day is. Nothing moves it yet; a travel or located-commitment block will, and
  // the situation seam reads it from here rather than from the live situation.
  let locationId: string | null = recommendArguments.currentSituation?.locationId ?? null;
  let slotCursor = 0;
  const blocks: SimulatedBlock[] = [];
  const presences: DayPlan["locations"] = [];
  let truncated = false;

  while (blocks.length === 0 || t < through) {
    if (blocks.length >= stepCap) {
      truncated = true;
      break;
    }
    // Slots that have already ended can never be found again; dropping them keeps each later step's
    // window scan proportional to what is left of the horizon. Same answers: every read of the slot
    // list looks for slots containing or after `now`.
    while (slotCursor < schedule.slots.length && schedule.slots[slotCursor]!.endsAt <= t) slotCursor += 1;
    const planning = slotCursor === 0 ? schedule : { ...schedule, slots: schedule.slots.slice(slotCursor) };
    const first = blocks.length === 0;
    const recommendation = first
      ? input.recommendation
      : recommend({
          ...baseArguments,
          ...situationAt(t, { locationId }),
          now: t,
          actions,
          planning,
          forecasts: schedule.forecasts,
          ...waivedAt(recommendArguments, t),
          dailyHorizonEnd: dailyHorizonEnd(state, t),
          // Steps the simulation has already ticked off (`advance`'s `routine_step` case) must count
          // as done here too, or a commitment the plan itself just finished prepping for would still
          // read as running late at the very next step.
          routineSteps: simulatedState.routineSteps,
          lastEndedSessions,
          explain: false
        });
    const directive = first
      ? input.currentDirective
      : selectCurrentDirective({
          state: simulatedState,
          // Same materialized-occurrences list the live directive was resolved from (see the
          // parameter's own comment in directive.ts) — the replay must judge each simulated step
          // against the same commitments the live call would, recurring occurrences included.
          commitments: recommendArguments.protectedCommitments ?? recommendArguments.commitments,
          now: t,
          sleepPlans,
          recommendation,
          schedule: planning,
          ...(input.travel ? { travel: { ...input.travel, currentLocationId: locationId } } : {})
        });

    const rawStep = advance({
      directive,
      recommendation,
      t,
      through,
      nextTransition,
      sleepPlans,
      simulatedState,
      timezone,
      ...(input.recommendArguments.locale ? { locale: input.recommendArguments.locale } : {})
    });
    // A work step that would not move the clock (zero focused or zero wall-clock minutes) is
    // never stretched across the gap to the next transition as if it were still that session; it
    // becomes an ordinary gap block instead, so the replay never invents a session with no minutes in
    // it. The recommender is what decides whether a candidate has a session at all; this only
    // translates the step it already chose not to give one.
    const zeroLengthWork =
      (rawStep.block.kind === "action" || rawStep.block.kind === "deliverable") && rawStep.endsAt <= t;
    const step: Step = zeroLengthWork
      ? {
          block: {
            kind: "gap",
            targetId: null,
            title: directive.title,
            focusedMinutes: 0,
            reason: recommendation.explanation,
            gapKind: "none"
          },
          endsAt: nextTransition(t)
        }
      : rawStep;
    // The clock must move at every step, whatever the directive said; a block that would not move it
    // is stretched to the next transition instead of repeating forever.
    const endsAt = step.endsAt > t ? step.endsAt : nextTransition(t);
    const block = canonicalBlock({
      ...step.block,
      startsAt: t.toISOString(),
      endsAt: endsAt.toISOString(),
      wallClockMinutes: Math.max(0, Math.round((endsAt.getTime() - t.getTime()) / MINUTE)),
      confidence: first || FIRM_KINDS.has(step.block.kind) ? "firm" : "projected"
    });
    const previous = blocks.at(-1);
    if (previous && sameGap(previous, block)) {
      // One empty stretch, not a run of identical labels ending at every slot edge inside it.
      previous.endsAt = block.endsAt;
      previous.wallClockMinutes += block.wallClockMinutes;
    } else blocks.push(block);
    // Where the day is while this block runs: nowhere during a journey, otherwise where it started.
    addPresence(presences, t, endsAt, block.kind === "travel" ? null : locationId);

    if (step.worked) {
      actions = deduct(actions, step.worked, endsAt);
      const focused = step.worked.recommendedMinutes ?? 0;
      const key = step.worked.action.deliverableId ?? step.worked.action.id;
      lastEndedSessions = [
        ...lastEndedSessions.filter((session) => session.targetId !== key),
        { targetId: key, endedAt: endsAt, focusedMinutes: focused }
      ];
      if (focused >= step.worked.action.maximumSessionMinutes)
        addTransition(new Date(endsAt.getTime() + sessionBreakMinutes * MINUTE));
    }
    if (step.state) simulatedState = step.state;
    if (step.locationId !== undefined) locationId = step.locationId;
    t = endsAt;
    if (step.stopDay && t >= through) break;
  }

  return {
    through: through.toISOString(),
    mode: "policy_replay",
    blocks: blocks.map(({ unitId: _unitId, ...block }) => block),
    truncated,
    displaced: displacedUnits(schedule, blocks, now, through, recommendArguments.actions),
    // A band of nulls says nothing anyone could draw, so an unknown location yields no band at all.
    locations: presences.some((entry) => entry.locationId !== null)
      ? presences.map((entry) => ({
          ...entry,
          label: entry.locationId ? (input.travel?.locationName(entry.locationId) ?? entry.locationId) : "In transit"
        }))
      : []
  };
}

/** One stretch per place, so staying put across four blocks is one band and not four. */
function addPresence(presences: DayPlan["locations"], startsAt: Date, endsAt: Date, locationId: string | null) {
  const last = presences.at(-1);
  if (last && last.locationId === locationId && last.endsAt === startsAt.toISOString()) {
    last.endsAt = endsAt.toISOString();
    return;
  }
  presences.push({ startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), locationId, label: "" });
}

/**
 * Keys in the contract's order. The service returns the response through the schema, which rebuilds
 * objects in declaration order, and the boundary test holds the two byte-equal; emitting the same
 * order here is what keeps that true.
 */
function canonicalBlock(block: SimulatedBlock): SimulatedBlock {
  return {
    startsAt: block.startsAt,
    endsAt: block.endsAt,
    kind: block.kind,
    targetId: block.targetId,
    title: block.title,
    ...(block.projectId !== undefined ? { projectId: block.projectId } : {}),
    ...(block.toLocationId !== undefined ? { toLocationId: block.toLocationId } : {}),
    ...(block.mode !== undefined ? { mode: block.mode } : {}),
    focusedMinutes: block.focusedMinutes,
    wallClockMinutes: block.wallClockMinutes,
    ...(block.tier !== undefined ? { tier: block.tier } : {}),
    reason: block.reason,
    confidence: block.confidence,
    ...(block.gapKind !== undefined ? { gapKind: block.gapKind } : {}),
    ...(block.boundaryKind !== undefined ? { boundaryKind: block.boundaryKind } : {}),
    ...(block.unitId !== undefined ? { unitId: block.unitId } : {})
  };
}

/** Blocks that are scheduled facts rather than simulated choices. */
const FIRM_KINDS = new Set<DayPlanBlock["kind"]>(["commitment", "sleep", "routine_step"]);

interface Step {
  block: Omit<SimulatedBlock, "startsAt" | "endsAt" | "wallClockMinutes" | "confidence">;
  endsAt: Date;
  worked?: RecommendationCandidate;
  state?: WireState;
  /** A daily-horizon boundary closes the simulated day. */
  stopDay?: boolean;
  /** Where the day is once this block ends: a journey and a located commitment both move it. */
  locationId?: string | null;
}

/**
 * Turns one directive into the block it occupies and the moment the next decision is made. Every
 * directive kind the live chain can produce is handled here; the mapping only translates, it never
 * chooses.
 */
function advance(input: {
  directive: CurrentDirective;
  recommendation: Recommendation;
  t: Date;
  through: Date;
  nextTransition: (t: Date) => Date;
  sleepPlans: SleepPlan[];
  simulatedState: WireState;
  timezone: string;
  locale?: string;
}): Step {
  const { directive, recommendation, t, sleepPlans, simulatedState, timezone, locale } = input;
  const primary = recommendation.primary;
  // Deadline work inside its break, or the journey to it: the directive is the break. It ends where
  // the break does, or at the next transition (a commitment or routine window inside it) if sooner.
  if (
    (directive.kind === "action" ||
      directive.kind === "deliverable" ||
      (directive.kind === "travel" && directive.notBefore !== undefined)) &&
    primary?.restUntil &&
    primary.restUntil.getTime() > t.getTime()
  )
    return {
      block: {
        kind: "gap",
        targetId: null,
        title: "Take a break",
        focusedMinutes: 0,
        reason: `Take a break until ${formatTime(primary.restUntil, timezone, locale)}, then ${primary.action.title}.`,
        gapKind: "none"
      },
      endsAt: new Date(Math.min(primary.restUntil.getTime(), input.nextTransition(t).getTime()))
    };
  switch (directive.kind) {
    case "action":
    case "deliverable": {
      if (!primary) break;
      const focused = primary.recommendedMinutes ?? 0;
      const wall = primary.recommendedWallClockMinutes ?? 0;
      return {
        block: {
          kind: directive.kind,
          targetId: targetIdOf(primary),
          title: primary.action.title,
          projectId: primary.action.projectId,
          focusedMinutes: focused,
          tier: primary.criticalTier,
          reason: choice(primary).reason,
          unitId: primary.action.forecastUnitId ?? primary.action.id
        },
        endsAt: new Date(t.getTime() + wall * MINUTE),
        worked: primary
      };
    }
    case "sleep": {
      const plan = sleepPlans.find((item) => item.id === directive.targetId);
      if (!plan) break;
      return {
        block: {
          kind: "sleep",
          targetId: plan.id,
          title: directive.title,
          focusedMinutes: 0,
          reason: "Planned sleep."
        },
        endsAt: plan.plannedWakeAt,
        // Waking closes the night: the stored outcome becomes "completed" for this exact window, which
        // is what stops the same plan being the directive again after its wake time (a stored
        // "sleeping" plan is otherwise authoritative for as long as it lasts).
        state: {
          ...simulatedState,
          sleepPlans: [
            ...simulatedState.sleepPlans.filter((item) => item.id !== plan.id),
            {
              ...(simulatedState.sleepPlans.find((item) => item.id === plan.id) ?? storedSleep(plan)),
              plannedStartAt: plan.plannedStartAt.toISOString(),
              plannedWakeAt: plan.plannedWakeAt.toISOString(),
              status: "completed" as const
            }
          ]
        }
      };
    }
    // `routine_instance` dropped: a bedtime/wake step is a `routine_step` row now, already
    // handled by the case below.
    case "routine_step": {
      const step = simulatedState.routineSteps.find((item) => item.id === directive.targetId);
      if (!step) break;
      const byDuration = new Date(t.getTime() + step.durationMinutes * MINUTE);
      const endsAt = step.durationMinutes > 0 ? byDuration : step.scheduledEndAt ? new Date(step.scheduledEndAt) : t;
      return {
        block: {
          kind: "routine_step",
          targetId: step.id,
          title: step.title,
          focusedMinutes: 0,
          reason: "Routine step."
        },
        endsAt,
        // The synthetic completion instant, not `t`: a directed step's wait (if it has one) runs from
        // when its hands-on work actually finished, so a dependent is not directed again until that
        // wait ends (the routine step timing design note, "The placer"; `directive.ts`'s
        // `runningWaitPrerequisite` reads this same field on the next replay step).
        state: {
          ...simulatedState,
          routineSteps: simulatedState.routineSteps.map((item) =>
            item.id === step.id ? { ...item, status: "completed" as const, completedAt: endsAt.toISOString() } : item
          )
        }
      };
    }
    case "travel":
      return {
        block: {
          kind: "travel",
          // A journey is for something, and naming that thing is what makes the block readable.
          targetId: directive.then?.targetId ?? null,
          title: directive.title,
          toLocationId: directive.toLocationId,
          ...(directive.mode ? { mode: directive.mode } : {}),
          focusedMinutes: 0,
          reason: directive.then
            ? `Getting to ${directive.then.title}; the journey is ${directive.source}.`
            : `The journey is ${directive.source}.`
        },
        endsAt: new Date(t.getTime() + directive.recommendedMinutes * MINUTE),
        locationId: directive.toLocationId
      };
    case "recovery":
      return {
        block: {
          kind: "recovery",
          targetId: null,
          title: directive.title,
          focusedMinutes: 0,
          reason: "No work fits, and protected recovery capacity is open."
        },
        endsAt: new Date(t.getTime() + directive.recommendedMinutes * MINUTE)
      };
    case "boundary": {
      const boundaryAt = new Date(directive.boundaryAt);
      // A horizon already behind us ends the day; the clock still has to reach the next transition
      // (the night, or the bound) so a multi-day plan can carry on into tomorrow. Otherwise capped at
      // the next transition too, not just the boundary itself: `recommend()`'s own boundary math
      // knows nothing about a routine step that will become due before it — an idle stretch pulled
      // open by a flexible step directed early (the routine step timing design note, "Flexible steps
      // offered early") — so without the cap this block ran straight through that due step to the
      // boundary beyond it, silently skipping everything in between. `stopDay` only fires once the
      // horizon is actually reached, not merely named as the reason nothing fits yet.
      const endsAt =
        boundaryAt > t
          ? new Date(Math.min(boundaryAt.getTime(), input.nextTransition(t).getTime()))
          : input.nextTransition(t);
      return {
        block: {
          kind: "gap",
          targetId: null,
          title: directive.title,
          focusedMinutes: 0,
          reason: recommendation.explanation,
          gapKind: "boundary",
          boundaryKind: directive.boundaryKind
        },
        endsAt,
        stopDay: directive.boundaryKind === "daily_horizon" && endsAt.getTime() >= boundaryAt.getTime()
      };
    }
    case "answer":
      return {
        block: {
          kind: "gap",
          targetId: null,
          title: directive.title,
          focusedMinutes: 0,
          reason: recommendation.explanation,
          gapKind: "answer"
        },
        endsAt: input.nextTransition(t)
      };
    case "none": {
      const commitment = recommendation.protectedCommitment;
      if (commitment) {
        // A commitment with journeys is not one unbroken block: the legs are their own directives, so
        // the block stops where the next one begins and the loop asks again. Without a journey nothing
        // splits, and a place-less commitment reads exactly as it always did.
        const { leaveBy, freeAt } = protectedLegEdges(commitment);
        // The segment that stops at `leaveBy` is the time before the journey — getting ready, waiting
        // to set off — and it is spent wherever you already are. Only what follows the leg is time at
        // the commitment's place, so this segment must not move the projection there: doing so made the
        // day read as already arrived, which then suppressed the very leg that takes it there.
        const beforeDeparture = Boolean(commitment.travelBefore) && t < leaveBy;
        const endsAt =
          commitment.travelBefore && t < leaveBy
            ? leaveBy
            : commitment.travelAfter && t < freeAt
              ? freeAt
              : commitment.protectedEndAt;
        return {
          block: {
            kind: "commitment",
            targetId: commitment.id,
            title: commitment.title,
            focusedMinutes: 0,
            reason: recommendation.explanation
          },
          endsAt,
          // A commitment somewhere leaves you there; its own return leg moves you on afterwards.
          ...(commitment.locationId && !beforeDeparture ? { locationId: commitment.locationId } : {})
        };
      }
      break;
    }
  }
  return {
    block: {
      kind: "gap",
      targetId: null,
      title: directive.title,
      focusedMinutes: 0,
      reason: recommendation.explanation,
      gapKind: "none"
    },
    endsAt: input.nextTransition(t)
  };
}

/** A stored sleep row for a plan the request never carried, so the simulated wake can be recorded. */
function storedSleep(plan: SleepPlan): WireState["sleepPlans"][number] {
  return {
    id: plan.id,
    plannedStartAt: plan.plannedStartAt.toISOString(),
    plannedWakeAt: plan.plannedWakeAt.toISOString(),
    desiredMinutes: plan.desiredMinutes,
    allowedMinutes: plan.allowedMinutes,
    sleepDeficitMinutes: plan.sleepDeficitMinutes,
    anchorDeviationMinutes: plan.anchorDeviationMinutes,
    hardErrors: plan.hardErrors,
    explanation: plan.explanation,
    status: "completed"
  };
}

/**
 * What a finished session changes in the candidate list — the same fields the portal writes when a
 * session ends: remaining effort less the focused minutes, last worked at the session's end, and
 * `done` when nothing remains, which in turn completes the dependencies that waited on it. Setup
 * minutes are wall-clock only and are not deducted.
 */
function deduct(actions: Action[], worked: RecommendationCandidate, endsAt: Date): Action[] {
  const focused = worked.recommendedMinutes ?? 0;
  const remaining = Math.max(0, worked.action.remainingMinutes - focused);
  const finished = remaining === 0;
  const advanced = actions.map((action) =>
    action.id === worked.action.id
      ? {
          ...action,
          remainingMinutes: remaining,
          lastWorkedAt: endsAt,
          ...(finished ? { status: "done" as const } : {})
        }
      : action
  );
  if (!finished) return advanced;
  const statusById = new Map(advanced.map((action) => [action.id, action.status]));
  return advanced.map((action) => {
    const dependencyIds = action.dependencyIds ?? [];
    // Waiting on a project or deliverable is not cleared by finishing an action in this day.
    if (action.dependenciesComplete || action.waitingOn?.length || !dependencyIds.includes(worked.action.id))
      return action;
    return { ...action, dependenciesComplete: dependencyIds.every((id) => statusById.get(id) === "done") };
  });
}

/** Two adjacent empty stretches with the same story are one stretch. */
function sameGap(a: DayPlanBlock, b: DayPlanBlock): boolean {
  return (
    a.kind === "gap" &&
    b.kind === "gap" &&
    a.gapKind === b.gapKind &&
    a.boundaryKind === b.boundaryKind &&
    a.title === b.title &&
    a.reason === b.reason
  );
}

/**
 * Units whose latest safe start falls inside the plan and which the plan does not reach in time.
 * Read from the forecasts and the blocks alone; the plan never moves a reservation to fix it. Starts
 * already behind us are the tier's business, not the plan's, so only starts still ahead are listed.
 */
function displacedUnits(
  schedule: PlanningResult,
  blocks: SimulatedBlock[],
  now: Date,
  through: Date,
  actions: Action[]
): DayPlan["displaced"] {
  const targetOfUnit = new Map(
    actions.map((action) => [action.forecastUnitId ?? action.id, action.deliverableId ?? action.id])
  );
  const found: DayPlan["displaced"] = [];
  for (const forecast of schedule.forecasts) {
    // An id in `unplacedUnitIds` presses at maximum: its expected minutes could not all be reserved,
    // so it is treated as though its latest safe start were `now`, whatever `latestSafeStarts` itself
    // holds for that id (`null`, or a placed date short only of its risk buffer). See
    // `ProjectForecast.unplacedUnitIds`.
    const unplaced = new Set(forecast.unplacedUnitIds ?? []);
    const unitIds = new Set([...Object.keys(forecast.latestSafeStarts), ...unplaced]);
    for (const unitId of unitIds) {
      const latestSafeStart = unplaced.has(unitId) ? now : forecast.latestSafeStarts[unitId];
      if (!latestSafeStart || latestSafeStart < now || latestSafeStart >= through) continue;
      const first = blocks.find((block) => block.unitId === unitId);
      if (first && new Date(first.startsAt) <= latestSafeStart) continue;
      found.push({
        targetId: targetOfUnit.get(unitId) ?? unitId,
        latestSafeStartAt: latestSafeStart.toISOString(),
        firstPlannedAt: first?.startsAt ?? null
      });
    }
  }
  return found.sort(
    (a, b) => a.latestSafeStartAt.localeCompare(b.latestSafeStartAt) || a.targetId.localeCompare(b.targetId)
  );
}

/** The stretch waivers still open at `t`: an accepted stretch ends at its `until`, mid-day included. */
function waivedAt(args: RecommendArguments, t: Date): Pick<RecommendArguments, "energyWaivedActionIds"> {
  if (!args.energyWaivedActionIds?.length) return {};
  const until = args.energyWaivedUntil;
  const open = until
    ? args.energyWaivedActionIds.filter((id) => until[id] === undefined || until[id]!.getTime() > t.getTime())
    : args.energyWaivedActionIds;
  return { energyWaivedActionIds: open };
}
