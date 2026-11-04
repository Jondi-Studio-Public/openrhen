import {
  DEFAULT_TIMEZONE,
  EMPTY_JOURNEY_INDEX,
  resolveJourney,
  resolveMode,
  type ConditionDefinition,
  type CurrentSituation,
  type JourneyCaution,
  type JourneyIndex,
  type JourneySource,
  type LocationRef,
  type TransportMode
} from "@openrhen/contracts";
import { ARRIVAL_MARGIN_MINUTES, isRemoteCommitment, type FixedCommitment } from "../model/types.js";
import { commitmentTimeline } from "../model/commitment-timeline.js";
import { ASSUMED_TRAVEL_MINUTES } from "./travel.js";

/**
 * Where you will be, later today (logic design §12, "Day plan"; plan §B).
 *
 * The day plan needs to know the situation at a future instant, and the only honest sources are the
 * things already fixed: located commitments, sleep at home, and the journeys between them. This
 * module turns those into a timeline of segments — at a place, or in transit to one — and answers
 * `at(t)` from it. It is pure and deterministic: no wall clock, no routing calls, anchors sorted by
 * time then id, so replaying it yields the same day.
 *
 * Travel is additive, not folded into the buffers: before a located commitment you get ready
 * (setup), travel, arrive with a small margin, then start; afterwards transition, then travel on. The
 * segments here reflect that arithmetic; extending the protected window to cover the legs is the
 * travel policy's job and is not done here.
 *
 * Only plan-required legs are projected. Where the plan says nothing — a commitment with no
 * location, no home to return to, no way to travel — you stay where you were. Energy is not projected
 * at all; the caller supplies it.
 */

const MINUTE = 60_000;
/** Stands in for the origin when the current place is unknown; it matches no stored pair or place. */
const UNKNOWN_ORIGIN_ID = "\u0000unknown-origin";
/**
 * The shortest stretch worth counting as usable between two anchors. The default after-anchor rule
 * takes the minimum session as a parameter; this is the fallback when the caller has none.
 */
export const RETURN_HOME_MIN_STAY_MINUTES = 15;

/** The journey store's own vocabulary. */
export type TravelLegSource = JourneySource | "default";

export interface TravelLeg {
  fromLocationId: string;
  toLocationId: string;
  /** Allowing: the planned figure. */
  minutes: number;
  /** Absent for a stored fallback or a symmetric assumption, which know the time but not the way. */
  mode?: TransportMode;
  source: TravelLegSource;
  /** The tier's median (or the live/fallback figure), for display beside the allowing minutes. */
  typicalMinutes: number;
  /** How many samples the figure rests on; 0 for a fallback, assumed or estimated journey. */
  sampleCount: number;
  /** Set when the whole day's projection started from an assumed origin, not a confirmed location. */
  originAssumed?: boolean;
}

export type PlannedLegReason = "commitment" | "sleep" | "return_home";

/** One journey the plan requires, placed in time. */
export interface PlannedLeg extends TravelLeg {
  departAt: Date;
  arriveAt: Date;
  reason: PlannedLegReason;
  /** The commitment or sleep plan the leg serves; absent for a return home between anchors. */
  anchorId?: string;
}

export interface SituationSegment {
  startsAt: Date;
  endsAt: Date;
  /** Null while in transit (you cannot work in the car) or when the location is simply unknown. */
  locationId: string | null;
  inTransitTo?: string;
}

/** The situation at a later instant: the live record with the location moved along the timeline. */
export interface ProjectedSituation extends CurrentSituation {
  inTransitTo?: string;
}

/**
 * What the after-anchor decision is made from. Everything is in minutes and every leg is already
 * resolved, so a chooser needs no access to the projection itself.
 */
export interface AfterAnchorChoiceInput {
  atLocationId: string;
  homeLocationId: string | undefined;
  nextLocationId: string;
  /** From the end of this anchor's protection to when the next leg must arrive. */
  gapMinutes: number;
  /** Staying: the one leg straight to the next anchor. */
  directMinutes: number;
  /** Going home first: the two legs, there and on. */
  toHomeMinutes: number;
  homeToNextMinutes: number;
  minSessionMinutes: number;
  /**
   * Whether any work is doable at each place with what you are carrying. Undefined means nobody
   * checked, which is treated as "yes" — the arithmetic alone then decides, as it did before anyone
   * asked. Minutes you cannot use are not minutes: staying somewhere nothing can be done is not a
   * larger stretch than going home, however much of it there is.
   */
  workableHere?: boolean;
  workableAtHome?: boolean;
}
export type AfterAnchorChoice = "stay" | "home";
export type AfterAnchorChooser = (input: AfterAnchorChoiceInput) => AfterAnchorChoice;

/**
 * The default rule: compare usable minutes. Staying leaves `gap − direct`; going home first leaves
 * `gap − toHome − homeToNext`. A stretch shorter than the minimum session is not usable, and neither
 * is a stretch somewhere nothing you carry can be worked on, so both count as nothing. The larger
 * wins; a tie goes home, because you have to return eventually and home grants the most; when neither
 * reaches a session you stay, since going home to do nothing costs a journey.
 */
export const chooseAfterAnchorByUsableMinutes: AfterAnchorChooser = (input) => {
  if (!input.homeLocationId || input.atLocationId === input.homeLocationId) return "stay";
  const usable = (minutes: number, workable: boolean | undefined) =>
    workable !== false && minutes >= input.minSessionMinutes ? minutes : 0;
  const stay = usable(input.gapMinutes - input.directMinutes, input.workableHere);
  const home = usable(input.gapMinutes - input.toHomeMinutes - input.homeToNextMinutes, input.workableAtHome);
  if (stay === 0 && home === 0) return "stay";
  return home >= stay ? "home" : "stay";
};

export interface ProjectSituationInput {
  from: {
    at: Date;
    situation: CurrentSituation;
    /**
     * The origin the projection plans from: the live location after the staleness rule, or the
     * assumed one when it has expired. Null only
     * when nothing at all is known — no assertion ever, and no home to fall back to.
     */
    resolvedLocationId: string | null;
    /** True when `resolvedLocationId` came from the stale-origin assumption, not a live location. */
    assumed?: boolean;
  };
  homeLocationId?: string;
  definitions: ConditionDefinition[];
  /** Protected commitments; only those carrying a `locationId` move you. */
  commitments: FixedCommitment[];
  /** Sleep happens at home, when a home is known. */
  sleepPlans: { id: string; plannedStartAt: Date; plannedWakeAt: Date }[];
  through: Date;
  /** Minutes to be at a place before a commitment starts, on top of travel time. Defaults to
   * `ARRIVAL_MARGIN_MINUTES` when absent — production always supplies `state.settings.arrivalMarginMinutes`. */
  arrivalMarginMinutes?: number;
  minSessionMinutes?: number;
  chooseAfterAnchor?: AfterAnchorChooser;
  /**
   * Whether anything the person could work on is doable at a place, given what they carry. Supplied
   * by the caller because the projection knows nothing about work; it only passes the answer to the
   * after-anchor chooser, which is the one rule that compares two places by what they are worth.
   */
  workableAt?: (locationId: string) => boolean;
  /** The one journey lookup's per-request index. Defaults to empty. */
  journeys?: JourneyIndex;
  /** The user's timezone, for deriving a departure's band. Defaults to `DEFAULT_TIMEZONE`. */
  timeZone?: string;
  userDefaultTransportMode?: TransportMode;
}

export interface ProjectedDay {
  /** Contiguous from `from.at` to `through`. */
  segments: SituationSegment[];
  legs: PlannedLeg[];
  at(t: Date): ProjectedSituation;
  /** Same precedence the timeline used; undefined when nothing is known about the journey. */
  travelBetween(fromLocationId: string | null, toLocationId: string): TravelLeg | undefined;
  /**
   * Commitment ids whose located anchor needed a journey (`here !== locationId`) but nothing could be
   * resolved for it — no live reading, no samples, no stored minutes, no coordinates
   * (the travel time model design note, "Unplaceable commitments", the `no_estimate` case).
   */
  noEstimateAnchorIds: ReadonlySet<string>;
}

interface Anchor {
  id: string;
  locationId: string;
  /** When you must be there. */
  arriveBy: Date;
  /** When its protection ends and you are free to move on. */
  freeAt: Date;
  reason: "commitment" | "sleep";
  /** `latenessMatters ?? true` for a commitment anchor; irrelevant (always normal) for sleep. */
  latenessMatters?: boolean;
  /** The commitment's own chosen mode, when it is a commitment anchor. */
  transportMode?: TransportMode;
}

export function projectSituation(input: ProjectSituationInput): ProjectedDay {
  const { from, homeLocationId, through } = input;
  const seed = from.situation;
  const modes = seed.transportModes;
  const minSession = input.minSessionMinutes ?? RETURN_HOME_MIN_STAY_MINUTES;
  const arrivalMarginMinutes = input.arrivalMarginMinutes ?? ARRIVAL_MARGIN_MINUTES;
  const choose = input.chooseAfterAnchor ?? chooseAfterAnchorByUsableMinutes;
  const journeys = input.journeys ?? EMPTY_JOURNEY_INDEX;
  const timeZone = input.timeZone ?? DEFAULT_TIMEZONE;
  // An unknown origin (no place at all) is not an assumed one: there is no place to confirm, so the legs
  // carry no `originAssumed` and nothing offers "Yes, I'm here".
  const originAssumed = from.assumed === true && from.resolvedLocationId !== null;
  const locations = new Map(
    input.definitions.filter((definition) => definition.kind === "location").map((item) => [item.id, item])
  );

  const locationRefOf = (id: string): LocationRef => {
    const definition = locations.get(id);
    return {
      id,
      ...(definition?.travelMinutes !== undefined ? { storedMinutes: definition.travelMinutes } : {}),
      ...(definition?.latitude !== undefined ? { latitude: definition.latitude } : {}),
      ...(definition?.longitude !== undefined ? { longitude: definition.longitude } : {})
    };
  };

  /** The rough departure the two-pass lookup starts from: the pair's any-time median, or the stored figure. */
  const roughMinutesFor = (a: string, b: string, mode: TransportMode): number => {
    const cell = journeys.cell(a, b, mode, null, null);
    const tierStats = cell ? (cell.own.count >= 3 ? cell.own : cell.pooled) : undefined;
    if (tierStats && tierStats.count >= 1) return tierStats.median;
    return locations.get(b)?.travelMinutes ?? 0;
  };

  const modeFor = (a: string, b: string, preferredMode?: TransportMode): TransportMode | undefined => {
    const placeUsualMode = locations.get(b)?.usualTransportMode;
    return resolveMode({
      ...(preferredMode !== undefined ? { commitmentMode: preferredMode } : {}),
      ...(placeUsualMode !== undefined ? { placeUsualMode } : {}),
      ...(input.userDefaultTransportMode !== undefined ? { userDefaultMode: input.userDefaultTransportMode } : {}),
      transportModes: modes,
      journeys,
      from: locationRefOf(a),
      to: locationRefOf(b)
    });
  };

  const travelBetween = (
    a: string | null,
    b: string,
    opts?: { caution?: JourneyCaution; arriveBy?: Date; preferredMode?: TransportMode; fromUnknown?: boolean }
  ): TravelLeg | undefined => {
    // An unknown origin has no measured pair, but the destination's own stored figure does not depend
    // on where you start (the journey lookup's fourth tier), so a commitment's approach may still use it.
    if ((a === null && !opts?.fromUnknown) || a === b || !locations.has(b)) return undefined;
    const origin = a ?? UNKNOWN_ORIGIN_ID;
    a = origin;
    const mode = modeFor(a, b, opts?.preferredMode);
    if (!mode) return undefined;
    const caution = opts?.caution ?? "normal";
    const arriveBy = opts?.arriveBy ?? from.at;
    // Two passes, never more: a rough departure to
    // find a first minutes figure, then the departure that figure actually implies.
    const roughDepartAt = new Date(arriveBy.getTime() - roughMinutesFor(a, b, mode) * MINUTE);
    const fromRef = locationRefOf(a);
    const toRef = locationRefOf(b);
    const journeyArgs = {
      journeys,
      from: fromRef,
      to: toRef,
      mode,
      now: from.at,
      timeZone,
      caution,
      ...(homeLocationId ? { homeLocationId } : {})
    };
    const first = resolveJourney({ ...journeyArgs, departAt: roughDepartAt });
    if (!first) return undefined;
    const finalDepartAt = new Date(arriveBy.getTime() - first.minutes * MINUTE);
    const journey = resolveJourney({ ...journeyArgs, departAt: finalDepartAt }) ?? first;
    return {
      fromLocationId: a === UNKNOWN_ORIGIN_ID ? "" : a,
      toLocationId: b,
      minutes: journey.minutes,
      mode: journey.mode,
      source: journey.source,
      typicalMinutes: journey.typicalMinutes,
      sampleCount: journey.sampleCount
    };
  };
  const minutesBetween = (a: string | null, b: string) => travelBetween(a, b)?.minutes ?? 0;

  // Every anchor whose `reason` is "sleep" is forced home below (never chosen by the usable-minutes
  // trade-off — you have to be home to sleep, whatever the arithmetic says about staying put). That is
  // what gives the day's last away-from-home commitment a return leg whenever a sleep plan for tonight
  // is among the anchors — which the caller almost always supplies: the engine's own forecast pass
  // (`engine.ts`, `calculatePlanAndForecast`'s second `projectDay` call, the one whose output feeds
  // `derivedState.commitmentTimelines`) always derives and passes tonight's sleep plan whenever a home
  // location is configured. When no sleep plan is supplied at all — sleep tracking off, or a caller
  // that only wants the commitments themselves — this module still has no opinion of its own that the
  // day must end at home; a synthetic "go home for the night regardless" anchor would contradict this
  // module's own documented rule (only plan-required legs are projected; where the plan says nothing,
  // you stay where you were — see "stays at the shops…" below, which relies on exactly that with no
  // sleep plan given at all).
  const anchors: Anchor[] = [
    ...input.commitments.flatMap((commitment): Anchor[] =>
      // A remote commitment is nowhere: no anchor, so no leg to it and none home from it.
      commitment.locationId && locations.has(commitment.locationId) && !isRemoteCommitment(commitment)
        ? [
            {
              id: commitment.id,
              locationId: commitment.locationId,
              arriveBy: new Date(commitment.startsAt.getTime() - arrivalMarginMinutes * MINUTE),
              // `freeAt` needs no legs, so the timeline is the source here too (the margin passed
              // never affects it — see `commitment-timeline.ts`'s "What needs legs"). Tracked overtime
              // (`trackedEndedAt`) pushes this later than the bare scheduled end, which is what keeps
              // the journey home from being projected while the shift is still actually running.
              freeAt: commitmentTimeline(commitment, arrivalMarginMinutes).freeAt,
              reason: "commitment",
              latenessMatters: commitment.latenessMatters ?? true,
              ...(commitment.transportMode ? { transportMode: commitment.transportMode } : {})
            }
          ]
        : []
    ),
    ...(homeLocationId && locations.has(homeLocationId)
      ? input.sleepPlans.map((plan): Anchor => ({
          id: plan.id,
          locationId: homeLocationId,
          arriveBy: plan.plannedStartAt,
          freeAt: plan.plannedWakeAt,
          reason: "sleep"
        }))
      : [])
  ]
    .filter((anchor) => {
      if (anchor.freeAt > from.at) return true;
      // Free-at has passed: only a commitment's own journey home can still keep it live, and only for
      // as long as that journey could still be under way — until `freeAt` plus the leg home — and only
      // while nothing has said the person got there (or anywhere else) without saying so. Without this
      // the leg vanished the instant `freeAt` passed and the drive home was counted as free time;
      // the risk this accepts is the converse — an unasserted arrival keeps the leg for at most one
      // leg's worth of minutes past when it was actually over (see the plan's Risks).
      if (anchor.reason !== "commitment" || !homeLocationId) return false;
      const homeMinutes = minutesBetween(anchor.locationId, homeLocationId);
      if (!homeMinutes) return false;
      const retainedUntil = new Date(anchor.freeAt.getTime() + homeMinutes * MINUTE);
      if (from.at >= retainedUntil) return false;
      const assertedElsewhereSince =
        seed.locationSetAt !== undefined &&
        new Date(seed.locationSetAt) >= anchor.freeAt &&
        from.resolvedLocationId !== anchor.locationId;
      return !assertedElsewhereSince;
    })
    .sort((x, y) => x.arriveBy.getTime() - y.arriveBy.getTime() || x.id.localeCompare(y.id));

  const segments: SituationSegment[] = [];
  const legs: PlannedLeg[] = [];
  const noEstimateAnchorIds = new Set<string>();
  let at = from.at;
  let here: string | null = from.resolvedLocationId;
  const stay = (until: Date) => {
    const last = segments[segments.length - 1];
    if (until > at) {
      // Staying on somewhere you already were is one segment, not two.
      if (last && !last.inTransitTo && last.locationId === here && last.endsAt.getTime() === at.getTime())
        last.endsAt = until;
      else segments.push({ startsAt: at, endsAt: until, locationId: here });
    }
    at = until;
  };
  const travel = (
    to: string,
    arriveBy: Date,
    reason: PlannedLegReason,
    anchorId?: string,
    caution: JourneyCaution = "normal",
    preferredMode?: TransportMode
  ) => {
    if (here === to) return;
    let leg = travelBetween(here, to, {
      caution,
      arriveBy,
      fromUnknown: reason === "commitment",
      ...(preferredMode ? { preferredMode } : {})
    });
    // A located commitment nothing can give a journey for still takes time to reach: plan the engine's
    // assumed figure, flagged, rather than none (unknown travel is not zero). The commitment's timeline
    // reads the same figure, so the projection and the protected window agree.
    if (!leg && reason === "commitment" && anchorId) {
      noEstimateAnchorIds.add(anchorId);
      leg = {
        fromLocationId: here ?? "",
        toLocationId: to,
        minutes: ASSUMED_TRAVEL_MINUTES,
        source: "default",
        typicalMinutes: ASSUMED_TRAVEL_MINUTES,
        sampleCount: 0
      };
    }
    const minutes = leg?.minutes ?? 0;
    const departAt = new Date(Math.max(at.getTime(), arriveBy.getTime() - minutes * MINUTE));
    const arriveAt = new Date(departAt.getTime() + minutes * MINUTE);
    stay(departAt);
    if (arriveAt > departAt) segments.push({ startsAt: departAt, endsAt: arriveAt, locationId: null, inTransitTo: to });
    if (leg)
      legs.push({
        ...leg,
        departAt,
        arriveAt,
        reason,
        ...(anchorId ? { anchorId } : {}),
        ...(originAssumed ? { originAssumed: true } : {})
      });
    at = arriveAt;
    here = to;
  };

  for (const [index, anchor] of anchors.entries()) {
    const anchorCaution: JourneyCaution =
      anchor.reason === "sleep" || anchor.latenessMatters === false ? "normal" : "high";
    travel(anchor.locationId, anchor.arriveBy, anchor.reason, anchor.id, anchorCaution, anchor.transportMode);
    stay(new Date(Math.max(at.getTime(), anchor.freeAt.getTime())));
    const next = anchors[index + 1];
    if (!next || next.locationId === here || !homeLocationId || here === homeLocationId || !here) continue;
    // Sleep always happens at home: whether to go home before it is not the usable-minutes trade-off
    // the chooser makes between two commitments elsewhere — it is mandatory. Forcing it here, rather
    // than leaving it to the chooser, is also what makes the leg land with `reason: "return_home"`
    // (picked up by `withTravelLegs`, engine.ts) instead of the "sleep" reason the anchor's own
    // `travel()` call below would otherwise record.
    if (next.reason === "sleep") {
      travel(homeLocationId, at, "return_home");
      continue;
    }
    const gapMinutes = (next.arriveBy.getTime() - at.getTime()) / MINUTE;
    // The onward leg to a commitment is planned at the assumed figure when nothing gives a journey
    // (see `travel` above), so the choice weighs the same figure rather than a free trip.
    const onwardMinutes = (origin: string) =>
      origin === next.locationId
        ? 0
        : (travelBetween(origin, next.locationId)?.minutes ??
          (next.reason === "commitment" ? ASSUMED_TRAVEL_MINUTES : 0));
    const choice = choose({
      atLocationId: here,
      homeLocationId,
      nextLocationId: next.locationId,
      gapMinutes,
      directMinutes: onwardMinutes(here),
      toHomeMinutes: minutesBetween(here, homeLocationId),
      homeToNextMinutes: onwardMinutes(homeLocationId),
      minSessionMinutes: minSession,
      ...(input.workableAt
        ? { workableHere: input.workableAt(here), workableAtHome: input.workableAt(homeLocationId) }
        : {})
    });
    if (choice === "home") travel(homeLocationId, at, "return_home");
  }
  stay(through);
  if (!segments.length) segments.push({ startsAt: from.at, endsAt: through, locationId: here });
  // Segments past the bound are cut off; the anchors that produced them still shaped what came before.
  const bounded = segments
    .filter((segment) => segment.startsAt < through)
    .map((segment) => (segment.endsAt > through ? { ...segment, endsAt: through } : segment));
  if (!bounded.length) bounded.push({ startsAt: from.at, endsAt: through, locationId: from.resolvedLocationId });

  const situationAt = (t: Date): ProjectedSituation => {
    const segment =
      bounded.find((entry) => t >= entry.startsAt && t < entry.endsAt) ??
      (t < from.at ? bounded[0]! : bounded[bounded.length - 1]!);
    const sameAsSeed = segment.locationId !== null && segment.locationId === from.resolvedLocationId;
    return {
      locationId: segment.locationId,
      locationSetAt: t.toISOString(),
      // Overrides are momentary and vanish on a move; carrying and modes travel with you.
      overrides: sameAsSeed ? seed.overrides : {},
      carrying: seed.carrying,
      transportModes: seed.transportModes,
      // Travel off travels with you; it is a policy choice, not a fact about the seed place.
      travelOff: seed.travelOff,
      // Measurements are from the seed place only; anywhere else the matcher falls back to stored figures.
      travel: sameAsSeed ? seed.travel : {},
      ...(sameAsSeed && seed.travelRefreshedAt ? { travelRefreshedAt: seed.travelRefreshedAt } : {}),
      ...(segment.inTransitTo ? { inTransitTo: segment.inTransitTo } : {})
    };
  };

  return { segments: bounded, legs, at: situationAt, travelBetween, noEstimateAnchorIds };
}
