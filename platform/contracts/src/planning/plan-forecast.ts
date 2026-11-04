import { z } from "zod";
import { portalStateSchema } from "../portal/state-schema.js";
import { transportModeSchema } from "./context-model.js";
import { deliverableProjectionSchema } from "./deliverable-projection.js";

const journeyStatsSchema = z.object({
  count: z.number().int().nonnegative(),
  median: z.number().finite().min(0),
  p80: z.number().finite().min(0),
  p95: z.number().finite().min(0)
});

/** One row of the journey summary (`platform/database/src/planning/journey-summary.ts`). */
const journeyCellSchema = z.object({
  fromLocationId: z.string().min(1),
  toLocationId: z.string().min(1),
  mode: transportModeSchema,
  dayType: z.enum(["weekday", "weekend"]).nullable(),
  band: z.number().int().nonnegative().nullable(),
  pooled: journeyStatsSchema,
  own: journeyStatsSchema
});

const journeyLatestSchema = z.object({
  fromLocationId: z.string().min(1),
  toLocationId: z.string().min(1),
  mode: transportModeSchema,
  minutes: z.number().finite().min(0),
  departedAt: z.string().datetime({ offset: true }),
  observedAt: z.string().datetime({ offset: true })
});

/**
 * The journey store's per-cell summary, computed once in SQL (the travel time model design note,
 * "What the engine receives"). Defaults to empty so an older stored request, or an issue snapshot
 * predating this field, still parses — the engine then falls through every tier to the stored-minutes
 * and straight-line fallbacks, exactly as it did before the journey store existed.
 */
export const journeySummarySchema = z.object({
  cells: z.array(journeyCellSchema).default([]),
  latest: z.array(journeyLatestSchema).default([])
});

export const PLAN_FORECAST_CONTRACT_VERSION = "1" as const;

const isoDateTime = z.string().datetime({ offset: true });
const jsonPrimitiveSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type JsonValue = z.infer<typeof jsonPrimitiveSchema> | JsonValue[] | { [key: string]: JsonValue };
export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([jsonPrimitiveSchema, z.array(jsonValueSchema), z.record(z.string(), jsonValueSchema)])
);

export const continuationRequestSchema = z.object({
  actionId: z.string().min(1),
  requestedMinutes: z.number().int().positive().optional()
});

/** Must stay under MAX_AUTOMATIC_DAYS (400) in engine/core's capacity.ts. The runtime plans 180 days ahead; the cap keeps a stray request from making the engine expand years of occurrences. */
export const PLAN_FORECAST_MAX_HORIZON_DAYS = 366;

export const planForecastRequestSchema = z
  .object({
    contractVersion: z.literal(PLAN_FORECAST_CONTRACT_VERSION),
    requestId: z.string().uuid(),
    inputVersion: z.string().min(1).max(128),
    calculatedAt: isoDateTime,
    horizonEnd: isoDateTime,
    state: portalStateSchema,
    /**
     * Derived by the Deliverable Workspace, not read out of `state`. The engine plans against these
     * projections and never inspects a deliverable's criteria, blockers, evidence or proposals.
     */
    deliverables: z.array(deliverableProjectionSchema).default([]),
    /** The journey summary (see `journeySummarySchema`), computed once per request in SQL. */
    journeys: journeySummarySchema.default({ cells: [], latest: [] }),
    continuation: continuationRequestSchema.optional()
  })
  .superRefine((request, context) => {
    const span = new Date(request.horizonEnd).getTime() - new Date(request.calculatedAt).getTime();
    if (span <= 0) {
      context.addIssue({ code: "custom", path: ["horizonEnd"], message: "horizonEnd must be after calculatedAt" });
    } else if (span > PLAN_FORECAST_MAX_HORIZON_DAYS * 86_400_000) {
      context.addIssue({
        code: "custom",
        path: ["horizonEnd"],
        message: `horizonEnd must be within ${PLAN_FORECAST_MAX_HORIZON_DAYS} days of calculatedAt`
      });
    }
  });

export const planningStatusSchema = z.enum(["current", "pending", "stale", "unavailable", "failed"]);

/** A ranked target named by a directive that is not itself the thing to do now. */
const nextFitTargetSchema = z.object({
  kind: z.enum(["action", "deliverable"]),
  targetId: z.string(),
  title: z.string(),
  recommendedMinutes: z.number().int().nonnegative()
});

/**
 * How well the engine knows a journey's length. `live` is a fresh Google sample from the current
 * place; `own` and `typical` are the journey store's own-trip and pooled tiers; `fallback` is the location's stored figure; `assumed` is that
 * figure read backwards (the way there standing in for the way home); `estimated` is straight-line
 * distance at a per-mode speed, the last resort between two places nobody has measured; `default` is the engine's
 * flat 30-minute guess when nothing at all gives a figure. `measured` is
 * kept only so a result stored before the journey store existed still parses; the engine never emits
 * it again.
 */
export const travelSourceSchema = z.enum([
  "live",
  "own",
  "typical",
  "fallback",
  "estimated",
  "assumed",
  "default",
  "measured"
]);
export type TravelSource = z.infer<typeof travelSourceSchema>;

/** What the journey is for: the thing that starts once you have arrived. */
const travelThenSchema = z.object({
  // `routine_instance` dropped: a sleep-anchored routine step a journey home leads into is
  // now the same `routine_step` kind a commitment's own preparation step already used.
  kind: z.enum(["action", "deliverable", "commitment", "sleep", "routine_step"]),
  targetId: z.string(),
  title: z.string(),
  recommendedMinutes: z.number().int().nonnegative()
});

export const currentDirectiveSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("action"),
    targetId: z.string(),
    title: z.string(),
    recommendedMinutes: z.number().int().nonnegative(),
    /** Deadline work still inside its break: it is the pick, but starts no earlier than this. */
    notBefore: isoDateTime.optional()
  }),
  z.object({
    kind: z.literal("sleep"),
    targetId: z.string(),
    title: z.string(),
    recommendedMinutes: z.number().int().nonnegative()
  }),
  // Covers both anchors: a commitment's own preparation step and a bedtime/wake step alike,
  // since both are `routine_steps` rows now.
  z.object({
    kind: z.literal("routine_step"),
    targetId: z.string(),
    title: z.string(),
    recommendedMinutes: z.number().int().nonnegative()
  }),
  // The engine allocates attention to the enduring deliverable only. BCR phase and internal step
  // selection remain workspace concerns.
  z.object({
    kind: z.literal("deliverable"),
    targetId: z.string(),
    title: z.string(),
    recommendedMinutes: z.number().int().nonnegative(),
    /** Deadline work still inside its break: it is the pick, but starts no earlier than this. */
    notBefore: isoDateTime.optional()
  }),
  /**
   * Getting somewhere is the thing to do now: the leg to a located commitment, home for sleep, or the
   * journey a trip-eligible recommendation needs. A kind rather than a field on another directive,
   * because it is exclusive — a session cannot be started against it — and the projected day has to
   * draw it. It never pre-empts a protected window: a plan-required leg *is* protected (it extends the
   * commitment's own window), and a directed trip is bounded by the next protected start.
   */
  z.object({
    kind: z.literal("travel"),
    toLocationId: z.string(),
    title: z.string(),
    /** The journey itself, in wall-clock minutes: the allowing figure. */
    recommendedMinutes: z.number().int().nonnegative(),
    mode: transportModeSchema.optional(),
    source: travelSourceSchema,
    /** The tier's median (or the live/fallback figure), for display beside the allowing minutes. */
    typicalMinutes: z.number().int().nonnegative().optional(),
    /** When to leave, for a plan-required leg. Absent for a directed trip, which has no such anchor. */
    leaveBy: isoDateTime.optional(),
    /** How many samples the figure rests on; 0 for a fallback, assumed or estimated journey. */
    sampleCount: z.number().int().nonnegative().optional(),
    /** Set when the leg starts from an assumed origin rather than a confirmed live location. */
    originAssumed: z.boolean().optional(),
    /** Deadline work still inside its break: the break comes first, so leave no earlier than this. */
    notBefore: isoDateTime.optional(),
    /** Absent only when the journey serves nothing in particular, as when going home ends the day. */
    // oxlint-disable-next-line unicorn/no-thenable -- `then` is a domain field of the travel directive, not a promise continuation
    then: travelThenSchema.optional()
  }),
  // No work fits but protected recovery capacity is open, so rest is the deliberate recommendation.
  z.object({ kind: z.literal("recovery"), title: z.string(), recommendedMinutes: z.number().int().nonnegative() }),
  // Nothing fits only because a context nobody has answered stands in the way. The question is the
  // directive, and the candidate is what would lead if the answer were yes.
  z.object({
    kind: z.literal("answer"),
    title: z.string(),
    recommendedMinutes: z.literal(0),
    question: z.string(),
    contextIds: z.array(z.string()),
    candidate: nextFitTargetSchema.nullable()
  }),
  // Nothing fits before a boundary — the daily horizon, a commitment, sleep, or capacity opening —
  // so the directive names the boundary and the first thing that fits after it.
  z.object({
    kind: z.literal("boundary"),
    title: z.string(),
    recommendedMinutes: z.literal(0),
    boundaryAt: isoDateTime,
    boundaryKind: z.enum(["daily_horizon", "commitment", "sleep", "capacity"]),
    boundaryTitle: z.string().optional(),
    // Whether `boundaryAt` is where the named commitment's protection starts ("before") or ends
    // ("until"); absent means start, which is every older result.
    boundaryEdge: z.enum(["start", "end"]).optional(),
    nextFit: nextFitTargetSchema.extend({ at: isoDateTime }).nullable()
  }),
  z.object({ kind: z.literal("none"), title: z.string(), recommendedMinutes: z.literal(0) })
]);

/** What comes after the current directive, in routine sequence or plan ranking order — never the current item itself. */
export const upcomingDirectiveSchema = z.object({
  kind: z.enum(["action", "routine_step", "commitment", "travel"]),
  targetId: z.string(),
  title: z.string(),
  recommendedMinutes: z.number().int().nonnegative(),
  /**
   * When the item actually starts, present only where the queue reaches past a boundary that makes
   * "next" ambiguous — currently the wake time of a sleep directive, on the far side of which an item
   * can be days away. Optional because stored results predating it must still replay.
   */
  at: isoDateTime.optional()
});

/**
 * One block of the engine's projected day: what the current directive policy would have you doing
 * from `startsAt` to `endsAt` if the day went as expected. `blocks[0]` is the live current
 * directive; later blocks are the same policy re-run at a synthetic later instant.
 */
export const dayPlanBlockSchema = z.object({
  startsAt: isoDateTime,
  endsAt: isoDateTime,
  // `routine_instance` dropped: a bedtime/wake step draws as an ordinary `routine_step`
  // block now, the same as a commitment's own preparation step.
  kind: z.enum(["action", "deliverable", "commitment", "sleep", "routine_step", "recovery", "travel", "gap"]),
  /** The directive's target (action, deliverable, commitment, sleep plan, routine); null for gaps and recovery. */
  targetId: z.string().nullable(),
  title: z.string(),
  projectId: z.string().optional(),
  /** Travel blocks only: where the leg goes, and how. */
  toLocationId: z.string().optional(),
  mode: transportModeSchema.optional(),
  /** Focused minutes the block deducts from remaining effort; zero for anything that is not work. */
  focusedMinutes: z.number().int().nonnegative(),
  wallClockMinutes: z.number().int().nonnegative(),
  /** Named critical tier of a work block, as the ranking assessed it at that instant. */
  tier: z.string().optional(),
  reason: z.string(),
  /** `firm`: block 0 and fixed facts (commitments, sleep, routines). `projected`: simulated. */
  confidence: z.enum(["firm", "projected"]),
  /** Why a gap block is empty: waiting on a boundary, an unanswered context, or nothing at all. */
  gapKind: z.enum(["boundary", "answer", "none"]).optional(),
  boundaryKind: z.enum(["daily_horizon", "commitment", "sleep", "capacity"]).optional()
});

/**
 * The forward-simulated day: an execution projection of the same policy that produces
 * `currentDirective`. `policy_replay` re-runs ranking and precedence against the run's own schedule
 * (slots and forecasts frozen at calculation); `full_replay` would re-plan at every step and is
 * reserved for a later engine. `truncated` says the step cap was reached before `through`.
 */
export const dayPlanSchema = z.object({
  through: isoDateTime,
  mode: z.enum(["policy_replay", "full_replay"]),
  blocks: z.array(dayPlanBlockSchema),
  truncated: z.boolean(),
  /**
   * Units whose latest safe start falls inside the plan but which the plan does not reach in time —
   * a deadline the projected day would displace. Reservations are never moved to fix this.
   */
  displaced: z
    .array(z.object({ targetId: z.string(), latestSafeStartAt: isoDateTime, firstPlannedAt: isoDateTime.nullable() }))
    .default([]),
  /**
   * Where the projected day says you are, as a contiguous band beside the blocks. `locationId` is null
   * while in transit. Empty when the current location is unknown, since then nothing about later
   * places is knowable either.
   */
  locations: z
    .array(
      z.object({
        startsAt: isoDateTime,
        endsAt: isoDateTime,
        locationId: z.string().nullable(),
        label: z.string()
      })
    )
    .default([])
});

/**
 * One routine step's placement facts:
 * a pending step's hands-on interval, or a non-pending step's running wait, plus the latest legal
 * start, earliest legal start and the band it landed in. One entry per placed or running-wait step.
 */
export const stepPlacementSchema = z.object({
  stepId: z.string(),
  anchorKind: z.enum(["commitment", "sleep_plan"]),
  anchorId: z.string(),
  /** Pending steps only: the placer's hands-on interval. */
  placedStartAt: isoDateTime.optional(),
  placedEndAt: isoDateTime.optional(),
  /** Any step with a wait not yet over: from placedEndAt (pending) or completedAt (completed). */
  waitStartsAt: isoDateTime.optional(),
  waitEndsAt: isoDateTime.optional(),
  startBy: isoDateTime.optional(),
  earliestAt: isoDateTime.optional(),
  /** The band whose occurrence the step was placed in; absent for a chain-slot placement. */
  bandId: z.string().optional()
});
export type StepPlacementWire = z.infer<typeof stepPlacementSchema>;

/**
 * One soft interval of the cadence pass's fitting occurrences:
 * cosmetic room only, never a reservation, never touching allocations or the deadline pipeline.
 */
export const softPlacementSchema = z.object({
  actionId: z.string(),
  startsAt: isoDateTime,
  endsAt: isoDateTime,
  minutes: z.number().int().positive()
});
export type SoftPlacementWire = z.infer<typeof softPlacementSchema>;

/** One journey edge on a commitment's timeline. */
const commitmentJourneyEdgeSchema = z.object({
  fromLocationId: z.string(),
  toLocationId: z.string(),
  mode: transportModeSchema.optional(),
  minutes: z.number().int().nonnegative(),
  typicalMinutes: z.number().int().nonnegative(),
  source: travelSourceSchema,
  sampleCount: z.number().int().nonnegative(),
  originAssumed: z.boolean().optional()
});

/**
 * A commitment's eight edges, the single definition every
 * engine consumer reads: `id`, the edges as ISO strings (optional ones present only when computed),
 * whether tracked overtime stretched it, and whether a late arrival at it matters. One entry per
 * commitment in `protectedList`, sorted by id.
 */
export const commitmentTimelineSchema = z.object({
  id: z.string(),
  /** The protected start: `leaveBy` with a journey, else `startsAt` minus setup. */
  setupStartsAt: isoDateTime,
  /** Present only with a journey. */
  leaveBy: isoDateTime.optional(),
  /** `startsAt` minus margin with a journey, else `startsAt`. */
  arriveBy: isoDateTime,
  startsAt: isoDateTime,
  endsAt: isoDateTime,
  /** The later of `endsAt` and any tracked end. */
  effectiveEndsAt: isoDateTime,
  freeAt: isoDateTime,
  /** Present only with a homeward leg attached. */
  homeAt: isoDateTime.optional(),
  /** `homeAt` when present, else `freeAt`. */
  protectedUntil: isoDateTime,
  /** `effectiveEndsAt > endsAt`. */
  overtime: z.boolean(),
  /** Absent on the row reads as true, matching `commitmentSchema.latenessMatters`'s own default. */
  latenessMatters: z.boolean(),
  /** The journey before the commitment, present only when the projection attached one. */
  journeyBefore: commitmentJourneyEdgeSchema.optional(),
  /** The journey home after the commitment, present only when the projection attached one. */
  journeyAfter: commitmentJourneyEdgeSchema.optional(),
  /**
   * Why a commitment with a place got no journey figure at all (the travel time model design note,
   * "Unplaceable commitments"): `no_place` for free-text `location` with no `locationId`, `no_estimate`
   * for a located place with no coordinates, no stored minutes and no samples (its `leaveBy` then rests on
   * an assumed journey time, so the travel time is a guess). Absent means a journey was resolved (or
   * none was needed).
   */
  travelGap: z.enum(["no_place", "no_estimate"]).optional()
});

/**
 * Whether getting ready for the next fixed commitment is keeping pace with the clock. Reported for
 * at most one commitment at a time — whichever one's preparation is currently underway or due — and
 * omitted entirely when nothing is being prepared for right now (`computePrepPace`, engine.ts).
 *
 * `requiredMinutes` is the remaining before-phase routine-step time plus the commitment's own
 * `setupBeforeMinutes` and the travel leg the engine already computed for it (never recomputed here).
 * `availableMinutes` is the clock minutes from now until the commitment's `startsAt` less any arrival
 * margin a journey carries — the moment the chain must be finished by. `minutesBehind` is
 * `max(0, requiredMinutes - availableMinutes)`; `status` is `behind` when that is positive, `tight`
 * when the spare minutes are under 5, else `on_track`.
 */
export const prepPaceSchema = z.object({
  commitmentId: z.string(),
  commitmentTitle: z.string(),
  commitmentStartsAt: isoDateTime,
  requiredMinutes: z.number().int().nonnegative(),
  /** Can go negative once the boundary it names has already passed. */
  availableMinutes: z.number().int(),
  minutesBehind: z.number().int().nonnegative(),
  status: z.enum(["on_track", "tight", "behind"]),
  /**
   * Where the forward simulation says you'll arrive, at this pace (the routine step timing design note
   * "Prep pace"). Optional so results stored by earlier engine versions still parse.
   */
  projectedArriveAt: isoDateTime.optional(),
  /** `max(0, projectedArriveAt + margin − startsAt)`. Optional for the same reason. */
  projectedLateMinutes: z.number().int().nonnegative().optional()
});

/**
 * A pending flexible commitment before-step offerable right now, ranked beside ordinary work
 * Every offerable step less
 * the current directive, ordered by `placedStartAt`.
 */
export const canDoNowItemSchema = z.object({
  stepId: z.string(),
  commitmentId: z.string(),
  title: z.string(),
  durationMinutes: z.number().int().nonnegative(),
  placedStartAt: isoDateTime,
  startBy: isoDateTime.optional()
});
export type CanDoNowItem = z.infer<typeof canDoNowItemSchema>;

/**
 * A pending step whose latest start (`startBy`) is close or past (the routine step timing design note
 * "Warnings and arrival projection"). Sorted by `startBy` across every anchor.
 */
export const startByWarningSchema = z.object({
  stepId: z.string(),
  anchorId: z.string(),
  anchorTitle: z.string(),
  title: z.string(),
  startBy: isoDateTime,
  status: z.enum(["soon", "missed"])
});
export type StartByWarning = z.infer<typeof startByWarningSchema>;

/**
 * One surviving choice of the stay-up offer: staying up N more minutes tonight, and the night that
 * results.
 */
export const stayUpOfferChoiceSchema = z.object({
  minutes: z.number().int().positive(),
  bedtimeAt: isoDateTime,
  wakeAt: isoDateTime,
  sleepMinutes: z.number().int().nonnegative()
});

/**
 * Tonight's offer to trade sleep for work on a project whose deadline-based health is behind, when a
 * surviving choice exists. At most one per
 * night, and only while unanswered.
 */
export const stayUpOfferSchema = z.object({
  nightId: z.string(),
  projectId: z.string(),
  projectTitle: z.string(),
  actionId: z.string(),
  actionTitle: z.string(),
  minutesBehind: z.number().int().nonnegative(),
  opensAt: isoDateTime,
  closesAt: isoDateTime,
  choices: z.array(stayUpOfferChoiceSchema).min(1)
});
export type StayUpOffer = z.infer<typeof stayUpOfferSchema>;
export type StayUpOfferChoice = z.infer<typeof stayUpOfferChoiceSchema>;

export const planForecastResponseSchema = z.object({
  contractVersion: z.literal(PLAN_FORECAST_CONTRACT_VERSION),
  requestId: z.string().uuid(),
  inputVersion: z.string().min(1),
  engineVersion: z.string().min(1),
  calculatedAt: isoDateTime,
  validUntil: isoDateTime,
  derivedState: z.object({
    sleepPlans: z.array(jsonValueSchema),
    occurrences: z.array(jsonValueSchema),
    // `routineInstances` dropped: a sleep-anchored routine step is a `routineSteps` row now.
    routineSteps: z.array(jsonValueSchema),
    commitmentRepeats: z.array(jsonValueSchema).default([]),
    /**
     * The one timeline per commitment, `commitmentTimelineSchema`
     * above. Optional so results stored by earlier engine versions still parse; a reader treats
     * absent as `[]`. The engine always emits it.
     */
    commitmentTimelines: z.array(commitmentTimelineSchema).optional(),
    /**
     * One entry per placed or running-wait routine step. Typed
     * (not `schedule`'s untyped JSON) so the portal never reinterprets it; defaults to `[]` so a
     * result stored before this plan still parses.
     */
    stepPlacements: z.array(stepPlacementSchema).default([])
  }),
  schedule: jsonValueSchema,
  recommendation: jsonValueSchema,
  currentDirective: currentDirectiveSchema,
  upcomingDirectives: z.array(upcomingDirectiveSchema).max(3).default([]),
  continuation: jsonValueSchema.nullable(),
  /**
   * The detailed band read as a week: reserved minutes by project, free minutes, projects whose
   * required pace exceeds their reserved share, and minutes by area as a stewardship signal. Optional
   * so results stored by earlier engine versions still parse.
   */
  weekOutlook: jsonValueSchema.optional(),
  /** The projected day (§12 of the logic design). Optional so results stored before 1.4.0 still parse. */
  dayPlan: dayPlanSchema.optional(),
  /** Present only while a commitment's preparation is under way or due; see `prepPaceSchema`. */
  prepPace: prepPaceSchema.optional(),
  /**
   * Tonight's stay-up-for-work offer, present only while its five conditions all hold and it is
   * unanswered.
   */
  stayUpOffer: stayUpOfferSchema.optional(),
  /**
   * Every offerable flexible step, less the current directive (the routine step timing design note
   * "Flexible steps offered early"). Optional so results stored by earlier engine versions still
   * parse; a reader treats absent as `[]`.
   */
  canDoNow: z.array(canDoNowItemSchema).optional(),
  /**
   * Every pending step with a `startBy` that is soon or missed (the routine step timing design note
   * "Warnings and arrival projection"). Optional for the same reason.
   */
  startByWarnings: z.array(startByWarningSchema).optional(),
  /**
   * The cadence soft pass's own intervals, one per fitting occurrence. Cosmetic room only: never a reservation, never in `allocations`. Defaults
   * to `[]` so a result stored before this plan still parses.
   */
  softPlacements: z.array(softPlacementSchema).default([])
});

export const planningRuntimeStateSchema = z.object({
  status: planningStatusSchema,
  lastSuccessfulAt: isoDateTime.optional(),
  validUntil: isoDateTime.optional(),
  nextAttemptAt: isoDateTime.optional(),
  message: z.string().optional(),
  result: planForecastResponseSchema.optional()
});

export type CommitmentTimelineWire = z.infer<typeof commitmentTimelineSchema>;
export type PlanForecastRequest = z.infer<typeof planForecastRequestSchema>;
export type PlanForecastResponse = z.infer<typeof planForecastResponseSchema>;
export type PlanningRuntimeState = z.infer<typeof planningRuntimeStateSchema>;
export type CurrentDirective = z.infer<typeof currentDirectiveSchema>;
export type UpcomingDirective = z.infer<typeof upcomingDirectiveSchema>;
export type DayPlanBlock = z.infer<typeof dayPlanBlockSchema>;
export type DayPlan = z.infer<typeof dayPlanSchema>;
export type PrepPace = z.infer<typeof prepPaceSchema>;
export type JourneySummaryWire = z.infer<typeof journeySummarySchema>;
