"use client";

import { recoveryOccurrence } from "@openrhen/contracts";
import type { PortalState } from "@/state/portal-state";
import { localDayKey } from "@/features/today/today-view";
import { recoverySkippedCommand } from "@/features/now/recovery-commands";
import type { SaveEntityCommand } from "@/features/now/now-model";

/** The person's local wall-clock `HH:MM` at `now`. */
function localClock(now: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("hour")}:${get("minute")}`;
}

/**
 * One line while today's protected recovery window has not yet
 * ended: its hours with "Skip today", or, once skipped, "Recovery skipped today" with "Undo". Saved
 * through the same `daily_plan` command as the horizon extension, carrying the plan's other fields.
 */
export function RecoveryWindowLine({
  state,
  now,
  timezone,
  saving,
  saveEntityCommand
}: {
  state: PortalState;
  now: Date;
  timezone: string;
  saving: boolean;
  saveEntityCommand: SaveEntityCommand;
}) {
  const { recoveryStartTime: start, recoveryEndTime: end, recoveryWeekdays } = state.settings;
  if (!start || !end) return null;
  const todayKey = localDayKey(now, timezone);
  // The occurrence is named by the date it starts on, which is yesterday after midnight on an overnight
  // window; the skip is saved and read against that date, as the engine's capacity does.
  const occurrence = recoveryOccurrence({
    localDate: todayKey,
    clock: localClock(now, timezone),
    startTime: start,
    endTime: end,
    weekdays: recoveryWeekdays
  });
  if (!occurrence) return null;
  const { startDate } = occurrence;
  const plan = state.dailyPlan?.localDate === startDate ? state.dailyPlan : undefined;
  const skipped = plan?.recoverySkipped === true || state.dailyPlan?.recoverySkippedDates?.includes(startDate) === true;
  const when = startDate === todayKey ? "today" : "last night";
  const setSkipped = (value: boolean) =>
    void saveEntityCommand(recoverySkippedCommand(plan, startDate, value, startDate !== todayKey));
  return (
    <p className="microcopy recovery-window-line">
      {skipped ? `Recovery skipped ${when}` : `Recovery ${start}–${end} ${when}`}{" "}
      <button type="button" className="quiet small" disabled={saving} onClick={() => setSkipped(!skipped)}>
        {skipped ? "Undo" : startDate === todayKey ? "Skip today" : "Skip"}
      </button>
    </p>
  );
}
