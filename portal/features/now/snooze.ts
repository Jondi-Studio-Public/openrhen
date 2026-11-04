import { dateOnly, nextDayKey, zonedDayStart } from "@/features/today/local-datetime";
import { formatZonedDate } from "@/shared/date-format";

export interface SnoozeOption {
  label: "Later today" | "Tomorrow" | "Next week";
  /** The instant written to the action's "available from". */
  at: Date;
}

const QUARTER = 15 * 60_000;
/** "Later today" is hidden once the evening is too far gone for it to mean anything. */
const LATEST_LATER_HOUR = 21;

/** Local midnight at the start of a picked "YYYY-MM-DD" in the plan zone. */
export function startOfLocalDay(dayKey: string, timezone: string): Date {
  return zonedDayStart(dayKey, timezone);
}

/**
 * Where "put it off" can go, all read in the plan zone. Later today is three hours on, rounded up to
 * a quarter hour, and is left out when that would land late in the evening or on tomorrow. Tomorrow
 * and Next week (the coming Monday) open at the start of the day, so the planner still chooses the
 * hour.
 */
export function snoozeOptions(now: Date, timezone: string): SnoozeOption[] {
  const today = dateOnly(now, timezone);
  const options: SnoozeOption[] = [];
  const later = new Date(Math.ceil((now.getTime() + 3 * 60 * 60_000) / QUARTER) * QUARTER);
  const laterHour = Number(
    new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", hourCycle: "h23" }).format(later)
  );
  if (dateOnly(later, timezone) === today && laterHour < LATEST_LATER_HOUR) {
    options.push({ label: "Later today", at: later });
  }
  options.push({ label: "Tomorrow", at: zonedDayStart(nextDayKey(today), timezone) });
  // Day of week of the plan-zone date: a calendar day key is zone-free.
  const weekday = new Date(`${today}T12:00:00Z`).getUTCDay();
  const untilMonday = (8 - weekday) % 7 || 7;
  options.push({ label: "Next week", at: zonedDayStart(nextDayKey(today, untilMonday), timezone) });
  return options;
}

export interface SnoozeSubject {
  /** The project's external deadline: the only date that is really not negotiable. */
  externalDeadlineAt?: string | undefined;
  latestStartAt?: string | undefined;
  /** An existing put-off; a chip must not pull it earlier. */
  availableFrom?: string | undefined;
}

/**
 * What a snooze is checked against. An action's own `deadlineAt` is a soft self-set target that can
 * already be in the past while the work is still due, so the guard reads the project's external
 * deadline instead, plus the action's latest safe start.
 */
export function snoozeSubject(
  action: { projectId?: string | undefined; latestStartAt?: string | undefined; availableFrom?: string | undefined },
  projects: readonly { id: string; externalDeadlineAt?: string | undefined }[]
): SnoozeSubject {
  const external = projects.find((project) => project.id === action.projectId)?.externalDeadlineAt;
  return {
    externalDeadlineAt: external,
    latestStartAt: action.latestStartAt,
    availableFrom: action.availableFrom
  };
}

/**
 * Why a snooze to `availableFrom` would be wrong, or null. Putting work off past the point it has to
 * start by, or past its external deadline, is a decision to miss it, which is not what a snooze says.
 * A snooze also never brings an existing, later put-off forward.
 */
export function snoozeRefusal(subject: SnoozeSubject, availableFrom: Date, timezone: string): string | null {
  if (subject.latestStartAt && availableFrom.getTime() > new Date(subject.latestStartAt).getTime()) {
    return `That is after its latest safe start (${formatZonedDate(subject.latestStartAt, timezone)}).`;
  }
  if (subject.externalDeadlineAt && availableFrom.getTime() > new Date(subject.externalDeadlineAt).getTime()) {
    return `That is after its deadline (${formatZonedDate(subject.externalDeadlineAt, timezone)}).`;
  }
  if (subject.availableFrom && availableFrom.getTime() < new Date(subject.availableFrom).getTime()) {
    return `It is already put off until ${formatZonedDate(subject.availableFrom, timezone)}.`;
  }
  return null;
}

/**
 * Snoozing sets "available from" on the stored action. For a recurring or cadence series that would
 * hold back every later occurrence, and an occurrence has no date of its own to move, so only one-off
 * actions offer it.
 */
export function canSnooze(action: { schedulingMode?: string | undefined; occurrenceId?: string | undefined }): boolean {
  return (action.schedulingMode ?? "one_off") === "one_off" && !action.occurrenceId;
}

/** Everything the picker needs about one action: whether it can be snoozed and what bounds a snooze. */
export function snoozeTarget(
  action: {
    schedulingMode?: string | undefined;
    occurrenceId?: string | undefined;
    projectId?: string | undefined;
    latestStartAt?: string | undefined;
    availableFrom?: string | undefined;
  },
  projects: readonly { id: string; externalDeadlineAt?: string | undefined }[]
) {
  return {
    schedulingMode: action.schedulingMode,
    occurrenceId: action.occurrenceId,
    ...snoozeSubject(action, projects)
  };
}
