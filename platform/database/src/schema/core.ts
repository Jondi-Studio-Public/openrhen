import {
  type AnyPgColumn,
  bigint,
  bigserial,
  boolean,
  check,
  date,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  real,
  primaryKey,
  smallint,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { EXTRA_PUSH_CHANNELS } from "./private/push-channels.js";
import type { ActionStatus, CommitmentRepeatUnit, EnergyType, LifecycleStatus, MonthAnchor } from "@openrhen/contracts";

/** Shared audit columns; exported only so the private table groups can reuse them. */
export const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  version: integer("version").notNull().default(1)
};

/**
 * Closed-record columns (archive-removals design, section 5), on the eight tables in CLOSED_TABLES. Stamped by the
 * `stamp_closed_columns` BEFORE INSERT/UPDATE trigger (migration 0140) on a status transition into or out of a closed
 * status, never by application code; all nullable. `closed_by` is the `priorities.actor` setting at the time, `system`
 * when unset, and NULL on rows that were already closed when the columns were added.
 */
export const closedColumns = {
  closedAt: timestamp("closed_at", { withTimezone: true }),
  closedFromStatus: text("closed_from_status"),
  closedBy: text("closed_by"),
  closedBatch: uuid("closed_batch"),
  closedReason: text("closed_reason")
};

export const recordStatus = pgEnum("record_status", ["active", "paused", "done", "cancelled", "archived"]);
export const actionStatus = pgEnum("action_status", [
  "inbox",
  "planned",
  "active",
  "doing",
  "waiting",
  "blocked",
  "done",
  "cancelled",
  "archived"
]);
export const energyType = pgEnum("energy_type", ["high", "medium", "low", "recovery"]);
export const uncertaintyLevel = pgEnum("uncertainty_level", ["known", "some", "high"]);
export const projectHealth = pgEnum("project_health", ["ahead", "on_track", "at_risk", "behind", "unknown"]);
export const sessionStatus = pgEnum("session_status", [
  "planned",
  "running",
  "paused",
  "awaiting_feedback",
  "completed",
  "stopped",
  "blocked",
  "did_not_start",
  "skipped"
]);
export const proposalStatus = pgEnum("proposal_status", ["pending", "confirmed", "ignored", "superseded"]);
export const conditionKind = pgEnum("condition_kind", ["location", "capability", "contact", "live"]);
export const conditionPortability = pgEnum("condition_portability", ["fixed", "portable"]);
export const deliverableStatus = pgEnum("deliverable_status", [
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
export const criterionState = pgEnum("criterion_state", ["unsatisfied", "satisfied", "uncertain", "not_applicable"]);
export const blockerCategory = pgEnum("blocker_category", [
  "missing_information",
  "waiting_on_someone",
  "prerequisite",
  "tool_or_context_unavailable",
  "technical_problem",
  "energy_or_health",
  "other"
]);
export const blockerState = pgEnum("blocker_state", [
  "open",
  "awaiting_response",
  "possibly_resolved",
  "resolved",
  "dismissed"
]);
// a commitment recurrence rule repeats either every N days (as it always has) or every N
// months, anchored to its start date one of four ways. See the monthly commitment recurrence design note.
export const commitmentIntervalUnit = pgEnum("commitment_interval_unit", ["days", "weeks", "months"]);
export const commitmentMonthAnchor = pgEnum("commitment_month_anchor", [
  "day_of_month",
  "last_day",
  "nth_weekday",
  "last_weekday"
]);

/**
 * Compile-time-only check that a pg enum's member list exactly matches the corresponding
 * `@openrhen/contracts` type — in both directions, so a member added, removed, or misspelled on
 * either side breaks `corepack pnpm typecheck` instead of surfacing at runtime as a row the engine
 * silently never ranks. See the one spelling per word design note.
 *
 * Wrapping each side in a one-element tuple (`[X] extends [Y]`) stops the conditional from
 * distributing over the union's members, which would otherwise make the check too permissive.
 */
type AssertSameMembers<PgEnumMembers extends string, ContractMembers extends string> = [PgEnumMembers] extends [
  ContractMembers
]
  ? [ContractMembers] extends [PgEnumMembers]
    ? true
    : ["missing from the pg enum", Exclude<ContractMembers, PgEnumMembers>]
  : ["not part of the contract", Exclude<PgEnumMembers, ContractMembers>];

// The `const`s below are never read at runtime beyond existing as an inert `true`; their only job
// is to make a divergent member list fail `corepack pnpm typecheck`.
const _actionStatusMatchesContract: AssertSameMembers<(typeof actionStatus.enumValues)[number], ActionStatus> = true;
const _energyTypeMatchesContract: AssertSameMembers<(typeof energyType.enumValues)[number], EnergyType> = true;
const _recordStatusMatchesContract: AssertSameMembers<(typeof recordStatus.enumValues)[number], LifecycleStatus> = true;
const _commitmentIntervalUnitMatchesContract: AssertSameMembers<
  (typeof commitmentIntervalUnit.enumValues)[number],
  CommitmentRepeatUnit
> = true;
const _commitmentMonthAnchorMatchesContract: AssertSameMembers<
  (typeof commitmentMonthAnchor.enumValues)[number],
  MonthAnchor
> = true;

// @ts-expect-error — "typo" is not a real action status; proves AssertSameMembers rejects a
// divergent member list instead of silently passing (see the design note's "Risks" table: the
// check must not be written so loosely it never fails).
const _driftIsCaught: AssertSameMembers<"inbox" | "planned" | "typo", ActionStatus> = true;

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    displayName: text("display_name").notNull(),
    timezone: text("timezone").notNull().default("UTC"),
    locale: text("locale").notNull().default("en"),
    ...timestamps
  },
  (table) => [check("users_locale_check", sql`char_length(${table.locale}) BETWEEN 2 AND 35`)]
);

// Legacy one-time import source. The PostgreSQL portal no longer reads or writes
// this table after its saved snapshot has been migrated into normalized records.
export const portalState = pgTable(
  "portal_state",
  {
    id: smallint("id").primaryKey(),
    stateJson: jsonb("state_json").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [check("portal_state_singleton_check", sql`${table.id} = 1`)]
);

export const userPreferences = pgTable(
  "user_preferences",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    planningHorizonEnd: time("planning_horizon_end").notNull().default("22:00"),
    currentHorizonEndAt: timestamp("current_horizon_end_at", { withTimezone: true }),
    assertedConditions: jsonb("asserted_conditions").notNull().default(["home"]),
    currentEnergy: energyType("current_energy").notNull().default("medium"),
    defaultUsableFraction: numeric("default_usable_fraction", { precision: 4, scale: 3 }).notNull().default("0.850"),
    defaultSetupBufferMinutes: integer("default_setup_buffer_minutes").notNull().default(10),
    defaultTransitionBufferMinutes: integer("default_transition_buffer_minutes").notNull().default(10),
    submissionBufferMinutes: integer("submission_buffer_minutes").notNull().default(60),
    submissionBufferPercent: numeric("submission_buffer_percent", { precision: 4, scale: 3 })
      .notNull()
      .default("0.100"),
    energyMeanings: jsonb("energy_meanings")
      .notNull()
      .default({ high: "Deep focus", medium: "Steady concentration", low: "Light effort", recovery: "Rest and reset" }),
    estimateBucketsMinutes: jsonb("estimate_buckets_minutes").notNull().default([5, 15, 30, 60, 90, 120]),
    // `transportModes` defaults to every supported mode, not an empty list: an empty list reads as
    // "never configured, so unconstrained" wherever it is consumed (`current-situation.ts`), which a
    // fresh row should already be rather than rely on that same fallback to reconstruct it.
    currentSituation: jsonb("current_situation")
      .notNull()
      .default({ locationId: null, overrides: {}, carrying: {}, transportModes: ["car", "bike", "walk"], travel: {} }),
    /**
     * What the phone and the browser have reported about where the device is: a short rolling
     * history of matched observations and at most one pending suggestion awaiting an answer. It is
     * evidence, not the assertion — `current_situation.locationId` remains the only statement of
     * where the person says they are. Coordinates are deliberately not kept: the match each reading
     * produced is everything the policy needs, and a stored track is a liability nothing here uses.
     */
    deviceLocationState: jsonb("device_location_state").notNull().default({ observations: [], suggestion: null }),
    /** The location condition you sleep at and return to. A slug, not a FK: conditions are keyed (user_id, id). */
    homeLocationId: text("home_location_id"),
    preferredBedtime: time("preferred_bedtime").notNull().default("22:00"),
    preferredWakeTime: time("preferred_wake_time").notNull().default("06:00"),
    desiredSleepMinutes: integer("desired_sleep_minutes").notNull().default(480),
    minimumSleepMinutes: integer("minimum_sleep_minutes").notNull().default(360),
    maxAwakeHours: integer("max_awake_hours").notNull().default(20),
    bedtimeDeviationMinutes: integer("bedtime_deviation_minutes").notNull().default(180),
    /** Protected recovery window: both null is off; weekdays null reads as all seven. */
    recoveryStartTime: time("recovery_start_time"),
    recoveryEndTime: time("recovery_end_time"),
    recoveryWeekdays: jsonb("recovery_weekdays").$type<number[]>(),
    lastWokeAt: timestamp("last_woke_at", { withTimezone: true }),
    bedtimeRoutinePresetId: uuid("bedtime_routine_preset_id"),
    /** Mirrors `bedtimeRoutinePresetId`: no FK, ownership checked in application code. */
    wakeRoutinePresetId: uuid("wake_routine_preset_id"),
    /**
     * Disruption capture presets (portal-only; the engine never reads these). Defaults match the
     * values the capture form used to hardcode, so an existing user sees no change until they edit
     * one. See the design notes and /settings/disruptions.
     */
    disruptionKindLabels: jsonb("disruption_kind_labels")
      .notNull()
      .default({ work: "Work", family: "Family", life_admin: "Life admin", other: "Other" }),
    disruptionWhenPresets: jsonb("disruption_when_presets")
      .notNull()
      .default([
        { id: "now", label: "Now", delayMinutes: 0 },
        { id: "in_15", label: "+15m", delayMinutes: 15 },
        { id: "in_30", label: "+30m", delayMinutes: 30 },
        { id: "in_60", label: "+60m", delayMinutes: 60 }
      ]),
    disruptionDurationPresets: jsonb("disruption_duration_presets")
      .notNull()
      .default([
        { id: "30m", label: "30 min", kind: "minutes", minutes: 30 },
        { id: "1h", label: "1 hour", kind: "minutes", minutes: 60 },
        { id: "2h", label: "2 hours", kind: "minutes", minutes: 120 },
        { id: "3h", label: "3 hours", kind: "minutes", minutes: 180 },
        { id: "rest_of_day", label: "Rest of day", kind: "rest_of_day" },
        { id: "unknown", label: "No idea", kind: "unknown" }
      ]),
    disruptionRetroFallbackMinutes: integer("disruption_retro_fallback_minutes").notNull().default(60),
    /**
     * Minutes to be at a place before a commitment starts, on top of the setup buffer: get ready,
     * travel, arrive with this margin, then start. Promoted from a hardcoded engine constant
     * (`ARRIVAL_MARGIN_MINUTES`, engine/core/src/model/types.ts) — the default here must match the
     * fallback still baked into that file's tests and dead-code paths. Read directly (outside the
     * settings contract) by the routine-step scheduler in platform/database and portal, which cannot
     * import the engine.
     */
    arrivalMarginMinutes: integer("arrival_margin_minutes").notNull().default(2),
    /**
     * Named windows of the day, local to `timezone`, that a
     * flexible commitment before-step can prefer (`routine_steps.preferred_bands`). Each band is
     * `{ id, name, start: "HH:MM", end: "HH:MM" }`, `start < end`, no band crosses midnight. The
     * default is morning 06:00-12:00, afternoon 12:00-17:00, evening 17:00-22:00 — the same JSON
     * `DEFAULT_TIME_BANDS` exports (`platform/contracts`, `state-schema.ts`).
     */
    timeBands: jsonb("time_bands")
      .notNull()
      .default([
        { id: "morning", name: "Morning", start: "06:00", end: "12:00" },
        { id: "afternoon", name: "Afternoon", start: "12:00", end: "17:00" },
        { id: "evening", name: "Evening", start: "17:00", end: "22:00" }
      ]),
    /**
     * Minutes ahead of a step's `mustStartByMinutes` (or wait-derived latest start) that Now marks it
     * "soon" rather than on time; past the latest start it reads "missed". See
     * The routine step timing design note "Warnings and arrival projection".
     */
    startByWarningMinutes: integer("start_by_warning_minutes").notNull().default(30),
    /**
     * The fatigue gap owed after an exact-band session reaches `maximumSessionMinutes`: the same
     * action can't be reserved again within this many minutes of wall-clock time after the run ends.
     * Other actions may use the gap; it is not lost capacity. See the forecast reservation design note.
     */
    sessionBreakMinutes: integer("session_break_minutes").notNull().default(15),
    /**
     * The mode order's last tier before "fastest available by typical"
     * a commitment's own `transport_mode` beats
     * the destination's `usual_transport_mode`, which beats this. Null means unset.
     */
    defaultTransportMode: text("default_transport_mode"),
    /**
     * How long before `leaveBy` the lead reminder fires.
     * 0 is legitimate: only the at-leave-by prompt is sent.
     */
    leaveByLeadMinutes: integer("leave_by_lead_minutes").notNull().default(10),
    /**
     * The pulse lapse thresholds. Null means the default
     * (`DEFAULT_PULSE_THRESHOLDS`): unknown for this many minutes plus `pulseFurtherPrompts` unanswered
     * prompts is `off/lapsed`, or `pulseUnknownHardOffMinutes` with no further prompt.
     */
    pulseUnknownToOffMinutes: integer("pulse_unknown_to_off_minutes"),
    pulseFurtherPrompts: integer("pulse_further_prompts"),
    pulseUnknownHardOffMinutes: integer("pulse_unknown_hard_off_minutes"),
    /**
     * Per-tool OpenAI model overrides for the two portal server consumers that call the Responses API
     * (deliverable workspace chat, import extraction). Null means unset — each consumer falls back to
     * "gpt-5.6-sol" itself, so this table names no default. See /settings/ai and the design notes.
     */
    deliverableChatModel: text("deliverable_chat_model"),
    importExtractorModel: text("import_extractor_model"),
    setupCompletedAt: timestamp("setup_completed_at", { withTimezone: true }),
    /** Master switch for the family calendar publish sweep. Off by default. */
    calendarShareEnabled: boolean("calendar_share_enabled").default(false),
    /** Whether a newly-created roster shift defaults to shared, per the roster-sync create path. */
    sharePrimaryEvents: boolean("share_primary_events").default(false),
    /** Master switch for publishing the redacted public pulse object; see `pulse-publish.ts`. */
    pulsePublishEnabled: boolean("pulse_publish_enabled").notNull().default(false),
    /** Apply learned estimate calibration to planning (logic design §5). */
    estimateCalibrationEnabled: boolean("estimate_calibration_enabled").notNull().default(true),
    /** Regular expression for reference codes the plan map links by; null turns those rules off (0135). */
    planCodePattern: text("plan_code_pattern"),
    ...timestamps
  },
  (table) => [
    check(
      "user_preferences_usable_fraction_check",
      sql`${table.defaultUsableFraction} > 0 AND ${table.defaultUsableFraction} <= 1`
    ),
    check("user_preferences_setup_buffer_check", sql`${table.defaultSetupBufferMinutes} BETWEEN 0 AND 1440`),
    check("user_preferences_transition_buffer_check", sql`${table.defaultTransitionBufferMinutes} BETWEEN 0 AND 1440`),
    check("user_preferences_submission_buffer_check", sql`${table.submissionBufferMinutes} BETWEEN 0 AND 1440`),
    check("user_preferences_submission_percent_check", sql`${table.submissionBufferPercent} BETWEEN 0 AND 1`),
    check(
      "user_preferences_sleep_duration_check",
      sql`${table.minimumSleepMinutes} >= 60 AND ${table.minimumSleepMinutes} <= ${table.desiredSleepMinutes} AND ${table.desiredSleepMinutes} <= 960`
    ),
    check("user_preferences_max_awake_check", sql`${table.maxAwakeHours} BETWEEN 8 AND 36`),
    check("user_preferences_bedtime_deviation_check", sql`${table.bedtimeDeviationMinutes} BETWEEN 0 AND 720`),
    check(
      "user_preferences_recovery_window_check",
      sql`(${table.recoveryStartTime} IS NULL AND ${table.recoveryEndTime} IS NULL) OR (${table.recoveryStartTime} IS NOT NULL AND ${table.recoveryEndTime} IS NOT NULL AND ${table.recoveryStartTime} <> ${table.recoveryEndTime})`
    ),
    check(
      "user_preferences_disruption_retro_fallback_check",
      sql`${table.disruptionRetroFallbackMinutes} BETWEEN 1 AND 1440`
    ),
    check("user_preferences_arrival_margin_check", sql`${table.arrivalMarginMinutes} BETWEEN 0 AND 60`),
    check("user_preferences_start_by_warning_check", sql`${table.startByWarningMinutes} BETWEEN 0 AND 240`),
    check("user_preferences_session_break_check", sql`${table.sessionBreakMinutes} BETWEEN 0 AND 120`),
    check(
      "user_preferences_default_transport_mode_check",
      sql`${table.defaultTransportMode} IS NULL OR ${table.defaultTransportMode} IN ('car','bike','walk')`
    ),
    check("user_preferences_leave_by_lead_check", sql`${table.leaveByLeadMinutes} BETWEEN 0 AND 60`)
  ]
);

export const areas = pgTable(
  "areas",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    name: text("name").notNull(),
    description: text("description"),
    status: recordStatus("status").notNull().default("active"),
    sortOrder: integer("sort_order").notNull(),
    reviewIntervalDays: integer("review_interval_days"),
    lastReviewedAt: timestamp("last_reviewed_at", { withTimezone: true }),
    /** The pulse criteria and publish design note ("Private"): hides this area, and everything under
        it, from the published pulse. Effective privacy is OR-inherited down to the leaf. */
    private: boolean("private").notNull().default(false),
    ...timestamps,
    ...closedColumns
  },
  (table) => [
    uniqueIndex("areas_user_name_unique").on(table.userId, table.name),
    index("areas_user_status_sort_idx").on(table.userId, table.status, table.sortOrder)
  ]
);

export const outcomes = pgTable(
  "outcomes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    areaId: uuid("area_id")
      .notNull()
      .references(() => areas.id),
    title: text("title").notNull(),
    definitionOfDone: text("definition_of_done").notNull(),
    value: smallint("value").notNull().default(3),
    status: recordStatus("status").notNull().default("active"),
    deadlineAt: timestamp("deadline_at", { withTimezone: true }),
    reviewOn: date("review_on"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...timestamps,
    ...closedColumns
  },
  (table) => [
    check("outcomes_value_check", sql`${table.value} between 1 and 5`),
    index("outcomes_area_status_idx").on(table.areaId, table.status)
  ]
);

/**
 * Comparison-derived consequence (comparison-consequence-ranking design, 3.3 and 3.4), on `projects` and `actions`
 * only (deliverables stay on stars). All three are derived by `consequence/refit.ts` from `consequence_comparisons`
 * and are null together: the value (finite, 0..6; a different range from the 1-5 stars), the stars it was fitted for
 * (the engine ignores the value when the item's current stars differ, so a star edit wins at once) and the local day
 * the fit used. Null means exactly today's behaviour. No ordinary save writes them.
 */
export const consequenceRefinedColumns = {
  consequenceRefined: real("consequence_refined"),
  consequenceRefinedForStars: smallint("consequence_refined_for_stars"),
  consequenceRefinedAsOf: date("consequence_refined_as_of")
};

/**
 * All three are set or none is. `between` is false for NaN and the infinities in Postgres, so the range check also
 * keeps the value finite; every column is named as `is not null` too because a NULL in a CHECK passes it.
 */
function consequenceRefinedCheck(table: {
  consequenceRefined: AnyPgColumn;
  consequenceRefinedForStars: AnyPgColumn;
  consequenceRefinedAsOf: AnyPgColumn;
}) {
  const { consequenceRefined: value, consequenceRefinedForStars: stars, consequenceRefinedAsOf: asOf } = table;
  return sql`(${value} is null and ${stars} is null and ${asOf} is null) or (${value} is not null and ${stars} is not null and ${asOf} is not null and ${value} between 0 and 6 and ${stars} between 1 and 5)`;
}

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    outcomeId: uuid("outcome_id")
      .notNull()
      .references(() => outcomes.id),
    title: text("title").notNull(),
    status: recordStatus("status").notNull().default("active"),
    externalDeadlineAt: timestamp("external_deadline_at", { withTimezone: true }),
    internalDeadlineAt: timestamp("internal_deadline_at", { withTimezone: true }),
    uncertainty: uncertaintyLevel("uncertainty").notNull().default("some"),
    consequence: smallint("consequence").notNull().default(3),
    ...consequenceRefinedColumns,
    actualCompletionRatio: numeric("actual_completion_ratio", { precision: 6, scale: 5 }),
    requiredCompletionRatio: numeric("required_completion_ratio", { precision: 6, scale: 5 }),
    remainingEffortOverrideMinutes: integer("remaining_effort_override_minutes"),
    /** Pulse privacy, inherited from the outcome/area unless set here — see `areas.private`. */
    private: boolean("private").notNull().default(false),
    forecastStartedAt: timestamp("forecast_started_at", { withTimezone: true }),
    // total estimated minutes (completed + remaining) the moment the project first became
    // forecastable, alongside forecastStartedAt. Never rewritten once set, except a reset back to null
    // when the project is re-activated after being paused or archived — see saveProject.
    baselineEstimateMinutes: integer("baseline_estimate_minutes"),
    lastWorkedAt: timestamp("last_worked_at", { withTimezone: true }),
    // Set only by the explicit "still wanted" command (the weekly review's Keep), never by an ordinary save.
    lastReviewedAt: timestamp("last_reviewed_at", { withTimezone: true }),
    // Set only by the review's "Seen, leave it" on an overdue project: it stops counting toward that review week.
    overdueSeenAt: timestamp("overdue_seen_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...timestamps,
    ...closedColumns
  },
  (table) => [
    check(
      "projects_deadline_check",
      sql`${table.internalDeadlineAt} is null or ${table.externalDeadlineAt} is null or ${table.internalDeadlineAt} <= ${table.externalDeadlineAt}`
    ),
    check("projects_consequence_check", sql`${table.consequence} between 1 and 5`),
    check("projects_consequence_refined_check", consequenceRefinedCheck(table)),
    index("projects_outcome_status_idx").on(table.outcomeId, table.status)
  ]
);

export const actions = pgTable(
  "actions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    title: text("title").notNull(),
    schedulingMode: text("scheduling_mode").notNull().default("one_off"),
    notes: text("notes"),
    status: actionStatus("status").notNull().default("planned"),
    optimisticMinutes: integer("optimistic_minutes").notNull(),
    expectedMinutes: integer("expected_minutes").notNull(),
    pessimisticMinutes: integer("pessimistic_minutes").notNull(),
    remainingMinutes: integer("remaining_minutes").notNull(),
    /**
     * When `remaining_minutes` was last set or confirmed (the fact freshness design note, effort age): a session
     * finish, a deliverable rollover, a cadence reset, or a save that changed it. The migration set every
     * existing row to the migration time, so the first deploy does not flag every at-risk estimate at once;
     * a new row takes its creation time from the default.
     */
    remainingSetAt: timestamp("remaining_set_at", { withTimezone: true }).notNull().defaultNow(),
    energy: energyType("energy").notNull(),
    minimumSessionMinutes: integer("minimum_session_minutes").notNull(),
    maximumSessionMinutes: integer("maximum_session_minutes").notNull(),
    splittable: boolean("splittable").notNull().default(true),
    availableFrom: timestamp("available_from", { withTimezone: true }),
    deadlineAt: timestamp("deadline_at", { withTimezone: true }),
    importance: smallint("importance").notNull().default(3),
    consequence: smallint("consequence").notNull().default(3),
    ...consequenceRefinedColumns,
    setupMinutes: integer("setup_minutes").notNull().default(0),
    latestStartAt: timestamp("latest_start_at", { withTimezone: true }),
    dependenciesComplete: boolean("dependencies_complete").notNull().default(true),
    estimateNeedsReview: boolean("estimate_needs_review").notNull().default(false),
    /**
     * Which of the estimate and judgement fields (camelCase names from `ASSUMABLE_ACTION_FIELDS` in
     * `@openrhen/contracts`) were a default or a guess rather than something a person said. Written by the
     * action save (`nextAssumedFields`); `{}` for every row from before it was kept, because which were
     * defaulted cannot be known.
     */
    assumedFields: text("assumed_fields")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    sortOrder: integer("sort_order").notNull().default(0),
    lastWorkedAt: timestamp("last_worked_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    /**
     * Present only on a deliverable's action:
     * which deliverable it belongs to. Null for a plain action. `portal/server/persistence/postgres/readers/actions.ts` is the one place that
     * filters `deliverable_id IS NULL` when building the ordinary action list — see `WireState.actions`
     * in the design note.
     */
    deliverableId: uuid("deliverable_id").references(() => deliverables.id, { onDelete: "cascade" }),
    /** True by default for a deliverable's action; null (not false) for a plain action. */
    required: boolean("required"),
    completionCondition: text("completion_condition"),
    /**
     * Structural, conditional re-arm: when this action is marked done, the system re-records this
     * description as a fresh open blocker rather than trusting a follow-up conversation to remember
     * to. Both columns are set together by extend_plan and never edited directly. Null for a plain
     * action.
     */
    reblockDescription: text("reblock_description"),
    reblockCategory: blockerCategory("reblock_category"),
    /** Pulse privacy, inherited from the project unless set here — see `areas.private`. */
    private: boolean("private").notNull().default(false),
    /**
     * Present only on prep for a commitment (the design notes, CONTEXT.md "Prep"):
     * the commitment this action prepares for, so prep is attached rather than merely dated. Null for
     * every other action. Cancelling the commitment lists its open prep so it can be cancelled with it;
     * the FK is `set null` because deleting a commitment must not delete work the person may still do.
     */
    prepForCommitmentId: uuid("prep_for_commitment_id").references(() => commitments.id, {
      onDelete: "set null"
    }),
    ...timestamps,
    ...closedColumns
  },
  (table) => [
    check(
      "actions_estimates_check",
      sql`${table.optimisticMinutes} > 0 and ${table.optimisticMinutes} <= ${table.expectedMinutes} and ${table.expectedMinutes} <= ${table.pessimisticMinutes}`
    ),
    check(
      "actions_sessions_check",
      sql`${table.minimumSessionMinutes} > 0 and ${table.minimumSessionMinutes} <= ${table.maximumSessionMinutes}`
    ),
    check("actions_remaining_check", sql`${table.remainingMinutes} >= 0`),
    check("actions_scores_check", sql`${table.importance} between 1 and 5 and ${table.consequence} between 1 and 5`),
    check("actions_consequence_refined_check", consequenceRefinedCheck(table)),
    index("actions_project_status_sort_idx").on(table.projectId, table.status, table.sortOrder),
    index("actions_status_energy_idx").on(table.status, table.energy),
    index("actions_deliverable_status_sort_idx").on(table.deliverableId, table.status, table.sortOrder),
    check("actions_scheduling_mode_check", sql`${table.schedulingMode} IN ('one_off','recurring','cadence')`)
  ]
);

export const actionRecurrenceRules = pgTable(
  "action_recurrence_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actionId: uuid("action_id")
      .notNull()
      .unique()
      .references(() => actions.id, { onDelete: "cascade" }),
    timezone: text("timezone").notNull(),
    startDate: date("start_date").notNull(),
    endDate: date("end_date"),
    intervalDays: integer("interval_days").notNull().default(1),
    completionMode: text("completion_mode").notNull().default("end_date"),
    targetTotalMinutes: integer("target_total_minutes"),
    accumulatedMinutes: integer("accumulated_minutes").notNull().default(0),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    // an alternative to `intervalDays` for a cadence rule — a target count of occurrences
    // inside a rolling window of days (periodLength) or the calendar month (periodUnit='month',
    // periodLength null). Additive and nullable; a rule that never sets these keeps using intervalDays.
    periodUnit: text("period_unit"),
    periodLength: integer("period_length"),
    targetOccurrences: integer("target_occurrences"),
    minSpacingDays: integer("min_spacing_days"),
    eligibleWeekdays: jsonb("eligible_weekdays").$type<number[]>(),
    ...timestamps
  },
  (table) => [
    check("action_recurrence_dates_check", sql`${table.endDate} IS NULL OR ${table.endDate} >= ${table.startDate}`),
    check("action_recurrence_interval_check", sql`${table.intervalDays} > 0`),
    check(
      "action_recurrence_completion_mode_check",
      sql`${table.completionMode} IN ('end_date','total_minutes','manual')`
    ),
    check(
      "action_recurrence_end_date_required_check",
      sql`${table.completionMode} <> 'end_date' OR ${table.endDate} IS NOT NULL`
    ),
    check(
      "action_recurrence_target_minutes_required_check",
      sql`${table.completionMode} <> 'total_minutes' OR (${table.targetTotalMinutes} IS NOT NULL AND ${table.targetTotalMinutes} > 0)`
    ),
    check(
      "action_recurrence_period_unit_check",
      sql`${table.periodUnit} IS NULL OR ${table.periodUnit} IN ('days','month')`
    ),
    check("action_recurrence_period_length_check", sql`${table.periodLength} IS NULL OR ${table.periodLength} > 0`),
    check(
      "action_recurrence_period_length_required_check",
      sql`${table.periodUnit} IS DISTINCT FROM 'days' OR ${table.periodLength} IS NOT NULL`
    ),
    check(
      "action_recurrence_target_occurrences_check",
      sql`${table.targetOccurrences} IS NULL OR ${table.targetOccurrences} > 0`
    ),
    check("action_recurrence_min_spacing_check", sql`${table.minSpacingDays} IS NULL OR ${table.minSpacingDays} >= 0`)
  ]
);

export const actionRecurrenceWindows = pgTable(
  "action_recurrence_windows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ruleId: uuid("rule_id")
      .notNull()
      .references(() => actionRecurrenceRules.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    anchor: text("anchor").notNull(),
    startOffsetMinutes: integer("start_offset_minutes"),
    endOffsetMinutes: integer("end_offset_minutes"),
    localStartTime: time("local_start_time"),
    localEndTime: time("local_end_time"),
    fallbackStartTime: time("fallback_start_time"),
    fallbackEndTime: time("fallback_end_time"),
    ...timestamps
  },
  (table) => [
    check("action_recurrence_window_anchor_check", sql`${table.anchor} IN ('wake','sleep_start','local_time')`),
    uniqueIndex("action_recurrence_window_rule_name_unique").on(table.ruleId, table.name)
  ]
);

export const actionOccurrences = pgTable(
  "action_occurrences",
  {
    id: text("id").primaryKey(),
    actionId: uuid("action_id")
      .notNull()
      .references(() => actions.id, { onDelete: "cascade" }),
    ruleId: uuid("rule_id")
      .notNull()
      .references(() => actionRecurrenceRules.id, { onDelete: "cascade" }),
    windowId: uuid("window_id")
      .notNull()
      .references(() => actionRecurrenceWindows.id, { onDelete: "cascade" }),
    localDate: date("local_date").notNull(),
    windowStartsAt: timestamp("window_starts_at", { withTimezone: true }).notNull(),
    windowEndsAt: timestamp("window_ends_at", { withTimezone: true }).notNull(),
    anchorSource: text("anchor_source").notNull(),
    status: text("status").notNull().default("pending"),
    routineCovered: boolean("routine_covered").notNull().default(false),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...timestamps
  },
  (table) => [
    check("action_occurrence_time_check", sql`${table.windowEndsAt} > ${table.windowStartsAt}`),
    check("action_occurrence_status_check", sql`${table.status} IN ('pending','completed','missed','cancelled')`),
    check(
      "action_occurrence_anchor_source_check",
      sql`${table.anchorSource} IN ('actual_wake','planned_wake','preferred_wake','planned_sleep','local_time','fallback')`
    ),
    index("action_occurrence_action_date_idx").on(table.actionId, table.localDate)
  ]
);

/**
 * Requirements are AND within a pathway and OR across pathways, so an action can state several
 * valid ways of being done. An action with no pathways is unconstrained.
 */
export const actionRequirementPathways = pgTable(
  "action_requirement_pathways",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actionId: uuid("action_id")
      .notNull()
      .references(() => actions.id, { onDelete: "cascade" }),
    sortOrder: integer("sort_order").notNull().default(0)
  },
  (table) => [uniqueIndex("action_requirement_pathways_action_sort_unique").on(table.actionId, table.sortOrder)]
);

// context_key carries no foreign key, matching the existing action_contexts precedent. Referential
// integrity is enforced by import validation and by the matcher, which fails closed on an
// undefined context rather than treating it as satisfiable.
export const actionRequirements = pgTable(
  "action_requirements",
  {
    pathwayId: uuid("pathway_id")
      .notNull()
      .references(() => actionRequirementPathways.id, { onDelete: "cascade" }),
    contextKey: text("context_key").notNull()
  },
  (table) => [primaryKey({ columns: [table.pathwayId, table.contextKey] })]
);

/** Soft context fit. Never affects eligibility, only ranking. */
export const actionPreferences = pgTable(
  "action_preferences",
  {
    actionId: uuid("action_id")
      .notNull()
      .references(() => actions.id, { onDelete: "cascade" }),
    contextKey: text("context_key").notNull()
  },
  (table) => [primaryKey({ columns: [table.actionId, table.contextKey] })]
);

export const actionDependencies = pgTable(
  "action_dependencies",
  {
    actionId: uuid("action_id")
      .notNull()
      .references(() => actions.id, { onDelete: "cascade" }),
    dependsOnActionId: uuid("depends_on_action_id")
      .notNull()
      .references(() => actions.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    primaryKey({ columns: [table.actionId, table.dependsOnActionId] }),
    check("action_dependencies_not_self", sql`${table.actionId} <> ${table.dependsOnActionId}`)
  ]
);

/**
 * A finishable body of work under a project, holding its own definition of done and its own step
 * plan. Unlike an action it cannot be started without a planning step first, which is why an
 * unapproved contract leaves it in `needs_breakdown` rather than pretending its effort is known.
 */
export const deliverables = pgTable(
  "deliverables",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    title: text("title").notNull(),
    details: text("details"),
    status: deliverableStatus("status").notNull().default("needs_breakdown"),
    externalDeadlineAt: timestamp("external_deadline_at", { withTimezone: true }),
    internalDeadlineAt: timestamp("internal_deadline_at", { withTimezone: true }),
    uncertainty: uncertaintyLevel("uncertainty").notNull().default("some"),
    importance: smallint("importance").notNull().default(3),
    consequence: smallint("consequence").notNull().default(3),
    completionThreshold: text("completion_threshold"),
    // Contract and plan are approved separately because a revised brief can invalidate one without the
    // other. Version 0 means never approved, which is what keeps the deliverable out of ordinary work.
    contractVersion: integer("contract_version").notNull().default(0),
    planVersion: integer("plan_version").notNull().default(0),
    contractApprovedAt: timestamp("contract_approved_at", { withTimezone: true }),
    planApprovedAt: timestamp("plan_approved_at", { withTimezone: true }),
    approvalNote: text("approval_note"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    sortOrder: integer("sort_order").notNull().default(0),
    lastWorkedAt: timestamp("last_worked_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    /** Pulse privacy, inherited from the project unless set here — see `areas.private`. */
    private: boolean("private").notNull().default(false),
    ...timestamps,
    ...closedColumns
  },
  (table) => [
    check(
      "deliverables_deadline_check",
      sql`${table.internalDeadlineAt} is null or ${table.externalDeadlineAt} is null or ${table.internalDeadlineAt} <= ${table.externalDeadlineAt}`
    ),
    check(
      "deliverables_scores_check",
      sql`${table.importance} between 1 and 5 and ${table.consequence} between 1 and 5`
    ),
    check("deliverables_versions_check", sql`${table.contractVersion} >= 0 and ${table.planVersion} >= 0`),
    index("deliverables_project_status_sort_idx").on(table.projectId, table.status, table.sortOrder)
  ]
);

/**
 * Prerequisites that `action_dependencies` and `deliverable_dependencies` cannot hold: every edge from
 * or to a project, and every edge between different kinds.
 * Polymorphic, so there are no foreign keys; the write path checks the targets, the read path drops a
 * row whose target is gone, and deleting an entity deletes its rows in both directions.
 */
export const entityPrerequisites = pgTable(
  "entity_prerequisites",
  {
    entityKind: text("entity_kind").notNull(),
    entityId: uuid("entity_id").notNull(),
    requiresKind: text("requires_kind").notNull(),
    requiresId: uuid("requires_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    primaryKey({ columns: [table.entityKind, table.entityId, table.requiresKind, table.requiresId] }),
    check(
      "entity_prerequisites_kinds_check",
      sql`${table.entityKind} in ('project', 'deliverable', 'action') and ${table.requiresKind} in ('project', 'deliverable', 'action')`
    ),
    check(
      "entity_prerequisites_not_self",
      sql`not (${table.entityKind} = ${table.requiresKind} and ${table.entityId} = ${table.requiresId})`
    ),
    index("entity_prerequisites_requires_idx").on(table.requiresKind, table.requiresId)
  ]
);

/**
 * What "complete" means for the prerequisite is not copied onto the edge; the prerequisite's own
 * approved contract already defines it, and duplicating it would let the two answers disagree.
 */
export const deliverableDependencies = pgTable(
  "deliverable_dependencies",
  {
    deliverableId: uuid("deliverable_id")
      .notNull()
      .references(() => deliverables.id, { onDelete: "cascade" }),
    dependsOnDeliverableId: uuid("depends_on_deliverable_id")
      .notNull()
      .references(() => deliverables.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    primaryKey({ columns: [table.deliverableId, table.dependsOnDeliverableId] }),
    check("deliverable_dependencies_not_self", sql`${table.deliverableId} <> ${table.dependsOnDeliverableId}`)
  ]
);

/** One clause of the completion contract. `key` is stable so a revised brief can amend rather than replace. */
export const deliverableCriteria = pgTable(
  "deliverable_criteria",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deliverableId: uuid("deliverable_id")
      .notNull()
      .references(() => deliverables.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    title: text("title").notNull(),
    required: boolean("required").notNull().default(true),
    interpretation: text("interpretation"),
    sourceDocument: text("source_document"),
    sourceLocation: text("source_location"),
    expectedEvidence: text("expected_evidence"),
    verificationMethod: text("verification_method"),
    state: criterionState("state").notNull().default("unsatisfied"),
    notes: text("notes"),
    sortOrder: integer("sort_order").notNull().default(0),
    ...timestamps
  },
  (table) => [
    check(
      "deliverable_criteria_verification_check",
      sql`${table.verificationMethod} is null or ${table.verificationMethod} in ('llm_inspection','user_confirmation','submission_receipt','external_result','not_verifiable')`
    ),
    uniqueIndex("deliverable_criteria_key_unique").on(table.deliverableId, table.key),
    index("deliverable_criteria_deliverable_sort_idx").on(table.deliverableId, table.sortOrder)
  ]
);

/**
 * Which actions make a criterion true. Contract coverage is then a query, not an assertion.
 * Re-pointed at `actions` when steps moved into that table.
 */
export const deliverableCriterionActions = pgTable(
  "deliverable_criterion_actions",
  {
    criterionId: uuid("criterion_id")
      .notNull()
      .references(() => deliverableCriteria.id, { onDelete: "cascade" }),
    actionId: uuid("action_id")
      .notNull()
      .references(() => actions.id, { onDelete: "cascade" })
  },
  (table) => [primaryKey({ columns: [table.criterionId, table.actionId] })]
);

/**
 * An obstacle, not a status. Resolving one recalculates the step graph; it never clears another, and
 * sending the clarification request does not by itself prove the obstacle is gone.
 */
export const deliverableBlockers = pgTable(
  "deliverable_blockers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deliverableId: uuid("deliverable_id")
      .notNull()
      .references(() => deliverables.id, { onDelete: "cascade" }),
    description: text("description").notNull(),
    category: blockerCategory("category").notNull().default("other"),
    state: blockerState("state").notNull().default("open"),
    proposedResolution: text("proposed_resolution"),
    resolutionNotes: text("resolution_notes"),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    ...timestamps
  },
  (table) => [index("deliverable_blockers_deliverable_state_idx").on(table.deliverableId, table.state)]
);

/** Which actions a blocker gates. Re-pointed at `actions` when steps moved into that table. */
export const deliverableBlockerActions = pgTable(
  "deliverable_blocker_actions",
  {
    blockerId: uuid("blocker_id")
      .notNull()
      .references(() => deliverableBlockers.id, { onDelete: "cascade" }),
    actionId: uuid("action_id")
      .notNull()
      .references(() => actions.id, { onDelete: "cascade" })
  },
  (table) => [primaryKey({ columns: [table.blockerId, table.actionId] })]
);

/**
 * The Breakdown conversation, one row per turn. The engine never reads this table — the workspace
 * projection is all it sees (logic-design §6) — so the chat can hold source excerpts and images
 * without widening what planning depends on. Attachments are inline data URLs in jsonb: chat images
 * are small, per-message capped, and this keeps a turn restorable as one row.
 */
export const deliverableChatMessages = pgTable(
  "deliverable_chat_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deliverableId: uuid("deliverable_id")
      .notNull()
      .references(() => deliverables.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    content: text("content").notNull(),
    attachments: jsonb("attachments").notNull().default([]),
    /** Present on `external` rows: `{kind: pick_up|note|drop_off, tool}` — see the external coordination design note. */
    meta: jsonb("meta").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    check("deliverable_chat_messages_role_check", sql`${table.role} in ('user','assistant','external')`),
    index("deliverable_chat_messages_deliverable_created_idx").on(table.deliverableId, table.createdAt)
  ]
);

/** Provenance for an extracted requirement, reusing the existing source store rather than a second one. */
export const deliverableSources = pgTable(
  "deliverable_sources",
  {
    deliverableId: uuid("deliverable_id")
      .notNull()
      .references(() => deliverables.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    role: text("role")
  },
  (table) => [primaryKey({ columns: [table.deliverableId, table.sourceId] })]
);

export const sources = pgTable(
  "sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    sourceType: text("source_type").notNull(),
    externalId: text("external_id"),
    title: text("title"),
    capturedText: text("captured_text"),
    sourceLink: text("source_link"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }),
    contentHash: text("content_hash"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [uniqueIndex("sources_external_unique").on(table.userId, table.sourceType, table.externalId)]
);

/** Retained originals for a source. Binary content is base64 for portable logical backups. */
export const sourceFiles = pgTable(
  "source_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    contentHash: text("content_hash").notNull(),
    contentBase64: text("content_base64").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("source_files_source_hash_unique").on(table.sourceId, table.contentHash),
    index("source_files_source_sort_idx").on(table.sourceId, table.sortOrder)
  ]
);

export const captures = pgTable(
  "captures",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id),
    proposalType: text("proposal_type").notNull().default("unclassified"),
    status: proposalStatus("status").notNull().default("pending"),
    proposedFields: jsonb("proposed_fields").notNull().default({}),
    /**
     * Open questions that must be answered before the proposal can be confirmed (the shared shape,
     * `openQuestionSchema`). An `email_change` keeps its questions on the change inside `proposed_fields`.
     */
    questions: jsonb("questions").notNull().default([]),
    confidence: numeric("confidence", { precision: 4, scale: 3 }),
    matchedEntityType: text("matched_entity_type"),
    matchedEntityId: uuid("matched_entity_id"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    ...timestamps
  },
  (table) => [index("captures_user_status_created_idx").on(table.userId, table.status, table.createdAt)]
);

export const commitmentRecurrenceRules = pgTable(
  "commitment_recurrence_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    timezone: text("timezone").notNull(),
    startDate: date("start_date").notNull(),
    endDate: date("end_date"),
    // `intervalDays` is the whole rule for `interval_unit = 'days'`; a `'months'` rule leaves
    // it NULL and uses `intervalMonths`/`monthAnchor` instead — see the pairing CHECK below. No row
    // predates this: every existing rule defaults to 'days' with its `intervalDays` unchanged.
    intervalUnit: commitmentIntervalUnit("interval_unit").notNull().default("days"),
    intervalDays: integer("interval_days"),
    intervalMonths: integer("interval_months"),
    monthAnchor: commitmentMonthAnchor("month_anchor"),
    // a `'weeks'` rule is `intervalWeeks` plus `weekdays` (a JSON array of 0=Sunday..6=Saturday,
    // ascending, each once) and leaves the days and months fields NULL — see the pairing CHECK below.
    intervalWeeks: integer("interval_weeks"),
    weekdays: jsonb("weekdays").$type<number[]>(),
    localStartTime: time("local_start_time").notNull(),
    localEndTime: time("local_end_time").notNull(),
    location: text("location"),
    /** Location condition slug (no FK). */
    locationId: text("location_id"),
    setupBeforeMinutes: integer("setup_before_minutes").notNull().default(0),
    transitionAfterMinutes: integer("transition_after_minutes").notNull().default(0),
    /** What this rule's occurrences claim of the time; see commitments.presence. */
    presence: text("presence").notNull().default("blocking"),
    status: text("status").notNull().default("active"),
    sourceId: uuid("source_id").references(() => sources.id),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    /**
     * Where this rule's occurrences get their preparation routine from: the place default
     * ('inherit'), a named preset ('preset'), or nowhere ('none'). Occurrences copy these two
     * columns when they are materialised, and keep their own values afterwards.
     */
    routineSource: text("routine_source").notNull().default("inherit"),
    routinePresetId: uuid("routine_preset_id").references(() => routinePresets.id),
    /** Whether this rule's occurrences publish to the family calendar; see commitments.shareToCalendar. */
    shareToCalendar: boolean("share_to_calendar").notNull().default(false),
    /**
     * Whether a late arrival at this rule's occurrences matters. Nothing reads this yet
     * stored here so travel-time-model does not re-migrate this
     * table, which gives it its first reader. Part of the per-date overlay: an occurrence copies this
     * at materialisation and can then override it.
     */
    latenessMatters: boolean("lateness_matters").notNull().default(true),
    /**
     * How this rule's occurrences are reached, when known. Nothing reads this yet; travel-time-model
     * gives it its effect and its editor field. Part of the per-date overlay, same as `latenessMatters`.
     */
    transportMode: text("transport_mode"),
    /**
     * The slug of a `condition_definitions` row of kind `contact`, no FK, exactly as `locationId`
     * names a place. The engine never reads this; `commitment-contacts.md` gives it its picker and
     * offers. Part of the per-date overlay, same as `latenessMatters`.
     */
    contactId: text("contact_id"),
    /** Pulse privacy; an occurrence inherits this unless it overrides it — see `areas.private`. */
    private: boolean("private").notNull().default(false),
    /** Pulse check-in allowance for this rule's occurrences; see `commitments.checkInExtraMinutes`. */
    checkInExtraMinutes: integer("check_in_extra_minutes"),
    ...timestamps
  },
  (table) => [
    check("commitment_recurrence_dates_check", sql`${table.endDate} IS NULL OR ${table.endDate} >= ${table.startDate}`),
    // Replaces, not adds to, the old `interval_days > 0` check: it pairs all four repeat columns to
    // the unit, so a 'days' row can never carry a month field and a 'months' row can never carry
    // `interval_days` — the enum already restricts `month_anchor`'s values, so this only needs the
    // NULL/NOT NULL coupling the enum cannot express. The `IS NOT NULL` halves are not redundant
    // beside the `> 0` ones: `NULL > 0` is UNKNOWN, and a CHECK rejects only FALSE, so without
    // them a 'days' row with a NULL `interval_days` satisfies the constraint and then fails to
    // parse on the way back out.
    // NULL/NOT NULL coupling the enum cannot express.
    check(
      "commitment_recurrence_interval_check",
      // compared as text because 'weeks' was added by ALTER TYPE ADD VALUE, which cannot be used
      // in the same migration transaction (precedent 0063_commitment_context_kind.sql).
      sql`(${table.intervalUnit}::text = 'days' AND ${table.intervalDays} IS NOT NULL AND ${table.intervalDays} > 0 AND ${table.intervalWeeks} IS NULL AND ${table.weekdays} IS NULL AND ${table.intervalMonths} IS NULL AND ${table.monthAnchor} IS NULL)
          OR
          (${table.intervalUnit}::text = 'weeks' AND ${table.intervalWeeks} IS NOT NULL AND ${table.intervalWeeks} > 0 AND ${table.weekdays} IS NOT NULL AND jsonb_typeof(${table.weekdays}) = 'array' AND jsonb_array_length(${table.weekdays}) BETWEEN 1 AND 7 AND ${table.intervalDays} IS NULL AND ${table.intervalMonths} IS NULL AND ${table.monthAnchor} IS NULL)
          OR
          (${table.intervalUnit}::text = 'months' AND ${table.intervalDays} IS NULL AND ${table.intervalWeeks} IS NULL AND ${table.weekdays} IS NULL AND ${table.intervalMonths} IS NOT NULL AND ${table.intervalMonths} > 0 AND ${table.monthAnchor} IS NOT NULL)`
    ),
    check("commitment_recurrence_time_check", sql`${table.localEndTime} > ${table.localStartTime}`),
    check("commitment_recurrence_status_check", sql`${table.status} IN ('active','ended')`),
    check("commitment_recurrence_presence_check", sql`${table.presence} IN ('blocking','anchor')`),
    check(
      "commitment_recurrence_routine_source_check",
      sql`${table.routineSource} IN ('inherit','preset','custom','none')`
    ),
    check(
      "commitment_recurrence_transport_mode_check",
      sql`${table.transportMode} IS NULL OR ${table.transportMode} IN ('car','bike','walk')`
    )
  ]
);

export const commitments = pgTable(
  "commitments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    title: text("title").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    status: text("status").notNull().default("confirmed"),
    location: text("location"),
    /** Location condition slug (no FK). */
    locationId: text("location_id"),
    setupBeforeMinutes: integer("setup_before_minutes").notNull().default(0),
    transitionAfterMinutes: integer("transition_after_minutes").notNull().default(0),
    /**
     * What being at this commitment costs. 'blocking' consumes the hour outright: nothing else is
     * offered while it runs. 'anchor' holds the same place in every plan — capacity, the day plan and
     * the forward replay all subtract it identically, because no plan can know in advance which
     * obligations leave gaps — but live, being present at it is not the same as being taken up by it,
     * so its own window reopens for other work until an engagement session says otherwise.
     */
    presence: text("presence").notNull().default("blocking"),
    /**
     * Whether `presence` still tracks its recurrence rule ('inherit', the default and the only state
     * a one-off commitment ever needs) or was pinned by an explicit per-occurrence edit ('custom').
     * `persistDerivedState` (plan-forecast-runtime.ts) only heals `presence` on an 'inherit' row when
     * a replan re-derives it from the rule — the same rule-switched-to-'anchor' healing that lets a
     * whole-series edit reach every occurrence already materialised. A 'custom' row keeps whatever an
     * occurrence-level save set it to, the same one-way detach `routineSource` uses, until someone
     * edits it back to match the rule by hand. Without this column presence was
     * written unconditionally on every replan, so a single occurrence's engagement level never stuck.
     */
    presenceSource: text("presence_source").notNull().default("inherit"),
    sourceId: uuid("source_id").references(() => sources.id),
    recurrenceRuleId: uuid("recurrence_rule_id").references(() => commitmentRecurrenceRules.id, {
      onDelete: "cascade"
    }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    localDate: date("local_date"),
    /**
     * Where this commitment's preparation routine comes from: the place default ('inherit'), a named
     * preset ('preset'), steps the user shaped by hand ('custom'), or nowhere ('none'). Only
     * 'inherit' and 'preset' let a replan rewrite the steps, and only while every step is pending.
     */
    routineSource: text("routine_source").notNull().default("inherit"),
    routinePresetId: uuid("routine_preset_id").references(() => routinePresets.id),
    /**
     * How this commitment came to exist. 'planned' is anything put in the diary ahead of time;
     * 'disruption' is something that landed on the day and was made real immediately so the plan
     * could reflow around it. The engine ignores all four columns — they exist so the portal can
     * tell the two apart afterwards without keeping a side table.
     */
    origin: text("origin").notNull().default("planned"),
    /** Which part of life interrupted, for later review. Only ever set when origin is 'disruption'. */
    disruptionSource: text("disruption_source"),
    /**
     * The duration was unknown when it landed, so ends_at is a pessimistic guess rather than a fact.
     * The flag is what lets "done, heading home" and "another hour" be offered on this record alone.
     */
    disruptionOpenEnded: boolean("disruption_open_ended").notNull().default(false),
    /**
     * When the disruption was reported, which is not created_at and not starts_at: a retro-log is
     * written now for something that began an hour ago. Keeping the moment it was known separate
     * from the moment it began is what keeps "how much warning did I get" answerable later.
     */
    landedAt: timestamp("landed_at", { withTimezone: true }),
    /**
     * How eagerly the check-in scheduler asks "Still on X?" while this commitment is the active
     * protected or open-anchor one. 'normal' for every commitment — there is no commitment-type
     * taxonomy to default off, so this is always an explicit per-commitment choice. Sleep is silenced
     * by the scheduler reading the sleep window directly; this field never mentions it.
     */
    promptPolicy: text("prompt_policy").notNull().default("normal"),
    /** Whether this commitment publishes to the family calendar via the publish sweep. */
    shareToCalendar: boolean("share_to_calendar").notNull().default(false),
    /**
     * Whether `shareToCalendar` still tracks its recurrence rule ('inherit', the default) or was
     * pinned by an explicit per-occurrence edit ('custom') — the same inherit/custom healing shape
     * as `presenceSource`.
     */
    shareSource: text("share_source").notNull().default("inherit"),
    /**
     * Whether this occurrence's title, times, location, buffers, project, lateness, transport mode
     * and contact still track its recurrence rule ('inherit', the default and the only state a
     * one-off commitment ever needs) or were pinned by an explicit per-occurrence edit ('custom'),
     * iCal-style. Mirrors `presenceSource`/`shareSource`; the
     * occurrence editor always writes the whole overlaid set, so one column covers every field rather
     * than one per field. **Use the series** sets this back to 'inherit'.
     */
    scheduleSource: text("schedule_source").notNull().default("inherit"),
    /**
     * Whether a late arrival at this commitment matters. Part of the per-date overlay; a recurring
     * occurrence copies this from its rule at materialisation and can then override it. Nothing reads
     * this yet; the editor toggle ships with travel-time-model.
     */
    latenessMatters: boolean("lateness_matters").notNull().default(true),
    /**
     * How this commitment is reached, when known. Part of the per-date overlay, same as
     * `latenessMatters`. Nothing reads this yet; travel-time-model gives it its effect and its editor
     * field.
     */
    transportMode: text("transport_mode"),
    /**
     * The slug of a `condition_definitions` row of kind `contact`, no FK, exactly as `locationId`
     * names a place. Part of the per-date overlay, same as `latenessMatters`. The engine never reads
     * this; `commitment-contacts.md` gives it its picker and offers.
     */
    contactId: text("contact_id"),
    /**
     * How the person takes part: 'in_person' (the default, and every commitment before this column)
     * or 'remote' (`CONTEXT.md` "Attendance"). A remote commitment has no journey: the travel model
     * plans no leg to it and leave-by never fires for it.
     */
    attendance: text("attendance").notNull().default("in_person"),
    /**
     * A location condition slug (no FK) the person would rather be at for a remote commitment, such
     * as the home desk. A preference the planner honours when it can, never a requirement, and
     * unused while `attendance` is 'in_person' (`locationId` is the place then).
     */
    preferredLocationId: text("preferred_location_id"),
    /** Pulse privacy; effective privacy is this OR its recurrence rule's — see `areas.private`. */
    private: boolean("private").notNull().default(false),
    /**
     * Pulse check-in allowance: minutes added to both unknown-to-lapsed
     * thresholds while this commitment is in force. Null means its recurrence rule's, else the default
     * (`DEFAULT_CHECK_IN_EXTRA_MINUTES`, 15).
     */
    checkInExtraMinutes: integer("check_in_extra_minutes"),
    /**
     * "I'm free": the instant the person released the rest of this occurrence to the planner. Null means
     * not freed. The commitment is not ended, finished, moved or cancelled; the engine reads it as an
     * open window from this instant to the effective end (`isFreedNow`), and it lapses by itself.
     */
    freedFrom: timestamp("freed_from", { withTimezone: true }),
    ...timestamps,
    ...closedColumns
  },
  (table) => [
    check("commitments_time_check", sql`${table.endsAt} > ${table.startsAt}`),
    check("commitments_status_check", sql`${table.status} IN ('confirmed','tentative','cancelled')`),
    check("commitments_presence_check", sql`${table.presence} IN ('blocking','anchor')`),
    check("commitments_presence_source_check", sql`${table.presenceSource} IN ('inherit','custom')`),
    check("commitments_share_source_check", sql`${table.shareSource} IN ('inherit','custom')`),
    check("commitments_origin_check", sql`${table.origin} IN ('planned','disruption')`),
    check(
      "commitments_disruption_source_check",
      sql`${table.disruptionSource} IS NULL OR ${table.disruptionSource} IN ('work','family','life_admin','other')`
    ),
    check("commitments_routine_source_check", sql`${table.routineSource} IN ('inherit','preset','custom','none')`),
    check("commitments_prompt_policy_check", sql`${table.promptPolicy} IN ('silent','reduced','normal')`),
    check("commitments_schedule_source_check", sql`${table.scheduleSource} IN ('inherit','custom')`),
    check("commitments_attendance_check", sql`${table.attendance} IN ('in_person','remote')`),
    check(
      "commitments_transport_mode_check",
      sql`${table.transportMode} IS NULL OR ${table.transportMode} IN ('car','bike','walk')`
    ),
    index("commitments_user_time_idx").on(table.userId, table.startsAt, table.endsAt),
    uniqueIndex("commitment_recurrence_occurrence_unique")
      .on(table.recurrenceRuleId, table.localDate)
      .where(sql`${table.recurrenceRuleId} IS NOT NULL`)
  ]
);

/**
 * A periodic ground-truth sample: "Still on X?" where X is the engine's own belief at the instant the
 * slot fired. Record-only in v1 — nothing here feeds back into planning, it only measures how often
 * the plan and reality agree. `directive_kind`/`directive_target_id`/`directive_phase`/`directive_title`
 * are a snapshot of `currentDirective` (or, for a held or open-anchor commitment, of `recommendation`'s
 * `protectedCommitment`/`openAnchor`) taken when the slot was created — never re-derived later, so a
 * check-in answered an hour on still asks about what was actually true when it fired.
 */
export const checkIns = pgTable(
  "check_in",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** The jittered instant this slot was scheduled for; also when the belief below was snapshotted. */
    slotAt: timestamp("slot_at", { withTimezone: true }).notNull(),
    /** When the in-app surface actually showed this to the user, distinct from when the slot fired. */
    promptedAt: timestamp("prompted_at", { withTimezone: true }),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    /**
     * The `currentDirective` discriminant, or one of two states that discriminant does not itself
     * distinguish: 'protected_commitment' when the clock was held for a blocking commitment (an
     * ordinary `currentDirective.kind` of 'none' says nothing about why), and 'open_anchor' when an
     * anchor commitment's window was open with nothing else claiming the moment.
     */
    directiveKind: text("directive_kind").notNull(),
    directiveTargetId: text("directive_target_id"),
    directivePhase: text("directive_phase"),
    /** Display snapshot — the wording the check-in asks about, frozen at slot creation. */
    directiveTitle: text("directive_title").notNull(),
    status: text("status").notNull().default("pending"),
    deviationCategory: text("deviation_category"),
    deviationNote: text("deviation_note"),
    /** A different planned task the user names instead — recorded only, never started or switched to. */
    deviationTargetId: text("deviation_target_id"),
    answerSource: text("answer_source"),
    /** Open tags on his words, `[{tag, mark: 'stated'|'inferred'}]`; a reader adds them, `tag_check_in` changes them. */
    tags: jsonb("tags")
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** The agent that answered, by its self-declared name; null for a person or an answer before this column. */
    answeredBy: text("answered_by"),
    /**
     * The time the owner's device claimed for the answer (`occurredAt`), kept beside `answered_at`, which holds the time
     * the server used. Null when the answer carried none. The note says why the claim was not used; null when it was.
     */
    occurredAt: timestamp("occurred_at", { withTimezone: true }),
    occurredNote: text("occurred_note"),
    ...timestamps
  },
  (table) => [
    check("check_in_status_check", sql`${table.status} IN ('pending','on_track','deviated','unknown','superseded')`),
    check(
      "check_in_deviation_category_check",
      sql`${table.deviationCategory} IS NULL OR ${table.deviationCategory} IN ('work','family','life_admin','other')`
    ),
    check(
      "check_in_answer_source_check",
      sql`${table.answerSource} IS NULL OR ${table.answerSource} IN ('in_app_banner','sheet','push_action','widget','shortcut','app','session_reconciliation')`
    ),
    check("check_in_tags_check", sql`jsonb_typeof(${table.tags}) = 'array'`),
    index("check_in_user_slot_idx").on(table.userId, table.slotAt),
    // Enforced in code too (the scheduler supersedes before inserting), but a partial unique index is
    // what actually makes "never two pending" hold under a race rather than just under normal timing.
    uniqueIndex("check_in_one_pending_per_user")
      .on(table.userId)
      .where(sql`${table.status} = 'pending'`)
  ]
);

export const calendarEventLinks = pgTable(
  "calendar_event_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    frameId: text("frame_id").notNull(),
    externalEventId: text("external_event_id").notNull(),
    /** Exactly one of `commitmentId`/`recurrenceRuleId` is set (check below): a one-off entry links its
     * commitment, a repeating entry from a provider that owns its recurrence links its rule. Every other
     * provider only ever links commitments. */
    commitmentId: uuid("commitment_id").references(() => commitments.id, { onDelete: "cascade" }),
    recurrenceRuleId: uuid("recurrence_rule_id").references(() => commitmentRecurrenceRules.id, {
      onDelete: "cascade"
    }),
    /** `primary` for a provider whose values are definitive on the fields it gives (a roster source), else
     * `secondary`; `sourceRole` in `@openrhen/contracts` maps provider to role. Defaults to `secondary` so
     * a writer that predates roles lands correctly; the roster provider writer states `primary`
     * */
    role: text("role").notNull().default("secondary"),
    profileLabel: text("profile_label").notNull(),
    sourceCalendarId: text("source_calendar_id"),
    lastRemoteSnapshot: jsonb("last_remote_snapshot").notNull().default({}),
    lastRemoteHash: text("last_remote_hash").notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    ...timestamps
  },
  (table) => [
    uniqueIndex("calendar_event_links_external_unique").on(
      table.userId,
      table.provider,
      table.frameId,
      table.externalEventId
    ),
    // One commitment (or rule) is one real event seen through several sources: at most one link per
    // provider each, and at most one primary (the source matching design note, `AT-W`). The external
    // unique above keeps one external event from linking to two commitments.
    uniqueIndex("calendar_event_links_commitment_unique")
      .on(table.userId, table.commitmentId, table.provider)
      .where(sql`${table.commitmentId} IS NOT NULL`),
    uniqueIndex("calendar_event_links_rule_unique")
      .on(table.userId, table.recurrenceRuleId, table.provider)
      .where(sql`${table.recurrenceRuleId} IS NOT NULL`),
    uniqueIndex("calendar_event_links_commitment_primary_unique")
      .on(table.userId, table.commitmentId)
      .where(sql`${table.role} = 'primary' AND ${table.commitmentId} IS NOT NULL`),
    uniqueIndex("calendar_event_links_rule_primary_unique")
      .on(table.userId, table.recurrenceRuleId)
      .where(sql`${table.role} = 'primary' AND ${table.recurrenceRuleId} IS NOT NULL`),
    check("calendar_event_links_role_check", sql`${table.role} IN ('primary','secondary')`),
    check("calendar_event_links_target_check", sql`num_nonnulls(${table.commitmentId}, ${table.recurrenceRuleId}) = 1`)
  ]
);

/**
 * Which Google calendars the automatic sync reads. The account also
 * carries shared, holiday and subscribed calendars that must never import, so nothing is read until a
 * calendar is chosen here. `summary` is the calendar's name when last listed, kept so a saved choice
 * still reads sensibly if the proxy is briefly unreachable. Backed up: the choice is authored.
 */
export const calendarSourceSelections = pgTable(
  "calendar_source_selections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** The connection the calendar belongs to (a connection id, e.g. `google_calendar`). */
    provider: text("provider").notNull().default("google_calendar"),
    calendarId: text("calendar_id").notNull(),
    summary: text("summary").notNull(),
    selected: boolean("selected").notNull().default(false),
    ...timestamps
  },
  (table) => [
    uniqueIndex("calendar_source_selections_user_provider_calendar_unique").on(
      table.userId,
      table.provider,
      table.calendarId
    )
  ]
);

/**
 * A calendar event a person rejected in review, remembered so the next automatic run does not propose
 * it again. It returns only if the event's title or start changes (compared with what is stored here).
 * Keyed by provider so the calendar provider can use it too. Backed up: the rejection is a decision, and losing it
 * would re-propose every declined event.
 */
export const calendarEventDismissals = pgTable(
  "calendar_event_dismissals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    externalEventId: text("external_event_id").notNull(),
    title: text("title").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    ...timestamps
  },
  (table) => [
    uniqueIndex("calendar_event_dismissals_user_provider_event_unique").on(
      table.userId,
      table.provider,
      table.externalEventId
    )
  ]
);

/**
 * A remembered "same event" decision: when the owner confirms that a
 * remote event titled `remoteTitleNorm` (from `provider`) is the commitment titled `localTitleNorm`,
 * later imports treat that pair of titles as matching. Both titles are stored normalised
 * (`aliasTitleNorm`). Authored data, so it is in `BACKUP_TABLES`.
 */
export const sourceMatchAliases = pgTable(
  "source_match_aliases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    remoteTitleNorm: text("remote_title_norm").notNull(),
    localTitleNorm: text("local_title_norm").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("source_match_aliases_unique").on(
      table.userId,
      table.provider,
      table.remoteTitleNorm,
      table.localTitleNorm
    )
  ]
);

/**
 * One commitment's state in the family calendar publish sweep: at most one row per
 * (user, commitment), since a commitment either has a remote event or doesn't. `commitmentId` has
 * no FK — the sweep's own plan step treats a missing commitment as "no longer shared" and deletes
 * the row's remote event rather than relying on cascade — so a `removed` row can be reused with a
 * new remote id if the commitment becomes shared again. `remoteEventId` is null until the create
 * call succeeds (or during orphan-recovery adoption); see the shared-calendar publish run. Backed up: the
 * remote id cannot be regenerated from anything else in this database.
 */
export const calendarPublications = pgTable(
  "calendar_publications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** The calendar connection published to (a connection id). */
    provider: text("provider").notNull(),
    commitmentId: uuid("commitment_id").notNull(),
    frameId: text("frame_id").notNull(),
    remoteEventId: text("remote_event_id"),
    lastPushedSnapshot: jsonb("last_pushed_snapshot"),
    lastPushedHash: text("last_pushed_hash"),
    lastPushedAt: timestamp("last_pushed_at", { withTimezone: true }),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    lastError: text("last_error"),
    ...timestamps
  },
  (table) => [
    check(
      "calendar_publications_status_check",
      sql`${table.status} IN ('pending','published','remote_missing','failed','removed')`
    ),
    uniqueIndex("calendar_publications_user_provider_commitment_unique").on(
      table.userId,
      table.provider,
      table.commitmentId
    ),
    uniqueIndex("calendar_publications_user_provider_frame_remote_unique")
      .on(table.userId, table.provider, table.frameId, table.remoteEventId)
      .where(sql`${table.remoteEventId} IS NOT NULL`)
  ]
);

export const routineSteps = pgTable(
  "routine_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    /**
     * One routine, one table: this row's own
     * `commitments` id when `anchorType='commitment'`, kept (rather than folded into `anchorId`)
     * so the existing `ON DELETE CASCADE` from a deleted commitment keeps working untouched. `NULL`
     * for a sleep-anchored row.
     */
    commitmentId: uuid("commitment_id").references(() => commitments.id, { onDelete: "cascade" }),
    /** `'commitment'` for a commitment's own preparation, `'sleep_plan'` for a bedtime/wake step. */
    anchorType: text("anchor_type").notNull().default("commitment"),
    /**
     * The commitment's own id (mirroring `commitmentId`) or the sleep plan's id — no FK, since which
     * table it names depends on `anchorType` (the same polymorphic shape `routine_instances.anchor_id`
     * used before this table absorbed it).
     */
    anchorId: uuid("anchor_id").notNull(),
    /** `NULL` for a commitment-anchored step; `'bedtime'`/`'wake'` for a sleep-anchored one. */
    purpose: text("purpose"),
    title: text("title").notNull(),
    durationMinutes: integer("duration_minutes").notNull(),
    sequence: integer("sequence").notNull(),
    timingRule: text("timing_rule").notNull(),
    maxLeadMinutes: integer("max_lead_minutes"),
    energy: energyType("energy").notNull().default("low"),
    phase: text("phase").notNull().default("before"),
    contexts: jsonb("contexts").notNull().default([]),
    /** The recurring-action window this step is the same work as, so the two are planned once. */
    actionWindowId: uuid("action_window_id").references(() => actionRecurrenceWindows.id, { onDelete: "set null" }),
    /**
     * The cadence action this step stands in for, so completing the step also records the cadence
     * completion. Mutually exclusive with `actionWindowId` (enforced by
     * `routine_steps_action_link_check` below) — a step links to at most one of a recurring-action
     * window or a cadence action, never both.
     */
    cadenceActionId: uuid("cadence_action_id").references(() => actions.id, { onDelete: "set null" }),
    /**
     * The `routine_preset_steps` row this step was generated from, when it was preset-derived — the
     * template-step identity `planRoutineStepReconciliation` matches on first, before falling back to
     * position (`platform/database/src/planning/routine-inheritance.ts`). Null for hand-added steps and
     * for rows written before this column existed (backfilled the next time reconciliation matches them
     * by position). `routine_preset_steps` rows are stable across a preset edit (re-saved under the same
     * deterministic id — `entity-commands.ts`'s `routine_preset` write), so a real FK is safe; a preset
     * step's own deletion clears this link rather than taking the commitment's step with it.
     */
    presetStepId: uuid("preset_step_id").references(() => routinePresetSteps.id, { onDelete: "set null" }),
    status: text("status").notNull().default("pending"),
    scheduledStartAt: timestamp("scheduled_start_at", { withTimezone: true }),
    scheduledEndAt: timestamp("scheduled_end_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    /**
     * Minutes this step's hands-on work must finish before whatever follows it may begin — the wash
     * running, not protected and holding no place.
     * Zero (the default) is today's contiguous chain, unchanged.
     */
    waitAfterMinutes: integer("wait_after_minutes").notNull().default(0),
    /**
     * How late this step may start: before phase, at least this many minutes before the chain's
     * anchor; forward chains (after, wake), within this many minutes of the chain's anchor. Null
     * means no such constraint. See the routine step timing design note "Must start by".
     */
    mustStartByMinutes: integer("must_start_by_minutes"),
    /**
     * Time-band ids (`user_preferences.time_bands`) this flexible before-step prefers, in order. A
     * step naming a deleted band ignores it. Only ever consulted for a flexible commitment
     * before-step. See the routine step timing design note "Bands".
     */
    preferredBands: jsonb("preferred_bands").notNull().default([]),
    ...timestamps
  },
  (table) => [
    // Sleep rows carry `commitmentId=NULL`, and Postgres never treats two NULLs as equal, so this
    // index already only ever constrains the commitment side — untouched by this plan.
    uniqueIndex("routine_steps_commitment_sequence_unique").on(table.commitmentId, table.sequence),
    // The sleep side's own uniqueness — `purpose` is never NULL for a `sleep_plan` row, so this partial
    // index (the same pattern `calendar_publications_user_provider_frame_remote_unique` already uses) has no
    // NULL-equality gap the way a plain unique index over a nullable `purpose` would.
    uniqueIndex("routine_steps_anchor_sequence_unique")
      .on(table.anchorType, table.anchorId, table.purpose, table.sequence)
      .where(sql`${table.anchorType} = 'sleep_plan'`),
    check("routine_steps_duration_check", sql`${table.durationMinutes} > 0`),
    check("routine_steps_timing_check", sql`${table.timingRule} IN ('contiguous','flexible')`),
    check("routine_steps_lead_check", sql`${table.timingRule} = 'contiguous' OR ${table.maxLeadMinutes} > 0`),
    check("routine_steps_phase_check", sql`${table.phase} IN ('before','after')`),
    check(
      "routine_steps_status_check",
      sql`${table.status} IN ('pending','doing','completed','blocked','cancelled','skipped')`
    ),
    check("routine_steps_action_link_check", sql`${table.actionWindowId} IS NULL OR ${table.cadenceActionId} IS NULL`),
    check("routine_steps_anchor_type_check", sql`${table.anchorType} IN ('commitment','sleep_plan')`),
    check(
      "routine_steps_anchor_check",
      sql`(${table.anchorType} = 'commitment' AND ${table.commitmentId} IS NOT NULL AND ${table.purpose} IS NULL)
        OR (${table.anchorType} = 'sleep_plan' AND ${table.commitmentId} IS NULL AND ${table.purpose} IN ('bedtime','wake'))`
    ),
    check("routine_steps_wait_after_check", sql`${table.waitAfterMinutes} >= 0`),
    check(
      "routine_steps_must_start_by_check",
      sql`${table.mustStartByMinutes} IS NULL OR ${table.mustStartByMinutes} > 0`
    )
  ]
);

export const routineStepDependencies = pgTable(
  "routine_step_dependencies",
  {
    stepId: uuid("step_id")
      .notNull()
      .references(() => routineSteps.id, { onDelete: "cascade" }),
    dependsOnStepId: uuid("depends_on_step_id")
      .notNull()
      .references(() => routineSteps.id, { onDelete: "cascade" })
  },
  (table) => [
    primaryKey({ columns: [table.stepId, table.dependsOnStepId] }),
    check("routine_step_dependency_no_self", sql`${table.stepId} <> ${table.dependsOnStepId}`)
  ]
);

export const routinePresets = pgTable(
  "routine_presets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    activityName: text("activity_name").notNull(),
    status: text("status").notNull().default("active"),
    /**
     * When true and this preset resolves for a confirmed commitment, that commitment can skip or
     * truncate the day's wake routine instance rather than run alongside it — see
     * The wake routine design note.
     */
    replacesWakeRoutine: boolean("replaces_wake_routine").notNull().default(false),
    ...timestamps,
    ...closedColumns
  },
  (table) => [
    uniqueIndex("routine_presets_user_name_unique").on(table.userId, table.name),
    check("routine_presets_status_check", sql`${table.status} IN ('active','archived')`)
  ]
);

export const routinePresetSteps = pgTable(
  "routine_preset_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    presetId: uuid("preset_id")
      .notNull()
      .references(() => routinePresets.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    durationMinutes: integer("duration_minutes").notNull(),
    sequence: integer("sequence").notNull(),
    timingRule: text("timing_rule").notNull(),
    maxLeadMinutes: integer("max_lead_minutes"),
    energy: energyType("energy").notNull().default("low"),
    phase: text("phase").notNull().default("before"),
    contexts: jsonb("contexts").notNull().default([]),
    actionWindowId: uuid("action_window_id").references(() => actionRecurrenceWindows.id, { onDelete: "set null" }),
    /** Mirrors `routineSteps.cadenceActionId` — see the comment there. */
    cadenceActionId: uuid("cadence_action_id").references(() => actions.id, { onDelete: "set null" }),
    /** Mirrors `routineSteps.waitAfterMinutes` — see the comment there. */
    waitAfterMinutes: integer("wait_after_minutes").notNull().default(0),
    /** Mirrors `routineSteps.mustStartByMinutes` — see the comment there. */
    mustStartByMinutes: integer("must_start_by_minutes"),
    /** Mirrors `routineSteps.preferredBands` — see the comment there. */
    preferredBands: jsonb("preferred_bands").notNull().default([])
  },
  (table) => [
    uniqueIndex("routine_preset_steps_sequence_unique").on(table.presetId, table.sequence),
    check("routine_preset_steps_duration_check", sql`${table.durationMinutes} > 0`),
    check("routine_preset_steps_phase_check", sql`${table.phase} IN ('before','after')`),
    check(
      "routine_preset_steps_action_link_check",
      sql`${table.actionWindowId} IS NULL OR ${table.cadenceActionId} IS NULL`
    ),
    check("routine_preset_steps_wait_after_check", sql`${table.waitAfterMinutes} >= 0`),
    check(
      "routine_preset_steps_must_start_by_check",
      sql`${table.mustStartByMinutes} IS NULL OR ${table.mustStartByMinutes} > 0`
    )
  ]
);

export const routinePresetStepDependencies = pgTable(
  "routine_preset_step_dependencies",
  {
    stepId: uuid("step_id")
      .notNull()
      .references(() => routinePresetSteps.id, { onDelete: "cascade" }),
    dependsOnStepId: uuid("depends_on_step_id")
      .notNull()
      .references(() => routinePresetSteps.id, { onDelete: "cascade" })
  },
  (table) => [
    primaryKey({ columns: [table.stepId, table.dependsOnStepId] }),
    check("routine_preset_dependency_no_self", sql`${table.stepId} <> ${table.dependsOnStepId}`)
  ]
);

/**
 * The typed condition catalogue, replacing the flat user_preferences.context_catalog and absorbing
 * location_profiles. The identity is a human-readable slug, because the string key is already what
 * every other part of the condition system stores and what the user edits in an import sheet.
 *
 * Columns apply per kind: pathways and portability to capabilities, grants and travel and the
 * setup/transition buffers to locations, channels to contacts.
 */
export const conditionDefinitions = pgTable(
  "condition_definitions",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    id: text("id").notNull(),
    name: text("name").notNull(),
    kind: conditionKind("kind").notNull(),
    status: text("status").notNull().default("active"),
    portability: conditionPortability("portability").notNull().default("fixed"),
    pathways: jsonb("pathways").notNull().default([]),
    grants: jsonb("grants").notNull().default([]),
    channels: jsonb("channels").notNull().default([]),
    travelMinutes: integer("travel_minutes"),
    /** Where the place is, so travel can be measured rather than estimated by hand. */
    latitude: doublePrecision("latitude"),
    longitude: doublePrecision("longitude"),
    /** The address those coordinates were found at, for recognition only. Null unless both are set. */
    address: text("address"),
    setupBeforeMinutes: integer("setup_before_minutes").notNull().default(0),
    transitionAfterMinutes: integer("transition_after_minutes").notNull().default(0),
    defaultRoutinePresetId: uuid("default_routine_preset_id").references(() => routinePresets.id),
    /**
     * Location only. A place created quietly from a one-off search — a dentist, an interview — that
     * exists for the commitment(s) referencing it and stays out of the normal place pickers. It is
     * archived automatically once nothing upcoming refers to it any more.
     */
    oneOff: boolean("one_off").notNull().default(false),
    /**
     * Live only. Names the recurring series this condition tracks — satisfied while now falls
     * inside a live, confirmed occurrence of the rule. Exactly one of recurrence_rule_id/commitment_id
     * is required when kind is 'live', and neither is accepted otherwise (contracts refinement;
     * `condition_definitions_commitment_check` below backstops it at the row level).
     */
    recurrenceRuleId: uuid("recurrence_rule_id").references(() => commitmentRecurrenceRules.id, {
      onDelete: "set null"
    }),
    /** Live only. Names a single one-off commitment instead of a recurring series. */
    commitmentId: uuid("commitment_id").references(() => commitments.id, { onDelete: "set null" }),
    /**
     * Location only. How this place is usually reached, when known — the mode order's second tier
     * a commitment's own `transport_mode` beats
     * this, and this beats the user's `default_transport_mode`. Nothing else reads or writes this yet.
     */
    usualTransportMode: text("usual_transport_mode"),
    /**
     * Contact only. Where a prefilled text or email is addressed.
     * OpenRhen never sends anything to either: they only fill in the `sms:`/`mailto:` compose the
     * person sends themselves. Never published, and null for every other kind.
     */
    phone: text("phone"),
    email: text("email"),
    ...timestamps,
    ...closedColumns
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.id] }),
    uniqueIndex("condition_definitions_user_name_unique").on(table.userId, table.name),
    check("condition_definitions_status_check", sql`${table.status} IN ('active','archived')`),
    check("condition_definitions_travel_check", sql`${table.travelMinutes} IS NULL OR ${table.travelMinutes} >= 0`),
    check(
      "condition_definitions_commitment_check",
      sql`(${table.kind}::text = 'live' AND num_nonnulls(${table.recurrenceRuleId}, ${table.commitmentId}) = 1)
        OR (${table.kind}::text <> 'live' AND ${table.recurrenceRuleId} IS NULL AND ${table.commitmentId} IS NULL)`
    ),
    check(
      "condition_definitions_usual_transport_mode_check",
      sql`${table.usualTransportMode} IS NULL OR ${table.usualTransportMode} IN ('car','bike','walk')`
    ),
    check(
      "condition_definitions_contact_address_check",
      sql`${table.kind}::text = 'contact' OR (${table.phone} IS NULL AND ${table.email} IS NULL)`
    )
  ]
);

/**
 * One observed journey, Google's or the person's own (the travel time model design note "The
 * lookup", "Persistence"). `originLocationId`/`destinationLocationId` are `condition_definitions`
 * slugs, no FK, exactly as `commitments.locationId` names a place. Own trips cannot be
 * re-fetched, so this table is in `BACKUP_TABLES`; `plan-retention.ts` prunes rows older than 180
 * days, the same window `readJourneySummary` reads over.
 */
export const journeySamples = pgTable(
  "journey_samples",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    originLocationId: text("origin_location_id").notNull(),
    destinationLocationId: text("destination_location_id").notNull(),
    mode: text("mode").notNull(),
    minutes: numeric("minutes", { precision: 6, scale: 1 }).notNull(),
    /** The requested departure for a Google sample, the inferred one for an own trip. */
    departedAt: timestamp("departed_at", { withTimezone: true }).notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    source: text("source").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("journey_samples_pair_mode_departed_idx").on(
      table.userId,
      table.originLocationId,
      table.destinationLocationId,
      table.mode,
      sql`${table.departedAt} DESC`
    ),
    // The journey summary and latest-sample queries filter and order by observed_at.
    index("journey_samples_pair_mode_observed_idx").on(
      table.userId,
      table.originLocationId,
      table.destinationLocationId,
      table.mode,
      sql`${table.observedAt} DESC`
    ),
    check("journey_samples_mode_check", sql`${table.mode} IN ('car','bike','walk')`),
    check("journey_samples_minutes_check", sql`${table.minutes} >= 0`),
    check("journey_samples_source_check", sql`${table.source} ~ '^[a-z][a-z0-9_]{1,39}$'`)
  ]
);

/**
 * The daily Google lookup spend, one row per user per local date (the travel time model design note
 * "Spending the budget"). Recomputable from `journey_samples`' Google rows, so it is in
 * `REGENERABLE_TABLES` rather than the backup. A spend is `INSERT … ON CONFLICT DO UPDATE SET spent =
 * spent + n WHERE spent + n <= limit RETURNING`, so two concurrent spenders cannot overrun the limit.
 */
export const travelLookupBudget = pgTable(
  "travel_lookup_budget",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    localDate: date("local_date").notNull(),
    spent: integer("spent").notNull().default(0)
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.localDate] }),
    check("travel_lookup_budget_spent_check", sql`${table.spent} >= 0`)
  ]
);

/**
 * One browser's Web Push registration. Not backed up:
 * a restored subscription in a test database or a restore-verify stack could push to the real
 * phone, and re-enabling on the device costs one tap. `REGENERABLE_TABLES`.
 */
export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    endpoint: text("endpoint").notNull().unique(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    /** The VAPID public key this subscription was made with, so a key rotation can be detected. */
    vapidPublicKey: text("vapid_public_key").notNull(),
    /** From the subscribing browser's user agent, e.g. "iPhone" — shown on the Notifications page. */
    label: text("label"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    lastFailureAt: timestamp("last_failure_at", { withTimezone: true }),
    failureCount: integer("failure_count").notNull().default(0)
  },
  (table) => [index("push_subscriptions_user_idx").on(table.userId)]
);

/**
 * One queued or sent leave-by push. Not
 * backed up: nothing here is plan input the engine reads, and a stale queued row is worthless after
 * a restore. `REGENERABLE_TABLES`; `plan-retention.ts` deletes rows older than 30 days.
 */
export const pushOutbox = pgTable(
  "push_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** `leave_by:<commitmentId>:<occurrenceStartsAt>:<kind>` — `reminder`/`assumed_origin` share `lead`. */
    dedupeKey: text("dedupe_key").notNull(),
    kind: text("kind").notNull(),
    /** `{ title, body, tag, url }` — composed once, server-side, so push and the handheld banner agree. */
    payload: jsonb("payload").notNull(),
    commitmentId: text("commitment_id"),
    occurrenceStartsAt: timestamp("occurrence_starts_at", { withTimezone: true }),
    /** The `leaveBy` this row's reminder announced, so a later "earlier" prompt can compare against it. */
    announcedLeaveBy: timestamp("announced_leave_by", { withTimezone: true }),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    lastError: text("last_error"),
    /** Which sender claims the row: `webpush` (the original drain) or a channel a private build adds (schema/private/push-channels.ts). */
    channel: text("channel").notNull().default("webpush"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("push_outbox_user_dedupe_unique").on(table.userId, table.dedupeKey, table.channel),
    index("push_outbox_status_next_attempt_idx").on(table.status, table.nextAttemptAt),
    check("push_outbox_kind_check", sql`${table.kind} IN ('reminder','assumed_origin','earlier','due','test')`),
    check("push_outbox_status_check", sql`${table.status} IN ('pending','sent','cancelled','expired','failed')`),
    check(
      "push_outbox_channel_check",
      sql`${table.channel} IN (${sql.raw(["webpush", ...EXTRA_PUSH_CHANNELS].map((channel) => `'${channel}'`).join(","))})`
    )
  ]
);

/**
 * Wakes for the owner's OpenClaw agent. A producer inserts a row, one worker tick
 * claims and sends it. `sent` is set before the POST (at-most-once); `dead` covers expired, refused three times, stale
 * (`last_error` "stale") and cancelled ("cancelled"). Regenerable: a restore must not resurrect old wakes.
 */
export const agentWakes = pgTable(
  "agent_wakes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    event: text("event").notNull(),
    /** The check_in id or the lapse's start: what the template names. Ids only, never record text. */
    targetId: text("target_id").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    /** An HTTP status plus a fixed reason, never gateway output. */
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("agent_wakes_user_dedupe_unique").on(table.userId, table.dedupeKey),
    index("agent_wakes_status_created_idx").on(table.status, table.createdAt),
    check(
      "agent_wakes_event_check",
      sql`${table.event} IN ('check_in_unanswered','pulse_lapsed','pulse_unknown','attention_waiting')`
    ),
    check("agent_wakes_status_check", sql`${table.status} IN ('pending','sent','dead')`)
  ]
);

export const sleepPlans = pgTable(
  "sleep_plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    plannedStartAt: timestamp("planned_start_at", { withTimezone: true }).notNull(),
    plannedWakeAt: timestamp("planned_wake_at", { withTimezone: true }).notNull(),
    desiredMinutes: integer("desired_minutes").notNull(),
    allowedMinutes: integer("allowed_minutes").notNull(),
    sleepDeficitMinutes: integer("sleep_deficit_minutes").notNull().default(0),
    anchorDeviationMinutes: integer("anchor_deviation_minutes").notNull().default(0),
    hardErrors: jsonb("hard_errors").notNull().default([]),
    explanation: text("explanation").notNull(),
    status: text("status").notNull().default("planned"),
    actualStartAt: timestamp("actual_start_at", { withTimezone: true }),
    actualWakeAt: timestamp("actual_wake_at", { withTimezone: true }),
    inputVersion: text("input_version"),
    scoreComponents: jsonb("score_components").notNull().default({}),
    stayUpAnswerMinutes: integer("stay_up_answer_minutes"),
    placementChoice: text("placement_choice"),
    ...timestamps
  },
  (table) => [
    index("sleep_plans_user_start_idx").on(table.userId, table.plannedStartAt),
    check("sleep_plans_status_check", sql`${table.status} IN ('planned','sleeping','completed','cancelled')`),
    check(
      "sleep_plans_stay_up_answer_check",
      sql`${table.stayUpAnswerMinutes} IS NULL OR ${table.stayUpAnswerMinutes} IN (0,30,60,90)`
    ),
    check(
      "sleep_plans_placement_choice_check",
      sql`${table.placementChoice} IS NULL OR ${table.placementChoice} IN ('early','near')`
    )
  ]
);

// `routine_instances`/`routine_instance_occurrences` dropped (the one routine storage design note,
// migration `0081`): a bedtime/wake step is a `routineSteps` row now, like a commitment's own; its
// `actionWindowId` is the occurrence link the junction table used to carry.

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    actionId: uuid("action_id").references(() => actions.id),
    occurrenceId: text("occurrence_id").references(() => actionOccurrences.id),
    targetType: text("target_type").notNull().default("action"),
    targetId: uuid("target_id"),
    targetStepId: uuid("target_step_id"),
    targetTitle: text("target_title"),
    status: sessionStatus("status").notNull().default("planned"),
    plannedStartedAt: timestamp("planned_started_at", { withTimezone: true }).notNull(),
    plannedEndAt: timestamp("planned_end_at", { withTimezone: true }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    // When a reconciled `finish_activity` closes the session at a chosen past moment (`endedAt`
    // earlier than now), this is when that choice was actually made — real now, never `endedAt`.
    // Null for every session that ended at now, which is every session before this column existed.
    // See the session reconciliation design note, "Two clocks".
    endedRecordedAt: timestamp("ended_recorded_at", { withTimezone: true }),
    // Mirror of `endedRecordedAt` for a start: when a `startedAt` earlier than now was chosen
    //. Null for every session that started at now.
    startedRecordedAt: timestamp("started_recorded_at", { withTimezone: true }),
    /** The agent that started it, by its self-declared name; null for a person or a session before this column. */
    startedBy: text("started_by"),
    plannedMinutes: integer("planned_minutes").notNull(),
    activeMinutes: integer("active_minutes").notNull().default(0),
    remainingBeforeMinutes: integer("remaining_before_minutes").notNull(),
    remainingAfterMinutes: integer("remaining_after_minutes"),
    resultNote: text("result_note"),
    overrideReason: text("override_reason"),
    pausedRemainingSeconds: integer("paused_remaining_seconds"),
    feedbackRequestedAt: timestamp("feedback_requested_at", { withTimezone: true }),
    recommendationId: uuid("recommendation_id"),
    blockingReason: text("blocking_reason"),
    /**
     * The pulse criteria and publish design note (Decision Q2, "Self-started session"): what
     * sanctioned this session's target at the moment it started, decided once and frozen — never
     * recomputed from a later plan. Null on a session predating this column (judged live) and on any
     * session whose target was unsanctioned when it started.
     */
    planSanction: text("plan_sanction"),
    /** The instant `planSanction` stops holding: `plannedEndAt` for a directive/alternative/day-plan
        sanction, the protected block's end for a protected target, moved forward by `continue`. Null
        for a `free` sanction (free time has no clock to run out) and for a legacy null sanction. */
    sanctionUntil: timestamp("sanction_until", { withTimezone: true }),
    ...timestamps
  },
  (table) => [
    uniqueIndex("sessions_one_running_per_user")
      .on(table.userId)
      .where(sql`${table.status} = 'running'`),
    index("sessions_action_created_idx").on(table.actionId, table.createdAt),
    // The hot state-read lookups: per-user ended sessions, the per-commitment latest end by target,
    // and the NOT EXISTS / foreign-key check on an occurrence (most sessions have none, hence partial).
    index("sessions_user_ended_idx").on(table.userId, table.endedAt),
    index("sessions_target_idx").on(table.targetType, table.targetId),
    index("sessions_occurrence_idx")
      .on(table.occurrenceId)
      .where(sql`${table.occurrenceId} IS NOT NULL`),
    check(
      "sessions_plan_sanction_check",
      sql`${table.planSanction} IS NULL OR ${table.planSanction} IN ('directive','alternative','day_plan_block','continuation','free')`
    )
  ]
);

export const sessionSegments = pgTable(
  "session_segments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    /**
     * Which deliverable action this stretch of time belongs to. One session spans several actions, and
     * the total is derived by summing these segments — there is never a second timer accumulating in
     * parallel, because two independent timers is how the same minute gets counted twice. Points at
     * `actions.id` since a deliverable's steps moved into that table; the column keeps its
     * name because nothing about a session's own shape moved.
     */
    stepId: uuid("step_id").references(() => actions.id, { onDelete: "set null" }),
    interruptionNote: text("interruption_note"),
    /**
     * The time the owner's device claimed for this segment's start and end (`occurredAt` on the command that made
     * it), always kept beside `started_at` / `ended_at`, which hold the time the server used. Null when the command
     * carried none. The note says why the claim was not used (the reply said the same); null when it was used.
     */
    startOccurredAt: timestamp("start_occurred_at", { withTimezone: true }),
    startOccurredNote: text("start_occurred_note"),
    endOccurredAt: timestamp("end_occurred_at", { withTimezone: true }),
    endOccurredNote: text("end_occurred_note")
  },
  (table) => [
    check("session_segments_time_check", sql`${table.endedAt} is null or ${table.endedAt} > ${table.startedAt}`),
    uniqueIndex("session_segments_one_open_per_session")
      .on(table.sessionId)
      .where(sql`${table.endedAt} is null`),
    index("session_segments_session_time_idx").on(table.sessionId, table.startedAt)
  ]
);

/**
 * One row per time a cadence (cadence) action was done. The rule's "last done" and count
 * are read from here rather than denormalised onto the rule, so there is one source of truth. A
 * cycle is done at most once per local day: a second record that day is a no-op, not a second cycle.
 */
export const actionCadenceCompletions = pgTable(
  "action_cadence_completions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actionId: uuid("action_id")
      .notNull()
      .references(() => actions.id, { onDelete: "cascade" }),
    ruleId: uuid("rule_id")
      .notNull()
      .references(() => actionRecurrenceRules.id, { onDelete: "cascade" }),
    completedAt: timestamp("completed_at", { withTimezone: true }).notNull(),
    localDate: date("local_date").notNull(),
    minutes: integer("minutes").notNull().default(0),
    sessionId: uuid("session_id").references(() => sessions.id, { onDelete: "set null" }),
    source: text("source").notNull().default("session"),
    ...timestamps
  },
  (table) => [
    check("action_cadence_completion_source_check", sql`${table.source} IN ('session','manual')`),
    check("action_cadence_completion_minutes_check", sql`${table.minutes} >= 0`),
    uniqueIndex("action_cadence_completion_rule_date_unique").on(table.ruleId, table.localDate),
    index("action_cadence_completion_action_date_idx").on(table.actionId, table.localDate)
  ]
);

export const forecastSnapshots = pgTable(
  "forecast_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    calculatedAt: timestamp("calculated_at", { withTimezone: true }).notNull().defaultNow(),
    inputVersion: text("input_version").notNull(),
    protectedRemainingMinutes: integer("protected_remaining_minutes"),
    pessimisticRemainingMinutes: integer("pessimistic_remaining_minutes"),
    compatibleCapacityMinutes: integer("compatible_capacity_minutes"),
    grossCompatibleCapacityMinutes: integer("gross_compatible_capacity_minutes"),
    reservedByEarlierDeadlinesMinutes: integer("reserved_by_earlier_deadlines_minutes"),
    requiredPaceMinutesPerWeek: integer("required_pace_minutes_per_week"),
    forecastBand: text("forecast_band"),
    forecastConfidence: text("forecast_confidence"),
    forecastThrough: timestamp("forecast_through", { withTimezone: true }),
    expectedMarginMinutes: integer("expected_margin_minutes"),
    pessimisticMarginMinutes: integer("pessimistic_margin_minutes"),
    scheduleVariance: numeric("schedule_variance", { precision: 6, scale: 5 }),
    health: projectHealth("health").notNull(),
    explanation: jsonb("explanation").notNull().default({})
  },
  (table) => [index("forecast_project_calculated_idx").on(table.projectId, table.calculatedAt)]
);

export const recommendations = pgTable(
  "recommendations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    calculatedAt: timestamp("calculated_at", { withTimezone: true }).notNull().defaultNow(),
    validUntil: timestamp("valid_until", { withTimezone: true }),
    inputVersion: text("input_version").notNull(),
    kind: text("kind").notNull(),
    primaryActionId: uuid("primary_action_id").references(() => actions.id),
    primaryOccurrenceId: text("primary_occurrence_id").references(() => actionOccurrences.id),
    targetType: text("target_type").notNull().default("action"),
    targetId: text("target_id"),
    executionOptionId: text("execution_option_id"),
    plannedMinutes: integer("planned_minutes"),
    plannedEndAt: timestamp("planned_end_at", { withTimezone: true }),
    headline: text("headline").notNull(),
    explanation: text("explanation").notNull(),
    reasonData: jsonb("reason_data").notNull().default({}),
    supersededAt: timestamp("superseded_at", { withTimezone: true })
  },
  (table) => [
    uniqueIndex("recommendations_current_user_unique")
      .on(table.userId)
      .where(sql`${table.supersededAt} is null`),
    // Retention ranks superseded rows per user by age; without this it reads the whole table.
    index("recommendations_user_calculated_idx").on(table.userId, table.calculatedAt)
  ]
);

export const planningRuns = pgTable(
  "planning_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    requestId: uuid("request_id").notNull().unique(),
    inputVersion: text("input_version").notNull(),
    contractVersion: text("contract_version").notNull(),
    engineVersion: text("engine_version").notNull(),
    calculatedAt: timestamp("calculated_at", { withTimezone: true }).notNull(),
    validUntil: timestamp("valid_until", { withTimezone: true }).notNull(),
    result: jsonb("result").notNull(),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("planning_runs_current_user_unique")
      .on(table.userId)
      .where(sql`${table.supersededAt} is null`),
    index("planning_runs_user_calculated_idx").on(table.userId, table.calculatedAt)
  ]
);

export const recommendationCandidates = pgTable(
  "recommendation_candidates",
  {
    recommendationId: uuid("recommendation_id")
      .notNull()
      .references(() => recommendations.id, { onDelete: "cascade" }),
    actionId: uuid("action_id").references(() => actions.id),
    occurrenceId: text("occurrence_id").references(() => actionOccurrences.id),
    targetType: text("target_type").notNull().default("action"),
    targetId: text("target_id").notNull(),
    executionOptionId: text("execution_option_id"),
    rank: smallint("rank").notNull(),
    totalScore: numeric("total_score", { precision: 8, scale: 3 }).notNull(),
    scoreComponents: jsonb("score_components").notNull(),
    eligible: boolean("eligible").notNull(),
    exclusionReasons: jsonb("exclusion_reasons").notNull().default([]),
    recommendedMinutes: integer("recommended_minutes")
  },
  (table) => [
    uniqueIndex("recommendation_candidate_identity_unique").on(
      table.recommendationId,
      table.targetType,
      table.targetId,
      table.executionOptionId
    ),
    index("recommendation_candidates_rank_idx").on(table.recommendationId, table.rank)
  ]
);

/**
 * The write ledger: one row per command. `id` is the command id (the idempotency key a retry replays by), so a
 * header is kept for good. `actor` is null for a person, `system` for a background writer, else the agent's name.
 * `response` is the replay answer of a command that has one (catch-up settle). `kind`, `images` and `state` are the
 * undo columns (`portal/server/persistence/postgres/write-snapshot.ts`): `images` is the `SnapshotRow[]` an agent's
 * session, check-in, catch-up or confirm write touched, before and after; `state` flips between `applied` and
 * `undone`; the newest 500 per user keep their images, older writes get `images` and `state` null. Operational, not
 * authored: left out of the backup like the tables it replaces.
 */
export const writes = pgTable(
  "writes",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    commandType: text("command_type").notNull(),
    // SHA-256 of the command's canonical payload, so a reused command id with a different write is refused (409) instead of replayed. Null on rows from before it was kept.
    requestHash: text("request_hash"),
    actor: text("actor"),
    response: jsonb("response").notNull().default({}),
    kind: text("kind"),
    images: jsonb("images"),
    state: text("state"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("writes_user_created_idx").on(table.userId, table.createdAt),
    index("writes_user_actor_created_idx").on(table.userId, table.actor, table.createdAt.desc()),
    // The 500-image cap (write-snapshot.ts) walks only the writes that still hold images, not the whole history.
    index("writes_user_images_idx")
      .on(table.userId, table.createdAt.desc(), table.id.desc())
      .where(sql`${table.images} IS NOT NULL`),
    check("writes_state_check", sql`${table.state} IN ('applied', 'undone')`)
  ]
);

/** The per-entity change feed: one row per entity a write changed. */
export const writeRows = pgTable(
  "write_rows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    writeId: uuid("write_id")
      .notNull()
      .references(() => writes.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    operation: text("operation").notNull(),
    evidence: jsonb("evidence").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("write_rows_user_created_idx").on(table.userId, table.createdAt, table.id),
    index("write_rows_write_idx").on(table.writeId)
  ]
);

/**
 * A write an agent proposed, waiting for the person. `kind`
 * names the applier that replays `payload` on confirmation; `target_versions` is each touched entity's
 * version when the agent proposed, so a later edit makes the proposal `stale` instead of overwritten.
 * A pending row older than 14 days is marked `expired` when next read.
 */
export const agentProposals = pgTable(
  "agent_proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    /** The proposing agent's name, as `writes.actor` records it. */
    agent: text("agent").notNull(),
    kind: text("kind").notNull(),
    /** One human-readable line, at most 300 characters. */
    summary: text("summary").notNull(),
    /** The exact command the applier replays. */
    payload: jsonb("payload").notNull(),
    /** sha256 hex of the canonical JSON of `payload`; an identical pending proposal is not stored twice. */
    payloadHash: text("payload_hash").notNull(),
    basis: text("basis").notNull(),
    evidence: text("evidence"),
    targetVersions: jsonb("target_versions").notNull().default({}),
    status: text("status").notNull().default("pending"),
    /** Pending proposals from one agent with the same key merge into one row; `revision` counts the merges. */
    coalesceKey: text("coalesce_key"),
    revision: integer("revision").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: text("resolved_by"),
    resolutionNote: text("resolution_note"),
    /** True for a write a token agent's `directWrites: shadow` setting held back: it would have applied directly. */
    shadow: boolean("shadow").notNull().default(false)
  },
  (table) => [
    check("agent_proposals_basis_check", sql`${table.basis} IN ('stated','inferred','observed')`),
    check("agent_proposals_status_check", sql`${table.status} IN ('pending','confirmed','rejected','expired','stale')`),
    check("agent_proposals_summary_check", sql`char_length(${table.summary}) BETWEEN 1 AND 300`),
    check("agent_proposals_evidence_check", sql`${table.evidence} IS NULL OR char_length(${table.evidence}) <= 300`),
    index("agent_proposals_user_status_created_idx").on(table.userId, table.status, table.createdAt),
    // What makes "one pending proposal per agent and key" hold under a race, not just under normal timing.
    uniqueIndex("agent_proposals_pending_coalesce_idx")
      .on(table.userId, table.agent, table.coalesceKey)
      .where(sql`${table.status} = 'pending' AND ${table.coalesceKey} IS NOT NULL`)
  ]
);

/**
 * A scoped agent token. Only `sha256(token)` is stored; the token
 * itself is shown once at creation. `scopes` is the vocabulary of `agent-scopes.ts`; `direct_writes` maps an
 * entity class to `off` | `shadow` | `on` (absent means `off`). A name is unique per user among live tokens,
 * so a rotation can issue the new token before revoking the old one. A regenerable table: a restore revokes
 * every agent (see `REGENERABLE_TABLES`).
 */
export const agentTokens = pgTable(
  "agent_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    /** The agent name the token acts as; the same shape as `writes.actor`. */
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    scopes: jsonb("scopes").notNull().default([]),
    directWrites: jsonb("direct_writes").notNull().default({}),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true })
  },
  (table) => [
    check("agent_tokens_hash_check", sql`${table.tokenHash} ~ '^[0-9a-f]{64}$'`),
    check("agent_tokens_name_check", sql`${table.name} ~ '^[a-z0-9_-]{1,32}$'`),
    uniqueIndex("agent_tokens_hash_idx").on(table.tokenHash),
    uniqueIndex("agent_tokens_live_name_idx")
      .on(table.userId, table.name)
      .where(sql`${table.revokedAt} IS NULL`)
  ]
);

/**
 * The owner's credentials (the design notes, decision D2): an owner token for the
 * CLI and scripts, and one session per enrolled browser. Only `sha256(secret)` is stored. A browser session
 * slides: `expires_at` moves out to 30 days from last use. A regenerable table: a restore signs every
 * credential out, which is why `OWNER_RECOVERY_TOKEN` exists.
 */
export const ownerCredentials = pgTable(
  "owner_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    kind: text("kind").notNull(),
    label: text("label").notNull(),
    secretHash: text("secret_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    /** Null for an owner token, which lives until revoked. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    /** A device credential's install id (lowercase, kept by the app); null for a credential made by hand. */
    deviceInstallId: text("device_install_id"),
    /** What kind of device a device credential is (a short lowercase word the app declares). */
    platform: text("platform"),
    /** A limited credential is refused the routes in the `owner-admin` class (`agent-routes.ts`). */
    limited: boolean("limited").notNull().default(false),
    /** A web-view session's device credential: it is revoked with it, and does not count toward the browser cap. */
    parentCredentialId: uuid("parent_credential_id").references((): AnyPgColumn => ownerCredentials.id),
    /** The address of the last request that used it (the proxy's connecting address), beside `last_used_at`. */
    lastUsedFrom: text("last_used_from")
  },
  (table) => [
    check("owner_credentials_kind_check", sql`${table.kind} IN ('token','browser')`),
    check("owner_credentials_hash_check", sql`${table.secretHash} ~ '^[0-9a-f]{64}$'`),
    check("owner_credentials_label_check", sql`char_length(${table.label}) BETWEEN 1 AND 60`),
    check(
      "owner_credentials_device_check",
      sql`${table.deviceInstallId} IS NULL OR (${table.deviceInstallId} ~ '^[a-z0-9][a-z0-9_-]{7,63}$' AND ${table.platform} ~ '^[a-z0-9_-]{1,16}$')`
    ),
    uniqueIndex("owner_credentials_hash_idx").on(table.secretHash),
    index("owner_credentials_parent_idx").on(table.parentCredentialId),
    uniqueIndex("owner_credentials_live_child_idx")
      .on(table.parentCredentialId)
      .where(sql`${table.parentCredentialId} IS NOT NULL AND ${table.revokedAt} IS NULL`)
  ]
);

/**
 * A pending or finished device pairing: a QR grant the signed-in owner made (`flow='pairing'`, approved from the
 * start) or a device code a phone asked for (`flow='code'`, approved when the owner types the code). Only
 * `sha256(secret)` is stored, for the pairing secret or device code (`secret_hash`) and for the typed code
 * (`user_code_hash`). The credential is minted when the device redeems or polls, so its secret is never held.
 * A regenerable table: ten minutes of life, and a restore signs every credential out anyway.
 */
export const ownerDevicePairings = pgTable(
  "owner_device_pairings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    flow: text("flow").notNull(),
    status: text("status").notNull().default("pending"),
    secretHash: text("secret_hash").notNull(),
    userCodeHash: text("user_code_hash"),
    name: text("name"),
    installId: text("install_id"),
    platform: text("platform"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    redeemedAt: timestamp("redeemed_at", { withTimezone: true }),
    lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
    pollIntervalSeconds: integer("poll_interval_seconds").notNull().default(5),
    createdByCredentialId: uuid("created_by_credential_id").references(() => ownerCredentials.id, {
      onDelete: "set null"
    }),
    credentialId: uuid("credential_id").references(() => ownerCredentials.id, { onDelete: "set null" }),
    createdFrom: text("created_from")
  },
  (table) => [
    check("owner_device_pairings_flow_check", sql`${table.flow} IN ('pairing','code')`),
    check("owner_device_pairings_status_check", sql`${table.status} IN ('pending','approved','denied','redeemed')`),
    check("owner_device_pairings_hash_check", sql`${table.secretHash} ~ '^[0-9a-f]{64}$'`),
    uniqueIndex("owner_device_pairings_secret_idx").on(table.secretHash),
    uniqueIndex("owner_device_pairings_user_code_idx")
      .on(table.userCodeHash)
      .where(sql`${table.userCodeHash} IS NOT NULL AND ${table.status} = 'pending'`),
    index("owner_device_pairings_user_time_idx").on(table.userId, table.createdAt)
  ]
);

/**
 * Who paired, redeemed and revoked what, shown on the Devices page. Not a plan input (`/api/changes` is). No secret
 * or hash is ever stored here. `credential_id` is cleared if the credential row is removed, and the label and
 * install id stay so the line still reads. A regenerable table: a restore signs every credential out.
 */
export const ownerCredentialEvents = pgTable(
  "owner_credential_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    event: text("event").notNull(),
    credentialId: uuid("credential_id").references(() => ownerCredentials.id, { onDelete: "set null" }),
    actorCredentialId: uuid("actor_credential_id").references(() => ownerCredentials.id, { onDelete: "set null" }),
    label: text("label"),
    deviceInstallId: text("device_install_id"),
    platform: text("platform"),
    address: text("address")
  },
  (table) => [
    check(
      "owner_credential_events_event_check",
      sql`${table.event} IN ('pairing_started','code_started','code_approved','code_denied','redeemed','revoked')`
    ),
    index("owner_credential_events_user_time_idx").on(table.userId, table.occurredAt.desc())
  ]
);

/**
 * A short-lived access token issued at `POST /oauth/token` for one agent token and one resource. Only `sha256(access token)` is stored; `scopes` is the subset the client asked
 * for, never more than the agent token holds. Revoking or expiring the agent token ends its access tokens at once
 * (they are checked against it on every request). A regenerable table: a restore revokes every agent token anyway.
 */
export const agentAccessTokens = pgTable(
  "agent_access_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    agentTokenId: uuid("agent_token_id")
      .notNull()
      .references(() => agentTokens.id),
    tokenHash: text("token_hash").notNull(),
    /** The canonical `/mcp` URL the token was issued for (RFC 8707); the resource server accepts nothing else. */
    resource: text("resource").notNull(),
    scopes: jsonb("scopes").notNull().default([]),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    check("agent_access_tokens_hash_check", sql`${table.tokenHash} ~ '^[0-9a-f]{64}$'`),
    uniqueIndex("agent_access_tokens_hash_idx").on(table.tokenHash),
    index("agent_access_tokens_agent_idx").on(table.agentTokenId)
  ]
);

/**
 * A public OAuth client registered at `POST /oauth/register` (RFC 7591; the design notes).
 * No secret: clients use PKCE. Capped at `MAX_OAUTH_CLIENTS`; a client past the cap with no live grant is evicted.
 * Excluded from backups with the other agent credential tables.
 */
export const oauthClients = pgTable(
  "oauth_clients",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    clientId: text("client_id").notNull(),
    clientName: text("client_name").notNull(),
    redirectUris: jsonb("redirect_uris").notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Registration order: `created_at` ties within a millisecond, so eviction of the oldest orders by this. */
    seq: bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity().notNull()
  },
  (table) => [uniqueIndex("oauth_clients_client_id_idx").on(table.clientId)]
);

/**
 * A single-use authorization code (120 s). Only `sha256(code)` is stored. `client_id` is the public client id (no
 * foreign key, so evicting a client never fails on old rows); `agent_token_id` is the agent token the owner's
 * approval created. `consumed_at` is set by the first exchange; a second one revokes the agent token.
 */
export const oauthAuthorizationCodes = pgTable(
  "oauth_authorization_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    codeHash: text("code_hash").notNull(),
    clientId: text("client_id").notNull(),
    agentTokenId: uuid("agent_token_id")
      .notNull()
      .references(() => agentTokens.id),
    redirectUri: text("redirect_uri").notNull(),
    codeChallenge: text("code_challenge").notNull(),
    resource: text("resource").notNull(),
    scopes: jsonb("scopes").notNull().default([]),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    check("oauth_authorization_codes_hash_check", sql`${table.codeHash} ~ '^[0-9a-f]{64}$'`),
    uniqueIndex("oauth_authorization_codes_hash_idx").on(table.codeHash),
    index("oauth_authorization_codes_agent_idx").on(table.agentTokenId)
  ]
);

/** A rotating refresh token (30 days, never past its agent token). Only `sha256(token)` is stored; `used_at` marks rotation. */
export const oauthRefreshTokens = pgTable(
  "oauth_refresh_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    tokenHash: text("token_hash").notNull(),
    clientId: text("client_id").notNull(),
    agentTokenId: uuid("agent_token_id")
      .notNull()
      .references(() => agentTokens.id),
    resource: text("resource").notNull(),
    scopes: jsonb("scopes").notNull().default([]),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    check("oauth_refresh_tokens_hash_check", sql`${table.tokenHash} ~ '^[0-9a-f]{64}$'`),
    uniqueIndex("oauth_refresh_tokens_hash_idx").on(table.tokenHash),
    index("oauth_refresh_tokens_agent_idx").on(table.agentTokenId)
  ]
);

/**
 * Agent time: one row per stretch an agent worked. `source` `calls` rows are kept by
 * the portal from an agent's own requests (a new row after 30 idle minutes; `touched` counts route templates,
 * never bodies); `reported` rows are posted by a client under its own `external_id`, unique per agent so a repost
 * replaces the record. Information only: no engine code reads this table.
 */
export const agentSessions = pgTable(
  "agent_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    agent: text("agent").notNull(),
    source: text("source").notNull(),
    externalId: text("external_id"),
    kind: text("kind").notNull().default("work"),
    title: text("title"),
    summary: text("summary"),
    topics: jsonb("topics").notNull().default([]),
    turnCount: integer("turn_count"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }).notNull(),
    requestCount: integer("request_count").notNull().default(0),
    writeCount: integer("write_count").notNull().default(0),
    touched: jsonb("touched").notNull().default({}),
    schemaVersion: integer("schema_version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    check("agent_sessions_agent_check", sql`${table.agent} ~ '^[a-z0-9_-]{1,32}$'`),
    check("agent_sessions_source_check", sql`${table.source} IN ('calls', 'reported')`),
    check("agent_sessions_span_check", sql`${table.endedAt} >= ${table.startedAt}`),
    uniqueIndex("agent_sessions_external_idx")
      .on(table.userId, table.agent, table.externalId)
      .where(sql`${table.externalId} IS NOT NULL`),
    index("agent_sessions_started_idx").on(table.userId, table.startedAt),
    index("agent_sessions_open_idx").on(table.userId, table.agent, table.endedAt)
  ]
);

/**
 * Timing and reachability evidence for calls to third-party providers (OpenAI, Google, the calendar provider),
 * all of which flow through the outbound-proxy sidecar. Not user data and not referenced by anything
 * else, so it carries no `user_id` — a single-tenant deployment has exactly one household using every
 * provider. `kind` distinguishes a call the app made for its own purposes (`real_call`) from one made
 * solely to answer "is this provider reachable right now" (`probe`); `operation` names the call type
 * within a provider (e.g. `geocode` vs `travel_matrix`, `deliverable_chat` vs `extract_contract`) so
 * the Connections page can break down volume by type. `first_byte_ms` is set only for streaming calls
 * (time to first token); non-streaming calls carry only `total_ms`, while a streaming call carries
 * both. `input_tokens`/`output_tokens` hold an LLM call's token usage when the provider's response
 * included it — null for every non-LLM provider and for any LLM call where it was not cheaply
 * available. Recomputable from nothing — it is direct observation — but disposable: see
 * `REGENERABLE_TABLES` for why it is excluded from backups, and `pruneOldProviderTelemetry` for its
 * 7-day retention.
 */
export const providerCallTelemetry = pgTable(
  "provider_call_telemetry",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: text("provider").notNull(),
    operation: text("operation").notNull(),
    kind: text("kind").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    firstByteMs: integer("first_byte_ms"),
    totalMs: integer("total_ms"),
    ok: boolean("ok").notNull(),
    errorSummary: text("error_summary"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens")
  },
  (table) => [
    check("provider_call_telemetry_kind_check", sql`${table.kind} in ('real_call','probe')`),
    index("provider_call_telemetry_provider_started_idx").on(table.provider, table.startedAt)
  ]
);

export const dailyPlans = pgTable(
  "daily_plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    localDate: date("local_date").notNull(),
    horizonOverrideAt: timestamp("horizon_override_at", { withTimezone: true }),
    recoverySkipped: boolean("recovery_skipped").notNull().default(false),
    ...timestamps
  },
  (table) => [uniqueIndex("daily_plans_user_date_unique").on(table.userId, table.localDate)]
);

/**
 * The (up to three) actions a day's plan names as its desired wins, in the order the person chose
 * them. Join rows rather than a jsonb array so deleting an action takes it out of the plan. Like
 * `action_dependencies`, a child table carries no `user_id`: ownership is the daily plan's.
 */
export const dailyPlanDesiredActions = pgTable(
  "daily_plan_desired_actions",
  {
    dailyPlanId: uuid("daily_plan_id")
      .notNull()
      .references(() => dailyPlans.id, { onDelete: "cascade" }),
    actionId: uuid("action_id")
      .notNull()
      .references(() => actions.id, { onDelete: "cascade" }),
    position: integer("position").notNull()
  },
  (table) => [primaryKey({ columns: [table.dailyPlanId, table.actionId] })]
);

/** The actions a day's plan set aside, each with the reason given and in the order they were listed. */
export const dailyPlanDeferredActions = pgTable(
  "daily_plan_deferred_actions",
  {
    dailyPlanId: uuid("daily_plan_id")
      .notNull()
      .references(() => dailyPlans.id, { onDelete: "cascade" }),
    actionId: uuid("action_id")
      .notNull()
      .references(() => actions.id, { onDelete: "cascade" }),
    reason: text("reason").notNull(),
    position: integer("position").notNull()
  },
  (table) => [primaryKey({ columns: [table.dailyPlanId, table.actionId] })]
);

export const planningFocusPeriods = pgTable(
  "planning_focus_periods",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    /** The local date the weekly review was finished for this period; null until it is. */
    reviewedOn: date("reviewed_on"),
    ...timestamps
  },
  (table) => [
    uniqueIndex("planning_focus_user_kind_period_unique").on(table.userId, table.kind, table.periodStart),
    check("planning_focus_kind_check", sql`${table.kind} IN ('weekly','monthly')`),
    check("planning_focus_period_check", sql`${table.periodEnd} >= ${table.periodStart}`)
  ]
);

/** The undated projects a focus period admits into forecasting; deleting a project drops it from the period. */
export const planningFocusProjects = pgTable(
  "planning_focus_projects",
  {
    focusPeriodId: uuid("focus_period_id")
      .notNull()
      .references(() => planningFocusPeriods.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" })
  },
  (table) => [primaryKey({ columns: [table.focusPeriodId, table.projectId] })]
);

export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: text("locked_by"),
    lastErrorCode: text("last_error_code"),
    lastErrorMessage: text("last_error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /**
     * Enqueue order. `created_at` is the enqueuing transaction's wall-clock start, so it can sort a later
     * job before an earlier one (a long caller transaction, a clock correction). "Newer job" questions
     * compare this instead, which only ever moves forward.
     */
    seq: bigserial("seq", { mode: "number" }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    /**
     * How long the attempt that finished this job took, in milliseconds. Finishing clears
     * `locked_at`, so without this the elapsed time of a run is unrecoverable the moment it ends —
     * which is exactly when someone wants to know whether the engine is getting slower.
     */
    durationMs: integer("duration_ms")
  },
  (table) => [
    index("jobs_claim_idx").on(table.status, table.availableAt),
    // The claim index is ordered for the queue, not for age. Retention sweeps by type and age.
    index("jobs_type_created_idx").on(table.type, table.createdAt),
    // The plan-job lookups filter on `payload->>'userId'`; without this every state read detoasts each job's large payload.
    index("jobs_type_user_created_idx").on(table.type, sql`(${table.payload}->>'userId')`, table.createdAt),
    index("jobs_type_user_seq_idx").on(table.type, sql`(${table.payload}->>'userId')`, table.seq)
  ]
);

export const importBatches = pgTable(
  "import_batches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sourceType: text("source_type").notNull(),
    inputKind: text("input_kind").notNull(),
    timezone: text("timezone").notNull(),
    templateVersion: text("template_version").notNull().default("1"),
    status: text("status").notNull().default("draft"),
    sourceText: text("source_text"),
    sourceFilename: text("source_filename"),
    sourceMimeType: text("source_mime_type"),
    contentHash: text("content_hash"),
    sourceFiles: jsonb("source_files").notNull().default([]),
    committedAt: timestamp("committed_at", { withTimezone: true }),
    ...timestamps
  },
  (table) => [
    index("import_batches_user_created_idx").on(table.userId, table.createdAt),
    check("import_batches_status_check", sql`${table.status} IN ('draft','ready','blocked','committed','failed')`),
    // Two uploads of the same file can both pass the "is one already open" lookup before either has
    // committed its insert; this is what turns the loser into a unique violation (caught in
    // `import-store.ts`'s `previewOrReopen`) instead of a silent duplicate open draft. Committed
    // batches are deliberately excluded — re-uploading a file already committed makes a fresh batch.
    uniqueIndex("import_batches_open_content_unique")
      .on(table.userId, table.sourceType, table.contentHash)
      .where(sql`${table.status} IN ('draft','ready','blocked') AND ${table.contentHash} IS NOT NULL`)
  ]
);

export const importRecords = pgTable(
  "import_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => importBatches.id, { onDelete: "cascade" }),
    importKey: text("import_key").notNull(),
    entityType: text("entity_type").notNull(),
    operation: text("operation").notNull(),
    expectedVersion: integer("expected_version"),
    // Text, not uuid: a condition definition is keyed by its own slug (see `conditionDefinitions`), so a
    // record that updates one matches on `home` rather than on a generated identifier.
    matchedEntityId: text("matched_entity_id"),
    fields: jsonb("fields").notNull().default({}),
    relationships: jsonb("relationships").notNull().default({}),
    validationErrors: jsonb("validation_errors").notNull().default([]),
    warnings: jsonb("warnings").notNull().default([]),
    removed: boolean("removed").notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    ...timestamps
  },
  (table) => [
    uniqueIndex("import_records_batch_type_key_unique").on(table.batchId, table.entityType, table.importKey),
    index("import_records_batch_sort_idx").on(table.batchId, table.sortOrder)
  ]
);

export const importEntityKeys = pgTable(
  "import_entity_keys",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    entityType: text("entity_type").notNull(),
    importKey: text("import_key").notNull(),
    entityId: uuid("entity_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.entityType, table.importKey] }),
    // Not unique: a commitment with several sources holds one key per source.
    index("import_entity_keys_entity_idx").on(table.userId, table.entityType, table.entityId)
  ]
);

/**
 * One run of a read-only roster sync (the roster provider today; the shape is provider-agnostic), whether fired by
 * the worker's daily trigger or a "Sync now" from Connections. Kept as its own small audit trail
 * rather than folded into `provider_call_telemetry`: that table is disposable request timing
 * (`REGENERABLE_TABLES`), while a sync run's `summary` — what was created, updated, deleted, held for
 * review — is exactly the kind of thing a person later asks "did last night's sync actually happen,
 * and what did it do", so it is backed up like authored data. The sync itself prunes rows older than
 * 90 days; see the roster sync run.
 */
export const integrationSyncRuns = pgTable(
  "integration_sync_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    trigger: text("trigger").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    status: text("status").notNull(),
    summary: jsonb("summary").notNull().default({}),
    ...timestamps
  },
  (table) => [
    check("integration_sync_runs_trigger_check", sql`${table.trigger} IN ('manual','scheduled')`),
    check(
      "integration_sync_runs_status_check",
      sql`${table.status} IN ('synced','needs_review','failed','not_configured')`
    ),
    index("integration_sync_runs_user_provider_started_idx").on(table.userId, table.provider, table.startedAt)
  ]
);

/**
 * A frozen record of one reported problem: authoritative state, the engine input and output behind
 * the plan on screen, the job queue, and what the Now page was rendering, all at one instant.
 *
 * Planning faults are time-dependent — by the time anyone investigates, the state has moved on and
 * the plan has been recalculated. The columns outside `snapshot` exist only so the list view can be
 * built without parsing every blob; `snapshot` itself is the evidence and is never written twice.
 */
export const issueSnapshots = pgTable(
  "issue_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    description: text("description").notNull(),
    formatVersion: text("format_version").notNull(),
    panelMode: text("panel_mode").notNull(),
    planningStatus: text("planning_status"),
    engineInputVersion: text("engine_input_version"),
    sizeBytes: integer("size_bytes").notNull(),
    snapshot: jsonb("snapshot").notNull(),
    /**
     * When the reported problem was dealt with; null while it is still outstanding. The captured
     * evidence above is never edited — only this verdict about it is, so a closed report still
     * replays exactly as it was reported.
     */
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewNote: text("review_note")
  },
  (table) => [
    index("issue_snapshots_user_captured_idx").on(table.userId, table.capturedAt),
    index("issue_snapshots_outstanding_idx")
      .on(table.userId, table.capturedAt)
      .where(sql`${table.reviewedAt} is null`)
  ]
);

/**
 * The pulse criteria and publish design note ("Recording"): the recorded history of on/off/free/
 * asleep/gap intervals `pulse-recorder.ts` writes, one open (`ended_at IS NULL`) segment per user.
 * History cannot be regenerated, so this is a `BACKUP_TABLES` entry, not `REGENERABLE_TABLES`.
 */
export const pulseSegments = pgTable(
  "pulse_segments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    state: text("state").notNull(),
    reason: text("reason"),
    doingKind: text("doing_kind"),
    doingId: text("doing_id"),
    doingTitle: text("doing_title"),
    expectedKind: text("expected_kind"),
    expectedId: text("expected_id"),
    private: boolean("private").notNull().default(false),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    /** Set when a later confirmation repainted this segment from `off`/`unconfirmed` to `on` — see
        "Back-fill" in the design note. Bounds are unchanged; only `state`/`reason` are rewritten. */
    repaintedAt: timestamp("repainted_at", { withTimezone: true }),
    /** Who made the confirmation behind an `on` segment: the person, their agent, or the schedule
        (`on/scheduled`). Null for every other state and for segments recorded before the state machine. */
    source: text("source"),
    ...timestamps
  },
  (table) => [
    index("pulse_segments_user_started_idx").on(table.userId, table.startedAt),
    uniqueIndex("pulse_segments_one_open_per_user")
      .on(table.userId)
      .where(sql`${table.endedAt} is null`),
    check("pulse_segments_state_check", sql`${table.state} IN ('on','off','free','asleep','gap','unknown')`),
    check(
      "pulse_segments_source_check",
      sql`${table.source} IS NULL OR ${table.source} IN ('person','agent','schedule')`
    )
  ]
);

/**
 * One row per user: the recorder's own bookkeeping (last evaluation, so it can insert a `gap`
 * segment across an outage) and the publisher's delivery state. Fully recomputable from
 * `pulse_segments` and the live plan state, so `REGENERABLE_TABLES`, not backed up.
 */
export const pulseState = pgTable("pulse_state", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  lastEvaluatedAt: timestamp("last_evaluated_at", { withTimezone: true }),
  /** The state machine's memory between ticks (the pulse on plan design note; `advancePulse`). */
  lastContactAt: timestamp("last_contact_at", { withTimezone: true }),
  lastContactSource: text("last_contact_source"),
  lastConfirmedAt: timestamp("last_confirmed_at", { withTimezone: true }),
  confirmedBy: text("confirmed_by"),
  unknownSince: timestamp("unknown_since", { withTimezone: true }),
  /** Unfrozen minutes spent unknown; silence windows do not count. */
  unknownMinutes: doublePrecision("unknown_minutes").notNull().default(0),
  /** Check-in prompts sent and unanswered since `unknownSince`. */
  unansweredPrompts: integer("unanswered_prompts").notNull().default(0),
  /** End of the expected-silence window holding the state, else null. */
  silenceUntil: timestamp("silence_until", { withTimezone: true }),
  /** When the state last moved into `off/lapsed`; set once per lapse, for the "Back on plan?" push. */
  enteredLapsedAt: timestamp("entered_lapsed_at", { withTimezone: true }),
  /** A `reenter` applied but not yet taken up by the recorder (written by `pulse-reentry.ts`). */
  reenteredAt: timestamp("reentered_at", { withTimezone: true }),
  reenteredBy: text("reentered_by"),
  publishSeq: bigint("publish_seq", { mode: "number" }).notNull().default(0),
  lastPublishedHash: text("last_published_hash"),
  lastPublishedAt: timestamp("last_published_at", { withTimezone: true }),
  lastPublishOutcome: text("last_publish_outcome"),
  lastPublishError: text("last_publish_error"),
  ...timestamps
});

/**
 * A recorded disruption (the pulse on plan design note, sections 1 and 2): what he is doing instead of the plan,
 * until when, where, the contexts available and whether it takes all of him. The recorder reads the newest row with
 * `ended_at IS NULL` into the pulse machine's `evidence.disruption`; ending early (an on-track answer, or an explicit
 * end) sets `ended_at`. Short-lived, so `REGENERABLE_TABLES`; write-ledger snapshots (`SNAPSHOT_TABLES`) undo it.
 */
export const pulseDisruptions = pgTable(
  "pulse_disruptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    doing: text("doing").notNull(),
    /** A target he named instead of free text: kind and id, else null. */
    doingKind: text("doing_kind"),
    doingId: text("doing_id"),
    until: timestamp("until", { withTimezone: true }).notNull(),
    locationId: text("location_id").notNull(),
    contexts: jsonb("contexts").notNull(),
    exclusive: boolean("exclusive").notNull(),
    /** `person` or the agent's name's class: who recorded it. */
    recordedBy: text("recorded_by").notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    ...timestamps
  },
  (table) => [
    index("pulse_disruptions_user_open_idx").on(table.userId, table.createdAt),
    // One disruption in force per user: recording replaces it, and a race cannot leave two.
    uniqueIndex("pulse_disruptions_one_open_per_user")
      .on(table.userId)
      .where(sql`${table.endedAt} is null`),
    check("pulse_disruptions_recorded_by_check", sql`${table.recordedBy} IN ('person','agent')`)
  ]
);

/**
 * Plan map. A lightweight node for "the same kind of thing" (maths,
 * meals); items link to a subject instead of to each other. Hand-curated, seeded per user by migration
 * 0100 and by `ensureUser`. Authored data, so `BACKUP_TABLES`.
 */
export const planSubjects = pgTable(
  "plan_subjects",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    id: text("id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status").notNull().default("active"),
    ...timestamps
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.id] }),
    check("plan_subjects_status_check", sql`${table.status} IN ('active','archived')`)
  ]
);

/**
 * A stored sideways link between two plan items, or an item and a subject. Both ends are polymorphic
 * (`from_type`/`from_id`) with no foreign key: the daily sweep deletes a link whose end is gone. A
 * rejected row is kept so the same pair is never proposed again. See `planMapLinkKindSchema` in contracts.
 */
export const planLinks = pgTable(
  "plan_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    fromType: text("from_type").notNull(),
    fromId: text("from_id").notNull(),
    toType: text("to_type").notNull(),
    toId: text("to_id").notNull(),
    kind: text("kind").notNull(),
    weight: real("weight"),
    status: text("status").notNull().default("suggested"),
    proposer: text("proposer").notNull(),
    evidence: jsonb("evidence").notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    lastConfirmedAt: timestamp("last_confirmed_at", { withTimezone: true })
  },
  (table) => [
    uniqueIndex("plan_links_pair_unique").on(
      table.userId,
      table.fromType,
      table.fromId,
      table.toType,
      table.toId,
      table.kind
    ),
    index("plan_links_user_status_idx").on(table.userId, table.status),
    index("plan_links_to_idx").on(table.userId, table.toType, table.toId),
    check("plan_links_status_check", sql`${table.status} IN ('suggested','confirmed','rejected','expired')`),
    check("plan_links_weight_check", sql`${table.weight} IS NULL OR (${table.weight} >= 0 AND ${table.weight} <= 1)`)
  ]
);

/** Something a health check or the reviewer noticed. A dismissed finding is kept so it is not raised again. */
export const planFindings = pgTable(
  "plan_findings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    checkName: text("check_name").notNull(),
    itemIds: jsonb("item_ids").notNull().default([]),
    text: text("text").notNull(),
    evidence: jsonb("evidence").notNull().default([]),
    suggestedChanges: jsonb("suggested_changes").notNull().default([]),
    /** Open questions to answer before the finding is accepted (the shared shape, `openQuestionSchema`). */
    questions: jsonb("questions").notNull().default([]),
    status: text("status").notNull().default("open"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true })
  },
  (table) => [
    index("plan_findings_user_status_idx").on(table.userId, table.status),
    check("plan_findings_status_check", sql`${table.status} IN ('open','accepted','dismissed')`)
  ]
);

/**
 * What an add-on running in `shadow` mode would have done. Pruned after 60 days by the sweep. Carries
 * `user_id` (the design's column list omits it) so the sweep and the user cascade can reach it.
 */
export const planShadowLog = pgTable(
  "plan_shadow_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    runId: text("run_id").notNull(),
    addon: text("addon").notNull(),
    itemType: text("item_type").notNull(),
    itemId: text("item_id").notNull(),
    wouldHave: jsonb("would_have").notNull().default({}),
    reason: text("reason").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [index("plan_shadow_log_user_created_idx").on(table.userId, table.createdAt)]
);

/** Per-add-on mode. An absent row means `off`; only the person sets `on`. */
export const planMapSwitches = pgTable(
  "plan_map_switches",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    addon: text("addon").notNull(),
    mode: text("mode").notNull().default("off"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.addon] }),
    check("plan_map_switches_mode_check", sql`${table.mode} IN ('off','shadow','on')`)
  ]
);

/**
 * A closed catch-up: the window it covered and what it settled. History only;
 * the ledger of unsettled items is derived on read. The latest `closed_at` is where the next window starts.
 */
export const catchUpRuns = pgTable(
  "catch_up_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    windowSince: timestamp("window_since", { withTimezone: true }),
    windowUntil: timestamp("window_until", { withTimezone: true }).notNull(),
    /** The agent that closed it, or null for the person in the portal. */
    closedBy: text("closed_by"),
    counts: jsonb("counts").notNull().default({}),
    closedAt: timestamp("closed_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [index("catch_up_runs_user_closed_idx").on(table.userId, table.closedAt)]
);

/**
 * Photo check-ins. The switch for the whole feature: an absent row, like
 * `off`, receives nothing; `shadow` stores and processes photos without prompting; `on` adds the hourly
 * prompt. Only the person sets it. Authored, so backed up.
 */
export const photoCheckinSettings = pgTable(
  "photo_checkin_settings",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    mode: text("mode").notNull().default("off"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [check("photo_checkin_settings_mode_check", sql`${table.mode} IN ('off','shadow','on')`)]
);

/**
 * One rich check-in: a photo and what the person said about it. Record-only: nothing here feeds the
 * plan, a session, the pulse or a `check_in`'s status. The photo bytes live in the blob store under their
 * SHA-256 (`PHOTO_STORE_DIR`), never in a row; a row holds only the hashes. `description` is the person's
 * own claim, seeded from the transcript and editable; the pipeline's reading is `vlm_description` and
 * never overwrites it. `check_in_id` is optional because a photo can be sent unprompted. Authored, so
 * backed up; the blob folder is backed up beside it.
 */
export const photoCheckins = pgTable(
  "photo_checkin",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    checkInId: uuid("check_in_id").references(() => checkIns.id, { onDelete: "set null" }),
    takenAt: timestamp("taken_at", { withTimezone: true }).notNull(),
    originalHash: text("original_hash").notNull(),
    originalBytes: integer("original_bytes").notNull(),
    originalType: text("original_type").notNull(),
    /** The downscaled copy the pipeline reads (about 400 KB); null until one is made. */
    workingHash: text("working_hash"),
    workingBytes: integer("working_bytes"),
    transcript: text("transcript").notNull().default(""),
    description: text("description").notNull().default(""),
    editedByUser: boolean("edited_by_user").notNull().default(false),
    vlmDescription: text("vlm_description"),
    /** Whether the pipeline's reading agrees with the plan directive; null until processed. Record-only. */
    agreement: text("agreement"),
    pipelineVersion: text("pipeline_version"),
    status: text("status").notNull().default("pending"),
    statusDetail: text("status_detail"),
    ...timestamps
  },
  (table) => [
    index("photo_checkin_user_taken_idx").on(table.userId, table.takenAt),
    uniqueIndex("photo_checkin_user_original_unique").on(table.userId, table.originalHash),
    check("photo_checkin_status_check", sql`${table.status} IN ('pending','processed','failed')`),
    check(
      "photo_checkin_agreement_check",
      sql`${table.agreement} IS NULL OR ${table.agreement} IN ('agrees','disagrees','unclear')`
    )
  ]
);

/** One pipeline stage's raw output for one photo, kept for audit. A rerun after a model change is a new row. */
export const photoCheckinStages = pgTable(
  "photo_checkin_stage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    photoCheckinId: uuid("photo_checkin_id")
      .notNull()
      .references(() => photoCheckins.id, { onDelete: "cascade" }),
    stage: text("stage").notNull(),
    model: text("model"),
    modelVersion: text("model_version"),
    output: jsonb("output").notNull().default({}),
    durationMs: integer("duration_ms"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [index("photo_checkin_stage_photo_idx").on(table.photoCheckinId)]
);

/**
 * A labelled reference photo of a place, taken when the place is created (design note answers from the owner).
 * `place_id` is the saved place's `condition_definition` id, kept as text because places have no table of
 * their own. The embedding is filled by the image-embedding stage once one is chosen.
 */
export const placeReferencePhotos = pgTable(
  "place_reference_photo",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    placeId: text("place_id").notNull(),
    label: text("label").notNull(),
    blobHash: text("blob_hash").notNull(),
    blobBytes: integer("blob_bytes").notNull(),
    blobType: text("blob_type").notNull(),
    embedding: jsonb("embedding"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [index("place_reference_photo_user_place_idx").on(table.userId, table.placeId)]
);

/**
 * A labelled block of days for the History calendar: a trip, a sick spell.
 * Calendar-only: nothing in planning, estimates or the engine reads it. `window` is an optional clock
 * window (`localStartTime`/`localEndTime`) repeated on every day; null means the whole days. The project
 * link is a label for the calendar and nulls out if the project is ever deleted. Authored, so backed up.
 */
export const spans = pgTable(
  "spans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    startDate: date("start_date").notNull(),
    endDate: date("end_date").notNull(),
    window: jsonb("window"),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    ...timestamps
  },
  (table) => [
    check("spans_date_order_check", sql`${table.endDate} >= ${table.startDate}`),
    index("spans_user_dates_idx").on(table.userId, table.startDate, table.endDate)
  ]
);

/**
 * One uploaded Google Takeout watch-history file, kept so the import can be undone (watch-history design).
 * `event_count` is the number of rows the import actually added, so a repeat upload that adds nothing shows 0.
 * Authored data (the person's own history): backed up, and listed before `watch_events` for the foreign key.
 */
export const watchImports = pgTable(
  "watch_imports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    filename: text("filename").notNull(),
    source: text("source").notNull().default("youtube_takeout"),
    eventCount: integer("event_count").notNull().default(0),
    importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [index("watch_imports_user_idx").on(table.userId, table.importedAt)]
);

/**
 * A single watch (or ad, or post) from a Takeout file. Raw events only: minutes are computed at display
 * time. Deliberately NOT in `PLAN_INPUT_TABLES`, so the engine never sees it and a write queues no recalc.
 * `video_id` is never null: a removed video gets a synthetic `x:<hash>` of its URL and title. `dup_index`
 * counts same-second repeats of one video inside one file, so re-importing is idempotent while two real
 * same-second watches both survive.
 */
export const watchEvents = pgTable(
  "watch_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    importId: uuid("import_id")
      .notNull()
      .references(() => watchImports.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    kind: text("kind").notNull(),
    videoId: text("video_id").notNull(),
    watchedAt: timestamp("watched_at", { withTimezone: true }).notNull(),
    dupIndex: integer("dup_index").notNull().default(0),
    title: text("title"),
    channel: text("channel")
  },
  (table) => [
    check("watch_events_source_check", sql`${table.source} IN ('youtube_takeout','youtube_music_takeout')`),
    check("watch_events_kind_check", sql`${table.kind} IN ('watch','ad','post')`),
    uniqueIndex("watch_events_unique_idx").on(
      table.userId,
      table.source,
      table.videoId,
      table.watchedAt,
      table.dupIndex
    ),
    index("watch_events_user_time_idx").on(table.userId, table.watchedAt),
    index("watch_events_import_idx").on(table.importId)
  ]
);

/**
 * One file (or other bulk load) held in the activity store, kept so the load can be undone and a file already held can
 * be recognised by its sha256 (activity-store design). Created by the first batch of an import. `(user_id, sha256)` is
 * unique so two concurrent first batches of one file resolve to a single row. Authored data: backed up, and listed
 * before `activity_events` for the foreign key. Never a plan input.
 */
export const activityImports = pgTable(
  "activity_imports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    filename: text("filename").notNull(),
    sha256: text("sha256").notNull(),
    eventCount: integer("event_count").notNull().default(0),
    importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("activity_imports_user_sha_idx").on(table.userId, table.sha256),
    index("activity_imports_user_idx").on(table.userId, table.importedAt)
  ]
);

/**
 * The append-only activity store: every non-plan data source (desktop activity, browser history, plays, messages,
 * sleep, weather) lands here. `source` and `kind` are validated in code against a registry, not by CHECK, so a new
 * source needs no migration. Rows are never updated (a trigger in migration 0148 rejects UPDATE); the store deletes
 * only for undo-import, purge-by-source and the retention purge. `content` is stored only when the source's content
 * gate is on. `(user_id, source, event_key)` is the idempotency key. Deliberately NOT in `PLAN_INPUT_TABLES`: the
 * engine never sees it and a write queues no recalculation.
 */
export const activityEvents = pgTable(
  "activity_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    kind: text("kind").notNull(),
    eventKey: text("event_key").notNull(),
    device: text("device"),
    tsStart: timestamp("ts_start", { withTimezone: true }).notNull(),
    tsEnd: timestamp("ts_end", { withTimezone: true }),
    /** Minutes east of UTC at the event; null when the source does not carry it. */
    tzOffsetMin: smallint("tz_offset_min"),
    /** True for a value derived rather than observed (a Steam playtime delta). */
    approximate: boolean("approximate").notNull().default(false),
    attrs: jsonb("attrs")
      .notNull()
      .default(sql`'{}'::jsonb`),
    content: text("content"),
    importId: uuid("import_id").references(() => activityImports.id, { onDelete: "cascade" }),
    /** The name of the agent token that posted the row; null for rows the portal wrote itself. */
    ingestedVia: text("ingested_via"),
    ingestedAt: timestamp("ingested_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    check("activity_events_time_order_check", sql`${table.tsEnd} IS NULL OR ${table.tsEnd} >= ${table.tsStart}`),
    uniqueIndex("activity_events_key_idx").on(table.userId, table.source, table.eventKey),
    index("activity_events_user_source_time_idx").on(table.userId, table.source, table.tsStart),
    index("activity_events_import_idx").on(table.importId),
    // The derived-reader runner scans a source by when we learned of a row, and the `as_of` reader filters on it.
    index("activity_events_user_source_ingested_idx").on(table.userId, table.source, table.ingestedAt),
    // Reply state is read at query time: a later from_self event with the same attrs.thread_id.
    index("activity_events_thread_idx")
      .on(table.userId, table.source, sql`(${table.attrs}->>'thread_id')`, table.tsStart)
      .where(sql`${table.attrs} ? 'thread_id'`),
    // Fact reads look a fact up by its id across reruns. Partial on `kind = 'fact'`: a plain expression index would
    // carry a NULL entry for every raw mail row (millions).
    index("activity_events_fact_id_idx")
      .on(table.userId, sql`(${table.attrs}->>'fact_id')`)
      .where(sql`${table.kind} = 'fact'`),
    // Derived reads and the daily re-offer scan only derived sources; the predicate keeps raw rows out of the index.
    index("activity_events_derived_idx")
      .on(table.userId, table.source, table.kind)
      .where(sql`${table.source} IN ('derived', 'derived-shadow')`),
    // Supersession finds a message's other copies by its normalised id. The function (migration 0156) does what
    // `normaliseMessageId` does, because raw mail ids are stored as the source sent them. Partial, so only rows that
    // carry an id are indexed.
    index("activity_events_message_id_idx")
      .on(table.userId, sql`(normalise_message_id(${table.attrs}->>'message_id'))`)
      .where(sql`${table.kind} = 'message' AND ${table.attrs} ? 'message_id'`)
  ]
);

/**
 * Per-source settings for the activity store: the content gate, retention, how often the owner expects the source to send,
 * and a live poller's resume point. An
 * absent row means the defaults (content off, kept permanently). The settings are authored, so the table is backed
 * up; the cursor rides along harmlessly.
 */
export const activitySourceState = pgTable(
  "activity_source_state",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    contentEnabled: boolean("content_enabled").notNull().default(false),
    retentionDays: integer("retention_days"),
    /** How often the owner expects the source to send, in minutes; null while the source learns its own rhythm. */
    expectedEveryMinutes: integer("expected_every_minutes"),
    cursor: jsonb("cursor"),
    lastOkAt: timestamp("last_ok_at", { withTimezone: true }),
    lastError: text("last_error")
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.source] }),
    check("activity_source_state_retention_check", sql`${table.retentionDays} IS NULL OR ${table.retentionDays} >= 1`),
    check(
      "activity_source_state_expected_check",
      sql`${table.expectedEveryMinutes} IS NULL OR ${table.expectedEveryMinutes} BETWEEN 5 AND 129600`
    )
  ]
);

/**
 * Which copy of one message a text reader sees (supersession). An import row that holds the text (`by_id`) stands in for
 * a thinner copy of the same message in another source (`superseded_id`, no text); the thin row stays in the store, is
 * still read by the derived pipeline and is never re-pointed, so nothing derived from it is lost. A side table, not a
 * column on `activity_events`, so the append-only trigger of 0148 stays untouched. `superseded_id` is the key: a row has
 * at most one superseder. Both foreign keys cascade, so undo-import, purge by source and the retention purge of either
 * side remove the link and the other row is visible again. `user_id` is carried so a per-user delete and the isolation
 * tests need no join; that both rows are this person's is enforced by the one insert that writes it (`INSERT ... SELECT`
 * with `user_id` checked on both rows) and by a restore check, not by the database. `created_at` is the later of the two
 * rows' `ingested_at`, so an `as_of` read never hides both copies. Append-only (a trigger rejects UPDATE). Never a plan input.
 */
export const activitySupersessions = pgTable(
  "activity_supersessions",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    supersededId: uuid("superseded_id")
      .primaryKey()
      .references(() => activityEvents.id, { onDelete: "cascade" }),
    byId: uuid("by_id")
      .notNull()
      .references(() => activityEvents.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    check("activity_supersessions_distinct_check", sql`${table.supersededId} <> ${table.byId}`),
    index("activity_supersessions_by_idx").on(table.byId)
  ]
);

/**
 * Which source rows a derived row (`source = 'derived'` or `'derived-shadow'`) was read from. A derived row is a
 * projection of its sources, so it goes when its last source goes: every source-delete path runs
 * `deleteDerivedForSources` first, in the same transaction (the cascade here removes only the lineage rows).
 * `user_id` is carried so a per-user delete and the isolation tests need no join. Never a plan input.
 */
export const derivedLineage = pgTable(
  "derived_lineage",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    derivedId: uuid("derived_id")
      .notNull()
      .references(() => activityEvents.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => activityEvents.id, { onDelete: "cascade" })
  },
  (table) => [
    primaryKey({ columns: [table.derivedId, table.sourceId] }),
    index("derived_lineage_source_idx").on(table.sourceId)
  ]
);

/**
 * Per-extractor progress for the derived readers: where a version of an extractor has scanned to, when it last
 * succeeded, its last error, and which version is the promoted one. `active` is a promotion record (one active
 * version per extractor, enforced by the partial unique index), not a user setting. Separate from
 * `activity_source_state`, whose cursor columns stay for pollers: an extractor and a source are different keys.
 */
export const extractorState = pgTable(
  "extractor_state",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    extractor: text("extractor").notNull(),
    version: text("version").notNull(),
    cursor: jsonb("cursor"),
    lastOkAt: timestamp("last_ok_at", { withTimezone: true }),
    lastError: text("last_error"),
    active: boolean("active").notNull().default(false)
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.extractor, table.version] }),
    uniqueIndex("extractor_state_one_active_idx")
      .on(table.userId, table.extractor)
      .where(sql`${table.active}`)
  ]
);

/**
 * Mail understanding settings (one row per person; an absent row means the defaults). Where the local model runs
 * (`ollama_url`, an http(s) URL with no credentials), which models the NEXT extractor version is pinned to, the
 * hosted tier's daily caps and how far back the model tier backfills. A data-flow setting, so the routes are the
 * owner's only (`OWNER_ROUTES`). The hosted API key is not here: it is a sealed secret in `app_secrets`. Never a plan
 * input. Authored, so backed up.
 */
export const derivedSettings = pgTable(
  "derived_settings",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    ollamaUrl: text("ollama_url"),
    t2Model: text("t2_model"),
    t3Model: text("t3_model"),
    t3DailyMessageCap: integer("t3_daily_message_cap").notNull().default(50),
    t3DailyTokenCap: integer("t3_daily_token_cap").notNull().default(200_000),
    backfillDays: integer("backfill_days").notNull().default(90),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    check("derived_settings_t3_message_cap_check", sql`${table.t3DailyMessageCap} BETWEEN 0 AND 10000`),
    check("derived_settings_t3_token_cap_check", sql`${table.t3DailyTokenCap} BETWEEN 0 AND 100000000`),
    check("derived_settings_backfill_days_check", sql`${table.backfillDays} BETWEEN 1 AND 3650`),
    check("derived_settings_ollama_url_check", sql`length(${table.ollamaUrl}) <= 2048`),
    check("derived_settings_t2_model_check", sql`length(${table.t2Model}) <= 200`),
    check("derived_settings_t3_model_check", sql`length(${table.t3Model}) <= 200`)
  ]
);

/**
 * The audit of every model send from the derived layer: which message (its event key, never its content), when, which
 * tier and model, the tokens each way and why. Append-only: a trigger in migration 0151 rejects UPDATE; DELETE stays
 * possible for the user cascade. No message content and no key is ever stored here. The hosted tier's daily caps and
 * the settings card's "today's sends" read it. Never a plan input.
 */
export const derivedModelCalls = pgTable(
  "derived_model_calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sourceEventKey: text("source_event_key").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    tier: text("tier").notNull(),
    model: text("model").notNull(),
    tokensIn: integer("tokens_in").notNull().default(0),
    tokensOut: integer("tokens_out").notNull().default(0),
    reason: text("reason").notNull()
  },
  (table) => [
    check("derived_model_calls_tier_check", sql`${table.tier} IN ('t2', 't3')`),
    check("derived_model_calls_tokens_check", sql`${table.tokensIn} >= 0 AND ${table.tokensOut} >= 0`),
    check(
      "derived_model_calls_short_text_check",
      sql`length(${table.sourceEventKey}) <= 512 AND length(${table.model}) <= 200 AND length(${table.reason}) <= 200`
    ),
    index("derived_model_calls_user_at_idx").on(table.userId, table.at)
  ]
);

/**
 * Public video metadata (length) fetched later from YouTube; no user column because it is not personal.
 * Regenerable, so left out of backups. Empty in the first release.
 */
export const videoInfo = pgTable("video_info", {
  videoId: text("video_id").primaryKey(),
  durationS: integer("duration_s"),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  unavailable: boolean("unavailable").notNull().default(false)
});

/**
 * A password or key the person typed into the web app (Settings, Passwords and keys): one row per named secret.
 * `ciphertext` and `nonce` are base64 of an AES-256-GCM sealing under `OPENRHEN_SECRETS_KEY`, with the user id, name
 * and `key_version` bound as additional authenticated data, so a row copied under another name or user cannot be
 * opened. The value is written and never read back by any route; only the proxy-call helper decrypts it. Not a plan
 * input, and in `REGENERABLE_TABLES`: a backup must not carry a key (restoring means entering the keys again).
 */
export const appSecrets = pgTable(
  "app_secrets",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    ciphertext: text("ciphertext").notNull(),
    nonce: text("nonce").notNull(),
    keyVersion: integer("key_version").notNull().default(1),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [primaryKey({ columns: [table.userId, table.name] })]
);

/**
 * Units of the YouTube Data API's daily quota the video-length lookup has used, per quota day (Google resets at
 * midnight Pacific time). `exhausted_at` is set when Google answered "quota exceeded", so the rest of that day's runs
 * stop without asking. Regenerable bookkeeping: left out of backups.
 */
export const youtubeQuotaUse = pgTable(
  "youtube_quota_use",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    quotaDate: date("quota_date").notNull(),
    unitsSpent: integer("units_spent").notNull().default(0),
    exhaustedAt: timestamp("exhausted_at", { withTimezone: true })
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.quotaDate] }),
    check("youtube_quota_use_units_check", sql`${table.unitsSpent} >= 0`)
  ]
);

/**
 * The Now offer log: what Now offered, and what happened next. Append-only, one row per event, never updated and
 * never deleted by code (rows go only with their user, by the cascade). Kept apart from planning retention
 * (`plan-retention.ts` deletes unchosen offers after 7 days), so `recommendation_id` and `target_id` carry no foreign
 * key and `label` snapshots the title: a deleted recommendation or action still reads. Written in the same
 * transaction as the thing it records (`offered` when a plan is published, an outcome when a command is applied) by
 * `offer-log/offer-log.ts`; a failed insert rolls that transaction back. The planner and the engine never read it
 * (`watch-history/engine-blind.test.ts`), so it is no plan input. In `BACKUP_TABLES` (format 21): history nothing
 * regenerates. See `docs/operations/database-and-backups.md`.
 *
 * `rank` is the target's rank in the user's latest `offered` row before the command (`rank_basis` says whether there was
 * one); a target outside that row's top 5 has a null rank and `detail.off_plan = true`.
 */
export const offerLog = pgTable(
  "offer_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    event: text("event").notNull(),
    recommendationId: uuid("recommendation_id"),
    surface: text("surface").notNull().default("server"),
    resolutionKind: text("resolution_kind"),
    targetType: text("target_type"),
    targetId: text("target_id"),
    executionOptionId: text("execution_option_id"),
    label: text("label"),
    rank: smallint("rank"),
    rankBasis: text("rank_basis"),
    candidates: jsonb("candidates"),
    validUntil: timestamp("valid_until", { withTimezone: true }),
    actor: text("actor"),
    commandId: uuid("command_id"),
    detail: jsonb("detail")
      .notNull()
      .default(sql`'{}'::jsonb`)
  },
  (table) => [
    check(
      "offer_log_event_check",
      sql`${table.event} IN ('offered','shown','started','skipped','did_not_start','blocked','snoozed','checked_in')`
    ),
    check("offer_log_surface_check", sql`${table.surface} IN ('server','portal','handheld')`),
    check(
      "offer_log_rank_basis_check",
      sql`${table.rankBasis} IS NULL OR ${table.rankBasis} IN ('offered_row','none')`
    ),
    check("offer_log_rank_check", sql`${table.rank} IS NULL OR ${table.rank} >= 1`),
    index("offer_log_user_time_idx").on(table.userId, table.occurredAt),
    index("offer_log_user_event_time_idx").on(table.userId, table.event, table.occurredAt.desc()),
    uniqueIndex("offer_log_command_event_target_idx")
      .on(table.commandId, table.event, table.targetId)
      .where(sql`${table.commandId} IS NOT NULL`)
  ]
);

/**
 * The comparison log (comparison-consequence-ranking design, 3.4): one row per answered group of items, append-only and
 * never updated or deleted by code (rows go only with their user, by the cascade). Item ids are plain text with NO
 * foreign key and no cascade to projects or actions, so a state replace (which deletes and reinserts them) cannot
 * destroy the log; ids that no longer exist are ignored by the fit. `item_ids` is the group as issued (sorted),
 * `item_stars` and `item_hashes` run parallel to it and hold each item's stars and material-field hash at answer time,
 * which is what the fit compares against to drop a stale answer. `ranking` is the item ids best first, or null for a
 * tie ("equal / can't decide"). `group_id` is unique, so an issued group cannot be answered twice, and
 * `(user_id, idempotency_key)` is unique, so a retried write is the same row. In `BACKUP_TABLES` (format 25): the
 * derived columns on projects and actions are recomputed from it, never the other way round.
 */
export const consequenceComparisons = pgTable(
  "consequence_comparisons",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    pool: text("pool").notNull(),
    itemIds: text("item_ids").array().notNull(),
    itemStars: smallint("item_stars").array().notNull(),
    itemHashes: text("item_hashes").array().notNull(),
    ranking: text("ranking").array(),
    tie: boolean("tie").notNull().default(false),
    answeredBy: text("answered_by").notNull(),
    basis: text("basis").notNull(),
    evidence: text("evidence"),
    questionWording: text("question_wording").notNull(),
    askedAt: timestamp("asked_at", { withTimezone: true }).notNull(),
    answeredAt: timestamp("answered_at", { withTimezone: true }).notNull().defaultNow(),
    idempotencyKey: text("idempotency_key").notNull(),
    groupId: uuid("group_id").notNull()
  },
  (table) => [
    foreignKey({
      columns: [table.groupId],
      foreignColumns: [consequenceGroupsIssued.id],
      name: "consequence_comparisons_group_fk"
    }),
    check("consequence_comparisons_pool_check", sql`${table.pool} in ('project','action')`),
    check("consequence_comparisons_answered_by_check", sql`${table.answeredBy} in ('person','agent')`),
    check("consequence_comparisons_basis_check", sql`${table.basis} in ('stated','observed','inferred')`),
    check(
      "consequence_comparisons_items_check",
      sql`cardinality(${table.itemIds}) between 2 and 4 and cardinality(${table.itemStars}) = cardinality(${table.itemIds}) and cardinality(${table.itemHashes}) = cardinality(${table.itemIds})`
    ),
    check(
      "consequence_comparisons_ranking_check",
      sql`(${table.tie} and ${table.ranking} is null) or (not ${table.tie} and ${table.ranking} is not null and cardinality(${table.ranking}) = cardinality(${table.itemIds}) and ${table.ranking} <@ ${table.itemIds} and ${table.itemIds} <@ ${table.ranking})`
    ),
    uniqueIndex("consequence_comparisons_idempotency_idx").on(table.userId, table.idempotencyKey),
    uniqueIndex("consequence_comparisons_group_idx").on(table.groupId),
    index("consequence_comparisons_user_pool_idx").on(table.userId, table.pool, table.answeredAt)
  ]
);

/**
 * Every group handed out for comparison (design 3.4), so "refuse an answer that does not match the group issued" is
 * checkable. `answered_at` and `answered_comparison_id` are set when the group is answered; the comparison id is plain,
 * not a foreign key, because the comparison already references this row. Item ids are plain text, as in the log.
 * `issued_at` is also the "asked" time the 30-day pair cool-down reads. Append-only except for the answered pair.
 */
export const consequenceGroupsIssued = pgTable(
  "consequence_groups_issued",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    pool: text("pool").notNull(),
    itemIds: text("item_ids").array().notNull(),
    wording: text("wording").notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    answeredComparisonId: uuid("answered_comparison_id")
  },
  (table) => [
    check("consequence_groups_issued_pool_check", sql`${table.pool} in ('project','action')`),
    check("consequence_groups_issued_items_check", sql`cardinality(${table.itemIds}) between 2 and 4`),
    check(
      "consequence_groups_issued_answered_check",
      sql`(${table.answeredAt} is null) = (${table.answeredComparisonId} is null)`
    ),
    index("consequence_groups_issued_user_pool_idx").on(table.userId, table.pool, table.issuedAt)
  ]
);
