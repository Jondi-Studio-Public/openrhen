import { z } from "zod";
import { sourceIdSchema } from "../connections/connection-id.js";
import { actionStatusSchema, energyTypeSchema, lifecycleStatusSchema } from "../core.js";
import { commitmentRepeatSchema } from "../planning/commitment-repeat.js";
import {
  conditionDefinitionSchema,
  currentSituationSchema,
  requirementPathwaySchema,
  transportModeSchema
} from "../planning/context-model.js";
import { firstPrerequisiteCycle, prerequisiteNodes, prerequisiteRefSchema } from "../planning/prerequisites.js";
import { spanWireSchema } from "../planning/span.js";
import { pendingLocationSuggestionSchema } from "../planning/location-observation.js";
import { openQuestionSchema } from "../questions.js";

/**
 * The status each stored record can carry, named so a reader of the wire (the CLI's `--status` check)
 * takes the values from here rather than keeping its own copy.
 */
export const commitmentRecurrenceRuleStatusSchema = z.enum(["active", "ended"]);
export const captureStatusSchema = z.enum(["pending", "confirmed", "ignored", "superseded"]);
export const deliverableStatusSchema = z.enum([
  "needs_breakdown",
  "ready",
  "in_progress",
  "under_review",
  "awaiting_result",
  "ready_to_complete",
  "completed",
  "cancelled",
  "archived"
]);
export const commitmentStatusSchema = z.enum(["confirmed", "tentative", "cancelled"]);
export const routineStepStatusSchema = z.enum(["pending", "doing", "completed", "blocked", "cancelled", "skipped"]);
export const routinePresetStatusSchema = z.enum(["active", "archived"]);
export const occurrenceStatusSchema = z.enum(["pending", "completed", "missed", "cancelled"]);
export const sleepPlanStatusSchema = z.enum(["planned", "sleeping", "completed", "cancelled"]);

const isoDateTime = z.string().datetime({ offset: true });
const energy = energyTypeSchema;
const lifecycleStatus = lifecycleStatusSchema;

const score = z.number().int().min(1).max(5);
/** A quarter-hour wall-clock time, `HH:MM`, matching the detailed band's 15-minute slots. */
const recoveryClockTime = z.string().regex(/^([01]\d|2[0-3]):(00|15|30|45)$/);

/**
 * The pulse criteria and publish design note ("Persistence", "Wire and commands"): the recorder's
 * latest judgement, read off `pulse_state`/the open `pulse_segments` row — never stored inside
 * `portal_state` itself. Absent for a user the recorder has never evaluated (no open segment yet).
 */
export const pulseWireSchema = z.object({
  state: z.enum(["on", "unknown", "off", "free", "asleep"]),
  since: isoDateTime,
  reason: z.enum([
    "confirmed",
    "unconfirmed",
    "deviated",
    "unsanctioned",
    "overran",
    "free",
    "asleep",
    // The state machine's.
    "lapsed",
    "scheduled",
    "disrupted",
    "reentered"
  ]),
  /** Why the state is `off`; set only then. `lapsed` needs re-entry. */
  offReason: z.enum(["lapsed"]).optional(),
  /** End of the expected-silence window holding the state (a work shift, the sleep night); absent outside one. */
  silenceUntil: isoDateTime.optional(),
  /** Who made the confirmation behind `lastConfirmedAt`: the person, or their agent. */
  confirmedBy: z.enum(["person", "agent"]).optional(),
  doing: z
    .object({
      kind: z.enum(["action", "deliverable", "commitment", "step", "sleep", "journey"]),
      id: z.string(),
      title: z.string()
    })
    .optional(),
  private: z.boolean(),
  lastConfirmedAt: isoDateTime.optional(),
  /** The recorded disruption holding `on/disrupted` (`record_disruption`); absent otherwise. Never published. */
  disruption: z
    .object({
      doing: z.string(),
      until: isoDateTime,
      locationId: z.string(),
      contexts: z.array(z.string()),
      exclusive: z.boolean(),
      recordedBy: z.enum(["person", "agent"])
    })
    .optional(),
  shares: z.object({
    today: z.object({ onPercent: z.number().nullable(), countedMinutes: z.number() }),
    days7: z.object({ onPercent: z.number().nullable(), countedMinutes: z.number() }),
    days30: z.object({ onPercent: z.number().nullable(), countedMinutes: z.number() })
  })
});

/**
 * Names one node inside a dependency cycle, or null when the graph is acyclic. Both the deliverable
 * graph and each step graph must be acyclic; reporting the node makes the failure fixable instead of
 * merely refused. Identifier sorting keeps the reported node stable for identical input.
 */
function firstCycle(nodes: { id: string; dependencyIds: string[] }[]): string | null {
  const edges = new Map(nodes.map((node) => [node.id, [...node.dependencyIds].sort()]));
  const visited = new Map<string, "visiting" | "done">();
  const walk = (id: string): string | null => {
    const seen = visited.get(id);
    if (seen === "done") return null;
    if (seen === "visiting") return id;
    visited.set(id, "visiting");
    for (const next of edges.get(id) ?? []) {
      const found = walk(next);
      if (found) return found;
    }
    visited.set(id, "done");
    return null;
  };
  for (const id of [...edges.keys()].sort()) {
    const found = walk(id);
    if (found) return found;
  }
  return null;
}
const nonNegativeMinutes = z.number().finite().min(0);

/**
 * A named window of the day, local to `settings.timezone` (the routine step timing design note
 * "Bands"). `start < end`; no band crosses midnight. Only a flexible commitment before-step
 * consults `preferredBands`, and a step naming a deleted band ignores it.
 */
export const timeBandSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    start: z.string().regex(/^\d{2}:\d{2}$/),
    end: z.string().regex(/^\d{2}:\d{2}$/)
  })
  .refine((band) => band.start < band.end, { message: "start must be before end", path: ["end"] });
export type TimeBand = z.infer<typeof timeBandSchema>;

/** `settings.timeBands`' default when absent, and `user_preferences.time_bands`'s DB default. */
export const DEFAULT_TIME_BANDS: TimeBand[] = [
  { id: "morning", name: "Morning", start: "06:00", end: "12:00" },
  { id: "afternoon", name: "Afternoon", start: "12:00", end: "17:00" },
  { id: "evening", name: "Evening", start: "17:00", end: "22:00" }
];

/** `settings.startByWarningMinutes`' default when absent, and `user_preferences.start_by_warning_minutes`'s DB default. */
export const DEFAULT_START_BY_WARNING_MINUTES = 30;

/**
 * What being at a commitment costs. `blocking` takes the hour outright; `anchor` holds the same place
 * in every plan — capacity, the day plan and the forward replay subtract it identically — but leaves
 * its own window open at the live moment, until an engagement session says you are taken up by it.
 */
const commitmentPresence = z.enum(["blocking", "anchor"]);
/** How the person takes part in a commitment; `CONTEXT.md` "Attendance". */
export const commitmentAttendance = z.enum(["in_person", "remote"]);
/**
 * How eagerly the check-in scheduler asks "Still on X?" while this commitment is the active protected
 * or open-anchor one. Absent means 'normal' — there is no commitment-type taxonomy to default off, so
 * every commitment starts at the same cadence and 'silent'/'reduced' are always an explicit choice.
 */
const commitmentPromptPolicy = z.enum(["silent", "reduced", "normal"]);
const recurrenceWindowSchema = z.object({
  id: z.string(),
  name: z.string(),
  anchor: z.enum(["wake", "sleep_start", "local_time"]),
  startOffsetMinutes: z.number().int().optional(),
  endOffsetMinutes: z.number().int().optional(),
  localStartTime: z.string().optional(),
  localEndTime: z.string().optional(),
  fallback: z.object({ startTime: z.string(), endTime: z.string() }).optional()
});
// an alternative to a plain `intervalDays` due date for a cadence rule — a target count of
// occurrences inside a rolling window of days, or the calendar month containing today. Present only
// on `schedulingMode: "cadence"` rules; see the state-level check below.
const cadencePeriodSchema = z.union([
  z.object({ unit: z.literal("days"), length: z.number().int().positive() }),
  z.object({ unit: z.literal("month") })
]);
const recurrenceRuleSchema = z
  .object({
    id: z.string(),
    version: z.number().int().positive().optional(),
    actionId: z.string(),
    timezone: z.string(),
    startDate: z.string().date(),
    endDate: z.string().date().optional(),
    intervalDays: z.number().int().positive(),
    // Empty on a cadence rule: cadence has no windows, only an interval.
    windows: z.array(recurrenceWindowSchema).default([]),
    completionMode: z.enum(["end_date", "total_minutes", "manual"]).default("end_date"),
    targetTotalMinutes: z.number().int().positive().optional(),
    accumulatedMinutes: z.number().int().min(0).default(0),
    completedAt: isoDateTime.optional(),
    /** Read from the cadence completion log; a windowed rule never carries these. */
    lastCompletedAt: isoDateTime.optional(),
    lastCompletedLocalDate: z.string().date().optional(),
    completionCount: z.number().int().min(0).optional(),
    // cadence-only fields — see the state-level `superRefine` for the schedulingMode gate.
    period: cadencePeriodSchema.optional(),
    targetOccurrences: z.number().int().positive().optional(),
    minSpacingDays: z.number().int().min(0).optional(),
    eligibleWeekdays: z.array(z.number().int().min(0).max(6)).min(1).optional(),
    /** Local dates of completions counted toward the current period, read from the completion log. */
    completionLocalDates: z.array(z.string().date()).optional()
  })
  .superRefine((value, context) => {
    if (value.completionMode === "end_date" && !value.endDate)
      context.addIssue({ code: "custom", message: "An end-date recurrence requires an end date." });
    if (value.completionMode === "total_minutes" && !value.targetTotalMinutes)
      context.addIssue({ code: "custom", message: "A total-time recurrence requires a target." });
    if (value.period?.unit === "days" && value.minSpacingDays && value.targetOccurrences) {
      if (value.minSpacingDays * value.targetOccurrences > value.period.length)
        context.addIssue({
          code: "custom",
          message: "Minimum spacing times the target occurrences does not fit within the period."
        });
    }
  });
export const commitmentRecurrenceRuleSchema = z.object({
  id: z.string(),
  version: z.number().int().positive().optional(),
  title: z.string().min(1),
  timezone: z.string(),
  startDate: z.string().date(),
  endDate: z.string().date().optional(),
  repeat: commitmentRepeatSchema,
  localStartTime: z.string(),
  localEndTime: z.string(),
  location: z.string().optional(),
  /** The location context the commitment happens at; `location` stays the free-text label. */
  locationId: z.string().min(1).optional(),
  setupBeforeMinutes: nonNegativeMinutes,
  transitionAfterMinutes: nonNegativeMinutes,
  /** What this rule's occurrences claim of the time; copied onto each one. Absent means 'blocking'. */
  presence: commitmentPresence.optional(),
  /** Whether this rule's occurrences publish to the family calendar. Absent means false. */
  shareToCalendar: z.boolean().optional(),
  status: commitmentRecurrenceRuleStatusSchema,
  projectId: z.string().optional(),
  /** Where this rule's occurrences take their preparation routine from; copied at materialisation. Absent means 'inherit'. */
  routineSource: z.enum(["inherit", "preset", "custom", "none"]).optional(),
  routinePresetId: z.string().optional(),
  /**
   * Whether a late arrival at this rule's occurrences matters (the travel time model design note
   * "Caution"). Copied onto each occurrence at materialisation, part of the per-date overlay.
   * Absent means true.
   */
  latenessMatters: z.boolean().optional(),
  /** How this rule's occurrences are reached, when known. Part of the per-date overlay. */
  transportMode: transportModeSchema.optional(),
  /**
   * The slug of a `condition_definitions` row of kind `contact`, no FK, exactly as `locationId` names
   * a place. Part of the per-date overlay. The engine never reads this.
   */
  contactId: z.string().optional(),
  /** Effective privacy is this OR each occurrence's own flag — see `areaSchema.private`. Absent means false. */
  private: z.boolean().optional(),
  /** Pulse check-in allowance its occurrences inherit (`commitmentSchema.checkInExtraMinutes`). Absent means the default. */
  checkInExtraMinutes: z.number().int().min(0).optional()
});

const areaSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive().optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  status: lifecycleStatus,
  sortOrder: z.number().int().min(0),
  /** The pulse criteria and publish design note ("Private"): hides this area, and everything under
      it, from the published pulse. Absent reads as `false`. */
  private: z.boolean().optional()
});
const outcomeSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive().optional(),
  areaId: z.string().min(1),
  title: z.string().min(1),
  definitionOfDone: z.string().min(1),
  value: score,
  status: lifecycleStatus,
  deadlineAt: isoDateTime.optional(),
  reviewOn: z.union([z.string().date(), isoDateTime]).optional()
});
const projectSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive().optional(),
  title: z.string().min(1),
  area: z.string().min(1),
  outcomeId: z.string().min(1),
  status: lifecycleStatus,
  uncertainty: z.enum(["known", "some", "high"]),
  value: score,
  consequence: score,
  // read-only. Derived by the database layer from each project's baseline estimate and its
  // deadline (`platform/database/src/planning/completion-ratios.ts`) on every plan-and-forecast run;
  // `saveProjectCommandSchema` does not accept either field, so a client cannot set them directly.
  actualCompletionRatio: z.number().min(0).max(1).optional(),
  requiredCompletionRatio: z.number().min(0).max(1).optional(),
  remainingEffortOverrideMinutes: nonNegativeMinutes.optional(),
  internalDeadlineAt: isoDateTime.optional(),
  externalDeadlineAt: isoDateTime.optional(),
  lastWorkedAt: isoDateTime.optional(),
  /** Read-only: set by the "still wanted" command (`confirmProjectWantedCommandSchema`), never by a project save. */
  lastReviewedAt: isoDateTime.optional(),
  /** Read-only: set by the same command with `kind: "overdue_seen"` (the review's "Seen, leave it"). */
  overdueSeenAt: isoDateTime.optional(),
  createdAt: isoDateTime.optional(),
  /** Pulse privacy, inherited from the area unless set here — see `areaSchema.private`. */
  private: z.boolean().optional(),
  /** What must finish first, beyond same-kind `dependencyIds` (`planning/prerequisites.ts`). */
  prerequisites: z.array(prerequisiteRefSchema).optional()
});
const actionSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive().optional(),
  projectId: z.string().min(1),
  title: z.string().min(1),
  status: actionStatusSchema,
  optimisticMinutes: nonNegativeMinutes,
  expectedMinutes: nonNegativeMinutes,
  pessimisticMinutes: nonNegativeMinutes,
  remainingMinutes: nonNegativeMinutes,
  /**
   * When `remainingMinutes` was last set or confirmed: a session finish, a
   * reset, or a save that changed it. Read-only, like `lastWorkedAt`: a save never sends it. Optional so a
   * stored request or an older client still parses; absent means the age is unknown, which never flags.
   */
  remainingSetAt: isoDateTime.optional(),
  splittable: z.boolean(),
  setupMinutes: nonNegativeMinutes,
  energy,
  minimumSessionMinutes: nonNegativeMinutes,
  maximumSessionMinutes: nonNegativeMinutes,
  importance: score,
  consequence: score,
  contexts: z.array(z.string().min(1)),
  dependencyIds: z.array(z.string().min(1)),
  /** Prerequisites that are not other actions (`planning/prerequisites.ts`). */
  prerequisites: z.array(prerequisiteRefSchema).optional(),
  availableFrom: isoDateTime.optional(),
  deadlineAt: isoDateTime.optional(),
  latestStartAt: isoDateTime.optional(),
  lastWorkedAt: isoDateTime.optional(),
  createdAt: isoDateTime.optional(),
  estimateNeedsReview: z.boolean().optional(),
  /**
   * The estimate and judgement fields (`ASSUMABLE_ACTION_FIELDS`) that were defaulted or guessed and not yet
   * said by a person. Absent when none are; a record from before this was kept reads as none.
   */
  assumedFields: z.array(z.string().min(1)).optional(),
  notes: z.string().optional(),
  schedulingMode: z.enum(["one_off", "recurring", "cadence"]).default("one_off"),
  recurrence: recurrenceRuleSchema.optional(),
  requirementPathways: z.array(requirementPathwaySchema).default([]),
  preferences: z.array(z.string().min(1)).default([]),
  /**
   * Set only on prep for a commitment (`CONTEXT.md` "Prep"): the commitment this action prepares for,
   * so prep is attached rather than merely dated. Absent for every other action.
   */
  prepForCommitmentId: z.string().min(1).optional(),
  /** Pulse privacy, inherited from the project unless set here — see `areaSchema.private`. */
  private: z.boolean().optional()
});
const deliverableCriterionSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive().optional(),
  key: z.string().min(1),
  title: z.string().min(1),
  required: z.boolean().default(true),
  interpretation: z.string().optional(),
  sourceDocument: z.string().optional(),
  sourceLocation: z.string().optional(),
  expectedEvidence: z.string().optional(),
  verificationMethod: z
    .enum(["llm_inspection", "user_confirmation", "submission_receipt", "external_result", "not_verifiable"])
    .optional(),
  state: z.enum(["unsatisfied", "satisfied", "uncertain", "not_applicable"]).default("unsatisfied"),
  notes: z.string().optional(),
  sortOrder: z.number().int().min(0).default(0),
  /** The steps that make this criterion true. Empty on a required criterion is a coverage failure. */
  stepIds: z.array(z.string().min(1)).default([])
});
/**
 * The wire shape of one of a deliverable's actions. Named for the storage it now shares with
 * `actions`; `deliverableStepSchema` below
 * is kept as an alias for one release so a consumer mid-migration on the name still resolves.
 */
export const deliverableActionSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive().optional(),
  title: z.string().min(1),
  details: z.string().optional(),
  completionCondition: z.string().optional(),
  // Read side only: closing a done step leaves it `archived`, and a cancelled one `cancelled`. The
  // write-side schema (planning/entity-fields.ts) omits both so a save cannot move a step into them.
  status: z.enum(["planned", "doing", "waiting", "blocked", "done", "cancelled", "archived"]),
  optimisticMinutes: nonNegativeMinutes,
  expectedMinutes: nonNegativeMinutes,
  pessimisticMinutes: nonNegativeMinutes,
  remainingMinutes: nonNegativeMinutes,
  energy,
  minimumSessionMinutes: nonNegativeMinutes,
  maximumSessionMinutes: nonNegativeMinutes,
  splittable: z.boolean().default(true),
  setupMinutes: nonNegativeMinutes.default(0),
  required: z.boolean().default(true),
  estimateNeedsReview: z.boolean().optional(),
  sortOrder: z.number().int().min(0).default(0),
  dependencyIds: z.array(z.string().min(1)).default([]),
  requirementPathways: z.array(requirementPathwaySchema).default([]),
  lastWorkedAt: isoDateTime.optional(),
  completedAt: isoDateTime.optional(),
  /**
   * Structural, conditional re-arm: set on a resubmit/hand-back step created via extend_plan. When
   * mark_steps_complete finishes this step, the system re-records this description as a fresh open
   * blocker on whatever step depends on it — the same shape as the blocker it reopens — so a
   * revision loop cannot silently coast past an unconfirmed wait. Absent on ordinary steps and on
   * whatever step represents final approval, which is how the loop ends instead of re-arming forever.
   */
  reblockOnComplete: z
    .object({
      description: z.string().min(1),
      category: z.enum([
        "missing_information",
        "waiting_on_someone",
        "prerequisite",
        "tool_or_context_unavailable",
        "technical_problem",
        "energy_or_health",
        "other"
      ])
    })
    .optional()
});
/** @deprecated Use `deliverableActionSchema`. Kept as an alias for one release. */
export const deliverableStepSchema = deliverableActionSchema;
const deliverableBlockerSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive().optional(),
  description: z.string().min(1),
  category: z
    .enum([
      "missing_information",
      "waiting_on_someone",
      "prerequisite",
      "tool_or_context_unavailable",
      "technical_problem",
      "energy_or_health",
      "other"
    ])
    .default("other"),
  state: z.enum(["open", "awaiting_response", "possibly_resolved", "resolved", "dismissed"]).default("open"),
  proposedResolution: z.string().optional(),
  resolutionNotes: z.string().optional(),
  confirmedAt: isoDateTime.optional(),
  resolvedAt: isoDateTime.optional(),
  createdAt: isoDateTime.optional(),
  stepIds: z.array(z.string().min(1)).default([])
});
const deliverableContractProposalSchema = z.object({
  id: z.string().uuid(),
  version: z.number().int().positive(),
  sourceId: z.string().uuid(),
  status: z.enum(["pending", "confirmed", "ignored", "superseded"]),
  key: z.string().min(1),
  title: z.string().min(1),
  required: z.boolean(),
  interpretation: z.string().optional(),
  sourceDocument: z.string().optional(),
  sourceLocation: z.string().optional(),
  expectedEvidence: z.string().optional(),
  verificationMethod: z
    .enum(["llm_inspection", "user_confirmation", "submission_receipt", "external_result", "not_verifiable"])
    .optional(),
  notes: z.string().optional(),
  basis: z.enum(["explicit", "inferred", "missing"]),
  confidence: z.enum(["high", "medium", "low"]).nullable(),
  evidence: z.array(z.string().max(500)).default([]),
  sourceTitle: z.string().optional(),
  sourceType: z.string().min(1),
  createdAt: isoDateTime
});

const deliverableSourceFileSchema = z.object({
  id: z.string().min(1),
  sourceId: z.string().min(1),
  filename: z.string().min(1),
  mimeType: z.string().min(1),
  byteSize: z.number().int().nonnegative(),
  createdAt: z.string().min(1)
});
const deliverableSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive().optional(),
  projectId: z.string().min(1),
  title: z.string().min(1),
  details: z.string().optional(),
  status: deliverableStatusSchema,
  externalDeadlineAt: isoDateTime.optional(),
  internalDeadlineAt: isoDateTime.optional(),
  uncertainty: z.enum(["known", "some", "high"]),
  importance: score,
  consequence: score,
  completionThreshold: z.string().optional(),
  /** Zero means never approved, which is what keeps an unplanned deliverable out of ordinary work. */
  contractVersion: z.number().int().min(0).default(0),
  planVersion: z.number().int().min(0).default(0),
  contractApprovedAt: isoDateTime.optional(),
  planApprovedAt: isoDateTime.optional(),
  approvalNote: z.string().optional(),
  submittedAt: isoDateTime.optional(),
  sortOrder: z.number().int().min(0).default(0),
  lastWorkedAt: isoDateTime.optional(),
  completedAt: isoDateTime.optional(),
  createdAt: isoDateTime.optional(),
  dependencyIds: z.array(z.string().min(1)).default([]),
  /** Prerequisites that are not other deliverables (`planning/prerequisites.ts`). */
  prerequisites: z.array(prerequisiteRefSchema).optional(),
  sourceIds: z.array(z.string().min(1)).default([]),
  sourceFiles: z.array(deliverableSourceFileSchema).default([]),
  criteria: z.array(deliverableCriterionSchema).default([]),
  steps: z.array(deliverableActionSchema).default([]),
  blockers: z.array(deliverableBlockerSchema).default([]),
  contractProposals: z.array(deliverableContractProposalSchema).default([]),
  /** Pulse privacy, inherited from the project unless set here — see `areaSchema.private`. */
  private: z.boolean().optional()
});
export const commitmentSourceSchema = z.object({
  /** The link row's id, which **Not the same event** names. */
  id: z.string().min(1),
  provider: sourceIdSchema,
  role: z.enum(["primary", "secondary"])
});
export const commitmentSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive().optional(),
  title: z.string().min(1),
  startsAt: isoDateTime,
  endsAt: isoDateTime,
  status: commitmentStatusSchema,
  location: z.string().optional(),
  /** The location context the commitment happens at; `location` stays the free-text label. */
  locationId: z.string().min(1).optional(),
  setupBeforeMinutes: nonNegativeMinutes,
  transitionAfterMinutes: nonNegativeMinutes,
  /** What being here costs: the whole hour, or only the place. Absent means 'blocking'. */
  presence: commitmentPresence.optional(),
  /** How eagerly the check-in scheduler prompts while this is the active commitment. Absent means 'normal'. */
  promptPolicy: commitmentPromptPolicy.optional(),
  /** Whether this commitment publishes to the family calendar. Absent means false. */
  shareToCalendar: z.boolean().optional(),
  /**
   * Whether `shareToCalendar` still tracks its recurrence rule ('inherit') or was hand-set on this
   * occurrence ('custom'), the same inherit-vs-custom shape as `routineSource`. Absent means 'inherit'.
   */
  shareSource: z.enum(["inherit", "custom"]).optional(),
  /**
   * Whether this occurrence's title, times, location, buffers, project, lateness, transport mode and
   * contact still track its recurrence rule ('inherit') or were pinned by an explicit per-occurrence
   * edit ('custom'), the same inherit/custom shape as `shareSource`. Absent means 'inherit'.
   */
  scheduleSource: z.enum(["inherit", "custom"]).optional(),
  /**
   * Whether a late arrival at this commitment matters (the travel time model design note
   * "Caution"). Part of the per-date overlay: a recurring occurrence copies this from its rule and
   * can then override it. Absent means true.
   */
  latenessMatters: z.boolean().optional(),
  /** How this commitment is reached, when known. Part of the per-date overlay. */
  transportMode: transportModeSchema.optional(),
  /**
   * The slug of a `condition_definitions` row of kind `contact`, no FK, exactly as `locationId`
   * names a place. Part of the per-date overlay. The engine never reads this.
   */
  contactId: z.string().optional(),
  /**
   * How the person takes part (`CONTEXT.md` "Attendance"). Absent means 'in_person'. A 'remote'
   * commitment has no journey: the travel model plans no leg to it and leave-by never fires.
   */
  attendance: commitmentAttendance.optional(),
  /**
   * A location condition slug the person would rather be at for a remote commitment (the home desk).
   * A preference the planner honours when it can, never a requirement; meaningless when in person.
   */
  preferredLocationId: z.string().min(1).optional(),
  recurrenceRuleId: z.string().optional(),
  localDate: z.string().date().optional(),
  projectId: z.string().optional(),
  /**
   * Where this commitment's preparation routine comes from: the place default ('inherit'), a named
   * preset ('preset'), hand-shaped steps ('custom'), or nowhere ('none'). Absent means 'inherit'.
   * Only inherit/preset let a replan rewrite the steps, and only while every step is still pending.
   */
  routineSource: z.enum(["inherit", "preset", "custom", "none"]).optional(),
  routinePresetId: z.string().optional(),
  /**
   * How this commitment came to exist. Absent means 'planned' — the ordinary editor never sends
   * these, which is what lets the store preserve a disruption's provenance through an ordinary edit.
   */
  origin: z.enum(["planned", "disruption"]).optional(),
  /** Which part of life interrupted. Only meaningful, and only accepted, alongside origin 'disruption'. */
  disruptionSource: z.enum(["work", "family", "life_admin", "other"]).optional(),
  /** The end time is a pessimistic guess, not a fact: the duration was unknown when this landed. */
  disruptionOpenEnded: z.boolean().optional(),
  /**
   * When the disruption was reported, as distinct from when it began: a retro-log has `startsAt` in
   * the past and `landedAt` now, and only the gap between them says how much warning there was.
   */
  landedAt: isoDateTime.optional(),
  /**
   * Provenance the store fills in and the editors never send back: which import wrote this record,
   * if any, and when it was created and last changed. A commitment that arrived by import can be
   * changed by the next one, which is a different thing from one somebody typed.
   */
  sourceType: z.string().min(1).optional(),
  sourceTitle: z.string().min(1).optional(),
  createdAt: isoDateTime.optional(),
  updatedAt: isoDateTime.optional(),
  /**
   * The actual end of the latest finished session tracked against this commitment, when it ran
   * later than `endsAt` — populated from the `sessions` table, never from the commitment's own
   * edited fields. `endsAt` itself deliberately never moves for an ordinary commitment (activity
   * time is logged, not scheduling), so this is the one channel the engine has for "the person was
   * actually here later than planned": it feeds `effectiveCommitmentEnd`
   * (engine/core/src/model/types.ts), which a live overtime session also reaches through
   * `activeSession` alone — this field only ever needs to carry a *finished* session's end. Absent
   * means "no known overtime", reproducing every existing engine and routine-schedule behaviour
   * exactly.
   */
  trackedEndedAt: isoDateTime.optional(),
  /** Effective privacy is this OR the recurrence rule's — see `areaSchema.private`. Absent means false. */
  private: z.boolean().optional(),
  /**
   * Pulse check-in allowance: minutes added to the unknown-to-lapsed
   * thresholds while this is in force. Absent means its recurrence rule's, else the default (15).
   */
  checkInExtraMinutes: z.number().int().min(0).optional(),
  /**
   * The calendar sources this commitment is one copy of: one entry
   * per `calendar_event_links` row, oldest first. Filled by the store, never sent back by an editor.
   * Absent means a hand-entered commitment with no source.
   */
  sources: z.array(commitmentSourceSchema).optional()
});
const captureSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive().optional(),
  text: z.string().min(1),
  createdAt: isoDateTime,
  status: captureStatusSchema,
  proposalType: z.enum([
    "unclassified",
    "outcome",
    "project",
    "action",
    "fixed_commitment",
    "someday",
    "reference",
    "deliverable",
    /** A change proposed by an email reasoning run (design: email-reasoning §7); one per `changes` entry. */
    "email_change"
  ]),
  proposedFields: z.record(z.string(), z.unknown()),
  /** Open questions that must be answered before this can be confirmed; absent means none. */
  questions: z.array(openQuestionSchema).optional(),
  sourceType: z.string().min(1),
  sourceLink: z.string().optional(),
  sourceId: z.string().min(1).optional(),
  confidence: z.number().min(0).max(1).optional(),
  reviewedAt: isoDateTime.optional()
});
const sessionHistorySchema = z.object({
  id: z.string().min(1),
  actionId: z.string(),
  actionTitle: z.string().min(1),
  result: z.enum(["completed", "stopped", "blocked", "did_not_start", "skipped"]),
  targetType: z
    .enum(["action", "routine_step", "routine_instance", "sleep", "fixed_commitment", "deliverable"])
    .optional(),
  startedAt: isoDateTime,
  /** Set when the session was started at a past `startedAt`; when that choice was made. */
  startedRecordedAt: isoDateTime.nullable().optional(),
  /** The agent that started it, by its self-declared name; absent for a person. */
  startedBy: z.string().optional(),
  endedAt: isoDateTime,
  plannedMinutes: nonNegativeMinutes,
  activeMinutes: nonNegativeMinutes,
  remainingBeforeMinutes: nonNegativeMinutes,
  remainingAfterMinutes: nonNegativeMinutes,
  resultNote: z.string().optional(),
  blockingReason: z.string().optional(),
  overrideReason: z.string().optional(),
  pausedMinutes: nonNegativeMinutes.optional(),
  segmentCount: z.number().int().min(0).optional()
});
const activeSessionSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive().optional(),
  actionId: z.string().min(1),
  status: z.enum(["running", "paused", "feedback"]),
  targetType: z
    .enum(["action", "routine_step", "routine_instance", "sleep", "fixed_commitment", "deliverable"])
    .optional(),
  targetId: z.string().optional(),
  stepId: z.string().optional(),
  targetTitle: z.string().optional(),
  startedAt: isoDateTime,
  startedRecordedAt: isoDateTime.nullable().optional(),
  startedBy: z.string().optional(),
  plannedEndAt: isoDateTime,
  plannedMinutes: nonNegativeMinutes,
  remainingBeforeMinutes: nonNegativeMinutes,
  activeElapsedSeconds: z.number().finite().min(0),
  segmentStartedAt: isoDateTime.optional(),
  /**
   * Elapsed seconds per deliverable step, summed from closed segments. The whole-session total is
   * derived from the same segments, so the two can never disagree about how long the work took. A
   * session that never touched a deliverable step has no breakdown at all, which is why this is
   * absent rather than an empty map: an empty map would claim a breakdown that was never measured.
   */
  stepSeconds: z.record(z.string(), z.number().finite().min(0)).optional(),
  pausedRemainingSeconds: z.number().finite().min(0).optional(),
  feedbackRequestedAt: isoDateTime.optional(),
  /**
   * When a paused session was paused (where its latest closed segment ended), the as-of of its
   * freshness. Absent while it runs, and when no segment has closed,
   * which then ages from `plannedEndAt` instead.
   */
  pausedAt: isoDateTime.optional(),
  /**
   * What the person typed when they paused — "what came up" — carried on `sessions.result_note`
   * while the session sits paused. Resuming clears it, since `result_note` is otherwise a
   * finish-time field and a stale pause reason should not bleed into how the session ends.
   */
  note: z.string().min(1).optional(),
  /**
   * The run of consecutive unanswered check-in slots behind this session, since it started. Derived
   * at read time from the check-in trail — see the session reconciliation design note — never
   * stored. Absent for a non-deliverable session, since check-ins only exist for
   * `directive_kind='deliverable'`.
   */
  unansweredCheckIns: z.number().int().min(0).optional(),
  /**
   * The last moment reconciliation can vouch for: the last `on_track`-answered check-in's
   * `slotAt`, or the open segment's start, or the session's `startedAt` — whichever is available,
   * in that order. Absent for a non-deliverable session.
   */
  lastVerifiedAt: isoDateTime.optional()
});

const calibrationFactorSchema = z.object({
  factor: z.number().positive(),
  spread: z.number().positive().optional(),
  samples: z.number().int().positive(),
  lastSampleAt: isoDateTime
});
const estimateCalibrationSchema = z.object({
  overall: calibrationFactorSchema.nullable(),
  areas: z.array(calibrationFactorSchema.extend({ areaId: z.string().min(1) }))
});

export const portalStateSchema = z
  .object({
    settings: z.object({
      version: z.number().int().positive().optional(),
      setupCompletedAt: isoDateTime.optional(),
      timezone: z.string().min(1),
      locale: z.string().min(1).optional(),
      planCodePattern: z.string().nullable().optional(),
      planningHorizonEnd: z.string().min(1),
      defaultUsableFraction: z.number().min(0).max(1),
      defaultSetupBufferMinutes: nonNegativeMinutes,
      defaultTransitionBufferMinutes: nonNegativeMinutes,
      submissionBufferMinutes: nonNegativeMinutes,
      submissionBufferPercent: z.number().min(0).max(1),
      energyMeanings: z.object({ high: z.string(), medium: z.string(), low: z.string(), recovery: z.string() }),
      estimateBucketsMinutes: z.array(nonNegativeMinutes).min(1),
      preferredBedtime: z.string().min(1),
      preferredWakeTime: z.string().min(1),
      desiredSleepMinutes: nonNegativeMinutes,
      minimumSleepMinutes: nonNegativeMinutes,
      maxAwakeHours: z.number().min(1),
      /**
       * How far a night may be placed before the preferred bedtime, in minutes, before it carries a
       * deviation warning and the near-night choice. Sleep is a wall: the engine never shortens a
       * night to protect work, so there is no deadline-pressure trade to configure.
       */
      bedtimeDeviationMinutes: z.number().min(0).max(720).default(180),
      lastWokeAt: isoDateTime.optional(),
      bedtimeRoutinePresetId: z.string().optional(),
      /** Mirrors `bedtimeRoutinePresetId`: no ownership enforcement in the schema, checked server-side. */
      wakeRoutinePresetId: z.string().optional(),
      /** The active location context you sleep at and return to; one home, chosen in Settings. */
      homeLocationId: z.string().min(1).optional(),
      /**
       * Disruption capture presets, edited on /settings/disruptions. Portal-only: the engine never
       * reads these. The four kind keys are fixed (they match `commitments`'s disruption_source
       * CHECK constraint) so only their labels are editable; the when/duration lists are freely
       * editable, and a duration preset is either a plain minute count or one of the two sentinel
       * kinds that compute an end time instead of using one.
       */
      disruptionKindLabels: z
        .object({
          work: z.string().min(1),
          family: z.string().min(1),
          life_admin: z.string().min(1),
          other: z.string().min(1)
        })
        .default({ work: "Work", family: "Family", life_admin: "Life admin", other: "Other" }),
      disruptionWhenPresets: z
        .array(z.object({ id: z.string().min(1), label: z.string().min(1), delayMinutes: nonNegativeMinutes }))
        .min(1)
        .default([
          { id: "now", label: "Now", delayMinutes: 0 },
          { id: "in_15", label: "+15m", delayMinutes: 15 },
          { id: "in_30", label: "+30m", delayMinutes: 30 },
          { id: "in_60", label: "+60m", delayMinutes: 60 }
        ]),
      disruptionDurationPresets: z
        .array(
          z.object({
            id: z.string().min(1),
            label: z.string().min(1),
            kind: z.enum(["minutes", "rest_of_day", "unknown"]),
            minutes: nonNegativeMinutes.optional()
          })
        )
        .min(1)
        .default([
          { id: "30m", label: "30 min", kind: "minutes", minutes: 30 },
          { id: "1h", label: "1 hour", kind: "minutes", minutes: 60 },
          { id: "2h", label: "2 hours", kind: "minutes", minutes: 120 },
          { id: "3h", label: "3 hours", kind: "minutes", minutes: 180 },
          { id: "rest_of_day", label: "Rest of day", kind: "rest_of_day" },
          { id: "unknown", label: "No idea", kind: "unknown" }
        ]),
      disruptionRetroFallbackMinutes: z.number().int().min(1).max(1440).default(60),
      /**
       * Minutes to be at a place before a commitment starts, on top of the setup buffer: get ready,
       * travel, arrive with this margin, then start. Read by the engine (model/types.ts,
       * situation-projection.ts, recommend.ts) and by the routine-step scheduler
       * (platform/database, portal) — both fall back to this same default when a value is absent.
       */
      arrivalMarginMinutes: z.number().int().min(0).max(60).default(2),
      /**
       * The fatigue gap owed after an exact-band session reaches `maximumSessionMinutes`: the same
       * action can't be reserved again within this many minutes of wall-clock time after the run
       * ends. See the forecast reservation design note.
       */
      sessionBreakMinutes: z.number().int().min(0).max(120).default(15),
      /**
       * The mode `resolveMode` falls to when a commitment names none and the place has no usual mode
       * of its own. Persisted by a later task;
       * declared here, minimally, so the engine's mode order can read it as soon as it is set.
       */
      defaultTransportMode: transportModeSchema.optional(),
      /**
       * How long before `leaveBy` the lead reminder fires (the leave by push design note, "Lead
       * time"). 0 is legitimate: only the at-leave-by prompt is sent.
       */
      leaveByLeadMinutes: z.number().int().min(0).max(60).default(10),
      /**
       * Named windows of the day a flexible commitment before-step can prefer. Absent means
       * `DEFAULT_TIME_BANDS`. Optional rather than
       * `.default()` so fixtures built before this field existed keep type-checking.
       */
      timeBands: z.array(timeBandSchema).optional(),
      /**
       * Minutes ahead of a step's latest start that Now marks it "soon" (`start-by-banner.tsx`).
       * Absent means `DEFAULT_START_BY_WARNING_MINUTES`.
       */
      startByWarningMinutes: z.number().int().min(0).max(240).optional(),
      /**
       * Per-tool OpenAI model overrides, edited on /settings/ai. Absent means unset: each of the
       * two portal server consumers (deliverable chat, import extraction) falls back to
       * "gpt-5.6-sol" itself rather than this contract naming a default.
       */
      deliverableChatModel: z.string().min(1).optional(),
      importExtractorModel: z.string().min(1).optional(),
      /** Master switch for the family calendar publish sweep. Absent means false. */
      calendarShareEnabled: z.boolean().default(false),
      /** Default: a newly-created roster shift is shared to the family calendar. Absent means false. */
      sharePrimaryEvents: z.boolean().default(false),
      /** Master switch for publishing the redacted public pulse object. Absent means false. */
      pulsePublishEnabled: z.boolean().default(false),
      /**
       * The pulse lapse thresholds. Absent means the default
       * (30 minutes, one further prompt, 60 minutes; `DEFAULT_PULSE_THRESHOLDS`).
       */
      pulseUnknownToOffMinutes: z.number().int().min(5).max(480).optional(),
      pulseFurtherPrompts: z.number().int().min(0).max(10).optional(),
      pulseUnknownHardOffMinutes: z.number().int().min(5).max(720).optional(),
      /** Apply learned estimate calibration to planning. Absent means true. */
      estimateCalibrationEnabled: z.boolean().default(true),
      /**
       * Protected recovery: an `HH:MM` window (overnight when the end is at or before the start) on the chosen weekdays (0 Sunday to
       * 6 Saturday). Both null means off. Ordinary work is never planned inside it; commitments and
       * sleep take precedence, shrinking it.
       */
      recoveryStartTime: recoveryClockTime.nullable().default(null),
      recoveryEndTime: recoveryClockTime.nullable().default(null),
      recoveryWeekdays: z.array(z.number().int().min(0).max(6)).min(1).default([0, 1, 2, 3, 4, 5, 6])
    }),
    areas: z.array(areaSchema),
    outcomes: z.array(outcomeSchema),
    projects: z.array(projectSchema),
    actions: z.array(actionSchema),
    deliverables: z.array(deliverableSchema).default([]),
    commitments: z.array(commitmentSchema),
    commitmentRecurrenceRules: z.array(commitmentRecurrenceRuleSchema).default([]),
    routineSteps: z.array(
      z.object({
        id: z.string(),
        version: z.number().int().positive().optional(),
        /**
         * One routine, one table: `commitmentId` is
         * carried for a commitment-anchored step (kept for its FK/cascade into `commitments`) and
         * absent for a sleep-anchored one, which carries `anchorType`/`anchorId`/`purpose` instead.
         * `anchorType` defaults to `"commitment"` so every commitment-step fixture predating this field
         * keeps validating unchanged; a real producer (`portal/server/persistence/postgres/readers/routine-read.ts`, the engine's
         * `deriveSleepRoutineSteps`) always sets all three explicitly for a sleep-anchored row.
         */
        commitmentId: z.string().optional(),
        anchorType: z.enum(["commitment", "sleep_plan"]).default("commitment"),
        /** The commitment's own id (mirroring `commitmentId`) or the sleep plan's id. Absent only on
         *  a commitment-step fixture that predates this column — a real row always carries it. */
        anchorId: z.string().optional(),
        /** `undefined`/`null` for a commitment-anchored step; `"bedtime"` or `"wake"` for a sleep one. */
        purpose: z.enum(["bedtime", "wake"]).optional(),
        title: z.string(),
        durationMinutes: nonNegativeMinutes,
        sequence: z.number().int().min(0),
        timingRule: z.enum(["contiguous", "flexible"]),
        maxLeadMinutes: nonNegativeMinutes.optional(),
        energy,
        contexts: z.array(z.string()),
        dependencyIds: z.array(z.string()).default([]),
        phase: z.enum(["before", "after"]).default("before"),
        /** The recurring-action window this step is the same work as; the two are then planned once. */
        actionWindowId: z.string().optional(),
        /**
         * The cadence action this step stands in for; completing the step records that action's
         * cadence completion. Mutually exclusive with `actionWindowId` — enforced by the DB check
         * constraint and at write time (`entity-commands.ts`), not expressible in this schema since
         * zod's `.optional()` on two independent fields can't say "at most one of these".
         */
        cadenceActionId: z.string().optional(),
        /** The `routine_preset_steps.id` this row was generated from, when it was preset-derived — its
         *  lineage back to the preset, for reconciliation matching and for surfacing in `show commitment`. */
        presetStepId: z.string().optional(),
        status: routineStepStatusSchema,
        scheduledStartAt: isoDateTime.optional(),
        scheduledEndAt: isoDateTime.optional(),
        /** When this step was completed. Absent means 0 for a wait run from it (never completed, or predates this field). The placer and prep-pace's simulation run a completed prerequisite's wait from here. */
        completedAt: isoDateTime.optional(),
        /** Minutes this step's hands-on work must finish before whatever depends on it may begin. Absent means 0 (today's contiguous chain). */
        waitAfterMinutes: nonNegativeMinutes.optional(),
        /** How late this step may start, minutes from its chain's anchor. Absent means no such constraint. */
        mustStartByMinutes: z.number().int().positive().optional(),
        /** Time-band ids (`settings.timeBands`) this flexible before-step prefers, in order. Absent means `[]`. */
        preferredBands: z.array(z.string()).optional()
      })
    ),
    routinePresets: z
      .array(
        z.object({
          id: z.string(),
          version: z.number().int().positive().optional(),
          name: z.string(),
          activityName: z.string().default(""),
          status: routinePresetStatusSchema,
          /**
           * When true and this preset resolves for a confirmed commitment, that commitment can skip
           * or truncate the day's wake routine instance rather than run alongside it. See
           * The wake routine design note.
           */
          replacesWakeRoutine: z.boolean().default(false),
          steps: z.array(
            z.object({
              id: z.string(),
              title: z.string(),
              durationMinutes: nonNegativeMinutes,
              sequence: z.number().int().min(0),
              timingRule: z.enum(["contiguous", "flexible"]),
              maxLeadMinutes: nonNegativeMinutes.optional(),
              energy,
              contexts: z.array(z.string()),
              dependencyIds: z.array(z.string()).default([]),
              phase: z.enum(["before", "after"]).default("before"),
              actionWindowId: z.string().optional(),
              /** Mirrors `routineSteps[].cadenceActionId` above — see the comment there. */
              cadenceActionId: z.string().optional(),
              /** Mirrors `routineSteps[].waitAfterMinutes` above — see the comment there. */
              waitAfterMinutes: nonNegativeMinutes.optional(),
              /** Mirrors `routineSteps[].mustStartByMinutes` above — see the comment there. */
              mustStartByMinutes: z.number().int().positive().optional(),
              /** Mirrors `routineSteps[].preferredBands` above — see the comment there. */
              preferredBands: z.array(z.string()).optional()
            })
          )
        })
      )
      .default([]),
    occurrences: z
      .array(
        z.object({
          id: z.string(),
          version: z.number().int().positive().optional(),
          actionId: z.string(),
          recurrenceRuleId: z.string(),
          windowId: z.string(),
          windowName: z.string(),
          localDate: z.string().date(),
          windowStartsAt: isoDateTime,
          windowEndsAt: isoDateTime,
          anchorSource: z.enum([
            "actual_wake",
            "planned_wake",
            "preferred_wake",
            "planned_sleep",
            "local_time",
            "fallback"
          ]),
          status: occurrenceStatusSchema,
          routineCovered: z.boolean().optional(),
          completedAt: isoDateTime.optional()
        })
      )
      .default([]),
    sleepPlans: z.array(
      z.object({
        id: z.string(),
        version: z.number().int().positive().optional(),
        plannedStartAt: isoDateTime,
        plannedWakeAt: isoDateTime,
        desiredMinutes: nonNegativeMinutes,
        allowedMinutes: nonNegativeMinutes,
        sleepDeficitMinutes: nonNegativeMinutes,
        anchorDeviationMinutes: nonNegativeMinutes,
        hardErrors: z.array(z.string()),
        explanation: z.string(),
        status: sleepPlanStatusSchema,
        actualStartAt: isoDateTime.optional(),
        actualWakeAt: isoDateTime.optional(),
        overridden: z.boolean().optional(),
        manual: z.boolean().optional(),
        targetMinutes: nonNegativeMinutes.optional(),
        minimumShortfallMinutes: nonNegativeMinutes.optional(),
        replannedFromMissedStart: z.boolean().optional(),
        wakeConstraint: z
          .object({ commitmentId: z.string(), title: z.string().optional(), protectedStartAt: isoDateTime })
          .optional(),
        /**
         * 0 records a decline; a positive value is the stay-up-offer minutes accepted for this night.
         * Restricted to the offer's own literal choice set (the sleep placement design note "The
         * stay-up offer") rather than any 0–90 integer, so a value the offer never presented (45, say)
         * fails validation here instead of reaching the command path as a plausible-looking number.
         */
        stayUpAnswerMinutes: z.union([z.literal(0), z.literal(30), z.literal(60), z.literal(90)]).optional(),
        placementChoice: z.enum(["early", "near"]).optional(),
        deviationOptions: z
          .object({
            early: z.object({ startsAt: isoDateTime, wakesAt: isoDateTime, minutes: nonNegativeMinutes }),
            near: z.object({ startsAt: isoDateTime, wakesAt: isoDateTime, minutes: nonNegativeMinutes }),
            warn: z.boolean()
          })
          .optional()
      })
    ),
    /** Calendar spans overlapping a year either side of today; display only. */
    spans: z.array(spanWireSchema).default([]),
    captures: z.array(captureSchema),
    completedToday: z.array(sessionHistorySchema),
    assertedConditions: z.array(z.string().min(1)),
    currentEnergy: energy,
    horizonEnd: isoDateTime,
    conditionDefinitions: z.array(conditionDefinitionSchema).default([]),
    currentSituation: currentSituationSchema.default(() => currentSituationSchema.parse({})),
    /**
     * A named place a phone reading offered but never asserted, for the Now page to raise as its own
     * question. Read-only from the client's side: it is written only by the phone-ping path and
     * cleared only by `DELETE /api/location/suggestion`, never by a whole-state write.
     */
    pendingLocationSuggestion: pendingLocationSuggestionSchema.nullable().default(null),
    activeSession: activeSessionSchema.nullable(),
    /** The recorder's latest judgement — see `pulseWireSchema`. Absent before the recorder's first run. */
    pulse: pulseWireSchema.optional(),
    /**
     * The latest ended session per target, action or deliverable, keyed by `action_id` or (for a
     * deliverable) `target_id`. One entry per target: the most recent session with `ended_at IS NOT
     * NULL`, so a paused or still-running session never counts. Feeds the maximum-session break
     * an action is not eligible again until
     * `endedAt + sessionBreakMinutes` once a session of at least its maximum length has ended.
     * Defaults to `[]`, so a stored snapshot from before this field existed replays with no live break.
     */
    lastEndedSessions: z
      .array(
        z.object({
          targetId: z.string(),
          endedAt: isoDateTime,
          focusedMinutes: nonNegativeMinutes
        })
      )
      .default([]),
    dailyPlan: z
      .object({
        id: z.string().min(1),
        version: z.number().int().positive().optional(),
        localDate: z.string().date(),
        desiredActionIds: z.array(z.string()),
        deferredItems: z.array(z.object({ actionId: z.string(), reason: z.string() })),
        horizonOverrideAt: isoDateTime.optional(),
        /** "Skip recovery today": that local date's recovery window becomes ordinary capacity. */
        recoverySkipped: z.boolean().default(false),
        /**
         * Local dates, among the newest row and the day before it, whose recovery occurrence is skipped. An
         * overnight window is skipped against the date it starts on, which can be the day before the newest row.
         */
        recoverySkippedDates: z.array(z.string().date()).optional()
      })
      .optional(),
    planningFocus: z
      .array(
        z.object({
          id: z.string().min(1),
          version: z.number().int().positive().optional(),
          kind: z.enum(["weekly", "monthly"]),
          periodStart: z.string().date(),
          periodEnd: z.string().date(),
          projectIds: z.array(z.string().min(1)),
          /** The local date the weekly review was finished for this period. */
          reviewedOn: z.string().date().optional()
        })
      )
      .default([]),
    /**
     * Learned estimate calibration (logic design §5): derived by the state read from session
     * history, never stored. The engine applies it only while `settings.estimateCalibrationEnabled`.
     */
    estimateCalibration: estimateCalibrationSchema.default({ overall: null, areas: [] }),
    currentRecommendationId: z.string().uuid().optional()
  })
  .superRefine((state, context) => {
    const unique = (values: { id: string }[], name: string) => {
      const seen = new Set<string>();
      for (const value of values) {
        if (seen.has(value.id)) context.addIssue({ code: "custom", message: `duplicate ${name} id: ${value.id}` });
        seen.add(value.id);
      }
    };
    const { recoveryStartTime: recoveryStart, recoveryEndTime: recoveryEnd } = state.settings;
    if ((recoveryStart === null) !== (recoveryEnd === null))
      context.addIssue({
        code: "custom",
        path: ["settings", "recoveryEndTime"],
        message: "recovery window needs both a start and an end"
      });
    else if (recoveryStart !== null && recoveryEnd !== null && recoveryStart === recoveryEnd)
      context.addIssue({
        code: "custom",
        path: ["settings", "recoveryEndTime"],
        message: "recovery window needs a start and an end that differ; an end at or before the start runs overnight"
      });
    unique(state.areas, "area");
    unique(state.outcomes, "outcome");
    unique(state.projects, "project");
    unique(state.actions, "action");
    const areaIds = new Set(state.areas.map((area) => area.id));
    const outcomeIds = new Set(state.outcomes.map((outcome) => outcome.id));
    const projectIds = new Set(state.projects.map((project) => project.id));
    const actionIds = new Set(state.actions.map((action) => action.id));
    for (const outcome of state.outcomes)
      if (!areaIds.has(outcome.areaId))
        context.addIssue({ code: "custom", message: `outcome ${outcome.id} has an invalid area` });
    for (const project of state.projects)
      if (!outcomeIds.has(project.outcomeId))
        context.addIssue({ code: "custom", message: `project ${project.id} has an invalid outcome` });
    for (const action of state.actions) {
      if (!projectIds.has(action.projectId))
        context.addIssue({ code: "custom", message: `action ${action.id} has an invalid project` });
      for (const dependencyId of action.dependencyIds)
        if (!actionIds.has(dependencyId))
          context.addIssue({ code: "custom", message: `action ${action.id} has an invalid dependency` });
      if (action.minimumSessionMinutes > action.maximumSessionMinutes)
        context.addIssue({ code: "custom", message: `action ${action.id} has an invalid session range` });
      if (action.optimisticMinutes > action.expectedMinutes || action.expectedMinutes > action.pessimisticMinutes)
        context.addIssue({ code: "custom", message: `action ${action.id} has invalid estimate ordering` });
      if (action.schedulingMode === "recurring" && action.recurrence && action.recurrence.windows.length === 0)
        context.addIssue({ code: "custom", message: `action ${action.id} recurs without a window` });
      if (action.schedulingMode === "cadence" && action.recurrence && action.recurrence.windows.length > 0)
        context.addIssue({ code: "custom", message: `action ${action.id} is cadence but carries windows` });
      if (
        action.schedulingMode !== "cadence" &&
        action.recurrence &&
        (action.recurrence.period ||
          action.recurrence.targetOccurrences !== undefined ||
          action.recurrence.minSpacingDays !== undefined ||
          action.recurrence.eligibleWeekdays)
      )
        context.addIssue({
          code: "custom",
          message: `action ${action.id} carries period/target-occurrence cadence fields outside cadence`
        });
    }
    unique(state.deliverables, "deliverable");
    const deliverableIds = new Set(state.deliverables.map((deliverable) => deliverable.id));
    for (const deliverable of state.deliverables) {
      if (!projectIds.has(deliverable.projectId))
        context.addIssue({ code: "custom", message: `deliverable ${deliverable.id} has an invalid project` });
      for (const dependencyId of deliverable.dependencyIds)
        if (!deliverableIds.has(dependencyId))
          context.addIssue({ code: "custom", message: `deliverable ${deliverable.id} has an invalid dependency` });
      unique(deliverable.steps, `deliverable ${deliverable.id} step`);
      unique(deliverable.criteria, `deliverable ${deliverable.id} criterion`);
      unique(deliverable.blockers, `deliverable ${deliverable.id} blocker`);
      const stepIds = new Set(deliverable.steps.map((step) => step.id));
      for (const step of deliverable.steps) {
        // A step may only depend on a step of the same deliverable; cross-deliverable ordering is a
        // deliverable dependency, which is the level the engine can explain.
        for (const dependencyId of step.dependencyIds)
          if (!stepIds.has(dependencyId))
            context.addIssue({ code: "custom", message: `step ${step.id} has an invalid prerequisite` });
        if (step.minimumSessionMinutes > step.maximumSessionMinutes)
          context.addIssue({ code: "custom", message: `step ${step.id} has an invalid session range` });
        if (step.optimisticMinutes > step.expectedMinutes || step.expectedMinutes > step.pessimisticMinutes)
          context.addIssue({ code: "custom", message: `step ${step.id} has invalid estimate ordering` });
      }
      for (const criterion of deliverable.criteria)
        for (const stepId of criterion.stepIds)
          if (!stepIds.has(stepId))
            context.addIssue({ code: "custom", message: `criterion ${criterion.id} names an unknown step` });
      for (const blocker of deliverable.blockers)
        for (const stepId of blocker.stepIds)
          if (!stepIds.has(stepId))
            context.addIssue({ code: "custom", message: `blocker ${blocker.id} names an unknown step` });
      const stepCycle = firstCycle(deliverable.steps);
      if (stepCycle)
        context.addIssue({
          code: "custom",
          message: `deliverable ${deliverable.id} has a cyclic prerequisite at step ${stepCycle}`
        });
    }
    const deliverableCycle = firstCycle(state.deliverables);
    if (deliverableCycle)
      context.addIssue({ code: "custom", message: `deliverable ${deliverableCycle} is part of a dependency cycle` });
    const prerequisiteTargets = new Set([
      ...state.projects.map((project) => `project:${project.id}`),
      ...state.deliverables.map((deliverable) => `deliverable:${deliverable.id}`),
      ...state.actions.map((action) => `action:${action.id}`)
    ]);
    const prerequisiteOwners = [
      ...state.projects.map((entity) => ({ label: "project", entity })),
      ...state.deliverables.map((entity) => ({ label: "deliverable", entity })),
      ...state.actions.map((entity) => ({ label: "action", entity }))
    ];
    for (const { label, entity } of prerequisiteOwners)
      for (const ref of entity.prerequisites ?? []) {
        if (!prerequisiteTargets.has(`${ref.kind}:${ref.id}`))
          context.addIssue({ code: "custom", message: `${label} ${entity.id} has an invalid prerequisite` });
        if (ref.kind === label && ref.id === entity.id)
          context.addIssue({ code: "custom", message: `${label} ${entity.id} cannot be its own prerequisite` });
        // Action-to-action and deliverable-to-deliverable edges are `dependencyIds`; only a project's
        // project-to-project edges live here.
        if (ref.kind === label && label !== "project")
          context.addIssue({
            code: "custom",
            message: `${label} ${entity.id} lists a ${label} in prerequisites; use dependencyIds`
          });
      }
    const prerequisiteLoop = firstPrerequisiteCycle(prerequisiteNodes(state));
    if (prerequisiteLoop)
      context.addIssue({
        code: "custom",
        message: `${prerequisiteLoop.kind} ${prerequisiteLoop.id} is part of a prerequisite cycle`
      });
    for (const focus of state.planningFocus)
      for (const projectId of focus.projectIds)
        if (!projectIds.has(projectId))
          context.addIssue({ code: "custom", message: `planning focus ${focus.id} has an invalid project` });
    for (const commitment of state.commitments)
      if (new Date(commitment.startsAt) >= new Date(commitment.endsAt))
        context.addIssue({ code: "custom", message: `${commitment.id} must end after it starts` });
    const occurrenceIds = new Set(state.occurrences.map((occurrence) => occurrence.id));
    if (
      state.activeSession &&
      (!state.activeSession.targetType || state.activeSession.targetType === "action") &&
      !actionIds.has(state.activeSession.actionId) &&
      !occurrenceIds.has(state.activeSession.actionId)
    )
      context.addIssue({ code: "custom", message: "active session has an invalid action" });
  });

export type PortalStateContract = z.infer<typeof portalStateSchema>;
export type PulseWire = z.infer<typeof pulseWireSchema>;
