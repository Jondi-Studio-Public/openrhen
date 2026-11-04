import type { CurrentDirective, PlanForecastRequest, PrepPace } from "@openrhen/contracts";
import type { FixedCommitment } from "../model/types.js";
import { commitmentTimeline } from "../model/commitment-timeline.js";

const MINUTE = 60_000;

/** A routine step still not done, in the sense `beforeStepsComplete` (model/types.ts) already uses. */
const INCOMPLETE = new Set(["pending", "doing", "blocked"]);

type WireRoutineStep = PlanForecastRequest["state"]["routineSteps"][number];
type WireActiveSession = PlanForecastRequest["state"]["activeSession"];

/**
 * Whether getting ready for the next fixed commitment is keeping pace with the clock — computed once
 * here so the CLI's `status` can show the same verdict the Now page does, rather than each surface
 * re-deriving the arithmetic (§ design note: "compute in the engine, not only in the page").
 *
 * Reported for at most one commitment: the one whose preparation is currently the live directive (a
 * `routine_step` directive naming one of its before-phase steps), or — when nothing is directing a
 * step right now — the nearest commitment that has not yet ended whose earliest pending before-phase
 * step is already due (`scheduledStartAt <= now`). A commitment nobody has started preparing for yet,
 * or one with no pending before-phase steps at all, reports nothing.
 *
 * `requiredMinutes`/`projectedArriveAt` come from a forward simulation
 * the candidate's remaining (`pending`, `doing`,
 * `blocked`) before-phase steps run from `now`, one at a time in placement order (`scheduledStartAt`,
 * then `sequence`). Each starts no earlier than every prerequisite's hands-on end plus its wait — a
 * completed prerequisite's wait counts from its own `completedAt`. A `doing` step's remaining time is
 * its hands-on minutes less what the open session on it (`activeSession` targeting that step) has
 * already run, floored at zero; with no open session it counts in full. `readyAt` is the later of the
 * last hands-on end and every wait (simulated or completed) that has not already elapsed by then.
 * `projectedArriveAt = readyAt + (arriveBy − setupStartsAt)` — setup plus the journey, both read once
 * from the commitment's own timeline, never recomputed here (`test/architecture/commitment-edges.test.ts`).
 * With no waits and no `doing` step this reproduces the old plain sum exactly.
 */
export function computePrepPace(args: {
  commitments: FixedCommitment[];
  routineSteps: WireRoutineStep[];
  now: Date;
  arrivalMarginMinutes: number;
  currentDirective: CurrentDirective;
  activeSession?: WireActiveSession;
}): PrepPace | undefined {
  const { commitments, routineSteps, now, arrivalMarginMinutes, currentDirective, activeSession } = args;
  const commitmentById = new Map(commitments.map((item) => [item.id, item]));
  const candidateId = resolveCandidateCommitmentId({ commitments, routineSteps, now, currentDirective });
  if (!candidateId) return undefined;
  const commitment = commitmentById.get(candidateId);
  if (!commitment) return undefined;

  const beforeSteps = routineSteps.filter((step) => step.commitmentId === candidateId && step.phase === "before");
  const readyAt = simulatePrepReadyAt(beforeSteps, now, activeSession);

  const timeline = commitmentTimeline(commitment, arrivalMarginMinutes);
  const setupAndTravelMs = timeline.arriveBy.getTime() - timeline.setupStartsAt.getTime();
  const projectedArriveAt = new Date(readyAt.getTime() + setupAndTravelMs);
  const requiredMinutes = Math.round((projectedArriveAt.getTime() - now.getTime()) / MINUTE);

  const boundaryAt = timeline.arriveBy;
  const availableMinutes = Math.round((boundaryAt.getTime() - now.getTime()) / MINUTE);

  const minutesBehind = Math.max(0, requiredMinutes - availableMinutes);
  const status: PrepPace["status"] =
    minutesBehind > 0 ? "behind" : availableMinutes - requiredMinutes < 5 ? "tight" : "on_track";

  // Late means arriving after the commitment starts; arriving inside the arrival margin only eats
  // the buffer, which minutesBehind already reports.
  const projectedLateMinutes = Math.max(
    0,
    Math.round((projectedArriveAt.getTime() - timeline.startsAt.getTime()) / MINUTE)
  );

  return {
    commitmentId: commitment.id,
    commitmentTitle: commitment.title ?? "Commitment",
    commitmentStartsAt: commitment.startsAt.toISOString(),
    requiredMinutes,
    availableMinutes,
    minutesBehind,
    status,
    projectedArriveAt: projectedArriveAt.toISOString(),
    projectedLateMinutes
  };
}

/**
 * The forward simulation's own answer: the instant every remaining before-phase step (and every wait
 * it owes) has run its course, starting from `now`. Non-remaining steps (`completed`, `skipped`,
 * `cancelled`) take no simulated time of their own, but a `completed` one with a `completedAt` still
 * anchors its own wait, since a remaining dependent may need to wait for it.
 */
function simulatePrepReadyAt(steps: WireRoutineStep[], now: Date, activeSession?: WireActiveSession): Date {
  // Every step's own wait-end, once known — from a completed prerequisite's `completedAt`, or from a
  // remaining step's own simulated hands-on end. Read by a dependent to bound its own start.
  const waitEndById = new Map<string, Date>();

  for (const step of steps) {
    if (step.status === "completed" && step.completedAt) {
      const completedAt = new Date(step.completedAt);
      waitEndById.set(step.id, addMinutes(completedAt, step.waitAfterMinutes ?? 0));
    }
  }

  const remaining = steps
    .filter((step) => INCOMPLETE.has(step.status))
    .slice()
    .sort((a, b) => {
      const start = (a.scheduledStartAt ?? "").localeCompare(b.scheduledStartAt ?? "");
      return start !== 0 ? start : a.sequence - b.sequence;
    });

  let cursor = now;
  let lastEnd = now;
  const candidateReadyAts: Date[] = [];

  for (const step of remaining) {
    const prerequisiteBounds = step.dependencyIds
      .map((id) => waitEndById.get(id))
      .filter((bound): bound is Date => bound !== undefined);
    const start = prerequisiteBounds.reduce((latest, bound) => later(latest, bound), cursor);

    const elapsedMinutes =
      step.status === "doing" &&
      activeSession &&
      activeSession.targetType === "routine_step" &&
      activeSession.targetId === step.id
        ? Math.floor(activeSession.activeElapsedSeconds / 60)
        : 0;
    const remainingMinutes = Math.max(0, step.durationMinutes - elapsedMinutes);

    const end = addMinutes(start, remainingMinutes);
    const waitEnd = addMinutes(end, step.waitAfterMinutes ?? 0);
    waitEndById.set(step.id, waitEnd);
    candidateReadyAts.push(waitEnd);

    cursor = end;
    lastEnd = end;
  }

  return candidateReadyAts.reduce((latest, waitEnd) => later(latest, waitEnd), lastEnd);
}

const addMinutes = (date: Date, minutes: number): Date => new Date(date.getTime() + minutes * MINUTE);
const later = (a: Date, b: Date): Date => (a.getTime() >= b.getTime() ? a : b);

/**
 * The one commitment this result is about, or null when no commitment's preparation has actually
 * started. A step directive names it directly; otherwise the nearest unfinished commitment counts
 * only if its earliest pending before-phase step's own scheduled start has already arrived.
 */
function resolveCandidateCommitmentId(args: {
  commitments: FixedCommitment[];
  routineSteps: WireRoutineStep[];
  now: Date;
  currentDirective: CurrentDirective;
}): string | null {
  const { commitments, routineSteps, now, currentDirective } = args;
  if (currentDirective.kind === "routine_step") {
    const step = routineSteps.find((item) => item.id === currentDirective.targetId);
    if (step && step.phase === "before" && commitments.some((item) => item.id === step.commitmentId))
      return step.commitmentId ?? null;
  }
  const next = commitments
    .filter((item) => item.endsAt > now)
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())[0];
  if (!next) return null;
  const pendingBefore = routineSteps.filter(
    (step) => step.commitmentId === next.id && step.phase === "before" && INCOMPLETE.has(step.status)
  );
  if (pendingBefore.length === 0) return null;
  const earliestStartMs = pendingBefore
    .map((step) => (step.scheduledStartAt ? new Date(step.scheduledStartAt).getTime() : undefined))
    .filter((value): value is number => value !== undefined)
    .sort((a, b) => a - b)[0];
  if (earliestStartMs === undefined || earliestStartMs > now.getTime()) return null;
  return next.id;
}
