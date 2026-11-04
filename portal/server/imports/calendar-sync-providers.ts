import { intervalCalendarSourceIds, type CalendarSyncProvider } from "@openrhen/contracts";

/**
 * Which providers the calendar sync may run for, from `CALENDAR_SYNC_PROVIDERS` (comma-separated), read
 * the same way the worker reads it (`engine/worker/src/calendar-sync-schedule.ts`) so that a provider the
 * worker does not schedule cannot be run from a "Sync now" either. Unset or blank means Google only;
 * unknown names are ignored. The calendar provider joins the list only once its login is known to work.
 */
const KNOWN: readonly CalendarSyncProvider[] = intervalCalendarSourceIds();

export function enabledCalendarSyncProviders(env: Record<string, string | undefined>): CalendarSyncProvider[] {
  const value = env.CALENDAR_SYNC_PROVIDERS;
  if (value === undefined || !value.trim()) return ["google_calendar"];
  const requested = value
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  return KNOWN.filter((provider) => requested.includes(provider));
}

export function isCalendarSyncEnabled(provider: CalendarSyncProvider, env: Record<string, string | undefined>) {
  return enabledCalendarSyncProviders(env).includes(provider);
}
