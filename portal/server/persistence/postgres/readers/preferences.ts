import { DEFAULT_LOCALE, DEFAULT_START_BY_WARNING_MINUTES, DEFAULT_TIME_BANDS } from "@openrhen/contracts";
import { userPreferences, users } from "@openrhen/database";
import { parseDeviceLocationState } from "@/server/location/observation-policy";
import { defaultPlanningSettings, type PortalState } from "@/state/portal-state";
import type { LeftJoined, Row } from "../db-row";
import { parseCurrentSituation } from "../current-situation";
import { withoutConsumedWaivers } from "../waiver-consumption";
import { numberOr } from "../row-values";
import type { Sql } from "../sql-pool";

type Preferences = Pick<
  PortalState,
  "settings" | "assertedConditions" | "currentEnergy" | "currentSituation" | "pendingLocationSuggestion" | "horizonEnd"
> & { timezone: string };

/** The settings block and the few state fields that live on the user's preferences row. */
export async function readPreferences(sql: Sql, userId: string): Promise<Preferences> {
  const defaults = defaultPlanningSettings();
  const preferences = await sql<
    (Row<typeof users, "timezone" | "locale"> &
      LeftJoined<
        Row<
          typeof userPreferences,
          | "planning_horizon_end"
          | "current_horizon_end_at"
          | "asserted_conditions"
          | "current_energy"
          | "default_usable_fraction"
          | "default_setup_buffer_minutes"
          | "default_transition_buffer_minutes"
          | "submission_buffer_minutes"
          | "submission_buffer_percent"
          | "energy_meanings"
          | "estimate_buckets_minutes"
          | "setup_completed_at"
          | "version"
          | "preferred_bedtime"
          | "preferred_wake_time"
          | "desired_sleep_minutes"
          | "minimum_sleep_minutes"
          | "max_awake_hours"
          | "bedtime_deviation_minutes"
          | "recovery_start_time"
          | "recovery_end_time"
          | "recovery_weekdays"
          | "last_woke_at"
          | "bedtime_routine_preset_id"
          | "wake_routine_preset_id"
          | "current_situation"
          | "home_location_id"
          | "device_location_state"
          | "disruption_kind_labels"
          | "disruption_when_presets"
          | "disruption_duration_presets"
          | "disruption_retro_fallback_minutes"
          | "arrival_margin_minutes"
          | "deliverable_chat_model"
          | "import_extractor_model"
          | "calendar_share_enabled"
          | "share_primary_events"
          | "pulse_publish_enabled"
          | "estimate_calibration_enabled"
          | "time_bands"
          | "start_by_warning_minutes"
          | "session_break_minutes"
          | "default_transport_mode"
          | "leave_by_lead_minutes"
          | "pulse_unknown_to_off_minutes"
          | "pulse_further_prompts"
          | "pulse_unknown_hard_off_minutes"
          | "plan_code_pattern"
        >
      > & { default_transport_mode: PortalState["settings"]["defaultTransportMode"] | null })[]
  >`
      SELECT u.timezone, u.locale, p.planning_horizon_end, p.current_horizon_end_at, p.asserted_conditions, p.current_energy,
        p.default_usable_fraction,
        p.default_setup_buffer_minutes, p.default_transition_buffer_minutes, p.submission_buffer_minutes,
        p.submission_buffer_percent, p.energy_meanings, p.estimate_buckets_minutes, p.setup_completed_at, p.version,
        p.preferred_bedtime,p.preferred_wake_time,p.desired_sleep_minutes,p.minimum_sleep_minutes,p.max_awake_hours,p.bedtime_deviation_minutes,p.recovery_start_time,p.recovery_end_time,p.recovery_weekdays,p.last_woke_at,p.bedtime_routine_preset_id,p.wake_routine_preset_id,
        p.current_situation,p.home_location_id,p.device_location_state,
        p.disruption_kind_labels,p.disruption_when_presets,p.disruption_duration_presets,p.disruption_retro_fallback_minutes,
        p.arrival_margin_minutes,p.deliverable_chat_model,p.import_extractor_model,p.calendar_share_enabled,p.share_primary_events,p.pulse_publish_enabled,p.estimate_calibration_enabled,
        p.time_bands,p.start_by_warning_minutes,p.session_break_minutes,p.default_transport_mode,p.leave_by_lead_minutes,
        p.pulse_unknown_to_off_minutes,p.pulse_further_prompts,p.pulse_unknown_hard_off_minutes, p.plan_code_pattern
      FROM users u LEFT JOIN user_preferences p ON p.user_id = u.id WHERE u.id = ${userId}
    `;
  const preference = preferences[0];
  const timezone = preference?.timezone ?? defaults.timezone;
  const storedMeanings =
    preference?.energy_meanings && typeof preference.energy_meanings === "object"
      ? (preference.energy_meanings as Partial<typeof defaults.energyMeanings>)
      : {};
  const storedBuckets = Array.isArray(preference?.estimate_buckets_minutes)
    ? preference.estimate_buckets_minutes.filter((value): value is number => typeof value === "number")
    : defaults.estimateBucketsMinutes;
  const storedKindLabels =
    preference?.disruption_kind_labels && typeof preference.disruption_kind_labels === "object"
      ? (preference.disruption_kind_labels as Partial<typeof defaults.disruptionKindLabels>)
      : {};
  const storedWhenPresets = Array.isArray(preference?.disruption_when_presets)
    ? (preference.disruption_when_presets as typeof defaults.disruptionWhenPresets)
    : [];
  const storedDurationPresets = Array.isArray(preference?.disruption_duration_presets)
    ? (preference.disruption_duration_presets as typeof defaults.disruptionDurationPresets)
    : [];
  return {
    timezone,
    settings: {
      ...(preference?.version ? { version: preference.version } : {}),
      ...(preference?.setup_completed_at ? { setupCompletedAt: preference.setup_completed_at.toISOString() } : {}),
      timezone,
      locale: preference?.locale ?? DEFAULT_LOCALE,
      planningHorizonEnd: preference?.planning_horizon_end?.slice(0, 5) ?? defaults.planningHorizonEnd,
      defaultUsableFraction: numberOr(preference?.default_usable_fraction, defaults.defaultUsableFraction),
      defaultSetupBufferMinutes: preference?.default_setup_buffer_minutes ?? defaults.defaultSetupBufferMinutes,
      defaultTransitionBufferMinutes:
        preference?.default_transition_buffer_minutes ?? defaults.defaultTransitionBufferMinutes,
      submissionBufferMinutes: preference?.submission_buffer_minutes ?? defaults.submissionBufferMinutes,
      submissionBufferPercent: numberOr(preference?.submission_buffer_percent, defaults.submissionBufferPercent),
      energyMeanings: { ...defaults.energyMeanings, ...storedMeanings },
      estimateBucketsMinutes: storedBuckets.length ? storedBuckets : defaults.estimateBucketsMinutes,
      preferredBedtime: preference?.preferred_bedtime?.slice(0, 5) ?? defaults.preferredBedtime,
      preferredWakeTime: preference?.preferred_wake_time?.slice(0, 5) ?? defaults.preferredWakeTime,
      desiredSleepMinutes: preference?.desired_sleep_minutes ?? defaults.desiredSleepMinutes,
      minimumSleepMinutes: preference?.minimum_sleep_minutes ?? defaults.minimumSleepMinutes,
      maxAwakeHours: preference?.max_awake_hours ?? defaults.maxAwakeHours,
      bedtimeDeviationMinutes: preference?.bedtime_deviation_minutes ?? defaults.bedtimeDeviationMinutes,
      recoveryStartTime: preference?.recovery_start_time?.slice(0, 5) ?? null,
      recoveryEndTime: preference?.recovery_end_time?.slice(0, 5) ?? null,
      recoveryWeekdays:
        Array.isArray(preference?.recovery_weekdays) && preference.recovery_weekdays.length
          ? (preference.recovery_weekdays as number[])
          : defaults.recoveryWeekdays,
      ...(preference?.last_woke_at ? { lastWokeAt: preference.last_woke_at.toISOString() } : {}),
      ...(preference?.bedtime_routine_preset_id
        ? { bedtimeRoutinePresetId: preference.bedtime_routine_preset_id }
        : {}),
      ...(preference?.wake_routine_preset_id ? { wakeRoutinePresetId: preference.wake_routine_preset_id } : {}),
      ...(preference?.home_location_id ? { homeLocationId: preference.home_location_id } : {}),
      disruptionKindLabels: { ...defaults.disruptionKindLabels, ...storedKindLabels },
      disruptionWhenPresets: storedWhenPresets.length ? storedWhenPresets : defaults.disruptionWhenPresets,
      disruptionDurationPresets: storedDurationPresets.length
        ? storedDurationPresets
        : defaults.disruptionDurationPresets,
      disruptionRetroFallbackMinutes:
        preference?.disruption_retro_fallback_minutes ?? defaults.disruptionRetroFallbackMinutes,
      arrivalMarginMinutes: preference?.arrival_margin_minutes ?? defaults.arrivalMarginMinutes,
      sessionBreakMinutes: preference?.session_break_minutes ?? defaults.sessionBreakMinutes,
      ...(preference?.deliverable_chat_model ? { deliverableChatModel: preference.deliverable_chat_model } : {}),
      ...(preference?.import_extractor_model ? { importExtractorModel: preference.import_extractor_model } : {}),
      calendarShareEnabled: preference?.calendar_share_enabled ?? defaults.calendarShareEnabled,
      sharePrimaryEvents: preference?.share_primary_events ?? defaults.sharePrimaryEvents,
      pulsePublishEnabled: preference?.pulse_publish_enabled ?? defaults.pulsePublishEnabled,
      estimateCalibrationEnabled: preference?.estimate_calibration_enabled ?? defaults.estimateCalibrationEnabled,
      timeBands:
        Array.isArray(preference?.time_bands) && preference.time_bands.length
          ? (preference.time_bands as PortalState["settings"]["timeBands"])
          : DEFAULT_TIME_BANDS,
      startByWarningMinutes: preference?.start_by_warning_minutes ?? DEFAULT_START_BY_WARNING_MINUTES,
      ...(preference?.default_transport_mode ? { defaultTransportMode: preference.default_transport_mode } : {}),
      leaveByLeadMinutes: preference?.leave_by_lead_minutes ?? defaults.leaveByLeadMinutes,
      ...(preference?.pulse_unknown_to_off_minutes != null
        ? { pulseUnknownToOffMinutes: preference.pulse_unknown_to_off_minutes }
        : {}),
      ...(preference?.pulse_further_prompts != null ? { pulseFurtherPrompts: preference.pulse_further_prompts } : {}),
      ...(preference?.pulse_unknown_hard_off_minutes != null
        ? { pulseUnknownHardOffMinutes: preference.pulse_unknown_hard_off_minutes }
        : {}),
      ...(preference?.plan_code_pattern ? { planCodePattern: preference.plan_code_pattern } : {})
    },
    assertedConditions: Array.isArray(preferences[0]?.asserted_conditions)
      ? (preferences[0]!.asserted_conditions as string[])
      : ["home"],
    currentEnergy: preferences[0]?.current_energy ?? "medium",
    currentSituation: await withoutConsumedWaivers(sql, parseCurrentSituation(preferences[0]?.current_situation)),
    // Only a "move" suggestion is actionable from the state document — an ambiguous or unmatched
    // reading has no single place to offer, and the read-only exposure was scoped to the one the Now
    // page can actually put a Confirm button on.
    pendingLocationSuggestion: (() => {
      const suggestion = parseDeviceLocationState(preferences[0]?.device_location_state).suggestion;
      return suggestion?.kind === "move"
        ? {
            locationId: suggestion.locationId,
            locationName: suggestion.locationName,
            observedAt: suggestion.observedAt
          }
        : null;
    })(),
    horizonEnd:
      preferences[0]?.current_horizon_end_at?.toISOString() ?? new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString()
  };
}
