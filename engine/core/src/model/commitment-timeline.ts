import type { CommitmentTravelLeg, FixedCommitment } from "./types.js";

/**
 * The eight-edge account of a commitment's time, computed once and read everywhere: `commitmentProtection`,
 * `travelLeadMinutes` and `effectiveCommitmentEnd` in `types.ts` are projections of this function, and every
 * engine consumer that used to compute its own arithmetic over `setupBeforeMinutes`,
 * `transitionAfterMinutes`, `travelBeforeMinutes`, `travelAfterMinutes` or `trackedEndedAt` reads its
 * answer from here instead. See the commitment timeline design note, "The timeline".
 *
 * The ordering is setup, then travel, then the arrival margin, then the commitment, then transition,
 * then the leg home — the same ordering the design notes already states. This changes
 * no edge for a commitment without overtime.
 */
export interface CommitmentTimeline {
  /** When getting ready starts — the protected window's own start. */
  setupStartsAt: Date;
  /** When to leave, present only with a journey (`travelBeforeMinutes > 0`). */
  leaveBy?: Date;
  /** When to arrive: `startsAt` minus the arrival margin with a journey, else `startsAt` itself. */
  arriveBy: Date;
  startsAt: Date;
  endsAt: Date;
  /** The later of `endsAt` and any tracked overtime (`trackedEndedAt`). */
  effectiveEndsAt: Date;
  /** Whether the commitment ran later than its scheduled `endsAt`. */
  overtime: boolean;
  /** When the person is free of the commitment itself: `effectiveEndsAt` plus transition. */
  freeAt: Date;
  /** When the person is home, present only with a homeward leg (`travelAfterMinutes > 0`). */
  homeAt?: Date;
  /** The end of the protected window: `homeAt` when present, else `freeAt`. */
  protectedUntil: Date;
  /** The attached leg before the commitment, when the journey requires one. */
  travelBefore?: CommitmentTravelLeg;
  /** The attached leg home, when the journey requires one. */
  travelAfter?: CommitmentTravelLeg;
  /** `leaveBy` rests on an assumed journey time, not an estimate: say the travel time is a guess. */
  travelUnknown: boolean;
  /** `commitment.latenessMatters ?? true`. */
  latenessMatters: boolean;
}

/**
 * Computes a commitment's timeline: every edge in the commitment timeline design note's "The
 * timeline" table, as `Date`s. Missing buffers (`setupBeforeMinutes`, `transitionAfterMinutes`,
 * `travelBeforeMinutes`, `travelAfterMinutes`) count as 0. "With a journey" means
 * `travelBeforeMinutes > 0`; "with a homeward leg" means `travelAfterMinutes > 0` — the same tests
 * `commitmentProtection` used before this function existed.
 */
export function commitmentTimeline(commitment: FixedCommitment, arrivalMarginMinutes: number): CommitmentTimeline {
  const setupMinutes = commitment.setupBeforeMinutes ?? 0;
  const transitionMinutes = commitment.transitionAfterMinutes ?? 0;
  const travelBeforeMinutes = commitment.travelBeforeMinutes ?? 0;
  const travelAfterMinutes = commitment.travelAfterMinutes ?? 0;
  const hasJourney = travelBeforeMinutes > 0;
  const hasHomewardLeg = travelAfterMinutes > 0;

  const startsAt = commitment.startsAt;
  const endsAt = commitment.endsAt;

  const arriveBy = hasJourney ? new Date(startsAt.getTime() - arrivalMarginMinutes * 60_000) : startsAt;
  const leaveBy = hasJourney ? new Date(arriveBy.getTime() - travelBeforeMinutes * 60_000) : undefined;
  const setupStartsAt = new Date((leaveBy ?? startsAt).getTime() - setupMinutes * 60_000);

  const effectiveEndsAt =
    commitment.trackedEndedAt && commitment.trackedEndedAt > endsAt ? commitment.trackedEndedAt : endsAt;
  const overtime = effectiveEndsAt.getTime() > endsAt.getTime();

  const freeAt = new Date(effectiveEndsAt.getTime() + transitionMinutes * 60_000);
  const homeAt = hasHomewardLeg ? new Date(freeAt.getTime() + travelAfterMinutes * 60_000) : undefined;
  const protectedUntil = homeAt ?? freeAt;

  return {
    setupStartsAt,
    ...(leaveBy ? { leaveBy } : {}),
    arriveBy,
    startsAt,
    endsAt,
    effectiveEndsAt,
    overtime,
    freeAt,
    ...(homeAt ? { homeAt } : {}),
    protectedUntil,
    ...(hasJourney && commitment.travelBefore ? { travelBefore: commitment.travelBefore } : {}),
    ...(hasHomewardLeg && commitment.travelAfter ? { travelAfter: commitment.travelAfter } : {}),
    travelUnknown: hasJourney && commitment.travelBeforeUnknown === true,
    latenessMatters: commitment.latenessMatters ?? true
  };
}
