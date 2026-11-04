import { formatZonedDateTime } from "@/shared/date-format";

/**
 * A night's start (or end) instant, in the timezone the person actually lives in. Deliberately not
 * `loggedSleepLabel` from Settings, which formats in the browser's own zone and silently disagrees
 * with every other clock in the app when the two differ — a bug this surface does not inherit.
 */
export function nightLabel(value: string, timezone: string): string {
  return formatZonedDateTime(value, timezone);
}

/** Hours slept, to one decimal place — the exact formula the seven-day sleep plan uses, so the two
 * surfaces never show different numbers for the same night. */
export function durationLabel(allowedMinutes: number): string {
  return `${Math.round(allowedMinutes / 6) / 10}h`;
}

/**
 * The night's real length when both actual times are known and in order, otherwise `allowedMinutes`
 * — the plan's frozen allowance, which is all a still-sleeping or planned-only row has. Preferring
 * the actual span matches what the backend now writes on wake (activity-commands.ts), and covers a
 * night finished before that recompute existed, where allowedMinutes is stuck at whatever was
 * planned rather than what happened.
 */
export function effectiveDurationMinutes(plan: {
  allowedMinutes: number;
  actualStartAt?: string | undefined;
  actualWakeAt?: string | undefined;
}): number {
  if (!plan.actualStartAt || !plan.actualWakeAt) return plan.allowedMinutes;
  const start = new Date(plan.actualStartAt).getTime();
  const wake = new Date(plan.actualWakeAt).getTime();
  return wake > start ? Math.round((wake - start) / 60000) : plan.allowedMinutes;
}
