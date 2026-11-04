import type { ConditionReach, TravelSource } from "@openrhen/contracts";
import { currentCompatibleWindow, slotFitsAction } from "../scheduling/slots.js";
import {
  commitmentProtection,
  type Action,
  type FixedCommitment,
  type TripPlan,
  type TripRefusal
} from "../model/types.js";
import type { TravelLeg } from "./situation-projection.js";

/**
 * The travel policy (logic design §4 trip eligibility, §9 travel cost).
 *
 * Work that needs another place is not impossible, it is a journey. The engine may direct one, and
 * the only question it asks is whether the journey is *avoidable*: if the projected day already puts
 * you at or near that place later, inside the deadline's slack, then going now buys nothing and the
 * ranking is charged for it; if it does not, the journey is unavoidable and costs nothing beyond the
 * wall-clock minutes it actually takes. There is deliberately no payback ratio and no minimum-session
 * gate on trips — travel is a cost to be minimised by timing, never a verdict on whether the work is
 * worth doing.
 */

const MINUTE = 60_000;
/** A fully avoidable hour of travel costs as much as switching projects twice. §9 component. */
export const TRAVEL_COST_WEIGHT = 15;
/** Avoidable travel saturates at an hour; beyond it the cost stops discriminating. */
export const TRAVEL_COST_HORIZON_MINUTES = 60;
/**
 * What an unknown journey is assumed to take, in minutes. A place with no stored figure, coordinates
 * or samples is not zero minutes away; this is a conservative guess (there is no travel-time setting
 * to read), always labelled as assumed. Used only when no better figure, such as the outbound time, exists.
 */
export const ASSUMED_TRAVEL_MINUTES = 30;
/** At most this many errands at one destination share a single journey (§9 bundling). */
export const TRIP_BUNDLE_LIMIT = 3;

/** What the projection tells the ranking. Supplied by the engine; absent in a request with no places. */
export interface TravelPolicy {
  /** Journey between two places, by the same precedence the projection resolved its own legs with. */
  travelBetween(fromLocationId: string | null, toLocationId: string): TravelLeg | undefined;
  /**
   * Where the projected day says you will be later, one entry per stay. These are the alternatives a
   * journey now is measured against; a stay you are already inside is not one of them.
   */
  presences: Array<{ locationId: string; startsAt: Date; endsAt: Date }>;
  /**
   * Everything that pins the day down, sleep included, with its protection already extended by the
   * legs. A trip is bounded by whichever comes first: you have to be free by then, and where it is
   * decides whether the journey back counts at all.
   */
  anchors: FixedCommitment[];
}

/** The policy resolved for one instant: the same object plus what `now` makes of it. */
export interface TripContext extends TravelPolicy {
  /** The first anchor after `now` that pins you somewhere, with its protection already extended. */
  nextAnchor: { protectedStartAt: Date; locationId?: string } | null;
}

/**
 * The next commitment that bounds a trip: whichever protects first, reading the extended window so a
 * journey to it is already accounted for. Its location, when it has one, is where a trip has to
 * travel on to — and when that is the trip's own destination, going there early costs nothing.
 */
export function nextAnchorAfter(
  now: Date,
  commitments: FixedCommitment[],
  arrivalMarginMinutes: number
): TripContext["nextAnchor"] {
  let best: { commitment: FixedCommitment; protectedStartAt: Date } | null = null;
  for (const commitment of commitments) {
    const { startsAt } = commitmentProtection(commitment, arrivalMarginMinutes);
    if (startsAt <= now) continue;
    if (
      !best ||
      startsAt.getTime() < best.protectedStartAt.getTime() ||
      (startsAt.getTime() === best.protectedStartAt.getTime() && commitment.id < best.commitment.id)
    )
      best = { commitment, protectedStartAt: startsAt };
  }
  if (!best) return null;
  return {
    protectedStartAt: best.protectedStartAt,
    ...(best.commitment.locationId ? { locationId: best.commitment.locationId } : {})
  };
}

export interface TripEvaluationInput {
  now: Date;
  action: Action;
  slots: Parameters<typeof currentCompatibleWindow>[0]["slots"];
  /** The daily horizon or the exact horizon, whichever binds first — the same bound in-place work uses. */
  boundedHorizon: Date;
  horizonEnd: Date;
  /** Risk-adjusted remaining effort, so a trip is bounded exactly as an in-place session is. */
  riskRemaining: number;
  /** Where the ranking is being made from; null when the location is unknown. */
  originLocationId: string | null;
  /** The destination and the journey to it, as the context matcher resolved them. */
  reach: ConditionReach | undefined;
  /** The earliest of latest-safe-start, latest useful start and deadline; the slack a deferral has. */
  slackUntil: Date | undefined;
  context: TripContext;
}

/**
 * Whether this work can be done by travelling, and what the journey is worth. A destination window
 * that fits the minimum session is the whole eligibility test: no ratio, no floor beyond the session
 * the work already declares.
 */
export function evaluateTrip(input: TripEvaluationInput): {
  trip?: TripPlan;
  tripReason?: TripRefusal;
  /** The compatible window at the destination, so the session can be stated from where it happens. */
  window?: ReturnType<typeof currentCompatibleWindow>;
} {
  const { action, context, now, reach } = input;
  // No way to get there is not a trip that is too short; it is not a trip at all.
  if (!reach) return { tripReason: "no_mode" };
  const destination = reach.locationId;
  const travelMinutes = Math.round(reach.travelMinutes);
  const anchor = context.nextAnchor;
  // Going early to a place the plan already sends you to is free: the leg is plan-required and is
  // already protected as that commitment's own travel phase (§9 hard precedence).
  const planRequired = anchor?.locationId === destination;
  const returnLeg =
    anchor && anchor.locationId && anchor.locationId !== destination
      ? context.travelBetween(destination, anchor.locationId)
      : undefined;
  // A journey on that is needed but unknown is not zero: assume it takes as long as the way out
  // (never less than the way out says), else the engine's assumed figure.
  const returnNeeded = Boolean(anchor?.locationId) && anchor!.locationId !== destination;
  const returnUnknown = returnNeeded && !returnLeg;
  const returnMinutes = returnLeg ? returnLeg.minutes : returnUnknown ? travelMinutes || ASSUMED_TRAVEL_MINUTES : 0;
  const bound = anchor
    ? Math.min(input.boundedHorizon.getTime(), anchor.protectedStartAt.getTime() - returnMinutes * MINUTE)
    : input.boundedHorizon.getTime();
  const window = currentCompatibleWindow({
    now: new Date(now.getTime() + travelMinutes * MINUTE),
    horizonEnd: new Date(bound),
    action,
    slots: input.slots
  });
  const session = Math.min(input.riskRemaining, action.maximumSessionMinutes, window.minutes);
  if (session < action.minimumSessionMinutes) return { tripReason: "no_window" };
  if (action.splittable === false && window.minutes < input.riskRemaining) return { tripReason: "no_window" };

  const costMinutes = planRequired ? 0 : travelMinutes + Math.round(returnMinutes);
  const opportunityMinutes = costMinutes
    ? cheapestFutureOpportunityMinutes({ ...input, destination, window: { minutes: window.minutes } })
    : null;
  const leg = context.travelBetween(input.originLocationId, destination);
  return {
    window,
    trip: {
      toLocationId: destination,
      travelMinutes,
      returnMinutes: Math.round(returnMinutes),
      ...(returnUnknown ? { returnUnknown: true } : {}),
      ...((reach.mode ?? leg?.mode) ? { mode: (reach.mode ?? leg?.mode)! } : {}),
      source: travelSourceOf(leg, reach.mode !== undefined),
      bundleSize: 1,
      windowMinutes: window.minutes,
      costMinutes,
      opportunityMinutes,
      avoidableMinutes: avoidableMinutes(costMinutes, 1, opportunityMinutes)
    }
  };
}

/** Round-trip minutes a later moment would have saved, after the bundle has shared the one journey. */
export function avoidableMinutes(costMinutes: number, bundleSize: number, opportunityMinutes: number | null): number {
  if (opportunityMinutes === null) return 0;
  return Math.max(0, Math.round(costMinutes / Math.max(1, bundleSize)) - opportunityMinutes);
}

/** The §9 component: −15 at a full avoidable hour, scaled linearly, zero when nothing is avoidable. */
export function travelCostOf(trip: TripPlan | undefined): number {
  if (!trip || trip.avoidableMinutes <= 0) return 0;
  return -Math.round(TRAVEL_COST_WEIGHT * Math.min(1, trip.avoidableMinutes / TRAVEL_COST_HORIZON_MINUTES));
}

/**
 * The smallest extra travel among the later moments the projection already puts you at or near the
 * destination, inside this work's slack and with room for a session. A stay at the destination costs
 * nothing extra; a stay near it costs the detour. Null when there is no such moment at all, which is
 * what makes travelling now unavoidable rather than merely early.
 */
export function cheapestFutureOpportunityMinutes(
  input: Omit<TripEvaluationInput, "reach"> & { destination: string; window: { minutes: number } }
): number | null {
  const { action, context, destination } = input;
  let best: number | null = null;
  for (const presence of context.presences) {
    if (presence.startsAt <= input.now) continue;
    if (input.slackUntil && presence.startsAt > input.slackUntil) continue;
    const detour =
      presence.locationId === destination ? 0 : context.travelBetween(presence.locationId, destination)?.minutes;
    if (detour === undefined) continue;
    if (best !== null && detour >= best) continue;
    const from = new Date(presence.startsAt.getTime() + detour * MINUTE);
    const until = new Date(Math.min(presence.endsAt.getTime(), input.horizonEnd.getTime()));
    // A stay usually begins inside the protection of whatever put you there — the arrival margin, the
    // commitment itself — so the question is not what is open at its first instant but whether
    // anything opens during it at all.
    const opens = input.slots.find(
      (slot) => slot.endsAt > from && slot.startsAt < until && slotFitsAction(slot, action)
    );
    if (!opens) continue;
    const window = currentCompatibleWindow({
      now: new Date(Math.max(from.getTime(), opens.startsAt.getTime())),
      horizonEnd: until,
      action,
      slots: input.slots
    });
    const session = Math.min(input.riskRemaining, action.maximumSessionMinutes, window.minutes);
    if (session < action.minimumSessionMinutes) continue;
    if (action.splittable === false && window.minutes < input.riskRemaining) continue;
    best = detour;
    if (best === 0) break;
  }
  return best;
}

/** How well the journey is known, in the words the directive uses. */
function travelSourceOf(leg: TravelLeg | undefined, measuredReach: boolean): TravelSource {
  // The journey store's vocabulary is a strict subset of the wire's `TravelSource`, so a leg's own
  // source passes straight through. With no projection to ask, the matcher's own precedence says it:
  // a mode means a journey was resolved (`live`), its absence a stored fallback.
  return leg?.source ?? (measuredReach ? "live" : "fallback");
}
