import {
  DEFAULT_TIME_BANDS,
  type CommitmentTimelineWire,
  type DayPlanBlock as EngineDayPlanBlock,
  type PlanForecastResponse,
  type SoftPlacementWire,
  type StepPlacementWire,
  type TransportMode,
  type TravelSource,
  isClosedStatus
} from "@openrhen/contracts";
import type { PortalState, StoredCommitment } from "@/state/portal-state";
import type { ClientAllocation, ClientRecommendation, ClientSlot } from "@/state/portal-provider";
import { criticalTierLabel } from "@/features/now/critical-tiers";
import { formatZonedTime } from "@/shared/date-format";
import { clip, mergeAdjacentBlocks, mergeAdjacentSessions, type TimeSpan } from "./day-layout";
import { zonedDayBounds, zonedWallTimeOnDay, type ZonedDayBounds } from "./local-datetime";

/**
 * The day as a set of placed facts and one projection.
 *
 * Every block here has a real start and end that something in state or the engine's result actually
 * asserts. The engine's forward-simulated day is the one thing on the canvas that is a projection
 * rather than a fact, and it says so on every block: it is the current directive policy replayed
 * from now, so it moves when the day does. The latest-safe reservations are kept apart as `reserved`
 * so they can be shown as what they are — feasibility, not a plan.
 */
export type DayPlanSource = "fixed" | "recorded" | "engine" | "reserved";

export type DayPlanKind =
  | "commitment"
  | "routine_step"
  | "sleep"
  | "occurrence"
  | "session"
  | "active_session"
  | "directive"
  | "planned"
  | "travel"
  | "next_fit"
  | "reserved"
  | "leave_by"
  | "start_by"
  | "soft";

export interface DayPlanItem extends TimeSpan {
  id: string;
  kind: DayPlanKind;
  source: DayPlanSource;
  title: string;
  subtitle?: string;
  /** The stored entity this block stands for, so a tap can open the right editor. */
  entityId: string;
  /** Extra ids a tap may need — the routine step's commitment, the occurrence's action. */
  parentId?: string;
  clippedStart: boolean;
  clippedEnd: boolean;
  /** A point in time rather than a span; drawn as a rule with a label. */
  marker?: boolean;
  /** Draw as a thin outline: a window something may happen in, not a thing that happens. */
  window?: boolean;
  /**
   * For a window: the routine step that is the same work, named as "step · routine".
   *
   * A routine tile's step may name a recurring-action window in Settings → Routines, which is the
   * model's one statement that ticking the step and filling the window are the same act. Where the
   * engine has already folded the window into a routine instance the window is not drawn at all;
   * this is for the rest — a link that exists but has no instance on this day — so the window row
   * says whose job it is instead of standing beside the step as an unrelated second demand.
   */
  coveredBy?: string;
  tentative?: boolean;
  /**
   * For a commitment: whether the time is fully taken or only anchored there. Carried onto the block
   * so a canvas can draw the difference — an anchor is somewhere you have to be, not an hour you
   * have lost — without looking the commitment up again and risking a second opinion about it.
   */
  presence?: NonNullable<StoredCommitment["presence"]>;
  /** An engine item from a plan that is no longer current; still shown, greyed out. */
  stale?: boolean;
  /** A simulated block rather than the live directive: where the policy would take the day, not a fact. */
  projected?: boolean;
  /** The wall-clock length of a work block, when it differs from the focused minutes in `minutes`. */
  wallMinutes?: number;
  /** The named critical tier the ranking gave the work at that instant. */
  tier?: string;
  /** The engine's one-line reason for placing this block here. */
  reason?: string;
  /** The plan does not reach this target before its latest safe start. */
  displaced?: boolean;
  /** Setup and transition halos around a commitment; drawn lighter behind the block. */
  halos?: TimeSpan[];
  /** Ordered steps derived inside a routine instance, or the members of a folded run; listed, not drawn to scale. */
  steps?: Array<{ id: string; title: string; startsAt: Date; endsAt: Date }>;
  /**
   * What a run of these is called once folded together — the parent's own wording, not this block's.
   * Only set where a run has a name worth keeping; without it a fold is named by its size.
   */
  groupTitle?: string;
  /** Folded from a run of blocks each too short to draw at this scale; `steps` names the members. */
  grouped?: boolean;
  /** For reservations: the deadline the reservation protects. */
  deadlineAt?: Date;
  minutes?: number;
  /** Travel blocks: where the leg goes and how. */
  toLocationId?: string;
  mode?: TransportMode;
  /**
   * Travel blocks: how well the leg's length is known. Only the live leg has it — the projected day
   * states a journey's minutes but not their provenance, and inventing one would be a second opinion.
   */
  travelSource?: TravelSource;
  /** Travel blocks: what the journey is for, named from whatever the block's target turns out to be. */
  thenTitle?: string;
  /**
   * Commitment blocks only: why the projection could give this commitment's journey no figure at all
   * Absent means a journey was
   * resolved, or none was needed.
   */
  travelGap?: "no_place" | "no_estimate";
  /** A start-by marker's own urgency, the same rule the Now banner uses. */
  urgency?: "soon" | "missed";
}

/** One segment of the waits strip beside the location strip (the day plan surfaces design note,
 *  "Waits strip"): free time after a step's hands-on work, before whatever depends on it may begin. */
export interface DayPlanWait extends TimeSpan {
  id: string;
  stepId: string;
  title: string;
  anchorTitle: string;
  /** A completed step's own wait (solid); a pending one's projected wait (lighter). */
  running: boolean;
  /** Read from a moved or missing commitment timeline entry — greyed like a halo in the same state. */
  stale?: boolean;
  /**
   * Set when a third or later wait overlapping the same two already-open slots folds into this one
   * the count of waits merged here, `title` reads
   * "N waits", and `stepId`/`anchorTitle` stay the earliest folded wait's own, so a tap still opens
   * that step.
   */
  foldedCount?: number;
}

export type DayPlanBackgroundKind = "sleep" | "free" | "protected" | "fixed" | "unavailable" | "elapsed";

export interface DayPlanBackground extends TimeSpan {
  id: string;
  kind: DayPlanBackgroundKind;
}

/**
 * Where the projected day says you are, as a contiguous band beside the hour gutter. `locationId` is
 * null while in transit, and `label` is the engine's own wording for the place — read, never looked
 * up again here, so the strip and the blocks can never disagree about what somewhere is called.
 */
export interface DayPlanLocation extends TimeSpan {
  id: string;
  locationId: string | null;
  label: string;
}

export interface DayPlanLine {
  id: string;
  kind: "horizon" | "boundary" | "gap";
  at: Date;
  label: string;
}

/** A deadline the projected day does not reach in time. Reservations are never moved to fix it. */
export interface DayPlanDisplaced {
  targetId: string;
  latestSafeStartAt: Date;
  firstPlannedAt: Date | null;
}

export interface DayPlanUntimed {
  id: string;
  kind: "action" | "routine_step" | "commitment" | "travel";
  title: string;
  minutes: number;
  /** Where the chip came from, so the reader knows it is next in ranking rather than next in time. */
  reason: string;
}

export interface DayPlan {
  bounds: ZonedDayBounds;
  items: DayPlanItem[];
  reserved: DayPlanItem[];
  backgrounds: DayPlanBackground[];
  lines: DayPlanLine[];
  /** Empty without a projected day, and empty when the current location is unknown. */
  locations: DayPlanLocation[];
  /** The waits strip beside the location strip; empty when there are no waits. */
  waits: DayPlanWait[];
  untimed: DayPlanUntimed[];
  /** Null when `now` is not on this day; the now-line is only ever drawn on today. */
  nowAt: Date | null;
  /** Deadlines the projected day does not reach in time; empty when there is no projected day. */
  displaced: DayPlanDisplaced[];
  /** When the engine computed the projected day, so a new run can be announced. Null without one. */
  calculatedAt: Date | null;
}

export type DayPlanState = Pick<
  PortalState,
  | "settings"
  | "commitments"
  | "routineSteps"
  | "routinePresets"
  | "sleepPlans"
  | "occurrences"
  | "completedToday"
  | "activeSession"
  | "actions"
  | "deliverables"
  | "projects"
  | "planning"
>;

export interface DayPlanInput {
  state: DayPlanState;
  slots: ClientSlot[];
  allocations: ClientAllocation[];
  recommendation: ClientRecommendation | null;
  currentDirective: PlanForecastResponse["currentDirective"] | null;
  upcomingDirectives: PlanForecastResponse["upcomingDirectives"];
  /** The engine's forward-simulated day; absent from results stored before engine 1.4.0. */
  dayPlan?: PlanForecastResponse["dayPlan"] | null;
  dayKey: string;
  now: Date;
  timezone: string;
}

const KIND_ORDER: Record<DayPlanKind, number> = {
  sleep: 0,
  commitment: 1,
  routine_step: 2,
  occurrence: 3,
  session: 4,
  active_session: 5,
  directive: 6,
  planned: 7,
  travel: 8,
  next_fit: 9,
  leave_by: 10,
  start_by: 11,
  reserved: 12,
  soft: 13
};

/** Kinds of projected block the portal draws; the rest of the day is drawn from the facts instead. */
const PLANNED_KINDS = new Set(["action", "deliverable", "recovery"]);
/** Shorter empty stretches are the grain of the day, not news; only longer ones get a label. */
const GAP_LABEL_MINUTES = 15;
/**
 * A shorter separation than this is the seam between two steps of one stretch, not a break in it.
 * The scale-aware test in `continuesRun` is the one that usually decides; this is the floor, so a
 * seam stays a seam even on a canvas drawn large enough to show it.
 */
const GROUP_GAP_MINUTES = 2;
/** Two blocks in a row are a pair the reader can still read as a pair; three are a wall. */
const GROUP_MIN_ITEMS = 3;

const date = (value: string | Date) => (value instanceof Date ? value : new Date(value));
const minutesBetween = (a: Date, b: Date) => Math.max(0, Math.round((b.getTime() - a.getTime()) / 60_000));

/** "7.7h", plus " · logged by hand" for a night entered after the fact rather than tracked live. */
export const sleepDurationLabel = (minutes: number, manual: boolean | undefined) =>
  `${Math.round(minutes / 6) / 10}h${manual ? " · logged by hand" : ""}`;
const later = (a: Date, b: Date) => (a.getTime() >= b.getTime() ? a : b);
/** "8:10 am" in the given timezone: the same 12-hour clock as every time the day plan draws beside it. */
const clockTime = (value: Date, timezone: string) => formatZonedTime(value, timezone);

export function buildDayPlan(input: DayPlanInput): DayPlan {
  const { state, dayKey, now, timezone } = input;
  const bounds = zonedDayBounds(dayKey, timezone);
  const items: DayPlanItem[] = [];
  const backgrounds: DayPlanBackground[] = [];
  const lines: DayPlanLine[] = [];
  const locations: DayPlanLocation[] = [];
  const untimed: DayPlanUntimed[] = [];
  const planningCurrent = state.planning?.status === "current";
  const stale = !planningCurrent;
  const nowAt = now >= bounds.startsAt && now < bounds.endsAt ? now : null;

  const place = (
    span: TimeSpan,
    item: Omit<DayPlanItem, "startsAt" | "endsAt" | "clippedStart" | "clippedEnd">
  ): DayPlanItem | null => {
    const clipped = clip(span, bounds);
    if (!clipped) return null;
    const placed: DayPlanItem = { ...item, ...clipped };
    if (item.halos) {
      placed.halos = item.halos
        .map((halo) => clip(halo, bounds))
        .filter((halo): halo is NonNullable<typeof halo> => halo !== null)
        .map((halo) => ({ startsAt: halo.startsAt, endsAt: halo.endsAt }));
    }
    items.push(placed);
    return placed;
  };

  const commitmentTitle = (id: string) => state.commitments.find((item) => item.id === id)?.title ?? "commitment";

  // Fixed commitments, buffers as halos. Tentative ones are drawn but marked; cancelled ones vanish.
  //
  // Time tracked against a commitment is drawn on the commitment rather than beside it. Start/Stop
  // on a commitment writes an ordinary session whose target is the commitment itself, so the day
  // holds two facts about one thing; drawn apart they are two blocks with the same name an hour
  // out of step with each other, and neither says it is the other's record.
  const tracked = trackedCommitmentSessions(state, now);
  const mergedSessionIds = new Set<string>();
  // The latest stored timeline per commitment, read only for its `travelGap` flag — the agenda's own
  // chip for a commitment the projection could give no journey figure at all
  // Absent from a result computed
  // before this plan, so a commitment simply gets no chip rather than a false one.
  const commitmentTimelines: CommitmentTimelineWire[] = state.planning?.result?.derivedState?.commitmentTimelines ?? [];
  // The one place a commitment's edges are read (invariant 1, the day plan surfaces design note): the
  // engine's own timeline, never `setupBeforeMinutes`/`transitionAfterMinutes` directly. A commitment
  // with no matching entry, or whose entry's `startsAt` has drifted from what is stored now (an edit
  // the next run has not caught up with yet), draws no halos and no leave-by marker until it does —
  // a gap of seconds, accepted (Q4).
  const timelineFor = (commitment: StoredCommitment, startsAt: Date): CommitmentTimelineWire | undefined => {
    const entry = commitmentTimelines.find((item) => item.id === commitment.id);
    if (!entry || date(entry.startsAt).getTime() !== startsAt.getTime()) return undefined;
    return entry;
  };
  for (const commitment of state.commitments) {
    if (isClosedStatus(commitment.status)) continue;
    const startsAt = date(commitment.startsAt);
    const endsAt = date(commitment.endsAt);
    const timeline = timelineFor(commitment, startsAt);
    const halos: TimeSpan[] = [];
    if (timeline) {
      const setupEnd = timeline.leaveBy ? date(timeline.leaveBy) : date(timeline.arriveBy);
      if (date(timeline.setupStartsAt).getTime() < setupEnd.getTime())
        halos.push({ startsAt: date(timeline.setupStartsAt), endsAt: setupEnd });
      if (timeline.leaveBy) {
        const arriveBy = date(timeline.arriveBy);
        if (arriveBy.getTime() < startsAt.getTime()) halos.push({ startsAt: arriveBy, endsAt: startsAt });
      }
      const effectiveEndsAt = date(timeline.effectiveEndsAt);
      const freeAt = date(timeline.freeAt);
      if (freeAt.getTime() > effectiveEndsAt.getTime()) halos.push({ startsAt: effectiveEndsAt, endsAt: freeAt });
    }
    // The block spans the appointment and everything recorded against it. Neither is dropped: work
    // that ran early or late is part of what the commitment took, and a ten-minute session inside a
    // three-hour booking must not shrink the booking to ten minutes. Only overlapping time is taken
    // in — a session recorded against a commitment on another day is other time, and folding it in
    // would stretch one block across the gap between them. The block's own end is the later of the
    // timeline's `effectiveEndsAt` (which already reads tracked overtime) and endsAt.
    const baseEndsAt = timeline ? date(timeline.effectiveEndsAt) : endsAt;
    const sessions = (tracked.get(commitment.id) ?? []).filter(
      (session) => session.startsAt < endsAt && session.endsAt > startsAt
    );
    const span = sessions.reduce<TimeSpan>(
      (current, session) => ({
        startsAt: session.startsAt < current.startsAt ? session.startsAt : current.startsAt,
        endsAt: session.endsAt > current.endsAt ? session.endsAt : current.endsAt
      }),
      { startsAt, endsAt: baseEndsAt }
    );
    const activeMinutes = sessions.reduce((total, session) => total + session.activeMinutes, 0);
    const recorded = sessions.at(-1);
    const travelGap = timeline?.travelGap;
    const placed = place(span, {
      id: `commitment:${commitment.id}`,
      kind: "commitment",
      source: recorded ? "recorded" : "fixed",
      title: commitment.title,
      subtitle: [
        commitmentSubtitle(commitment, state),
        recorded ? `${recorded.label} · ${activeMinutes} active min` : ""
      ]
        .filter(Boolean)
        .join(" · "),
      entityId: commitment.id,
      ...(commitment.recurrenceRuleId ? { parentId: commitment.recurrenceRuleId } : {}),
      ...(recorded ? { minutes: activeMinutes, wallMinutes: minutesBetween(span.startsAt, span.endsAt) } : {}),
      ...(travelGap ? { travelGap } : {}),
      tentative: commitment.status === "tentative",
      presence: commitment.presence ?? "blocking",
      halos
    });
    // Only a drawn commitment may swallow its sessions. One clipped off this day would take the
    // record of the work with it, and the session is the fact that it happened.
    if (placed) for (const session of sessions) mergedSessionIds.add(session.id);

    // Leave-by marker (the day plan surfaces design note, flow 8 "with caution"): only with a current
    // timeline entry, a journey (`leaveBy` and a non-zero `journeyBefore`), and never for a cancelled
    // commitment (already excluded above). The caption echoes `journeyBefore` exactly as sent, so Now's
    // own travel panel and this marker can never disagree about the same commitment (invariant 6).
    if (timeline?.leaveBy && timeline.journeyBefore && timeline.journeyBefore.minutes > 0) {
      const leaveBy = date(timeline.leaveBy);
      const captionParts = [
        `usually ${timeline.journeyBefore.typicalMinutes} min · allowing ${timeline.journeyBefore.minutes}`
      ];
      if (timeline.journeyBefore.originAssumed) captionParts.push("assuming you're at home");
      if (timeline.latenessMatters === false) captionParts.push("lateness relaxed");
      place(
        { startsAt: leaveBy, endsAt: leaveBy },
        {
          id: `leave_by:${commitment.id}`,
          kind: "leave_by",
          source: "engine",
          title: `Leave by ${clockTime(leaveBy, timezone)} for ${commitment.title}`,
          subtitle: captionParts.join(" · "),
          entityId: commitment.id,
          marker: true,
          stale
        }
      );
    }
  }

  // The placer's own facts: `startBy`, `waitEndsAt`, `earliestAt`
  // and `bandId`, keyed by step id. Never recomputed here — a wait, a start-by or a band name comes
  // only from this map or from `commitmentTimelines` above (invariant 1).
  const stepPlacements: StepPlacementWire[] = state.planning?.result?.derivedState?.stepPlacements ?? [];
  const placementByStepId = new Map(stepPlacements.map((entry) => [entry.stepId, entry]));
  const timeBands = state.settings.timeBands ?? DEFAULT_TIME_BANDS;
  const bandName = (bandId: string) => timeBands.find((band) => band.id === bandId)?.name ?? bandId;

  // Routine preparation with a scheduled time, one row per step for either anchor now: a
  // commitment's own preparation and a bedtime/wake step are both `routine_steps` rows, each already
  // carrying its own real `scheduledStartAt`/`scheduledEndAt` — nothing here derives a chain from a
  // bundled instance's own span the way the old `routine_instances` block used to. A commitment step
  // this day's planner could not yet place goes to the untimed strip so it is not silently missing; a
  // sleep-anchored step always carries its schedule from the engine's own derivation, so it never has
  // an untimed fallback to fall to.
  //
  // A step that is done is no longer something the day holds, so it leaves the canvas the moment it
  // is ticked rather than when the server next reschedules its times. The routine section on the
  // commitment's own page (or the Now page's own bedtime/wake panel) keeps listing it with its status,
  // and that row is the record of it.
  for (const step of state.routineSteps) {
    if (step.status === "completed" || step.status === "cancelled" || step.status === "skipped") continue;
    if (step.anchorType === "sleep_plan") {
      if (!step.scheduledStartAt || !step.scheduledEndAt) continue;
      const groupTitle = step.purpose === "wake" ? "Wake routine" : "Bedtime routine";
      place(
        { startsAt: date(step.scheduledStartAt), endsAt: date(step.scheduledEndAt) },
        {
          id: `routine_step:${step.id}`,
          kind: "routine_step",
          source: "fixed",
          title: step.title,
          subtitle: `${groupTitle} · ${step.durationMinutes} min`,
          entityId: step.id,
          ...(step.anchorId ? { parentId: step.anchorId } : {}),
          groupTitle
        }
      );
      continue;
    }
    if (step.scheduledStartAt && step.scheduledEndAt) {
      const phase = `${step.phase === "after" ? "After" : "Before"} ${commitmentTitle(step.commitmentId ?? "")}`;
      const placement = placementByStepId.get(step.id);
      // Preferred-time steps (the day plan surfaces design note, flow 8 "where planned"): the band the
      // step actually landed in, named from `settings.timeBands`, or — a flexible step that names bands
      // but landed nowhere in one — that it did not fit.
      const bandSubtitle =
        step.timingRule === "flexible" && step.phase === "before"
          ? placement?.bandId
            ? `${bandName(placement.bandId)} slot`
            : step.preferredBands?.length
              ? `No ${bandName(step.preferredBands[0]!)} slot fits · latest slot`
              : undefined
          : undefined;
      place(
        { startsAt: date(step.scheduledStartAt), endsAt: date(step.scheduledEndAt) },
        {
          id: `routine_step:${step.id}`,
          kind: "routine_step",
          source: "fixed",
          title: step.title,
          subtitle: [`${phase} · ${step.durationMinutes} min`, bandSubtitle].filter(Boolean).join(" · "),
          entityId: step.id,
          ...(step.commitmentId ? { parentId: step.commitmentId } : {}),
          groupTitle: phase
        }
      );
      // A flexible step whose window opened before its placed start: the room it could have run in.
      if (placement?.earliestAt) {
        const earliestAt = date(placement.earliestAt);
        const placedStartAt = date(step.scheduledStartAt);
        const windowStart = later(now, earliestAt);
        if (windowStart.getTime() < placedStartAt.getTime())
          place(
            { startsAt: windowStart, endsAt: placedStartAt },
            {
              id: `can_start:${step.id}`,
              kind: "routine_step",
              source: "engine",
              title: `Can start from ${clockTime(windowStart, timezone)} · ${step.title}`,
              subtitle: phase,
              entityId: step.id,
              ...(step.commitmentId ? { parentId: step.commitmentId } : {}),
              window: true
            }
          );
      }
      continue;
    }
    const commitment = state.commitments.find((item) => item.id === step.commitmentId);
    if (!commitment || isClosedStatus(commitment.status)) continue;
    if (!clip({ startsAt: date(commitment.startsAt), endsAt: date(commitment.endsAt) }, bounds)) continue;
    untimed.push({
      id: `routine_step:${step.id}`,
      kind: "routine_step",
      title: step.title,
      minutes: step.durationMinutes,
      reason: `Not yet placed · ${step.phase === "after" ? "after" : "before"} ${commitment.title}`
    });
  }

  // Start-by markers and the waits strip: both read only `stepPlacements`, never a stored field
  // (invariant 1). `anchorTitle` names whichever anchor placed the step — a commitment, or the
  // night either side of sleep.
  const routineStepById = new Map(state.routineSteps.map((step) => [step.id, step]));
  const startByWarningByStepId = new Map(
    (state.planning?.result?.startByWarnings ?? []).map((warning) => [warning.stepId, warning])
  );
  const waits: DayPlanWait[] = [];
  const anchorTitleFor = (entry: StepPlacementWire, step: DayPlanState["routineSteps"][number] | undefined): string => {
    if (entry.anchorKind === "sleep_plan") return step?.purpose === "wake" ? "Wake-up" : "Bedtime";
    return commitmentTitle(entry.anchorId);
  };
  for (const entry of stepPlacements) {
    const step = routineStepById.get(entry.stepId);
    if (!step) continue;

    if (entry.startBy && step.status === "pending") {
      const startBy = date(entry.startBy);
      const warning = startByWarningByStepId.get(entry.stepId);
      const status = now >= startBy ? "missed" : warning?.status === "soon" ? "soon" : undefined;
      const anchorTitle = anchorTitleFor(entry, step);
      const forSuffix =
        entry.anchorKind === "sleep_plan"
          ? step.purpose === "wake"
            ? "after waking"
            : "before bedtime"
          : `for ${anchorTitle} ${clockTime(date(state.commitments.find((item) => item.id === entry.anchorId)?.startsAt ?? entry.startBy), timezone)}`;
      place(
        { startsAt: startBy, endsAt: startBy },
        {
          id: `start_by:${step.id}`,
          kind: "start_by",
          source: "engine",
          title: `Start ${step.title} by ${clockTime(startBy, timezone)}`,
          subtitle: forSuffix,
          entityId: step.id,
          ...(step.commitmentId ? { parentId: step.commitmentId } : entry.anchorId ? { parentId: entry.anchorId } : {}),
          marker: true,
          ...(status ? { urgency: status } : {}),
          stale
        }
      );
    }

    if (entry.waitStartsAt && entry.waitEndsAt) {
      const span = { startsAt: date(entry.waitStartsAt), endsAt: date(entry.waitEndsAt) };
      const clipped = clip(span, bounds);
      if (clipped) {
        const anchorTitle = anchorTitleFor(entry, step);
        waits.push({
          id: `wait:${entry.stepId}`,
          stepId: entry.stepId,
          title: `${step.title} · ready ${clockTime(date(entry.waitEndsAt), timezone)}`,
          anchorTitle,
          running: step.status === "completed",
          startsAt: clipped.startsAt,
          endsAt: clipped.endsAt,
          stale
        });
      }
    }
  }
  waits.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime() || a.id.localeCompare(b.id));
  const foldedWaits = foldWaitOverlaps(waits);

  // Sleep: actual times once known, planned otherwise. Also shades the background across its span.
  for (const sleep of state.sleepPlans) {
    if (sleep.status === "cancelled") continue;
    const startsAt = date(sleep.actualStartAt ?? sleep.plannedStartAt);
    const endsAt = date(sleep.actualWakeAt ?? sleep.plannedWakeAt);
    if (endsAt <= startsAt) continue;
    const clipped = clip({ startsAt, endsAt }, bounds);
    if (!clipped) continue;
    backgrounds.push({
      id: `sleep-band:${sleep.id}`,
      kind: "sleep",
      startsAt: clipped.startsAt,
      endsAt: clipped.endsAt
    });
    const recorded = sleep.status === "completed" || sleep.status === "sleeping";
    place(
      { startsAt, endsAt },
      {
        id: `sleep:${sleep.id}`,
        kind: "sleep",
        source: recorded ? "recorded" : "fixed",
        title: sleep.status === "sleeping" ? "Sleeping" : sleep.status === "completed" ? "Slept" : "Sleep",
        subtitle: sleepDurationLabel(minutesBetween(startsAt, endsAt), sleep.manual),
        entityId: sleep.id,
        minutes: minutesBetween(startsAt, endsAt)
      }
    );
  }

  // Recurring windows: something may happen in them, so they are outlines rather than blocks. A
  // window a routine already covers is drawn by that routine's instance instead; a window merely
  // linked to a routine step, with no instance to fold it into, is drawn saying whose job it is.
  const windowCoverage = routineWindowCoverage(state);
  for (const occurrence of state.occurrences) {
    if (occurrence.status === "cancelled" || occurrence.routineCovered) continue;
    const action = state.actions.find((item) => item.id === occurrence.actionId);
    const coveredBy = windowCoverage.get(occurrence.windowId);
    place(
      { startsAt: date(occurrence.windowStartsAt), endsAt: date(occurrence.windowEndsAt) },
      {
        id: `occurrence:${occurrence.id}`,
        kind: "occurrence",
        source: "fixed",
        title: action?.title ?? "Recurring action",
        subtitle: `${occurrence.windowName} window · ${coveredBy ? `covered by ${coveredBy}` : occurrence.status}`,
        entityId: occurrence.id,
        parentId: occurrence.actionId,
        window: true,
        ...(coveredBy ? { coveredBy } : {})
      }
    );
  }

  // What actually happened: sessions that ended, and the one running now. A session already drawn
  // as its commitment's recorded time is not drawn a second time here.
  for (const session of state.completedToday) {
    if (mergedSessionIds.has(session.id)) continue;
    place(
      { startsAt: date(session.startedAt), endsAt: date(session.endedAt) },
      {
        id: `session:${session.id}`,
        kind: "session",
        source: "recorded",
        title: session.actionTitle,
        subtitle: `${sessionResultLabel(session.result)} · ${session.activeMinutes} active min`,
        entityId: session.id,
        parentId: session.actionId,
        minutes: session.activeMinutes
      }
    );
  }
  const active = state.activeSession;
  if (active && !mergedSessionIds.has(active.id)) {
    const startedAt = date(active.startedAt);
    const plannedEndAt = date(active.plannedEndAt);
    const endsAt = new Date(Math.max(plannedEndAt.getTime(), now.getTime(), startedAt.getTime() + 60_000));
    place(
      { startsAt: startedAt, endsAt },
      {
        id: `active_session:${active.id}`,
        kind: "active_session",
        source: "recorded",
        title: active.targetTitle ?? "Current session",
        subtitle:
          active.status === "paused" ? "Paused" : active.status === "feedback" ? "Checkpoint due" : "Running now",
        entityId: active.id,
        parentId: active.targetId ?? active.actionId,
        minutes: active.plannedMinutes
      }
    );
  }

  // The engine's projected day: the current directive policy replayed forward from the calculation
  // time. Block 0 is the live directive itself and is drawn as such; every later block is a
  // projection and is labelled as one. Blocks for things the portal already draws from state —
  // commitments, sleep, routines — are skipped, so each of those appears once, from the fact that
  // asserts it. Empty stretches are never blocks: a long one gets a line saying why it is empty.
  const enginePlan = input.dayPlan ?? null;
  const displaced: DayPlanDisplaced[] = (enginePlan?.displaced ?? []).map((entry) => ({
    targetId: entry.targetId,
    latestSafeStartAt: date(entry.latestSafeStartAt),
    firstPlannedAt: entry.firstPlannedAt ? date(entry.firstPlannedAt) : null
  }));
  const displacedIds = new Set(displaced.map((entry) => entry.targetId));
  if (enginePlan) {
    const spans: PlanSpan[] = enginePlan.blocks
      .map((block, index) => ({ block, index, targetId: block.targetId, ...planSpan(block) }))
      // The recorded session is the fact block 0 stands for, and it is already drawn above.
      .filter((span) => !(active && span.index === 0))
      // A plan is only as fresh as its calculation: what it placed before now is clipped away, and
      // what it placed around now is clipped to now. Nothing is ever shifted forward to meet it.
      .filter((span) => span.endsAt > now)
      .map((span) => (span.startsAt < now ? { ...span, startsAt: now } : span));
    for (const span of spans) {
      if (span.block.kind !== "gap") continue;
      if (minutesBetween(span.startsAt, span.endsAt) < GAP_LABEL_MINUTES) continue;
      if (span.startsAt < bounds.startsAt || span.startsAt >= bounds.endsAt) continue;
      lines.push({
        id: `gap:${span.block.startsAt}`,
        kind: "gap",
        at: span.startsAt,
        label: `Nothing fits · ${span.block.title}`
      });
    }
    // Legs are drawn on their own, never merged into the work either side of them. A located
    // commitment now arrives as setup, then the leg, then the commitment, all with the same target;
    // merging by target would swallow the journey, which is the one part of it that is a movement.
    for (const span of spans) {
      if (span.block.kind !== "travel") continue;
      const block = span.block;
      const firm = span.index === 0;
      const wall = minutesBetween(span.startsAt, span.endsAt);
      const entityId = block.toLocationId ?? block.targetId ?? "travel";
      // Only the live leg has a stated provenance, and only when the directive is that same leg.
      const live =
        firm && input.currentDirective?.kind === "travel" && input.currentDirective.toLocationId === block.toLocationId
          ? input.currentDirective
          : null;
      const then = block.targetId ? planTargetTitle(block.targetId, state) : undefined;
      place(
        { startsAt: span.startsAt, endsAt: span.endsAt },
        {
          id: firm ? `directive:travel:${entityId}` : `plan:travel:${block.startsAt}`,
          kind: "travel",
          source: "engine",
          title: block.title,
          subtitle: then ? `${wall} min · then ${then}` : `${wall} min`,
          entityId,
          ...(block.toLocationId ? { toLocationId: block.toLocationId } : {}),
          ...(block.mode ? { mode: block.mode } : {}),
          ...(live ? { travelSource: live.source } : {}),
          ...(then ? { thenTitle: then } : {}),
          // The journey is wall clock through and through: no part of it is focused work, so the one
          // figure shown is the time it takes rather than a focused figure of zero beside it.
          minutes: wall,
          reason: block.reason,
          projected: !firm,
          stale
        }
      );
    }
    const work = spans.filter((span) => PLANNED_KINDS.has(span.block.kind));
    // Block 0 is the live directive and stays its own block; the maximum session length splits the
    // rest into consecutive sessions, which read as one piece of work and are drawn as one.
    const runs = [
      ...work.filter((span) => span.index === 0).map((span) => ({ first: span, blocks: [span], ...span })),
      ...mergeAdjacentSessions(work.filter((span) => span.index > 0))
    ];
    for (const run of runs) {
      const first = run.first.block;
      const firm = run.first.index === 0;
      const entityId = first.targetId ?? "recovery";
      const focused = run.blocks.reduce((sum, span) => sum + span.block.focusedMinutes, 0);
      const wall = minutesBetween(run.startsAt, run.endsAt);
      const tier = criticalTierLabel(first.tier);
      const parts = [focused > 0 ? `${focused} focused min over ${wall}` : `${wall} min`];
      if (run.blocks.length > 1) parts.push(`${run.blocks.length} sessions`);
      if (tier) parts.push(tier);
      place(
        { startsAt: run.startsAt, endsAt: run.endsAt },
        {
          id: firm ? `directive:${first.kind}:${entityId}` : `plan:${entityId}:${first.startsAt}`,
          kind: firm ? "directive" : "planned",
          source: "engine",
          title: first.title,
          subtitle: firm ? `Planned now · ${parts.join(" · ")}` : parts.join(" · "),
          entityId,
          ...(first.projectId ? { parentId: first.projectId } : {}),
          minutes: focused,
          wallMinutes: wall,
          ...(tier ? { tier } : {}),
          reason: first.reason,
          projected: !firm,
          ...(first.targetId && displacedIds.has(first.targetId) ? { displaced: true } : {}),
          stale
        }
      );
    }
    // Where the projected day says you are: a contiguous band, one entry per stay, clipped to the
    // day like everything else. The engine sends it empty when the current location is unknown,
    // because then nothing about later places is knowable either, and the strip simply does not draw.
    for (const stay of enginePlan.locations) {
      const clipped = clip({ startsAt: date(stay.startsAt), endsAt: date(stay.endsAt) }, bounds);
      if (!clipped) continue;
      locations.push({
        id: `location:${stay.startsAt}:${stay.locationId ?? "transit"}`,
        locationId: stay.locationId,
        label: stay.label,
        startsAt: clipped.startsAt,
        endsAt: clipped.endsAt
      });
    }
  }

  // The boundary a directive names is drawn either way. Without a projected day — a result stored by
  // an engine before 1.4.0 — the directive is also a length from now, so it is drawn from now, and
  // nothing later is given a time the engine did not state: the older behaviour, kept as the fallback.
  const directive = input.currentDirective;
  if (directive && nowAt && !active) {
    if (
      !enginePlan &&
      (directive.kind === "action" ||
        directive.kind === "deliverable" ||
        directive.kind === "routine_step" ||
        directive.kind === "sleep" ||
        directive.kind === "recovery") &&
      directive.recommendedMinutes > 0
    ) {
      const primary = input.recommendation?.primary ?? null;
      const wallClock =
        (directive.kind === "action" || directive.kind === "deliverable") && primary?.recommendedWallClockMinutes
          ? primary.recommendedWallClockMinutes
          : directive.recommendedMinutes;
      const focused = directive.recommendedMinutes;
      place(
        { startsAt: now, endsAt: new Date(now.getTime() + wallClock * 60_000) },
        {
          id: `directive:${directive.kind}:${"targetId" in directive ? directive.targetId : "recovery"}`,
          kind: "directive",
          source: "engine",
          title: directive.title,
          subtitle:
            wallClock !== focused
              ? `Planned now · ${focused} focused min over ${wallClock}`
              : `Planned now · ${wallClock} min`,
          entityId: "targetId" in directive ? directive.targetId : "recovery",
          minutes: focused,
          stale
        }
      );
    }
    if (directive.kind === "boundary") {
      const boundaryAt = date(directive.boundaryAt);
      if (boundaryAt >= bounds.startsAt && boundaryAt < bounds.endsAt)
        lines.push({
          id: "boundary",
          kind: "boundary",
          at: boundaryAt,
          label: directive.boundaryTitle ?? boundaryLabel(directive.boundaryKind)
        });
      // With a projected day the same work is already placed as a block; the marker would say it twice.
      if (directive.nextFit && !enginePlan) {
        const at = date(directive.nextFit.at);
        place(
          { startsAt: at, endsAt: at },
          {
            id: `next_fit:${directive.nextFit.targetId}`,
            kind: "next_fit",
            source: "engine",
            title: `Next fit: ${directive.nextFit.title}`,
            subtitle: `${directive.nextFit.recommendedMinutes} min once the boundary passes`,
            entityId: directive.nextFit.targetId,
            marker: true,
            minutes: directive.nextFit.recommendedMinutes,
            stale
          }
        );
      }
    }
  }

  // Next up: ranking order, not clock order. Chips, never blocks — and only when there is no
  // projected day to place that work properly. A stale projected day is still a plan; it is greyed,
  // not replaced by chips.
  for (const upcoming of enginePlan ? [] : input.upcomingDirectives) {
    untimed.push({
      id: `upcoming:${upcoming.kind}:${upcoming.targetId}`,
      kind: upcoming.kind,
      title: upcoming.title,
      minutes: upcoming.recommendedMinutes,
      reason: "Next in the engine's ranking"
    });
  }

  // Engine capacity shading, from the calculation time forward. Adjacent slots of one availability
  // merge so a free afternoon is one band, not sixteen.
  const slotBands = mergeSlots(input.slots, bounds);
  backgrounds.push(...slotBands);
  // Everything before now has happened; dim it.
  if (nowAt) backgrounds.push({ id: "elapsed", kind: "elapsed", startsAt: bounds.startsAt, endsAt: nowAt });
  else if (now >= bounds.endsAt)
    backgrounds.push({ id: "elapsed", kind: "elapsed", startsAt: bounds.startsAt, endsAt: bounds.endsAt });

  const horizonAt = zonedWallTimeOnDay(dayKey, state.settings.planningHorizonEnd, timezone);
  if (horizonAt >= bounds.startsAt && horizonAt < bounds.endsAt)
    lines.push({ id: "horizon", kind: "horizon", at: horizonAt, label: "Daily horizon" });

  // Latest-safe reservations, merged into wall-clock intervals and kept apart from the plan proper.
  const reserved: DayPlanItem[] = [];
  for (const block of mergeAdjacentBlocks(input.allocations)) {
    const clipped = clip(block, bounds);
    if (!clipped) continue;
    const target = reservationTarget(block.actionId, state);
    reserved.push({
      id: `reserved:${block.id}`,
      kind: "reserved",
      source: "reserved",
      title: target.title,
      subtitle: target.deadlineAt ? "Reserved by deadline" : "Reserved",
      entityId: block.actionId,
      parentId: block.projectId,
      ...clipped,
      minutes: block.minutes,
      ...(target.deadlineAt ? { deadlineAt: target.deadlineAt } : {}),
      stale
    });
  }

  // Soft placements: cosmetic room only, in the reserved lane, only from now onward (invariant 3 —
  // never in `allocations`, never the "Reserved by deadline" wording, never `untimed` or the main
  // track). The cadence outlook's own counts, read from the same run, give the "N of M fit" subtitle.
  const softPlacements: SoftPlacementWire[] = state.planning?.result?.softPlacements ?? [];
  const cadenceActions =
    (
      state.planning?.result?.weekOutlook as
        | {
            cadence?: {
              actions?: Array<{ actionId: string; expectedOccurrences: number; fittingOccurrences: number }>;
            };
          }
        | undefined
    )?.cadence?.actions ?? [];
  for (const soft of softPlacements) {
    const startsAt = date(soft.startsAt);
    const endsAt = date(soft.endsAt);
    if (endsAt <= now) continue;
    const clipped = clip({ startsAt: later(now, startsAt), endsAt }, bounds);
    if (!clipped) continue;
    const action = state.actions.find((item) => item.id === soft.actionId);
    const counts = cadenceActions.find((item) => item.actionId === soft.actionId);
    reserved.push({
      id: `soft:${soft.actionId}:${soft.startsAt}`,
      kind: "soft",
      source: "reserved",
      title: action?.title ?? "Cadence room",
      subtitle: counts ? `${counts.fittingOccurrences} of ${counts.expectedOccurrences} fit this week` : "Cadence room",
      entityId: soft.actionId,
      ...(action?.projectId ? { parentId: action.projectId } : {}),
      ...clipped,
      minutes: soft.minutes,
      stale
    });
  }

  items.sort(compareItems);
  reserved.sort(compareItems);
  lines.sort((a, b) => a.at.getTime() - b.at.getTime() || a.id.localeCompare(b.id));
  locations.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime() || a.id.localeCompare(b.id));
  return {
    bounds,
    items,
    reserved,
    backgrounds,
    lines,
    locations,
    waits: foldedWaits,
    untimed,
    nowAt,
    displaced,
    // The contract fixes `blocks[0].startsAt` at the calculation time, so the plan carries when it
    // was computed without a second field to keep in step.
    calculatedAt: enginePlan?.blocks[0] ? date(enginePlan.blocks[0].startsAt) : null
  };
}

/**
 * Fold runs of blocks that are too short to draw at this scale into one block that stands for the
 * whole run.
 *
 * The minimum block height keeps a five-minute step tappable, and the pixel cascade keeps inflated
 * blocks off each other; neither stops six of them in a row from reading as a wall of slivers with
 * no room for a word in any of them. A run that would be drawn taller than the time it occupies is
 * folded instead: one block over the run's true span, with the members listed inside it by name and
 * time. Every member keeps its own start and end in `steps`, so nothing about when they run is lost.
 *
 * Only a run of the same kind, source, and parent folds, and only a contiguous one — a fold has to
 * be one thing said shorter, never several things said as one. A run of five half-hour steps has
 * room to draw itself and is left alone, which is what the scale test decides.
 */
export function groupCrampedRuns(items: DayPlanItem[], pixelsPerHour: number, minimumHeight: number): DayPlanItem[] {
  if (minimumHeight <= 0 || pixelsPerHour <= 0) return items;
  const ordered = [...items].sort(compareItems);
  const folded: DayPlanItem[] = [];
  let run: DayPlanItem[] = [];
  const flush = () => {
    if (run.length >= GROUP_MIN_ITEMS && runIsCramped(run, pixelsPerHour, minimumHeight)) folded.push(foldRun(run));
    else folded.push(...run);
    run = [];
  };
  for (const item of ordered) {
    if (!foldable(item, pixelsPerHour, minimumHeight)) {
      flush();
      folded.push(item);
      continue;
    }
    const previous = run.at(-1);
    if (previous && !continuesRun(previous, item, pixelsPerHour, minimumHeight)) flush();
    run.push(item);
  }
  flush();
  return folded;
}

const spanPixels = (span: TimeSpan, pixelsPerHour: number) =>
  ((span.endsAt.getTime() - span.startsAt.getTime()) / 3_600_000) * pixelsPerHour;

/**
 * Caps the waits strip at two sub-columns (the day plan surfaces design note, "Waits strip":
 * "Overlapping waits share the strip in at most two sub-columns (`assignColumns`). A third overlap
 * folds into 'N waits'"). Input must already be sorted by `startsAt`.
 *
 * Two open slots are tracked in start order. A wait fits an empty slot on its own; when both slots
 * are already occupied, it folds into whichever slot's occupant ends soonest (the one about to free
 * up), rather than opening a third column. The folded slot's own `stepId`, `title`'s subject and
 * `anchorTitle` stay the earliest folded wait's — so a tap still opens the first wait's sheet — while
 * its span grows to cover every folded member and its `title` becomes "N waits".
 */
function foldWaitOverlaps(waits: DayPlanWait[]): DayPlanWait[] {
  interface Slot {
    members: DayPlanWait[];
    end: number;
  }
  const slots: [Slot | null, Slot | null] = [null, null];
  const result: DayPlanWait[] = [];
  const slotToWait = (slot: Slot): DayPlanWait => {
    const first = slot.members[0]!;
    if (slot.members.length === 1) return first;
    return {
      ...first,
      id: `waits-fold:${first.id}`,
      title: `${slot.members.length} waits`,
      endsAt: new Date(slot.end),
      running: slot.members.every((member) => member.running),
      stale: slot.members.some((member) => member.stale),
      foldedCount: slot.members.length
    };
  };
  for (const wait of waits) {
    const start = wait.startsAt.getTime();
    for (const index of [0, 1] as const) {
      const slot = slots[index];
      if (slot && slot.end <= start) {
        result.push(slotToWait(slot));
        slots[index] = null;
      }
    }
    const freeIndex = slots[0] === null ? 0 : slots[1] === null ? 1 : null;
    if (freeIndex !== null) {
      slots[freeIndex] = { members: [wait], end: wait.endsAt.getTime() };
      continue;
    }
    const target = slots[0]!.end <= slots[1]!.end ? 0 : 1;
    const slot = slots[target]!;
    slot.members.push(wait);
    slot.end = Math.max(slot.end, wait.endsAt.getTime());
  }
  for (const slot of slots) if (slot) result.push(slotToWait(slot));
  result.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime() || a.id.localeCompare(b.id));
  return result;
}

/**
 * A block the fold may take. Anything that carries its own drawn detail is excluded: a halo is
 * positioned against its block and a routine instance already lists steps of its own, so folding
 * either would lose what the block was drawn for. A block with no parent has nothing to be folded
 * *into* — a run of unrelated blocks that merely touch is not one stretch.
 */
function foldable(item: DayPlanItem, pixelsPerHour: number, minimumHeight: number): boolean {
  if (item.marker || item.window || item.halos?.length || item.steps?.length) return false;
  if (item.parentId === undefined) return false;
  return spanPixels(item, pixelsPerHour) < minimumHeight;
}

/**
 * Whether the next block belongs to the run the previous one started.
 *
 * The separation that matters is the drawn one, not the clock one. A block inflated to the minimum
 * height covers everything in the next `minimumHeight` pixels below its own top, so a step starting
 * inside that stretch cannot be drawn clear of its predecessor however small the real gap is — and a
 * gap nobody can see is not a gap the reader is being shown. Runs of planner-placed steps, which sit
 * five and ten minutes apart rather than end to end, are exactly this case, and folding them is the
 * difference between one named block and a column of slivers. A separation wide enough to draw ends
 * the run, and so does any change of kind, source, or parent.
 *
 * Recorded sessions are the one exception to the parent rule. A busy afternoon of short sessions on
 * different actions is still one thing, the record of what was done, and drawing each at the minimum
 * height pushed the rest of the day hours below the clock. Session activity lists every one of them.
 */
function continuesRun(previous: DayPlanItem, item: DayPlanItem, pixelsPerHour: number, minimumHeight: number): boolean {
  if (previous.kind !== item.kind || previous.source !== item.source) return false;
  if (previous.parentId !== item.parentId && !isRecordedSession(item)) return false;
  const gap = item.startsAt.getTime() - previous.endsAt.getTime();
  if (gap < 0) return false;
  if (gap <= GROUP_GAP_MINUTES * 60_000) return true;
  return spanPixels({ startsAt: previous.startsAt, endsAt: item.startsAt }, pixelsPerHour) < minimumHeight;
}

/**
 * Cramped means the run is drawn taller than it lasts: the inflation, not the clock, sets its size.
 * It is also the bound on how much of the day a fold may claim — the folded block spans the run's
 * real time, which this test has just established is less canvas than the slivers would have taken.
 */
function runIsCramped(run: DayPlanItem[], pixelsPerHour: number, minimumHeight: number): boolean {
  const span = spanPixels({ startsAt: run[0]!.startsAt, endsAt: run.at(-1)!.endsAt }, pixelsPerHour);
  return span < run.length * minimumHeight;
}

const isRecordedSession = (item: DayPlanItem) => item.kind === "session" && item.source === "recorded";

function foldRun(run: DayPlanItem[]): DayPlanItem {
  const first = run[0]!;
  const last = run.at(-1)!;
  const shared = run.every((item) => item.groupTitle === first.groupTitle) ? first.groupTitle : undefined;
  const sessions = isRecordedSession(first);
  const minutes = minutesBetween(first.startsAt, last.endsAt);
  return {
    ...first,
    // Named from the first member so a tap opens that member's editor, which is where the run starts.
    id: `group:${first.id}`,
    title: sessions
      ? `${run.length} sessions`
      : shared
        ? `${shared} · ${run.length} steps`
        : `${run.length} quick blocks`,
    subtitle: `${minutes} min`,
    startsAt: first.startsAt,
    endsAt: last.endsAt,
    clippedStart: first.clippedStart,
    clippedEnd: last.clippedEnd,
    minutes,
    grouped: true,
    steps: run.map((item) => ({ id: item.id, title: item.title, startsAt: item.startsAt, endsAt: item.endsAt }))
  };
}

/** One block of the engine's projected day, as a span the layout helpers can merge and clip. */
interface PlanSpan extends TimeSpan {
  block: EngineDayPlanBlock;
  /** Position in the engine's own list; block 0 is the live directive and is never simulated. */
  index: number;
  targetId: string | null;
}

const planSpan = (block: EngineDayPlanBlock): TimeSpan => ({
  startsAt: new Date(block.startsAt),
  endsAt: new Date(block.endsAt)
});

/**
 * What a journey is for, named from whatever its target turns out to be. The engine gives a leg the
 * id of the thing waiting at the other end — a commitment, an action, a deliverable, a night's sleep
 * — without saying which kind it is, so every store is asked in turn and the id itself is the last
 * resort rather than a blank.
 */
function planTargetTitle(targetId: string, state: DayPlanState): string {
  return (
    state.commitments.find((item) => item.id === targetId)?.title ??
    state.actions.find((item) => item.id === targetId)?.title ??
    state.deliverables.find((item) => item.id === targetId)?.title ??
    // a bedtime/wake routine's target is a `routine_steps` row now, like a commitment's own
    // preparation step — both resolve their title here the same way (this also closes a pre-existing
    // gap: a commitment-anchored `routine_step` target was never resolved by this function before).
    state.routineSteps.find((item) => item.id === targetId)?.title ??
    (state.sleepPlans.some((item) => item.id === targetId) ? "sleep" : undefined) ??
    targetId
  );
}

function compareItems(a: DayPlanItem, b: DayPlanItem): number {
  return (
    a.startsAt.getTime() - b.startsAt.getTime() ||
    a.endsAt.getTime() - b.endsAt.getTime() ||
    KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
    a.id.localeCompare(b.id)
  );
}

function commitmentSubtitle(commitment: StoredCommitment, state: DayPlanState): string {
  const parts: string[] = [];
  if (commitment.status === "tentative") parts.push("Tentative");
  if (commitment.location) parts.push(commitment.location);
  const project = commitment.projectId ? state.projects.find((item) => item.id === commitment.projectId) : undefined;
  if (project) parts.push(project.title);
  return parts.join(" · ");
}

/** One stretch of measured time, from a finished session or the running one, normalised to a span. */
interface TrackedSession extends TimeSpan {
  id: string;
  activeMinutes: number;
  /** How the row should read: the session's result, or what the running one is doing. */
  label: string;
}

/**
 * Time measured against fixed commitments, by commitment id.
 *
 * Start/Stop on a commitment writes a session whose target is the commitment, so the link is
 * already in the data: `targetType` says the target is a commitment and `actionId` is its id. The
 * running session says the same through `targetId`. Sessions on one commitment are returned in
 * start order, so the last of them is the one whose wording describes where the work now stands.
 */
function trackedCommitmentSessions(state: DayPlanState, now: Date): Map<string, TrackedSession[]> {
  const byCommitment = new Map<string, TrackedSession[]>();
  const add = (commitmentId: string, session: TrackedSession) => {
    const existing = byCommitment.get(commitmentId);
    if (existing) existing.push(session);
    else byCommitment.set(commitmentId, [session]);
  };
  for (const session of state.completedToday) {
    if (session.targetType !== "fixed_commitment" || !session.actionId) continue;
    add(session.actionId, {
      id: session.id,
      startsAt: date(session.startedAt),
      endsAt: date(session.endedAt),
      activeMinutes: session.activeMinutes,
      label: sessionResultLabel(session.result)
    });
  }
  const active = state.activeSession;
  if (active && active.targetType === "fixed_commitment" && active.targetId) {
    const startsAt = date(active.startedAt);
    add(active.targetId, {
      id: active.id,
      startsAt,
      // The same reach the running session's own block is given: it has not ended, so it is drawn
      // to whichever of its planned end and the present moment is later.
      endsAt: new Date(Math.max(date(active.plannedEndAt).getTime(), now.getTime(), startsAt.getTime() + 60_000)),
      activeMinutes: Math.round(active.activeElapsedSeconds / 60),
      label: active.status === "paused" ? "Paused" : active.status === "feedback" ? "Checkpoint due" : "Running now"
    });
  }
  for (const sessions of byCommitment.values()) sessions.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  return byCommitment;
}

/**
 * Which routine step, if any, each recurring-action window is the same work as, by window id.
 *
 * Two kinds of step can say so: a tile in a routine preset (Settings → Routines) and a preparation
 * step attached to a commitment (Today → Preparation). Only an active preset counts, and only the
 * first step to claim a window: a window covered twice is still covered once as far as the day is
 * concerned. Preparation is read first, because a step placed against a real commitment on the day
 * is the more specific claim.
 */
function routineWindowCoverage(state: DayPlanState): Map<string, string> {
  const coverage = new Map<string, string>();
  for (const step of state.routineSteps) {
    if (!step.actionWindowId || coverage.has(step.actionWindowId) || step.status === "cancelled") continue;
    const commitment = state.commitments.find((item) => item.id === step.commitmentId);
    coverage.set(step.actionWindowId, `${step.title} · ${commitment?.title ?? "preparation"}`);
  }
  for (const preset of state.routinePresets) {
    if (preset.status !== "active") continue;
    for (const step of preset.steps) {
      if (!step.actionWindowId || coverage.has(step.actionWindowId)) continue;
      coverage.set(step.actionWindowId, `${step.title} · ${preset.activityName || preset.name}`);
    }
  }
  return coverage;
}

function sessionResultLabel(result: PortalState["completedToday"][number]["result"]): string {
  switch (result) {
    case "completed":
      return "Completed";
    case "stopped":
      return "Stopped";
    case "blocked":
      return "Blocked";
    case "did_not_start":
      return "Did not start";
    case "skipped":
      return "Skipped";
  }
}

function boundaryLabel(kind: "daily_horizon" | "commitment" | "sleep" | "capacity"): string {
  switch (kind) {
    case "daily_horizon":
      return "Daily horizon";
    case "commitment":
      return "Commitment";
    case "sleep":
      return "Sleep";
    case "capacity":
      return "Capacity opens";
  }
}

function reservationTarget(actionId: string, state: DayPlanState): { title: string; deadlineAt?: Date } {
  if (actionId.startsWith("deliverable:")) {
    const deliverable = state.deliverables.find((item) => item.id === actionId.slice("deliverable:".length));
    if (!deliverable) return { title: "Deliverable" };
    const deadline = deliverable.internalDeadlineAt ?? deliverable.externalDeadlineAt;
    return { title: deliverable.title, ...(deadline ? { deadlineAt: new Date(deadline) } : {}) };
  }
  const action = state.actions.find((item) => item.id === actionId);
  if (!action) return { title: "Ranked work" };
  const project = state.projects.find((item) => item.id === action.projectId);
  const deadline = action.deadlineAt ?? project?.internalDeadlineAt ?? project?.externalDeadlineAt;
  return { title: action.title, ...(deadline ? { deadlineAt: new Date(deadline) } : {}) };
}

function mergeSlots(slots: ClientSlot[], bounds: ZonedDayBounds): DayPlanBackground[] {
  const ordered = [...slots]
    .map((slot) => ({ ...slot, clipped: clip(slot, bounds) }))
    .filter((slot) => slot.clipped !== null)
    .sort((a, b) => a.clipped!.startsAt.getTime() - b.clipped!.startsAt.getTime());
  const bands: DayPlanBackground[] = [];
  for (const slot of ordered) {
    const { startsAt, endsAt } = slot.clipped!;
    const last = bands[bands.length - 1];
    if (last && last.kind === slot.availability && last.endsAt.getTime() >= startsAt.getTime()) {
      if (endsAt > last.endsAt) last.endsAt = endsAt;
      continue;
    }
    bands.push({
      id: `slot:${slot.availability}:${startsAt.toISOString()}`,
      kind: slot.availability,
      startsAt,
      endsAt
    });
  }
  return bands;
}
