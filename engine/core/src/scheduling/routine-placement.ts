import type { CommitmentTimeline } from "../model/commitment-timeline.js";
import { zonedDateTime } from "@openrhen/contracts";
import { addLocalDays, localDate } from "../recurrence/recurrence.js";

/**
 * Pure routine-step placer. Reads every
 * commitment edge from `CommitmentTimeline` — never `setupBeforeMinutes`, `transitionAfterMinutes`,
 * `travelBeforeMinutes`, `travelAfterMinutes` or `trackedEndedAt` directly
 * (`test/architecture/commitment-edges.test.ts`). Nothing calls this yet; task 005 wires it into the
 * engine's two projection passes.
 */

const MINUTE_MS = 60_000;

export type PlacementStepStatus = "pending" | "doing" | "completed" | "blocked" | "skipped" | "cancelled";
export type PlacementStepPhase = "before" | "after";
export type PlacementTimingRule = "contiguous" | "flexible";

/** One routine step as the placer sees it, chain-agnostic. */
export interface PlacementStep {
  id: string;
  sequence: number;
  /** Hands-on minutes. */
  durationMinutes: number;
  status: PlacementStepStatus;
  phase: PlacementStepPhase;
  timingRule: PlacementTimingRule;
  /** Flexible steps only: how early the step may run, minutes before the chain's own start. */
  maxLeadMinutes?: number;
  /** Minutes of idle time after hands-on ends before whatever follows may start. Absent means 0. */
  waitAfterMinutes?: number;
  /** Before phase: minutes before the anchor's start. Forward chains: minutes of the chain's anchor. */
  mustStartByMinutes?: number;
  /** Band ids this flexible commitment before-step prefers, in no particular order. */
  preferredBands?: string[];
  /** Ids of steps this one depends on (same chain). */
  dependencyIds: string[];
  contexts: string[];
  completedAt?: Date;
  /** Stored placement; only meaningful for a non-pending step (the placer's own input, never output). */
  scheduledStartAt?: Date;
  scheduledEndAt?: Date;
  /** A wake step dropped by `replacesWakeRoutine` truncation: takes no time, never placed. */
  skip?: boolean;
}

export interface TimeBand {
  id: string;
  name: string;
  /** Local wall time, "HH:MM". */
  start: string;
  /** Local wall time, "HH:MM". No band crosses midnight: `start < end`. */
  end: string;
}

export interface CommitmentChain {
  kind: "commitment";
  anchorId: string;
  timeline: CommitmentTimeline;
  /** The commitment's own place, deciding which after-steps are venue steps (Decisions: Anchors). */
  locationId?: string;
  steps: PlacementStep[];
}

export interface BedtimeChain {
  kind: "bedtime";
  anchorId: string;
  /** The night's own planned start — the boundary the before-phase chain ends at. */
  endsAt: Date;
  steps: PlacementStep[];
}

export interface WakeChain {
  kind: "wake";
  anchorId: string;
  /** Planned or actual wake — the boundary the forward chain starts at. */
  startsAt: Date;
  steps: PlacementStep[];
}

export type RoutineChain = CommitmentChain | BedtimeChain | WakeChain;

export interface BlockedRange {
  startsAt: Date;
  endsAt: Date;
}

export interface PlaceRoutineChainsInput {
  now: Date;
  timezone: string;
  bands: TimeBand[];
  chains: RoutineChain[];
  /** Other commitments' protection and (pass 2) planned nights. */
  blocked: BlockedRange[];
}

export interface PlacedStep {
  stepId: string;
  anchorId: string;
  /** Hands-on start. Absent for a completed step's running-wait-only entry. */
  placedStartAt?: Date;
  /** Hands-on end. Absent for a completed step's running-wait-only entry. */
  placedEndAt?: Date;
  /** Latest legal start; present only when a wait or must-start-by constrains the step. */
  startBy?: Date;
  /** Earliest legal start; flexible commitment before-steps only. */
  earliestAt?: Date;
  /** When the step's own wait ends, present only when the step has one. */
  waitEndsAt?: Date;
  /** The band whose occurrence the step landed in; band-eligible flexible steps only. */
  bandId?: string;
  /** A non-pending (completed) step's still-running wait: from `completedAt`. No hands-on interval —
   *  the step already happened; only its wait continues. */
  waitStartsAt?: Date;
}

// ---------------------------------------------------------------------------------------------
// Small time helpers
// ---------------------------------------------------------------------------------------------

const addMinutes = (date: Date, minutes: number): Date => new Date(date.getTime() + minutes * MINUTE_MS);
const waitOf = (step: PlacementStep): number => step.waitAfterMinutes ?? 0;
const earlier = (a: Date, b: Date): Date => (a.getTime() <= b.getTime() ? a : b);
const later = (a: Date, b: Date): Date => (a.getTime() >= b.getTime() ? a : b);

/** A non-pending step's own fixed hands-on end, for a forward chain's prerequisite lookup — a
 *  completed step's wait runs from `completedAt` when present, otherwise every locked status falls
 *  back to its stored `scheduledEndAt` (or `scheduledStartAt` when only that is known). */
function lockedStepEnd(step: PlacementStep): Date | undefined {
  if (step.status === "completed" && step.completedAt) return step.completedAt;
  return step.scheduledEndAt ?? step.scheduledStartAt;
}

// ---------------------------------------------------------------------------------------------
// Interval bookkeeping — used by the band search to avoid overlapping any placed hands-on interval
// or blocked range, across every chain.
// ---------------------------------------------------------------------------------------------

interface Interval {
  start: number;
  end: number;
}

function freeIntervals(rangeStart: number, rangeEnd: number, obstacles: readonly Interval[]): Interval[] {
  const relevant = obstacles
    .filter((obstacle) => obstacle.end > rangeStart && obstacle.start < rangeEnd)
    .sort((a, b) => a.start - b.start);
  const free: Interval[] = [];
  let cursor = rangeStart;
  for (const obstacle of relevant) {
    const start = Math.max(obstacle.start, rangeStart);
    const end = Math.min(obstacle.end, rangeEnd);
    if (start > cursor) free.push({ start: cursor, end: start });
    cursor = Math.max(cursor, end);
  }
  if (cursor < rangeEnd) free.push({ start: cursor, end: rangeEnd });
  return free;
}

/** The latest start inside `[rangeStart, rangeEnd]` at which a `durationMs`-long interval fits
 *  without overlapping any obstacle, or `undefined` when nothing that long fits at all. */
function latestFittingStart(
  rangeStart: number,
  rangeEnd: number,
  durationMs: number,
  obstacles: readonly Interval[]
): number | undefined {
  const free = freeIntervals(rangeStart, rangeEnd, obstacles);
  for (let index = free.length - 1; index >= 0; index -= 1) {
    const interval = free[index]!;
    if (interval.end - interval.start >= durationMs) return interval.end - durationMs;
  }
  return undefined;
}

/**
 * Searches band occurrences (in `timezone`) within `[searchStart, latestStart]` for the latest one
 * whose hands-on interval fits inside the band, overlapping neither `obstacles` nor an
 * already-placed interval. Latest occurrence first; within an occurrence, the latest fitting gap.
 * `undefined` when no band names an occurrence that fits — the caller places at the chain slot.
 */
interface BandFound {
  start: Date;
  bandId: string;
}

function findBandPlacement(args: {
  searchStart: Date;
  latestStart: Date;
  durationMinutes: number;
  bandIds: readonly string[];
  bands: readonly TimeBand[];
  timezone: string;
  obstacles: readonly Interval[];
}): BandFound | undefined {
  const { searchStart, latestStart, durationMinutes, bandIds, bands, timezone, obstacles } = args;
  if (searchStart.getTime() > latestStart.getTime()) return undefined;
  const namedBands = bandIds
    .map((id) => bands.find((band) => band.id === id))
    .filter((band): band is TimeBand => Boolean(band));
  if (namedBands.length === 0) return undefined;
  const durationMs = durationMinutes * MINUTE_MS;

  const lastDay = localDate(latestStart, timezone);
  const firstDay = localDate(searchStart, timezone);
  const days: string[] = [];
  for (let day = lastDay; ; day = addLocalDays(day, -1)) {
    days.push(day);
    if (day <= firstDay) break;
    if (days.length > 366) break; // defensive: never loop forever on a bad window.
  }

  const occurrences = days
    .flatMap((day) =>
      namedBands.map((band) => ({
        bandId: band.id,
        start: zonedDateTime(day, band.start, timezone),
        end: zonedDateTime(day, band.end, timezone)
      }))
    )
    .sort((a, b) => b.start.getTime() - a.start.getTime());

  for (const occurrence of occurrences) {
    const rangeStart = later(occurrence.start, searchStart).getTime();
    const rangeEnd = earlier(occurrence.end, addMinutes(latestStart, durationMinutes)).getTime();
    if (rangeEnd - rangeStart < durationMs) continue;
    const start = latestFittingStart(rangeStart, rangeEnd, durationMs, obstacles);
    if (start !== undefined) return { start: new Date(start), bandId: occurrence.bandId };
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Before-phase / bedtime — backward chain
// ---------------------------------------------------------------------------------------------

interface BackwardResolved {
  /** The pure latest-start pass's own answer — never adjusted for a band. Used for `startBy` and as
   *  the fallback "chain slot" when a flexible step names no fitting band. */
  pureLatestStart: Date;
  /** The step's actual placement — equal to `pureLatestStart` unless a band moved it earlier. */
  actualStart: Date;
  readonly startBy?: Date;
  readonly earliestAt?: Date;
  bandId?: string;
}

/** Steps that depend on `step` (its dependents), within the same phase-ordered list. */
function commitmentDependentsOf(step: PlacementStep, steps: readonly PlacementStep[]): PlacementStep[] {
  return steps.filter((candidate) => candidate.dependencyIds.includes(step.id));
}

function placeBackwardChain(
  chain: CommitmentChain | BedtimeChain,
  steps: readonly PlacementStep[],
  input: PlaceRoutineChainsInput,
  placedIntervals: Interval[]
): Map<string, PlacedStep> {
  const boundary = chain.kind === "commitment" ? chain.timeline.setupStartsAt : chain.endsAt;
  const mustStartByAnchor = chain.kind === "commitment" ? chain.timeline.startsAt : chain.endsAt;
  const ordered = steps
    .filter((step) => !step.skip)
    .slice()
    .sort((a, b) => a.sequence - b.sequence);
  const reversed = ordered.slice().reverse();

  // "Bound" of a step for its prerequisite's dependent-term: the resolved actual start once known
  // (non-pending: its stored start; pending: filled in as we walk backward).
  const boundStartOf = new Map<string, Date>();
  const pureResults = new Map<string, BackwardResolved>();

  let cursor = boundary;
  for (const step of reversed) {
    if (step.status !== "pending") {
      // A finished, cancelled or skipped step takes no time in the walk (today's scheduler skips it,
      // so the pending steps close up towards the boundary). A `doing` or `blocked` step still holds
      // its chain slot, as it did before; neither is re-placed (the caller keeps its stored times).
      if (step.status === "doing" || step.status === "blocked") {
        const start = addMinutes(cursor, -step.durationMinutes);
        boundStartOf.set(step.id, start);
        cursor = start;
      }
      continue;
    }

    const dependents =
      chain.kind === "commitment"
        ? commitmentDependentsOf(step, ordered)
        : (() => {
            const index = ordered.indexOf(step);
            const next = ordered[index + 1];
            return next ? [next] : [];
          })();

    const terms: Date[] = [cursor];
    for (const dependent of dependents) {
      const dependentStart = boundStartOf.get(dependent.id);
      if (dependentStart) terms.push(addMinutes(dependentStart, -waitOf(step)));
    }
    if (dependents.length === 0) terms.push(addMinutes(boundary, -waitOf(step)));
    const latestEnd = terms.reduce((min, term) => earlier(min, term));

    let latestStart = addMinutes(latestEnd, -step.durationMinutes);
    if (step.mustStartByMinutes !== undefined)
      latestStart = earlier(latestStart, addMinutes(mustStartByAnchor, -step.mustStartByMinutes));

    const startBy = waitOf(step) > 0 || step.mustStartByMinutes !== undefined ? latestStart : undefined;
    const earliestAt =
      chain.kind === "commitment" && step.phase === "before" && step.timingRule === "flexible"
        ? addMinutes(chain.timeline.startsAt, -(step.maxLeadMinutes ?? 0))
        : undefined;

    pureResults.set(step.id, {
      pureLatestStart: latestStart,
      actualStart: latestStart,
      ...(startBy ? { startBy } : {}),
      ...(earliestAt ? { earliestAt } : {})
    });
    boundStartOf.set(step.id, latestStart);
    cursor = latestStart;
  }

  const isBandEligible = (step: PlacementStep): boolean =>
    chain.kind === "commitment" &&
    step.phase === "before" &&
    step.timingRule === "flexible" &&
    step.status === "pending";

  // A non-band-eligible pending step's position is already final after the pure pass — occupy its
  // interval now, before the band pass runs, so a flexible step never gets band-placed onto it
  // (rule 4: no hands-on interval overlaps another in its chain).
  for (const step of ordered) {
    if (step.status !== "pending" || isBandEligible(step)) continue;
    const resolved = pureResults.get(step.id);
    if (!resolved) continue;
    placedIntervals.push({
      start: resolved.actualStart.getTime(),
      end: addMinutes(resolved.actualStart, step.durationMinutes).getTime()
    });
  }

  // Band pass — flexible commitment before-steps only, reverse-sequence again so a dependent's
  // already-resolved actual placement (possibly band-moved) is available to its prerequisite.
  for (const step of reversed) {
    if (!isBandEligible(step)) continue;
    const resolved = pureResults.get(step.id);
    if (!resolved) continue;

    const dependents = commitmentDependentsOf(step, ordered).filter((dependent) => dependent.status === "pending");
    let bound = resolved.pureLatestStart;
    for (const dependent of dependents) {
      const dependentResolved = pureResults.get(dependent.id);
      if (!dependentResolved) continue;
      if (dependentResolved.actualStart.getTime() < dependentResolved.pureLatestStart.getTime())
        // The dependent's *start* minus this step's wait AND this step's own hands-on time — the
        // bound is a latest-start, not a latest-end, so both must come off before comparing.
        bound = earlier(bound, addMinutes(dependentResolved.actualStart, -(waitOf(step) + step.durationMinutes)));
    }

    const searchStart = later(resolved.earliestAt ?? bound, input.now);
    const found = findBandPlacement({
      searchStart,
      latestStart: bound,
      durationMinutes: step.durationMinutes,
      bandIds: step.preferredBands ?? [],
      bands: input.bands,
      timezone: input.timezone,
      obstacles: [
        ...input.blocked.map((range) => ({ start: range.startsAt.getTime(), end: range.endsAt.getTime() })),
        ...placedIntervals
      ]
    });
    // No fitting band occurrence: fall back to `bound`, not the untightened `pureLatestStart` — once a
    // dependent has already moved into the band, `bound` (not the pure chain slot) is this step's own
    // latest legal start, and falling back further than that would let it land after its dependent.
    const actualStart = found?.start ?? bound;
    resolved.actualStart = actualStart;
    if (found) resolved.bandId = found.bandId;
    boundStartOf.set(step.id, actualStart);
    placedIntervals.push({
      start: actualStart.getTime(),
      end: addMinutes(actualStart, step.durationMinutes).getTime()
    });
  }

  const placed = new Map<string, PlacedStep>();
  for (const step of ordered) {
    if (step.status !== "pending") continue;
    const resolved = pureResults.get(step.id);
    if (!resolved) continue;
    const placedStartAt = resolved.actualStart;
    const placedEndAt = addMinutes(placedStartAt, step.durationMinutes);
    placed.set(step.id, {
      stepId: step.id,
      anchorId: chain.anchorId,
      placedStartAt,
      placedEndAt,
      ...(resolved.startBy ? { startBy: resolved.startBy } : {}),
      ...(resolved.earliestAt ? { earliestAt: resolved.earliestAt } : {}),
      ...(resolved.bandId ? { bandId: resolved.bandId } : {}),
      ...(waitOf(step) > 0 ? { waitEndsAt: addMinutes(placedEndAt, waitOf(step)) } : {})
    });
  }
  // A completed step's own wait may still be running (no hands-on interval to report — it already
  // happened), same as a forward chain's own locked steps (`placeForwardGroup`).
  for (const step of ordered) {
    if (step.status !== "completed" || !step.completedAt || waitOf(step) <= 0) continue;
    const waitEndsAt = addMinutes(step.completedAt, waitOf(step));
    if (waitEndsAt.getTime() > input.now.getTime())
      placed.set(step.id, {
        stepId: step.id,
        anchorId: chain.anchorId,
        waitStartsAt: step.completedAt,
        waitEndsAt
      });
  }
  return placed;
}

// ---------------------------------------------------------------------------------------------
// After-phase / wake — forward chain
// ---------------------------------------------------------------------------------------------

/** Places one forward group (venue steps, home steps, or a whole wake chain) in ascending sequence
 *  order, each step starting at the earliest instant at or after the cursor and after every
 *  prerequisite's hands-on end plus its wait. */
function placeForwardGroup(
  group: readonly PlacementStep[],
  boundary: Date,
  anchorId: string,
  mustStartByAnchor: Date,
  prerequisitesOf: (step: PlacementStep) => PlacementStep[],
  allByIdEnd: Map<string, Date>,
  placed: Map<string, PlacedStep>,
  now: Date
): Date {
  let cursor = boundary;
  for (const step of group) {
    if (step.skip) continue;
    if (step.status !== "pending") {
      const end = lockedStepEnd(step) ?? boundary;
      allByIdEnd.set(step.id, end);
      cursor = later(cursor, end);
      // A completed step's own wait may still be running — report it (no hands-on interval; the
      // step already happened) so the portal can draw the strip while pending steps ahead of it are
      // still waiting on it too.
      if (step.status === "completed" && step.completedAt && waitOf(step) > 0) {
        const waitEndsAt = addMinutes(step.completedAt, waitOf(step));
        if (waitEndsAt.getTime() > now.getTime())
          placed.set(step.id, {
            stepId: step.id,
            anchorId,
            waitStartsAt: step.completedAt,
            waitEndsAt
          });
      }
      continue;
    }
    const prerequisiteBounds = prerequisitesOf(step)
      .map((prerequisite) => {
        const end = allByIdEnd.get(prerequisite.id);
        return end ? addMinutes(end, waitOf(prerequisite)) : undefined;
      })
      .filter((bound): bound is Date => Boolean(bound));
    const placedStartAt = prerequisiteBounds.reduce((start, bound) => later(start, bound), cursor);
    const placedEndAt = addMinutes(placedStartAt, step.durationMinutes);
    const startBy =
      step.mustStartByMinutes !== undefined ? addMinutes(mustStartByAnchor, step.mustStartByMinutes) : undefined;

    placed.set(step.id, {
      stepId: step.id,
      anchorId,
      placedStartAt,
      placedEndAt,
      ...(startBy ? { startBy } : {}),
      ...(waitOf(step) > 0 ? { waitEndsAt: addMinutes(placedEndAt, waitOf(step)) } : {})
    });
    allByIdEnd.set(step.id, placedEndAt);
    cursor = placedEndAt;
  }
  return cursor;
}

/** Occupies a placed step's own hands-on interval; a completed step's running-wait-only entry has
 *  none, and is left out (it takes no room in the day). */
function occupyPlacedIntervals(placed: ReadonlyMap<string, PlacedStep>, placedIntervals: Interval[]): void {
  for (const placedStep of placed.values()) {
    if (!placedStep.placedStartAt || !placedStep.placedEndAt) continue;
    placedIntervals.push({ start: placedStep.placedStartAt.getTime(), end: placedStep.placedEndAt.getTime() });
  }
}

function placeCommitmentAfterChain(
  chain: CommitmentChain,
  afterSteps: readonly PlacementStep[],
  placedIntervals: Interval[],
  now: Date
): Map<string, PlacedStep> {
  const placed = new Map<string, PlacedStep>();
  const ordered = afterSteps.slice().sort((a, b) => a.sequence - b.sequence);
  const atVenue = (step: PlacementStep) => chain.locationId !== undefined && step.contexts.includes(chain.locationId);
  const venueSteps = ordered.filter(atVenue);
  const homeSteps = ordered.filter((step) => !atVenue(step));

  const allByIdEnd = new Map<string, Date>();
  const byId = new Map(ordered.map((step) => [step.id, step]));
  const prerequisitesOf = (step: PlacementStep): PlacementStep[] =>
    step.dependencyIds.map((id) => byId.get(id)).filter((s): s is PlacementStep => Boolean(s));

  const venueBoundary = chain.timeline.effectiveEndsAt;
  const venueEnd = placeForwardGroup(
    venueSteps,
    venueBoundary,
    chain.anchorId,
    venueBoundary,
    prerequisitesOf,
    allByIdEnd,
    placed,
    now
  );
  const homeBoundary0 = chain.timeline.homeAt ?? chain.timeline.freeAt;
  const homeBoundary = later(homeBoundary0, venueEnd);
  placeForwardGroup(homeSteps, homeBoundary, chain.anchorId, homeBoundary0, prerequisitesOf, allByIdEnd, placed, now);

  occupyPlacedIntervals(placed, placedIntervals);
  return placed;
}

function placeWakeChain(chain: WakeChain, placedIntervals: Interval[], now: Date): Map<string, PlacedStep> {
  const placed = new Map<string, PlacedStep>();
  const ordered = chain.steps.filter((step) => !step.skip).sort((a, b) => a.sequence - b.sequence);
  const allByIdEnd = new Map<string, Date>();
  const prerequisitesOf = (step: PlacementStep): PlacementStep[] => {
    const index = ordered.indexOf(step);
    const previous = ordered[index - 1];
    return previous ? [previous] : [];
  };
  placeForwardGroup(ordered, chain.startsAt, chain.anchorId, chain.startsAt, prerequisitesOf, allByIdEnd, placed, now);
  occupyPlacedIntervals(placed, placedIntervals);
  return placed;
}

// ---------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------

/**
 * Places every pending, non-skipped step of every chain. Pure: takes `now` as input, never reads
 * the clock. Output sorted by `(anchorId, sequence)`.
 */
export function placeRoutineChains(input: PlaceRoutineChainsInput): PlacedStep[] {
  const placedIntervals: Interval[] = [];
  const all: PlacedStep[] = [];
  const sequenceOf = new Map<string, number>();

  for (const chain of input.chains) {
    for (const step of chain.steps) sequenceOf.set(step.id, step.sequence);

    if (chain.kind === "bedtime") {
      const before = chain.steps.filter((step) => step.phase !== "after");
      for (const placedStep of placeBackwardChain(chain, before, input, placedIntervals).values()) all.push(placedStep);
      continue;
    }
    if (chain.kind === "wake") {
      for (const placedStep of placeWakeChain(chain, placedIntervals, input.now).values()) all.push(placedStep);
      continue;
    }
    // commitment
    const before = chain.steps.filter((step) => step.phase !== "after");
    const after = chain.steps.filter((step) => step.phase === "after");
    for (const placedStep of placeBackwardChain(chain, before, input, placedIntervals).values()) all.push(placedStep);
    for (const placedStep of placeCommitmentAfterChain(chain, after, placedIntervals, input.now).values())
      all.push(placedStep);
  }

  return all.sort((a, b) => {
    if (a.anchorId !== b.anchorId) return a.anchorId < b.anchorId ? -1 : 1;
    return (sequenceOf.get(a.stepId) ?? 0) - (sequenceOf.get(b.stepId) ?? 0);
  });
}
