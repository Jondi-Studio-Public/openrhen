import { z } from "zod";
import { offsetDateTime } from "../iso-datetime.js";
import { actionStatusSchema, energyTypeSchema, lifecycleStatusSchema } from "../core.js";
import { commitmentRepeatFallsOn, commitmentRepeatSchema } from "./commitment-repeat.js";
import { ASSUMABLE_ACTION_FIELDS } from "./action-defaults.js";
import { requirementPathwaySchema, transportModeSchema } from "./context-model.js";
import { removedFieldMessage } from "../removed-field-names.js";
import { prerequisiteRefSchema } from "./prerequisites.js";
import { agentBasisSchema } from "../agent-proposals.js";
import { CONSEQUENCE_WORDINGS } from "./consequence-question.js";

/** A session cannot be planned for longer than a day. */
export const MAX_PLANNED_SESSION_MINUTES = 1440;
const plannedSessionMinutes = z.number().int().positive().max(MAX_PLANNED_SESSION_MINUTES);
const optionalDateTime = offsetDateTime().optional();
const version = z.number().int().positive().nullable();
const status = lifecycleStatusSchema;
const score = z.number().int().min(1).max(5);
const commandBase = z.object({ commandId: z.string().uuid(), expectedVersion: version });
const clockWindowSchema = z.object({
  startTime: z.string().regex(/^\d{2}:\d{2}$/),
  endTime: z.string().regex(/^\d{2}:\d{2}$/)
});
const recurrenceWindowSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().trim().min(1),
    anchor: z.enum(["wake", "sleep_start", "local_time"]),
    startOffsetMinutes: z.number().int().optional(),
    endOffsetMinutes: z.number().int().optional(),
    localStartTime: z
      .string()
      .regex(/^\d{2}:\d{2}$/)
      .optional(),
    localEndTime: z
      .string()
      .regex(/^\d{2}:\d{2}$/)
      .optional(),
    fallback: clockWindowSchema.optional()
  })
  .superRefine((value, context) => {
    if (value.anchor === "local_time" && (!value.localStartTime || !value.localEndTime))
      context.addIssue({ code: "custom", message: "Clock windows require start and end times." });
    if (
      value.anchor !== "local_time" &&
      (value.startOffsetMinutes === undefined ||
        value.endOffsetMinutes === undefined ||
        value.endOffsetMinutes <= value.startOffsetMinutes)
    )
      context.addIssue({ code: "custom", message: "Relative windows require an increasing offset range." });
  });
// a target count of occurrences inside a rolling window of days or the calendar month, as an
// alternative to a cadence rule's plain `intervalDays` due date. Cadence-only — see the save-action
// `superRefine` below.
const cadencePeriodSchema = z.union([
  z.object({ unit: z.literal("days"), length: z.number().int().positive() }),
  z.object({ unit: z.literal("month") })
]);
export const overrideReasonSchema = z.enum([
  "better_fit",
  "lower_energy",
  "context_unavailable",
  "deadline_judgment",
  "maintain_momentum",
  "personal_priority",
  "other"
]);
export const blockingReasonSchema = z.enum([
  "missing_information",
  "waiting_on_someone",
  "dependency",
  "context_unavailable",
  "energy_or_health",
  "technical_problem",
  "other"
]);

export const saveProjectCommandSchema = z.object({
  commandId: z.string().uuid().optional(),
  expectedVersion: version,
  project: z
    .object({
      id: z.string().min(1),
      outcomeId: z.string().min(1),
      title: z.string().trim().min(1),
      status,
      uncertainty: z.enum(["known", "some", "high"]),
      consequence: score,
      internalDeadlineAt: optionalDateTime,
      externalDeadlineAt: optionalDateTime,
      remainingEffortOverrideMinutes: z.number().int().min(0).optional(),
      /** The pulse criteria and publish design note ("Private"): hides this project, and everything
          under it, from the published pulse. Absent on update leaves the stored value untouched. */
      private: z.boolean().optional(),
      /** Extra prerequisites (`prerequisites.ts`). Absent leaves the stored edges untouched; `[]` clears them. */
      prerequisites: z.array(prerequisiteRefSchema).optional()
    })
    .refine(
      (value) =>
        !value.internalDeadlineAt ||
        !value.externalDeadlineAt ||
        new Date(value.internalDeadlineAt) <= new Date(value.externalDeadlineAt),
      "Internal deadline cannot be after external deadline."
    )
});

/**
 * "Confirm project still wanted" (the weekly review's Keep): stamps `projects.last_reviewed_at`. This is the only
 * command that writes the column; `saveProjectCommandSchema` has no such field and a project save keeps the stored
 * value. `reviewedAt` is absent for a Keep (the server stamps now); the CLI's undo sends the earlier value back
 * (`null` when there was none).
 */
export const confirmProjectWantedCommandSchema = z.object({
  commandId: z.string().uuid().optional(),
  projectId: z.string().min(1),
  expectedVersion: z.number().int().positive(),
  reviewedAt: offsetDateTime().nullable().optional(),
  /**
   * What the stamp is for. Absent is a Keep (`last_reviewed_at`, which holds the project off the stale list for 30
   * days). `overdue_seen` is the review's "Seen, leave it" on an overdue project (`overdue_seen_at`, which keeps it
   * out of that review week's count). Both take `reviewedAt` the same way, so undo works for either.
   */
  kind: z.enum(["keep", "overdue_seen"]).optional()
});

export const saveActionCommandSchema = z.object({
  commandId: z.string().uuid().optional(),
  blockingReason: blockingReasonSchema.optional(),
  note: z.string().trim().max(2000).optional(),
  /**
   * True when the caller said the remaining time in this call, so it counts as confirmed now even when it matches
   * what is stored ("still about 3 h"): the answer to an aged-effort need. A save without it moves
   * `remainingSetAt` only when `remainingMinutes` changed, so an edit to something else never re-dates it.
   */
  remainingAsserted: z.boolean().optional(),
  expectedVersion: version,
  action: z
    .object({
      id: z.string().min(1),
      projectId: z.string().min(1),
      title: z.string().trim().min(1),
      status: actionStatusSchema,
      optimisticMinutes: z.number().int().positive(),
      expectedMinutes: z.number().int().positive(),
      pessimisticMinutes: z.number().int().positive(),
      remainingMinutes: z.number().int().min(0),
      energy: energyTypeSchema,
      minimumSessionMinutes: z.number().int().positive(),
      maximumSessionMinutes: z.number().int().positive(),
      splittable: z.boolean(),
      setupMinutes: z.number().int().min(0),
      importance: score,
      consequence: score,
      /** The pulse criteria and publish design note ("Private"): hides this action from the
          published pulse. Absent on update leaves the stored value untouched. */
      private: z.boolean().optional(),
      /**
       * Which of the estimate and judgement fields (`ASSUMABLE_ACTION_FIELDS`) are a default or a guess
       * rather than something a person said, so OpenRhen can label them. The CLI sends it on every action
       * save (`withActionDefaults`, `assumedFieldsAfterUpdate`). Absent leaves the stored list to the server:
       * a field stays assumed only while its value is unchanged (`nextAssumedFields`). `[]` says none are.
       */
      assumedFields: z
        .array(z.enum(ASSUMABLE_ACTION_FIELDS))
        .optional()
        .describe(
          "Fields that are a default or a guess. An update drops each one it names; give it only to say otherwise."
        ),
      /**
       * Marks this action as prep for a commitment (`CONTEXT.md` "Prep"). Absent on update leaves the
       * stored value untouched; explicit `null` detaches the action from its commitment.
       */
      prepForCommitmentId: z.string().trim().min(1).nullable().optional(),
      // no longer stored on its own (`action_contexts` is gone) — a caller sending only this,
      // with `requirementPathways` absent, is treated as one AND pathway of these contexts, the same
      // thing this field always meant. A caller that also sends `requirementPathways` means that
      // explicitly and wins.
      contexts: z.array(z.string().trim().min(1)),
      dependencyIds: z.array(z.string().min(1)),
      /** Prerequisites that are not other actions (`prerequisites.ts`). Absent leaves the stored edges untouched; `[]` clears them. */
      prerequisites: z.array(prerequisiteRefSchema).optional(),
      // Requirements are AND within a route and OR across them. Absent means the caller has nothing to
      // say about them, and the stored pathways are left alone; an empty array clears them. A route may
      // be sent either as a bare `string[]` or as the read shape's `{ id, contextIds }` object, so a
      // caller that merges a stored action straight back into a write payload does not have to convert.
      requirementPathways: z
        .array(z.union([z.array(z.string().trim().min(1)).min(1), requirementPathwaySchema]))
        .optional(),
      preferences: z.array(z.string().trim().min(1)).optional(),
      availableFrom: optionalDateTime,
      deadlineAt: optionalDateTime,
      latestStartAt: optionalDateTime,
      completedAt: optionalDateTime,
      notes: z.string().trim().max(5000).optional(),
      // `recurring` is a recurrence inside fixed windows; `cadence` is a rhythm suggested every N days
      // when time allows, so it carries a rule but no windows.
      schedulingMode: z.enum(["one_off", "recurring", "cadence"]).optional(),
      recurrence: z
        .object({
          id: z.string().min(1),
          timezone: z.string().min(1),
          startDate: z.string().date(),
          endDate: z.string().date().optional(),
          intervalDays: z.number().int().positive(),
          windows: z.array(recurrenceWindowSchema).default([]),
          completionMode: z.enum(["end_date", "total_minutes", "manual"]).optional(),
          targetTotalMinutes: z.number().int().positive().optional(),
          // cadence-only fields: takes precedence over `intervalDays` when present.
          period: cadencePeriodSchema.optional(),
          targetOccurrences: z.number().int().positive().optional(),
          minSpacingDays: z.number().int().min(0).optional(),
          eligibleWeekdays: z.array(z.number().int().min(0).max(6)).min(1).optional()
        })
        .optional()
    })
    .superRefine((value, context) => {
      if (!(value.optimisticMinutes <= value.expectedMinutes && value.expectedMinutes <= value.pessimisticMinutes)) {
        const [low, mid, high] = [value.optimisticMinutes, value.expectedMinutes, value.pessimisticMinutes].sort(
          (a, b) => a - b
        );
        context.addIssue({
          code: "custom",
          path: ["expectedMinutes"],
          message:
            `optimisticMinutes ${value.optimisticMinutes}, expectedMinutes ${value.expectedMinutes} and ` +
            `pessimisticMinutes ${value.pessimisticMinutes} are out of order: optimisticMinutes must be at most ` +
            "expectedMinutes, which must be at most pessimisticMinutes. Changing one estimate on an existing action " +
            "keeps the other two as they are, so send optimisticMinutes, expectedMinutes and pessimisticMinutes " +
            `together (for example ${low}, ${mid}, ${high}).`
        });
      }
      if (value.remainingMinutes > value.pessimisticMinutes)
        context.addIssue({ code: "custom", message: "Remaining effort exceeds the pessimistic estimate." });
      if (value.minimumSessionMinutes > value.maximumSessionMinutes)
        context.addIssue({ code: "custom", message: "Minimum session exceeds maximum session." });
      if (value.dependencyIds.includes(value.id))
        context.addIssue({ code: "custom", message: "An action cannot depend on itself." });
      if (value.prerequisites?.some((ref) => ref.kind === "action"))
        context.addIssue({
          code: "custom",
          message: "An action lists other actions in dependencyIds, not prerequisites."
        });
      if ((value.schedulingMode === "recurring" || value.schedulingMode === "cadence") && !value.recurrence)
        context.addIssue({ code: "custom", message: "Recurring actions require a recurrence rule." });
      if (value.schedulingMode === "recurring" && value.recurrence && value.recurrence.windows.length === 0)
        context.addIssue({ code: "custom", message: "A recurrence needs at least one window." });
      if (value.schedulingMode === "cadence" && value.recurrence && value.recurrence.windows.length > 0)
        context.addIssue({
          code: "custom",
          message: "A cadence has no windows; it is suggested when time allows."
        });
      if (value.recurrence && value.recurrence.endDate && value.recurrence.endDate < value.recurrence.startDate)
        context.addIssue({ code: "custom", message: "Recurrence end date cannot be before its start date." });
      if (value.recurrence?.completionMode === "end_date" && !value.recurrence.endDate)
        context.addIssue({ code: "custom", message: "An end-date recurrence requires an end date." });
      if (value.recurrence?.completionMode === "total_minutes" && !value.recurrence.targetTotalMinutes)
        context.addIssue({ code: "custom", message: "A total-time recurrence requires a target." });
      if (
        value.schedulingMode !== "cadence" &&
        value.recurrence &&
        (value.recurrence.period ||
          value.recurrence.targetOccurrences !== undefined ||
          value.recurrence.minSpacingDays !== undefined ||
          value.recurrence.eligibleWeekdays)
      )
        context.addIssue({
          code: "custom",
          message: "Period, target occurrences, minimum spacing and eligible weekdays only apply to a cadence."
        });
      if (
        value.recurrence?.period?.unit === "days" &&
        value.recurrence.minSpacingDays &&
        value.recurrence.targetOccurrences &&
        value.recurrence.minSpacingDays * value.recurrence.targetOccurrences > value.recurrence.period.length
      )
        context.addIssue({
          code: "custom",
          message: "Minimum spacing times the target occurrences does not fit within the period."
        });
    })
});

/** The `project` field of `saveProjectCommandSchema`, for callers that describe or check one project's fields. */
export const projectEntitySchema = saveProjectCommandSchema.shape.project;
/** The `action` field of `saveActionCommandSchema`, for callers that describe or check one action's fields. */
export const actionEntitySchema = saveActionCommandSchema.shape.action;

export const endRecurrenceGoalCommandSchema = commandBase.extend({
  type: z.literal("end_recurrence_goal"),
  actionId: z.string().min(1)
});
export type EndRecurrenceGoalCommand = z.infer<typeof endRecurrenceGoalCommandSchema>;

/**
 * Marks a cadence cycle done without a session — a run that happened away from the app.
 * Dated by local day; the same day recorded twice is one completion, not two.
 */
export const recordCadenceCompletionCommandSchema = commandBase.extend({
  type: z.literal("record_cadence_completion"),
  actionId: z.string().min(1),
  localDate: z.string().date().optional(),
  minutes: z.number().int().min(0).optional()
});
export type RecordCadenceCompletionCommand = z.infer<typeof recordCadenceCompletionCommandSchema>;

export const saveCommitmentRecurrenceRuleCommandSchema = z.object({
  commandId: z.string().uuid().optional(),
  expectedVersion: version,
  rule: z
    .object({
      id: z.string().min(1),
      title: z.string().trim().min(1),
      timezone: z.string().min(1),
      startDate: z.string().date(),
      endDate: z.string().date().optional(),
      repeat: commitmentRepeatSchema,
      localStartTime: z.string().regex(/^\d{2}:\d{2}$/),
      localEndTime: z.string().regex(/^\d{2}:\d{2}$/),
      location: z.string().trim().optional(),
      locationId: z.string().trim().min(1).optional(),
      setupBeforeMinutes: z.number().int().min(0),
      transitionAfterMinutes: z.number().int().min(0),
      /** What each occurrence claims of the time; see the state schema. Absent means 'blocking'. */
      presence: z.enum(["blocking", "anchor"]).optional(),
      /**
       * Whether this rule's occurrences publish to the family calendar. Absent means false
       * on a fresh rule; on an existing rule's update it means "no opinion" and leaves the stored
       * value untouched (see `saveCommitmentRecurrenceRule`).
       */
      shareToCalendar: z.boolean().optional(),
      /** Removed: the old name of `shareToCalendar`. Naming it fails the parse with the current name, rather than being dropped. */
      shareWithFamily: z.never({ error: removedFieldMessage({ shareWithFamily: true }) ?? "removed" }).optional(),
      status: z.enum(["active", "ended"]).optional(),
      projectId: z.string().trim().optional(),
      /**
       * The slug of a `condition_definitions` row of kind `contact`, no FK. Trimmed; an empty string
       * clears the stored value, an absent field leaves it untouched — see `recurrence-commands.ts`.
       */
      contactId: z.string().trim().optional(),
      /**
       * Whether a late arrival at this rule's occurrences matters (the travel time model design note
       * "Caution"). Copied onto each occurrence at materialisation, part of the per-date overlay.
       * Absent on update leaves the stored value untouched; absent on insert defaults to true, the
       * column's own default.
       */
      latenessMatters: z.boolean().optional(),
      /**
       * How this rule's occurrences are reached, when known (the travel time model design note, "Mode
       * per leg"). Part of the per-date overlay. Absent on update leaves the stored value untouched;
       * explicit `null` clears it back to "usual" (the series editor's own way of un-setting a
       * previously chosen mode, which a bare enum could not express — see `recurrence-commands.ts`).
       */
      transportMode: transportModeSchema.nullable().optional(),
      /** The pulse criteria and publish design note ("Private"): effective privacy is this OR the
          occurrence's own flag. Absent on update leaves the stored value untouched. */
      private: z.boolean().optional(),
      /**
       * Pulse check-in allowance for this rule's occurrences. Absent on update
       * leaves the stored value untouched; explicit `null` clears it back to the default.
       */
      checkInExtraMinutes: z.number().int().min(0).max(480).nullable().optional()
    })
    .superRefine((value, context) => {
      if (value.endDate && value.endDate < value.startDate)
        context.addIssue({ code: "custom", message: "Recurrence end date cannot be before its start date." });
      if (value.localEndTime <= value.localStartTime)
        context.addIssue({ code: "custom", message: "Recurrence end time must be after its start time." });
      // Invariant 2: a rule always falls on its own start date. Rejects, for example, a `last_day`
      // rule starting on the 15th, or an `nth_weekday` rule whose start is the 5th of its weekday.
      if (!commitmentRepeatFallsOn(value.repeat, value.startDate, value.startDate))
        context.addIssue({
          code: "custom",
          path: ["repeat"],
          message: "This repeat does not match its own start date."
        });
    }),
  /**
   * Answers the `occurrence_in_progress` refusal: absent while an
   * occurrence is in progress refuses the save; `false` marks that occurrence `custom` with its current
   * values before saving; `true` leaves it `inherit` so the series edit reaches it too.
   */
  applyToOccurrenceInProgress: z.boolean().optional()
});
export type SaveCommitmentRecurrenceRuleCommand = z.infer<typeof saveCommitmentRecurrenceRuleCommandSchema>;

/**
 * **Not the same event** on commitment detail: the
 * secondary source link `linkId` stops belonging to `commitmentId` and becomes a commitment of its
 * own. `expectedVersion` is the version of `commitmentId` the reader was looking at.
 */
export const splitCommitmentSourceCommandSchema = z.object({
  commandId: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
  commitmentId: z.string().uuid(),
  linkId: z.string().uuid()
});
export type SplitCommitmentSourceCommand = z.infer<typeof splitCommitmentSourceCommandSchema>;

/**
 * Undoes or redoes an agent's earlier write. `target` is the
 * `commandId` of the write whose row snapshot (`writes.images`) is put back or re-applied; `commandId` is
 * this revert's own, so a retry replays rather than reverting twice. A row changed since the agent's write
 * refuses the revert unless `force` says the person wants it overwritten.
 */
export const revertCommandSchema = z.object({
  commandId: z.string().uuid(),
  target: z.string().min(1).max(200),
  direction: z.enum(["undo", "redo"]),
  force: z.boolean().optional()
});
export type RevertCommand = z.infer<typeof revertCommandSchema>;

export type SaveProjectCommand = z.infer<typeof saveProjectCommandSchema>;
export type ConfirmProjectWantedCommand = z.infer<typeof confirmProjectWantedCommandSchema>;
export type SaveActionCommand = z.infer<typeof saveActionCommandSchema>;

export const sessionCommandSchema = z.discriminatedUnion("type", [
  commandBase.extend({
    type: z.literal("start"),
    actionId: z.string().min(1),
    plannedMinutes: plannedSessionMinutes,
    recommendationId: z.string().uuid().nullable().optional(),
    // A past start: bounded on the server.
    startedAt: optionalDateTime
  }),
  commandBase.extend({
    type: z.literal("select_alternative"),
    actionId: z.string().min(1),
    plannedMinutes: plannedSessionMinutes,
    recommendationId: z.string().uuid().nullable().optional(),
    reason: overrideReasonSchema,
    note: z.string().trim().max(1000).optional(),
    startedAt: optionalDateTime
  }),
  // Moves the start of the open session to a past moment (the design notes,
  // "Correcting a start already made"): the same bounds as a past start.
  commandBase.extend({
    type: z.literal("correct_start"),
    sessionId: z.string().uuid(),
    startedAt: offsetDateTime()
  }),
  commandBase.extend({ type: z.literal("pause"), sessionId: z.string().uuid() }),
  commandBase.extend({ type: z.literal("resume"), sessionId: z.string().uuid() }),
  commandBase.extend({ type: z.literal("request_feedback"), sessionId: z.string().uuid() }),
  commandBase.extend({
    type: z.literal("continue"),
    sessionId: z.string().uuid(),
    requestedMinutes: z.number().int().positive().max(480)
  }),
  commandBase
    .extend({
      type: z.literal("finish"),
      sessionId: z.string().uuid(),
      outcome: z.enum(["completed", "progress", "unsure"]),
      remainingMinutes: z.number().int().min(0).optional(),
      note: z.string().trim().max(2000).optional(),
      // Ends a session at a chosen past moment instead of now, with the same bounds as `finish_activity`'s:
      // after the start of the segment it ends, no later than now, running or awaiting-feedback sessions only.
      endedAt: optionalDateTime
    })
    .superRefine((value, context) => {
      if (value.outcome === "progress" && value.remainingMinutes === undefined)
        context.addIssue({
          code: "custom",
          message:
            'outcome "progress" needs remainingMinutes: the whole minutes of effort left after this work (0 or more). Send it with the finish, or use outcome "completed" if nothing is left.'
        });
    }),
  commandBase.extend({
    type: z.literal("block"),
    sessionId: z.string().uuid(),
    reason: blockingReasonSchema,
    actionStatus: z.enum(["waiting", "blocked"]),
    note: z.string().trim().max(2000).optional()
  }),
  commandBase.extend({
    type: z.literal("did_not_start"),
    sessionId: z.string().uuid(),
    note: z.string().trim().max(2000).optional()
  })
]);

export const activityCommandSchema = z.discriminatedUnion("type", [
  commandBase
    .extend({
      type: z.literal("start_activity"),
      // `routine_instance` dropped: a sleep-anchored
      // routine step is now a `routine_steps` row like a commitment's, so starting one is an ordinary
      // `routine_step` start naming that row's own id — no separate instance/step split.
      targetType: z.enum(["routine_step", "sleep", "fixed_commitment", "deliverable"]),
      targetId: z.string().min(1),
      stepId: z.string().min(1).optional(),
      plannedMinutes: plannedSessionMinutes,
      // Only meaningful for `fixed_commitment`: which of the commitment's protected phases this session
      // tracks, so the title and duration say what was actually being done rather than naming the
      // commitment itself for time spent getting ready or travelling to it.
      phase: z.enum(["setup", "travel", "arrival", "active", "transition", "return"]).optional(),
      // Starts the session at a chosen past moment instead of now.
      // Refused for `sleep` (use the sleep log), and by the server outside its bounds.
      startedAt: optionalDateTime
    })
    .superRefine((value, context) => {
      if (value.targetType === "sleep" && value.startedAt !== undefined)
        context.addIssue({
          code: "custom",
          path: ["startedAt"],
          message: "A sleep cannot be started in the past; log the night with save sleep-log-entry."
        });
    }),
  // Moving to another step inside the same deliverable. It closes the open segment and opens the next
  // one, so the elapsed time follows the step it was actually spent on and the session total stays a
  // sum of its parts rather than a second running count.
  commandBase.extend({
    type: z.literal("switch_deliverable_step"),
    sessionId: z.string().uuid(),
    stepId: z.string().min(1)
  }),
  commandBase.extend({
    type: z.literal("pause_activity"),
    sessionId: z.string().uuid(),
    note: z.string().trim().max(2000).optional()
  }),
  commandBase.extend({ type: z.literal("resume_activity"), sessionId: z.string().uuid() }),
  commandBase.extend({
    type: z.literal("finish_activity"),
    sessionId: z.string().uuid(),
    // `skipped` is only ever valid for a `routine_step` session — the server refuses it for anything
    // else — since it is the one target whose "done" and "moot" are worth telling apart.
    outcome: z.enum(["completed", "stopped", "blocked", "did_not_start", "skipped"]),
    note: z.string().trim().max(2000).optional(),
    // Ends the session at a chosen past moment instead of now: the open segment closes there, or for a
    // session awaiting feedback the segment the checkpoint closed ends there. Refused unless that
    // segment's start < endedAt <= now, and refused outright for a paused session — see
    // The session reconciliation design note.
    endedAt: optionalDateTime
  }),
  commandBase.extend({
    type: z.literal("skip_routine_step"),
    // Names the `routine_steps` row directly, for either anchor — no instance id, since a
    // sleep-anchored step is a row like a commitment's own.
    stepId: z.string().min(1)
  }),
  commandBase.extend({
    type: z.literal("reopen_routine_step"),
    // Undoes a skip: names the same `routine_steps` row, for either anchor, and returns it to pending.
    stepId: z.string().min(1)
  })
]);

export const planningEntityCommandSchema = commandBase.extend({
  type: z.literal("save_entity"),
  // A deliverable saves as one aggregate — criteria, steps, and blockers included — because its
  // contract and plan are approved together and a half-applied approval would be a lie about what
  // the user agreed to.
  entityType: z.enum([
    "area",
    "outcome",
    "commitment",
    "settings",
    "condition_definition",
    "current_availability",
    "routine_step",
    "routine_preset",
    "sleep_plan",
    "sleep_log_entry",
    "span",
    "capture",
    "capture_review",
    "daily_plan",
    "planning_focus",
    "deliverable",
    "deliverable_contract_review"
  ]),
  entity: z.record(z.string(), z.unknown())
});

export const recalculateCommandSchema = z.object({
  commandId: z.string().uuid(),
  type: z.literal("recalculate"),
  now: offsetDateTime(),
  assertedConditions: z.array(z.string().trim().min(1)).optional()
});

/**
 * `rankConsequenceGroup`: the answer to a group of items the server handed out ("which would you do if you could only
 * finish one?"). The portal card, `rhen rank` and an agent's `rhen_save comparison` all send this. `rankedIds` are
 * every id of the group once, best first; `tie` says they are equal or the person cannot decide. The server derives
 * who answered from the caller (a person in the portal, or the agent token), forces a person's basis to `stated`, and
 * holds an agent to the basis rules (`stated` and `observed` need evidence; `inferred` counts for half). `wording` is
 * optional: when sent it must be the wording the group was asked under. The command id is the idempotency key.
 */
export const rankConsequenceGroupCommandSchema = z
  .object({
    commandId: z.string().uuid(),
    groupId: z.string().trim().min(1).max(100),
    rankedIds: z.array(z.string().trim().min(1).max(200)).max(8).optional(),
    tie: z.boolean().optional(),
    wording: z.enum(CONSEQUENCE_WORDINGS).optional(),
    basis: agentBasisSchema.optional(),
    evidence: z.string().trim().min(1).max(300).optional()
  })
  .superRefine((command, context) => {
    if (command.tie === true && (command.rankedIds?.length ?? 0) > 0)
      context.addIssue({
        code: "custom",
        path: ["rankedIds"],
        message: "Send either rankedIds (every id of the group once, best first) or tie: true, not both."
      });
    if (command.tie !== true && (command.rankedIds?.length ?? 0) === 0)
      context.addIssue({
        code: "custom",
        path: ["rankedIds"],
        message:
          "Send rankedIds (every id of the group once, best first), or tie: true if the person says they are equal or cannot decide."
      });
  });
export type RankConsequenceGroupCommand = z.infer<typeof rankConsequenceGroupCommandSchema>;

/** What a recorded answer returns. */
export interface RankConsequenceGroupResult {
  comparisonId: string;
  groupId: string;
  /** True when this exact answer had already been recorded under the same command id. */
  replayed: boolean;
  by: "person" | "agent";
  basis: "stated" | "observed" | "inferred";
  /** What to do next, in words. */
  next: string;
}

/** How far back a wake or a sleep start may be told (the same bound as a backfilled session start). */
export const WAKE_MAX_BACK_HOURS = 24;

/**
 * `rhen wake`: when the person woke is an observation, and
 * this settles last night around it in one call. `at` (default: now) is when they woke and `sleptAt` when they went
 * to sleep; both are past moments within `WAKE_MAX_BACK_HOURS`, which the server checks against its own clock.
 */
export const wakeCommandSchema = z
  .object({
    commandId: z.string().uuid(),
    type: z.literal("wake"),
    at: optionalDateTime,
    sleptAt: optionalDateTime
  })
  .superRefine((value, context) => {
    if (value.at !== undefined && value.sleptAt !== undefined && Date.parse(value.sleptAt) >= Date.parse(value.at))
      context.addIssue({ code: "custom", path: ["sleptAt"], message: "The wake must be after the time slept." });
  });

/**
 * What a wake settled: a running sleep was finished, last night's planned sleep was completed, or a night was logged;
 * or, with no start tracked, planned or told (the usual case after a break), only the wake was recorded.
 */
export const wakeResultSchema = z.union([
  z.object({
    outcome: z.enum(["finished_session", "completed_plan", "logged_night"]),
    /** The sleep-log entry id: what `save sleep-log-entry --id` corrects. */
    sleepPlanId: z.string().uuid(),
    sleptAt: offsetDateTime(),
    wokeAt: offsetDateTime(),
    /** True when no start was given or tracked, so the planned start was taken for it. */
    startAssumed: z.boolean()
  }),
  /** The last wake moved to `wokeAt` and no night was logged. */
  z.object({ outcome: z.literal("recorded_wake"), wokeAt: offsetDateTime() })
]);

/** What a check-in answered "deviated" was taken up by instead. */
export const deviationCategorySchema = z.enum(["work", "family", "life_admin", "other"]);

/**
 * Answers one check-in slot. Record-only (Phase A): this never starts, switches, or otherwise touches
 * a session — `deviationTargetId` is a plain label of what was actually happening, not an action.
 */

const answerCheckInObjectSchema = commandBase.extend({
  type: z.literal("answer_check_in"),
  checkInId: z.string().uuid(),
  status: z.enum(["on_track", "deviated", "unknown"]),
  deviationCategory: deviationCategorySchema.optional(),
  deviationNote: z.string().trim().max(1000).optional(),
  /** A different planned task named instead of the engine's belief — recorded only, never started. */
  deviationTargetId: z.string().min(1).optional(),
  answerSource: z.enum(["in_app_banner", "sheet", "session_reconciliation"])
});

/**
 * Answers a whole check-in trail in one transaction, splitting it at `upTo` (see
 * The session reconciliation design note, "What reconciliation writes to them"): every id at or
 * before `upTo` becomes `on_track`; every id after it takes the tail's single answer. Reconciliation's
 * own escape hatch — "I was working the whole time" — is this same command with every slot on_track,
 * not a separate command. Record-only, same as `answer_check_in`: this never touches a session.
 */
const answerCheckInsObjectSchema = z.object({
  commandId: z.string().uuid(),
  type: z.literal("answer_check_ins"),
  checkInIds: z.array(z.string().uuid()).min(1),
  upTo: offsetDateTime(),
  tail: z.object({
    status: z.enum(["on_track", "deviated", "unknown"]),
    deviationCategory: deviationCategorySchema.optional(),
    deviationNote: z.string().trim().max(1000).optional()
  })
});

/**
 * A voluntary check-in: the answer when no check-in is waiting (the pulse went unknown and nobody was asked).
 * The server records a new, already-answered `check_in` row for the engine's current belief and refuses when
 * a check-in is open (answer that with `answer_check_in`) or the engine believes nothing.
 */
const voluntaryCheckInObjectSchema = commandBase.extend({
  type: z.literal("voluntary_check_in"),
  status: z.enum(["on_track", "deviated", "unknown"]),
  deviationCategory: deviationCategorySchema.optional(),
  deviationNote: z.string().trim().max(1000).optional(),
  deviationTargetId: z.string().min(1).optional(),
  answerSource: z.enum(["in_app_banner", "sheet"])
});

export const checkInCommandSchema = z
  .discriminatedUnion("type", [answerCheckInObjectSchema, answerCheckInsObjectSchema, voluntaryCheckInObjectSchema])
  .superRefine((value, context) => {
    if (value.type === "answer_check_in" || value.type === "voluntary_check_in") {
      if (value.deviationCategory && value.status !== "deviated")
        context.addIssue({ code: "custom", message: "A deviation category only belongs on a deviated answer." });
      if (value.deviationTargetId && value.status !== "deviated")
        context.addIssue({ code: "custom", message: "A named task only belongs on a deviated answer." });
    } else if (value.tail.deviationCategory && value.tail.status !== "deviated") {
      context.addIssue({ code: "custom", message: "A deviation category only belongs on a deviated tail answer." });
    }
  });
export type CheckInCommand = z.infer<typeof checkInCommandSchema>;
export type AnswerCheckInCommand = Extract<CheckInCommand, { type: "answer_check_in" }>;
export type VoluntaryCheckInCommand = Extract<CheckInCommand, { type: "voluntary_check_in" }>;
export type AnswerCheckInsCommand = Extract<CheckInCommand, { type: "answer_check_ins" }>;

export type SessionCommand = z.infer<typeof sessionCommandSchema>;
export type OverrideReason = z.infer<typeof overrideReasonSchema>;
export type BlockingReason = z.infer<typeof blockingReasonSchema>;
export type PlanningEntityCommand = z.infer<typeof planningEntityCommandSchema>;
export type RecalculateCommand = z.infer<typeof recalculateCommandSchema>;
export type ActivityCommand = z.infer<typeof activityCommandSchema>;
export type WakeCommand = z.infer<typeof wakeCommandSchema>;
export type WakeResult = z.infer<typeof wakeResultSchema>;
