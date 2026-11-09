import {
  defaultCalendarSyncProviderIds,
  intervalCalendarSourceIds,
  type CalendarSyncProvider
} from "@openrhen/contracts";

/**
 * Which providers the calendar sync may run for, from `CALENDAR_SYNC_PROVIDERS` (comma-separated), read
 * the same way the worker reads it (`engine/worker/src/calendar-sync-schedule.ts`) so that a provider the
 * worker does not schedule cannot be run from a "Sync now" either. Unset or blank means the sources whose
 * manifest sets `syncByDefault` (none when no manifest does); unknown names are ignored. Any other source joins the
 * list only once the setting names it.
 */
const KNOWN: readonly CalendarSyncProvider[] = intervalCalendarSourceIds();

export function enabledCalendarSyncProviders(env: Record<string, string | undefined>): CalendarSyncProvider[] {
  const value = env.CALENDAR_SYNC_PROVIDERS;
  if (value === undefined || !value.trim()) return defaultCalendarSyncProviderIds();
  const requested = value
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  return KNOWN.filter((provider) => requested.includes(provider));
}

export function isCalendarSyncEnabled(provider: CalendarSyncProvider, env: Record<string, string | undefined>) {
  return enabledCalendarSyncProviders(env).includes(provider);
}
