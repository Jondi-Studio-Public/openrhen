import { z } from "zod";
import { offsetDateTime } from "../iso-datetime.js";
import { energyTypeSchema, lifecycleStatusSchema } from "../core.js";
import {
  captureStatusSchema,
  commitmentStatusSchema,
  deliverableStatusSchema,
  routinePresetStatusSchema,
  routineStepStatusSchema,
  timeBandSchema
} from "../portal/state-schema.js";
import { openQuestionSchema } from "../questions.js";
import { actionEntitySchema, blockingReasonSchema, projectEntitySchema } from "./commands.js";
import {
  conditionKindSchema,
  conditionPortabilitySchema,
  conditionStatusSchema,
  contactChannelSchema,
  currentSituationSchema,
  transportModeSchema
} from "./context-model.js";
import { prerequisiteRefSchema } from "./prerequisites.js";
import { spanEntitySchema } from "./span.js";

/**
 * The fields the portal accepts for each `save` entity kind (the CLI's `ENTITY_TYPES`), so the CLI and
 * the MCP can publish a typed JSON Schema per kind and refuse an unknown field name before sending.
 *
 * The generic kinds travel as `planningEntityCommandSchema`'s open `entity` record and are validated by hand
 * in `portal/server/persistence/postgres/entity-commands.ts` (`saveEntity`, one branch per kind) and, for a
 * deliverable, `deliverable-write.ts`. These schemas list every top-level name those branches read, with the
 * type each accepts. Nested objects are typed loosely where the portal validates them in depth. A field is
 * required only where the portal refuses a create without it. The schemas are not strict: callers do their
 * own unknown-key check against `entityFieldNames`.
 *
 * Only what the save path reads and stores is listed: read-only joined or derived fields of a stored record
 * (a project's `area`, a commitment's `sources`, ...) are deliberately absent, so a caller sending one is told
 * it cannot be saved.
 */

export const SAVE_ENTITY_KINDS = [
  "area",
  "outcome",
  "project",
  "action",
  "commitment",
  "capture",
  "deliverable",
  "routine_step",
  "routine_preset",
  "sleep_plan",
  "planning_focus",
  "span",
  "condition_definition",
  "settings",
  "daily_plan",
  "current_availability",
  "sleep_log_entry",
  "capture_review",
  "deliverable_contract_review"
] as const;
export type SaveEntityKind = (typeof SAVE_ENTITY_KINDS)[number];

function entity<Shape extends z.ZodRawShape>(shape: Shape): z.ZodObject<Shape> {
  return z.object(shape);
}

const dateTime = offsetDateTime();
const OFFSET = "ISO 8601 with the owner's UTC offset (status.timezone), as 2026-10-28T09:00:00<offset>";
const optionalDateTime = (what: string) => dateTime.optional().describe(`${what} (${OFFSET}).`);
/** A date-time the portal clears when sent as null. */
const clearableDateTime = (what: string) =>
  dateTime.nullable().optional().describe(`${what} (${OFFSET}); null clears it.`);
const text = z.string();
const clearableText = z.string().nullable().optional();
const score = z.number().int().min(1).max(5);
const minutes = z.number().int().min(0);
const stringList = z.array(z.string());
const calendarDay = z.string();
const recordOfUnknown = z.record(z.string(), z.unknown());
const id = (what: string) => z.string().min(1).optional().describe(what);
const privateFlag = z
  .boolean()
  .optional()
  .describe("Hides this from the published pulse. Leaving it out keeps the stored value.");

// ---- Nested shapes the portal validates in depth: typed loosely, with the names it reads. ----

const routineStepTimingFields = {
  timingRule: z
    .enum(["contiguous", "flexible"])
    .describe("contiguous runs back to back; flexible may start up to maxLeadMinutes early."),
  maxLeadMinutes: z.number().int().positive().optional().describe("Required when timingRule is flexible."),
  energy: energyTypeSchema,
  contexts: stringList.optional().describe("Context (condition) ids the step needs."),
  dependencyIds: stringList
    .optional()
    .describe("Ids of steps in the same phase that must finish first. Left out, the previous step is used."),
  phase: z.enum(["before", "after"]).optional().describe("Whether the step comes before or after the commitment."),
  actionWindowId: z.string().nullable().optional().describe("A recurring-action window this step is the same work as."),
  cadenceActionId: z.string().nullable().optional().describe("A cadence action this step stands in for."),
  waitAfterMinutes: minutes.optional().describe("Minutes that must pass after this step before dependents begin."),
  mustStartByMinutes: z
    .number()
    .int()
    .positive()
    .nullable()
    .optional()
    .describe("Latest start, minutes from the chain anchor."),
  preferredBands: stringList.optional().describe("Time band ids (settings.timeBands) a flexible before-step prefers.")
};

const presetStepSchema = z
  .object({
    id: z.string().min(1),
    title: text,
    durationMinutes: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Minutes. Ignored when actionWindowId links an action."),
    sequence: minutes.optional(),
    ...routineStepTimingFields
  })
  .passthrough();

const deliverableStepSchema = z
  .object({
    id: z.string().min(1),
    title: text,
    details: text.optional(),
    completionCondition: text.optional(),
    status: z.enum(["planned", "doing", "waiting", "blocked", "done", "cancelled"]).optional(),
    optimisticMinutes: z.number().int().positive(),
    expectedMinutes: z.number().int().positive(),
    pessimisticMinutes: z.number().int().positive(),
    remainingMinutes: minutes.optional().describe("Defaults to expectedMinutes."),
    energy: energyTypeSchema,
    minimumSessionMinutes: z.number().int().positive(),
    maximumSessionMinutes: z.number().int().positive(),
    splittable: z.boolean().optional(),
    setupMinutes: minutes.optional(),
    required: z.boolean().optional(),
    completedAt: dateTime.optional(),
    dependencyIds: stringList.optional(),
    requirementPathways: z.array(z.unknown()).optional().describe("string[][] or { id, contextIds }[] routes."),
    reblockOnComplete: z.object({ description: text, category: text }).passthrough().optional()
  })
  .passthrough();

const deliverableCriterionSchema = z
  .object({
    id: z.string().optional(),
    key: z.string().optional().describe("Stable criterion key; falls back to id."),
    title: text,
    required: z.boolean().optional(),
    interpretation: text.optional(),
    sourceDocument: text.optional(),
    sourceLocation: text.optional(),
    expectedEvidence: text.optional(),
    verificationMethod: z
      .enum(["llm_inspection", "user_confirmation", "submission_receipt", "external_result", "not_verifiable"])
      .optional(),
    state: z.enum(["unsatisfied", "satisfied", "uncertain", "not_applicable"]).optional(),
    notes: text.optional(),
    stepIds: stringList.optional().describe("Ids of the steps that make this criterion true.")
  })
  .passthrough();

const deliverableBlockerSchema = z
  .object({
    id: z.string().min(1),
    description: text,
    category: text.optional(),
    state: z.enum(["open", "awaiting_response", "possibly_resolved", "resolved", "dismissed"]).optional(),
    proposedResolution: text.optional(),
    resolutionNotes: text.optional(),
    confirmedAt: dateTime.optional(),
    resolvedAt: dateTime.optional(),
    stepIds: stringList.optional()
  })
  .passthrough();

const disruptionKindLabels = z.object({ work: text, family: text, life_admin: text, other: text });
const disruptionWhenPreset = z.object({ id: z.string().optional(), label: text, delayMinutes: minutes });
const disruptionDurationPreset = z.object({
  id: z.string().optional(),
  label: text,
  kind: z.enum(["minutes", "rest_of_day", "unknown"]),
  minutes: z.number().int().positive().optional().describe("Required when kind is minutes.")
});

// ---- Project and action: the dedicated routes' own schemas, plus the names a stored record adds. ----

const projectSchema = projectEntitySchema;
// `blockingReason` and `note` travel beside the action on its command (why it is waiting or blocked, kept in the
// change log), so a caller may give them with the action's fields and the CLI lifts them out.
const actionSchema = actionEntitySchema.extend({
  blockingReason: blockingReasonSchema.optional().describe("Why it is waiting or blocked; kept in the change log."),
  note: z
    .string()
    .trim()
    .max(2000)
    .optional()
    .describe("A note on this change; kept in the change log, not on the action.")
});

// ---- The generic kinds. ----

const areaSchema = entity({
  id: id("Area id; left out, the command id is used."),
  name: text,
  description: clearableText,
  status: lifecycleStatusSchema,
  sortOrder: minutes.describe("Position in the area list, lowest first."),
  private: privateFlag
});

const outcomeSchema = entity({
  id: id("Outcome id; left out, the command id is used."),
  areaId: z.string().min(1),
  title: text,
  definitionOfDone: text,
  value: score.describe("How much the outcome matters, 1 (least) to 5 (most)."),
  status: lifecycleStatusSchema,
  deadlineAt: optionalDateTime("External deadline"),
  reviewOn: z.string().nullable().optional().describe("Date to review the outcome (YYYY-MM-DD).")
});

const commitmentSchema = entity({
  id: id("Commitment id; left out, the command id is used."),
  title: text,
  startsAt: dateTime.describe(`When it starts (${OFFSET}).`),
  endsAt: dateTime.describe(`When it ends (${OFFSET}); must be after startsAt.`),
  status: commitmentStatusSchema,
  setupBeforeMinutes: minutes
    .optional()
    .describe("Setup minutes before. Omitted: owner default on create, stored kept on update; 0 = none."),
  transitionAfterMinutes: minutes
    .optional()
    .describe("Wind-down minutes after. Omitted: owner default on create, stored kept on update; 0 = none."),
  location: clearableText.describe("Free-text place label."),
  locationId: clearableText.describe("Id of an active location context (condition definition)."),
  projectId: clearableText,
  contactId: clearableText.describe("Id of a contact context; an empty string clears it, leaving it out keeps it."),
  presence: z
    .enum(["blocking", "anchor"])
    .optional()
    .describe("blocking takes the whole hour; anchor holds only the place."),
  promptPolicy: z.enum(["silent", "reduced", "normal"]).optional().describe("How eagerly check-ins ask about it."),
  checkInExtraMinutes: z
    .number()
    .int()
    .min(0)
    .max(480)
    .nullable()
    .optional()
    .describe(
      "Minutes added to the pulse's unknown-to-lapsed limits while it is in force (default 15); null clears it back to the default, leaving it out keeps it."
    ),
  shareToCalendar: z.boolean().optional().describe("Publish to the family calendar."),
  latenessMatters: z.boolean().optional(),
  transportMode: transportModeSchema
    .or(z.literal(""))
    .nullable()
    .optional()
    .describe("How you get there; null or an empty string clears it."),
  attendance: z.enum(["in_person", "remote"]).optional(),
  preferredLocationId: clearableText.describe("Remote commitments only: the place you would rather be at."),
  private: privateFlag,
  routineSource: z
    .enum(["inherit", "preset", "custom", "none"])
    .optional()
    .describe("Where the preparation routine comes from; preset needs routinePresetId."),
  routinePresetId: clearableText,
  origin: z.enum(["planned", "disruption"]).optional(),
  disruptionSource: z
    .enum(["work", "family", "life_admin", "other"])
    .optional()
    .describe("Only with origin disruption."),
  disruptionOpenEnded: z.boolean().optional().describe("The end time is a guess."),
  landedAt: optionalDateTime("When the disruption was reported"),
  scheduleSource: z
    .enum(["inherit", "custom"])
    .optional()
    .describe("Send inherit to reattach an edited occurrence to its recurring series.")
});

const captureSchema = entity({
  id: id("Capture id; left out, the command id is used."),
  text: text.describe("The captured text. Needed when creating."),
  status: captureStatusSchema.describe("pending, confirmed, ignored or superseded. A new capture is pending."),
  proposalType: z
    .enum([
      "unclassified",
      "outcome",
      "project",
      "action",
      "fixed_commitment",
      "someday",
      "reference",
      "deliverable",
      "email_change"
    ])
    .optional()
    .describe("What the capture is proposed to become. Required when updating a capture."),
  proposedFields: recordOfUnknown.optional().describe("The fields of the proposed record. Defaults to { text }."),
  questions: z.array(openQuestionSchema).optional().describe("Open questions to answer before confirming."),
  restore: z.boolean().optional().describe("With status pending, restores a replaced (superseded) proposal."),
  reviewedAt: optionalDateTime("When the capture was reviewed"),
  createdAt: optionalDateTime("When the capture was made; defaults to now"),
  sourceType: z.string().optional().describe("Where it came from, such as manual_capture.")
});

const deliverableSchema = entity({
  id: id("Deliverable id; left out, the command id is used."),
  projectId: z.string().min(1),
  title: text,
  details: clearableText,
  status: deliverableStatusSchema.optional().describe("Defaults to needs_breakdown."),
  externalDeadlineAt: clearableDateTime("External deadline"),
  internalDeadlineAt: clearableDateTime("Internal deadline; not after the external one"),
  uncertainty: z.enum(["known", "some", "high"]).optional().describe("Defaults to some."),
  importance: score.optional().describe("1 to 5; defaults to 3."),
  consequence: score.optional().describe("1 to 5; defaults to 3."),
  completionThreshold: clearableText.describe("What counts as complete enough."),
  contractVersion: minutes.optional().describe("0 means the contract was never approved."),
  planVersion: minutes.optional().describe("0 means the plan was never approved."),
  contractApprovedAt: clearableDateTime("When the contract was approved"),
  planApprovedAt: clearableDateTime("When the plan was approved"),
  approvalNote: clearableText,
  submittedAt: clearableDateTime("When it was submitted"),
  sortOrder: minutes.optional(),
  completedAt: clearableDateTime("When it was completed"),
  private: privateFlag,
  dependencyIds: stringList.optional().describe("Ids of deliverables that must finish first."),
  prerequisites: z
    .array(prerequisiteRefSchema)
    .optional()
    .describe("Other prerequisites; [] clears them, absent keeps them."),
  steps: z.array(deliverableStepSchema).optional().describe("The whole step list: saved as one aggregate."),
  criteria: z.array(deliverableCriterionSchema).optional().describe("The whole completion-criteria list."),
  blockers: z.array(deliverableBlockerSchema).optional().describe("The whole blocker list.")
});

const routineStepSchema = entity({
  id: id("Step id; left out, the command id is used."),
  commitmentId: z.string().min(1).describe("The commitment this step prepares for."),
  title: text,
  sequence: minutes.describe("Position among the commitment's steps, from 0."),
  durationMinutes: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Minutes. Ignored when actionWindowId links an action."),
  status: routineStepStatusSchema.optional().describe("Defaults to pending."),
  scheduledStartAt: optionalDateTime(
    "Placed start; derived for inherit and preset routines, so only custom ones accept a change"
  ),
  scheduledEndAt: optionalDateTime("Placed end; same rule as scheduledStartAt"),
  ...routineStepTimingFields
});

const routinePresetSchema = entity({
  id: id("Preset id; left out, the command id is used."),
  name: text.describe("Must be unique among presets."),
  activityName: text.optional().describe("Defaults to name."),
  status: routinePresetStatusSchema.optional().describe("Defaults to active."),
  replacesWakeRoutine: z.boolean().optional().describe("A commitment using this preset can skip the wake routine."),
  steps: z.array(presetStepSchema).min(1).describe("At least one step, in order.")
});

const sleepPlanSchema = entity({
  id: z.string().min(1).describe("The sleep plan to change; it must already exist."),
  plannedStartAt: optionalDateTime("New bedtime; send with plannedWakeAt"),
  plannedWakeAt: optionalDateTime("New wake time; send with plannedStartAt"),
  stayUpAnswerMinutes: z
    .union([z.literal(0), z.literal(30), z.literal(60), z.literal(90)])
    .optional()
    .describe("The stay-up offer answer in minutes. Alone, only 0 (decline) is accepted."),
  placementChoice: z.enum(["early", "near"]).optional().describe("The deviation choice; alone, it moves nothing.")
});

const planningFocusSchema = entity({
  id: id("Not used: a focus is keyed by kind and periodStart."),
  kind: z.enum(["weekly", "monthly"]),
  periodStart: calendarDay.describe("First day of the period (YYYY-MM-DD)."),
  periodEnd: calendarDay.describe("Last day of the period (YYYY-MM-DD); not before periodStart."),
  projectIds: stringList.optional().describe("Projects to focus on in this period."),
  reviewedOn: calendarDay
    .nullable()
    .optional()
    .describe(
      "The date (YYYY-MM-DD) the weekly review was finished for this period; null clears it, left out keeps it."
    )
});

const spanSchema = entity({
  ...spanEntitySchema.shape,
  remove: z.literal(true).optional().describe("Send true with id alone to remove the span.")
});

const conditionDefinitionSchema = entity({
  id: z.string().min(1).describe("Lowercase slug (letters, numbers, single hyphens) that requirements refer to."),
  name: text,
  kind: conditionKindSchema.describe("location, capability, contact or live."),
  status: conditionStatusSchema.optional().describe("Defaults to active. A home location cannot be archived."),
  portability: conditionPortabilitySchema.optional().describe("Capability only: fixed or portable. Defaults to fixed."),
  pathways: z
    .array(stringList)
    .optional()
    .describe("Capability only: routes of context ids, any one of which suffices."),
  grants: stringList.optional().describe("Location only: context ids available here."),
  channels: z.array(contactChannelSchema).optional().describe("Contact only: how the contact can be reached."),
  travelMinutes: z.number().int().positive().nullable().optional().describe("Fallback travel minutes to the place."),
  latitude: z.number().min(-90).max(90).nullable().optional().describe("Needs longitude too."),
  longitude: z.number().min(-180).max(180).nullable().optional().describe("Needs latitude too."),
  address: clearableText.describe("Kept only alongside coordinates."),
  setupBeforeMinutes: minutes.optional(),
  transitionAfterMinutes: minutes.optional(),
  defaultRoutinePresetId: clearableText,
  oneOff: z.boolean().optional().describe("Location only, set when created; later edits do not change it."),
  recurrenceRuleId: clearableText.describe(
    "Live only: the recurring commitment series. Exactly one of this or commitmentId."
  ),
  commitmentId: clearableText.describe("Live only: a single commitment. Exactly one of this or recurrenceRuleId."),
  usualTransportMode: transportModeSchema.or(z.literal("")).nullable().optional().describe("Location only."),
  phone: clearableText.describe("Contact only."),
  email: clearableText.describe("Contact only.")
});

const settingsSchema = entity({
  timezone: z.string().optional().describe("IANA time zone, such as Europe/London."),
  locale: z.string().optional().describe("Date and time format, an English locale such as en-GB or en-US."),
  planCodePattern: z
    .string()
    .nullable()
    .optional()
    .describe(
      "Regular expression for reference codes (course or unit codes) the plan map links by; null turns those rules off. At most 200 characters, no repeated groups."
    ),
  setupCompletedAt: clearableDateTime("When first-run setup finished"),
  setupCompleted: z.boolean().optional().describe("true marks setup done now and creates the starting areas."),
  planningHorizonEnd: z.string().optional().describe("Clock time the planning day ends (HH:MM)."),
  desiredSleepMinutes: z.number().int().positive().optional(),
  minimumSleepMinutes: z.number().int().positive().optional().describe("Not above desiredSleepMinutes."),
  maxAwakeHours: z.number().int().min(8).max(36).optional(),
  bedtimeDeviationMinutes: z
    .number()
    .int()
    .min(0)
    .max(720)
    .optional()
    .describe("How far before preferredBedtime a night may start."),
  preferredBedtime: z.string().optional().describe("Clock time (HH:MM)."),
  preferredWakeTime: z.string().optional().describe("Clock time (HH:MM)."),
  lastWokeAt: clearableDateTime("When you last woke; not in the future"),
  recoveryStartTime: z
    .string()
    .nullable()
    .optional()
    .describe("Protected recovery start, quarter-hour HH:MM; set with recoveryEndTime."),
  recoveryEndTime: z
    .string()
    .nullable()
    .optional()
    .describe("Protected recovery end, quarter-hour HH:MM; an end at or before the start runs overnight."),
  recoveryWeekdays: z
    .array(z.number().int().min(0).max(6))
    .min(1)
    .optional()
    .describe("Recovery days, 0 Sunday to 6 Saturday."),
  assertedConditions: stringList.optional().describe("Context ids currently asserted as available."),
  bedtimeRoutinePresetId: clearableText.describe("Routine preset id used at bedtime."),
  wakeRoutinePresetId: clearableText.describe("Routine preset id used on waking."),
  homeLocationId: clearableText.describe("Active location context you sleep at."),
  defaultUsableFraction: z.number().min(0).max(1).optional().describe("Fraction of free time usable for work."),
  defaultSetupBufferMinutes: minutes.optional(),
  defaultTransitionBufferMinutes: minutes.optional(),
  submissionBufferMinutes: minutes.optional(),
  submissionBufferPercent: z.number().min(0).max(1).optional().describe("Fraction, 0 to 1."),
  energyMeanings: z
    .object({ high: text, medium: text, low: text, recovery: text })
    .optional()
    .describe("What each energy level means to you."),
  estimateBucketsMinutes: z.array(z.number().min(0)).optional().describe("Allowed estimate sizes in minutes."),
  disruptionKindLabels: disruptionKindLabels.optional(),
  disruptionWhenPresets: z.array(disruptionWhenPreset).min(1).optional(),
  disruptionDurationPresets: z.array(disruptionDurationPreset).min(1).optional(),
  disruptionRetroFallbackMinutes: z.number().int().min(1).max(1440).optional(),
  arrivalMarginMinutes: z.number().int().min(0).max(60).optional(),
  sessionBreakMinutes: z.number().int().min(0).max(120).optional(),
  timeBands: z
    .array(timeBandSchema)
    .optional()
    .describe("Named windows of the day; ids unique, none crossing midnight."),
  startByWarningMinutes: z.number().int().min(0).max(240).optional(),
  deliverableChatModel: clearableText.describe("Model override for deliverable chat; null clears it."),
  importExtractorModel: clearableText.describe("Model override for import extraction; null clears it."),
  calendarShareEnabled: z.boolean().optional(),
  sharePrimaryEvents: z.boolean().optional(),
  pulsePublishEnabled: z.boolean().optional(),
  pulseUnknownToOffMinutes: z
    .number()
    .int()
    .min(5)
    .max(480)
    .nullable()
    .optional()
    .describe(
      "Minutes without contact before the pulse lapses once a further prompt went unanswered (default 30); null restores it."
    ),
  pulseFurtherPrompts: z
    .number()
    .int()
    .min(0)
    .max(10)
    .nullable()
    .optional()
    .describe("Unanswered prompts after the pulse goes unknown before it lapses (default 1); null restores it."),
  pulseUnknownHardOffMinutes: z
    .number()
    .int()
    .min(5)
    .max(720)
    .nullable()
    .optional()
    .describe("Minutes without contact before the pulse lapses with no further prompt (default 60); null restores it."),
  estimateCalibrationEnabled: z.boolean().optional(),
  defaultTransportMode: transportModeSchema.or(z.literal("")).nullable().optional(),
  leaveByLeadMinutes: z.number().int().min(0).max(60).optional()
});

const dailyPlanSchema = entity({
  id: id("Not used: a plan is keyed by localDate."),
  localDate: calendarDay.describe("The planning day (YYYY-MM-DD)."),
  desiredActionIds: stringList.optional().describe("Up to three action ids wanted done today."),
  deferredItems: z
    .array(z.object({ actionId: z.string(), reason: z.string() }).passthrough())
    .optional()
    .describe("Actions put off, each with a reason."),
  horizonOverrideAt: optionalDateTime("Extends the planning day to this moment; leaving it out keeps the stored one"),
  recoverySkipped: z.boolean().optional().describe("Skip recovery today; leaving it out keeps the stored value."),
  recoverySkippedOnly: z
    .boolean()
    .optional()
    .describe("With recoverySkipped: change only the skip flag, leaving the date's wins and any version check alone.")
});

const currentAvailabilitySchema = entity({
  currentEnergy: energyTypeSchema,
  energyAsserted: z.boolean().optional().describe("true re-asserts the same energy so it counts as said now."),
  assertedConditions: stringList.optional().describe("Context ids currently asserted as available."),
  currentSituation: currentSituationSchema
    .partial()
    .passthrough()
    .optional()
    .describe(
      "Where you are and how you can travel; fields left out keep their stored value. transportModes cannot be empty."
    )
});

const sleepLogEntrySchema = entity({
  id: id("The logged night to correct or remove; left out, a new night is logged."),
  sleepAt: dateTime.optional().describe(`When sleep started (${OFFSET}). Needed unless removing.`),
  wakeAt: dateTime
    .optional()
    .describe(`When you woke (${OFFSET}), after sleepAt and not in the future. Needed unless removing.`),
  remove: z.boolean().optional().describe("true deletes a completed logged night; send with id alone.")
});

const captureReviewSchema = entity({
  id: z.string().min(1).describe("The pending capture proposal being reviewed."),
  proposalType: captureSchemaProposalType(),
  draft: recordOfUnknown.optional().describe("The fields of the record to create from the proposal."),
  answers: z.record(z.string(), z.string()).optional().describe("Answers to the proposal's open questions, by field."),
  commitmentStatus: z
    .enum(["confirmed", "tentative"])
    .optional()
    .describe("tentative confirms a commitment as maybe; only for fixed_commitment proposals.")
});

const deliverableContractReviewSchema = entity({
  id: z.string().min(1).describe("The pending requirement proposal being reviewed."),
  decision: z.enum(["confirm", "ignore"]),
  criterion: recordOfUnknown
    .optional()
    .describe(
      "The completion criterion to add (key, title, ...), edited from the proposal; defaults to the proposal's."
    )
});

function captureSchemaProposalType() {
  return z
    .string()
    .optional()
    .describe(
      "The proposal type (outcome, project, action, fixed_commitment, someday, reference, deliverable or email_change)."
    );
}

/** Every `save` entity kind's fields, keyed by the CLI's canonical entity name. */
export const ENTITY_FIELD_SCHEMAS: Record<SaveEntityKind, z.ZodObject<any>> = {
  area: areaSchema,
  outcome: outcomeSchema,
  project: projectSchema,
  action: actionSchema,
  commitment: commitmentSchema,
  capture: captureSchema,
  deliverable: deliverableSchema,
  routine_step: routineStepSchema,
  routine_preset: routinePresetSchema,
  sleep_plan: sleepPlanSchema,
  planning_focus: planningFocusSchema,
  span: spanSchema,
  condition_definition: conditionDefinitionSchema,
  settings: settingsSchema,
  daily_plan: dailyPlanSchema,
  current_availability: currentAvailabilitySchema,
  sleep_log_entry: sleepLogEntrySchema,
  capture_review: captureReviewSchema,
  deliverable_contract_review: deliverableContractReviewSchema
};

/** The top-level field names `kind` accepts (writable and read-only). */
export function entityFieldNames(kind: SaveEntityKind): string[] {
  return Object.keys(ENTITY_FIELD_SCHEMAS[kind].shape);
}
