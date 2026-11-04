import { dateTimeFormat } from "@/shared/locale";
import { PARTS_LOCALE, isValidTimeZone } from "@openrhen/contracts";
import type { PlanningSettings, PortalState } from "@/state/portal-state";

const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export function validatePlanningSettings(settings: PlanningSettings): string | null {
  if (!isValidTimeZone(settings.timezone)) return "Choose a valid IANA timezone, such as Europe/London.";
  if (!timePattern.test(settings.preferredBedtime) || !timePattern.test(settings.preferredWakeTime))
    return "Preferred bedtime and wake time must be valid times.";
  if (settings.minimumSleepMinutes < 60 || settings.minimumSleepMinutes > settings.desiredSleepMinutes)
    return "Minimum sleep must be at least one hour and cannot exceed desired sleep.";
  if (settings.maxAwakeHours < 8 || settings.maxAwakeHours > 36) return "Maximum awake hours must be between 8 and 36.";
  if (settings.bedtimeDeviationMinutes < 0 || settings.bedtimeDeviationMinutes > 720)
    return "Bedtime deviation must be between 0 and 720 minutes.";
  if (
    !Number.isFinite(settings.defaultUsableFraction) ||
    settings.defaultUsableFraction <= 0 ||
    settings.defaultUsableFraction > 1
  )
    return "Usable capacity must be above 0% and no more than 100%.";
  if (
    ![
      settings.defaultSetupBufferMinutes,
      settings.defaultTransitionBufferMinutes,
      settings.submissionBufferMinutes
    ].every((value) => Number.isInteger(value) && value >= 0 && value <= 1_440)
  )
    return "Buffer values must be whole minutes between 0 and 1,440.";
  if (
    !Number.isFinite(settings.submissionBufferPercent) ||
    settings.submissionBufferPercent < 0 ||
    settings.submissionBufferPercent > 1
  )
    return "Submission buffer percentage must be between 0% and 100%.";
  if (Object.values(settings.energyMeanings).some((meaning) => !meaning.trim()))
    return "Each energy level needs a clear meaning.";
  if (
    !settings.estimateBucketsMinutes.length ||
    settings.estimateBucketsMinutes.some((value) => !Number.isInteger(value) || value < 1 || value > 1_440)
  )
    return "Estimate buckets must be whole minutes between 1 and 1,440.";
  if (new Set(settings.estimateBucketsMinutes).size !== settings.estimateBucketsMinutes.length)
    return "Estimate buckets cannot contain duplicates.";
  if (!settings.estimateBucketsMinutes.every((value, index, list) => index === 0 || value > list[index - 1]!))
    return "Estimate buckets must be in ascending order.";
  return null;
}

export function applyPlanningSettings(state: PortalState, settings: PlanningSettings, now = new Date()): PortalState {
  const validation = validatePlanningSettings(settings);
  if (validation) throw new Error(validation);
  return {
    ...state,
    settings,
    horizonEnd: nextHorizonEnd(now, settings.timezone, settings.planningHorizonEnd).toISOString()
  };
}

export function nextHorizonEnd(now: Date, timezone: string, wallTime: string): Date {
  const day = zonedParts(now, timezone);
  const [hour, minute] = wallTime.split(":").map(Number) as [number, number];
  let candidate = zonedDateTimeToUtc(day.year, day.month, day.day, hour, minute, timezone);
  if (candidate <= now) {
    const nextDay = new Date(Date.UTC(day.year, day.month - 1, day.day + 1));
    candidate = zonedDateTimeToUtc(
      nextDay.getUTCFullYear(),
      nextDay.getUTCMonth() + 1,
      nextDay.getUTCDate(),
      hour,
      minute,
      timezone
    );
  }
  return candidate;
}

function zonedParts(date: Date, timezone: string) {
  const parts = dateTimeFormat(PARTS_LOCALE, {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)!.value);
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second")
  };
}

function zonedDateTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timezone: string
): Date {
  const desired = Date.UTC(year, month - 1, day, hour, minute);
  let timestamp = desired;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const actual = zonedParts(new Date(timestamp), timezone);
    const actualAsUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
    timestamp += desired - actualAsUtc;
  }
  return new Date(timestamp);
}
