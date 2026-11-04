import type { CommitmentTimelineWire } from "./plan-forecast.js";

/**
 * The prompt rules (the leave by push design note, "The prompt rules (leave-by.ts)"): decides slots,
 * phases and suppression for every eligible leg, from the latest planning run's `commitmentTimelines`.
 * Pure and stateless across ticks — the worker's scheduler, the device snapshot and Now's On my way
 * button all read the same answer from the same inputs, so push, handheld and Now can never disagree
 * about when "now" is time to leave.
 */

/** The grace after `leaveBy` a missed tick still gets before a leg is dropped entirely. */
export const LEAVE_BY_GRACE_MINUTES = 5;

/** On my way, as stored on `currentSituation.underway`. */
export interface Underway {
  commitmentId: string;
  occurrenceStartsAt: string;
  fromLocationId: string;
  departedAt: string;
}

/** The one commitment fact this module needs beyond its timeline entry: is it still live, unmoved. */
export interface LeaveByCommitment {
  id: string;
  startsAt: string;
  status: string;
  title: string;
  locationName?: string;
  /** `remote` (`CONTEXT.md` "Attendance") means there is nowhere to leave for; absent means in person. */
  attendance?: string;
}

export interface LeaveBySituation {
  locationId: string | null;
  locationSetAt: string | null;
  /** Whether that location assertion is stale (`DEFAULT_LOCATION_STALE_AFTER_MINUTES`). */
  stale: boolean;
  underway: Underway | null;
}

export interface LeaveByPromptsInput {
  /** The latest planning result's `derivedState.commitmentTimelines`. */
  timelines: readonly CommitmentTimelineWire[];
  commitments: readonly LeaveByCommitment[];
  situation: LeaveBySituation;
  /**
   * Unambiguous device evidence of having left `originId` since `since`: one observation that matches another known place or lies beyond
   * `matchToleranceMeters(accuracy) + AWAY_MARGIN_METERS` from the origin, or two consecutive
   * observations that both fail to match the origin. The caller (the scheduler) owns the device
   * trail; this stays a predicate so the pure rules here need no observation rows of their own.
   */
  observationsAwayFromOrigin: (originId: string, since: Date) => boolean;
  leadMinutes: number;
  now: Date;
}

export interface LeaveByLeg {
  commitmentId: string;
  occurrenceStartsAt: string;
  title: string;
  /** When to leave — the entry's own `leaveBy` edge. */
  leaveBy: Date;
  /** `leaveBy − leadMinutes`. */
  remindAt: Date;
  typicalMinutes: number;
  allowingMinutes: number;
  originAssumed: boolean;
  phase: "upcoming" | "remind" | "leave" | "done";
  suppressedBy?: "arrived" | "underway" | "moved" | "cancelled";
}

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

/**
 * Every eligible leg for this tick: a timeline entry with `leaveBy` and a positive `journeyBefore`
 * A leg whose `leaveBy + LEAVE_BY_GRACE_MINUTES` has
 * already passed is dropped outright — its outbox rows, if any, expire on their own `expires_at`, so
 * there is nothing left here for a scheduler to decide.
 */
export function leaveByPrompts(input: LeaveByPromptsInput): LeaveByLeg[] {
  const { timelines, commitments, situation, observationsAwayFromOrigin, leadMinutes, now } = input;
  const commitmentsById = new Map(commitments.map((commitment) => [commitment.id, commitment]));
  const legs: LeaveByLeg[] = [];

  for (const timeline of timelines) {
    const journeyBefore = timeline.journeyBefore;
    if (!timeline.leaveBy || !journeyBefore || journeyBefore.minutes <= 0) continue;

    const leaveBy = new Date(timeline.leaveBy);
    const graceEnd = addMinutes(leaveBy, LEAVE_BY_GRACE_MINUTES);
    if (now.getTime() > graceEnd.getTime()) continue;
    const remindAt = addMinutes(leaveBy, -leadMinutes);

    const commitment = commitmentsById.get(timeline.id);
    // A remote commitment has no journey. The engine plans no leg to one, but a plan computed before
    // the commitment became remote may still carry one; leave-by never fires for it either way.
    if (commitment?.attendance === "remote") continue;
    let suppressedBy: LeaveByLeg["suppressedBy"];
    if (!commitment || commitment.status === "cancelled") suppressedBy = "cancelled";
    else if (commitment.startsAt !== timeline.startsAt) suppressedBy = "moved";

    const fromLocationId = journeyBefore.fromLocationId;
    const toLocationId = journeyBefore.toLocationId;
    const originAssumed = Boolean(journeyBefore.originAssumed);

    if (!suppressedBy && commitment) {
      const arrived = situation.locationId === toLocationId && !situation.stale;
      const underwayAsserted =
        situation.underway !== null &&
        situation.underway.commitmentId === commitment.id &&
        situation.underway.occurrenceStartsAt === commitment.startsAt;
      const assertedElsewhereSinceWindow =
        situation.locationId !== null &&
        situation.locationId !== fromLocationId &&
        situation.locationId !== toLocationId &&
        situation.locationSetAt !== null &&
        new Date(situation.locationSetAt).getTime() >= remindAt.getTime();
      const deviceEvidence = observationsAwayFromOrigin(fromLocationId, remindAt);
      const underway = underwayAsserted || assertedElsewhereSinceWindow || deviceEvidence;
      if (arrived) suppressedBy = "arrived";
      else if (underway) suppressedBy = "underway";
    }

    let phase: LeaveByLeg["phase"];
    if (suppressedBy === "arrived" || suppressedBy === "underway") phase = "done";
    else if (now.getTime() >= leaveBy.getTime()) phase = "leave";
    else if (now.getTime() >= remindAt.getTime()) phase = "remind";
    else phase = "upcoming";

    legs.push({
      commitmentId: timeline.id,
      occurrenceStartsAt: commitment?.startsAt ?? timeline.startsAt,
      title: commitment?.title ?? "",
      leaveBy,
      remindAt,
      typicalMinutes: journeyBefore.typicalMinutes,
      allowingMinutes: journeyBefore.minutes,
      originAssumed,
      phase,
      ...(suppressedBy ? { suppressedBy } : {})
    });
  }
  return legs;
}
