import { dateTimeFormat, displayLocale } from "@/shared/locale";
import type { PortalState } from "@/state/portal-state";
import { HISTORY_WINDOW_DAYS } from "@/shared/history-window";
import { sleepDurationLabel } from "@/features/today/day-plan";
import { nextDayKey } from "@/features/today/local-datetime";
import { localDayKey } from "@/features/today/today-view";

/**
 * The History calendar: a week or month day grid with each day's
 * sessions, sleep and closed recurring occurrences, and spans drawn as bands across the days. Pure, so the
 * page stays thin and the band geometry is tested without rendering.
 */

export type CalendarView = "week" | "month";

export const OLDER_THAN_WINDOW_NOTICE = `Sessions older than ${HISTORY_WINDOW_DAYS} days are not kept in this view`;

type Session = PortalState["completedToday"][number];
type SleepPlan = PortalState["sleepPlans"][number];
type Occurrence = PortalState["occurrences"][number];
type Span = PortalState["spans"][number];

export interface CalendarEntry {
  id: string;
  title: string;
  detail: string;
}

export interface CalendarDay {
  key: string;
  /** Day of the month, for the cell label. */
  dayOfMonth: number;
  /** False for the leading and trailing days a month grid pads its first and last week with. */
  inRange: boolean;
  isToday: boolean;
  /** True before the session window: the day's sessions are not kept, so it must not read as empty. */
  beforeSessionWindow: boolean;
  sessions: CalendarEntry[];
  sleep: CalendarEntry[];
  occurrences: CalendarEntry[];
}

export interface CalendarBand {
  spanId: string;
  title: string;
  /** "09:00–17:30" when the span has a daily window; absent for whole days. */
  windowLabel?: string;
  /** Zero-based column of the first and last day this band covers within its week (Monday is 0). */
  startColumn: number;
  endColumn: number;
  /** Row within the week's band area, so overlapping spans stack instead of overdrawing. */
  lane: number;
  continuesBefore: boolean;
  continuesAfter: boolean;
}

export interface CalendarWeek {
  days: CalendarDay[];
  bands: CalendarBand[];
  laneCount: number;
}

export interface CalendarModel {
  view: CalendarView;
  /** "29 Sep – 5 Oct 2026" or "October 2026". */
  title: string;
  /** The first and last local day of the week or month shown (not the padding days around a month). */
  rangeStart: string;
  rangeEnd: string;
  weeks: CalendarWeek[];
  /** The line shown when any visible day is before the session window; absent otherwise. */
  notice?: string;
}

/** Monday is 0, matching the Australian week the rest of the portal uses. */
export function weekdayIndex(dayKey: string): number {
  const [year, month, day] = dayKey.split("-").map(Number) as [number, number, number];
  return (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7;
}

function startOfWeek(dayKey: string): string {
  return nextDayKey(dayKey, -weekdayIndex(dayKey));
}

function monthStart(dayKey: string): string {
  return `${dayKey.slice(0, 7)}-01`;
}

function monthEnd(dayKey: string): string {
  return nextDayKey(nextMonthStart(dayKey), -1);
}

function nextMonthStart(dayKey: string): string {
  const [year, month] = dayKey.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
}

/** The anchor day one period earlier (`-1`) or later (`1`): a week, or the first of a month. */
export function shiftAnchor(view: CalendarView, anchor: string, direction: -1 | 1): string {
  if (view === "week") return nextDayKey(anchor, 7 * direction);
  const first = monthStart(anchor);
  return direction === 1 ? nextMonthStart(first) : monthStart(nextDayKey(first, -1));
}

export function spanWindowLabel(span: Pick<Span, "window">): string | undefined {
  return span.window ? `${span.window.localStartTime}–${span.window.localEndTime}` : undefined;
}

function sessionEntry(session: Session, timezone: string): CalendarEntry {
  const time = dateTimeFormat(displayLocale(), { timeStyle: "short", timeZone: timezone }).format(
    new Date(session.endedAt)
  );
  return {
    id: session.id,
    title: session.actionTitle,
    detail: `${session.activeMinutes} min · ${session.result.replaceAll("_", " ")} · ends ${time}`
  };
}

/** A night with no sleep session behind it (logged by hand), worded the way Today words it. */
function sleepPlanEntry(
  plan: SleepPlan & { actualStartAt: string; actualWakeAt: string },
  timezone: string
): CalendarEntry {
  const minutes = Math.max(0, Math.round((Date.parse(plan.actualWakeAt) - Date.parse(plan.actualStartAt)) / 60_000));
  const time = dateTimeFormat(displayLocale(), { timeStyle: "short", timeZone: timezone }).format(
    new Date(plan.actualWakeAt)
  );
  return {
    id: `sleep:${plan.id}`,
    title: `Slept ${sleepDurationLabel(minutes, plan.manual)}`,
    detail: `${minutes} min · ends ${time}`
  };
}

function occurrenceEntry(occurrence: Occurrence, state: Pick<PortalState, "actions">): CalendarEntry {
  const action = state.actions.find((item) => item.id === occurrence.actionId);
  return {
    id: occurrence.id,
    title: `${action?.title ?? "Recurring action"} · ${occurrence.windowName}`,
    detail: occurrence.status
  };
}

function bandsForWeek(weekStart: string, spans: readonly Span[]): { bands: CalendarBand[]; laneCount: number } {
  const weekEnd = nextDayKey(weekStart, 6);
  const overlapping = spans
    .filter((span) => span.startDate <= weekEnd && span.endDate >= weekStart)
    .sort(
      (a, b) => a.startDate.localeCompare(b.startDate) || b.endDate.localeCompare(a.endDate) || a.id.localeCompare(b.id)
    );
  const laneEnds: number[] = [];
  const bands: CalendarBand[] = [];
  for (const span of overlapping) {
    const startColumn = span.startDate < weekStart ? 0 : weekdayIndex(span.startDate);
    const endColumn = span.endDate > weekEnd ? 6 : weekdayIndex(span.endDate);
    let lane = laneEnds.findIndex((end) => end < startColumn);
    if (lane === -1) lane = laneEnds.length;
    laneEnds[lane] = endColumn;
    const windowLabel = spanWindowLabel(span);
    bands.push({
      spanId: span.id,
      title: span.title,
      ...(windowLabel ? { windowLabel } : {}),
      startColumn,
      endColumn,
      lane,
      continuesBefore: span.startDate < weekStart,
      continuesAfter: span.endDate > weekEnd
    });
  }
  return { bands, laneCount: laneEnds.length };
}

const monthName = () => dateTimeFormat(displayLocale(), { month: "long", year: "numeric", timeZone: "UTC" });
const dayMonth = () => dateTimeFormat(displayLocale(), { day: "numeric", month: "short", timeZone: "UTC" });
const dayMonthYear = () =>
  dateTimeFormat(displayLocale(), {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC"
  });
const utc = (dayKey: string) => new Date(`${dayKey}T00:00:00Z`);

export function buildCalendar(input: {
  view: CalendarView;
  /** Any day inside the week or month to show. */
  anchor: string;
  now: Date;
  state: Pick<PortalState, "completedToday" | "sleepPlans" | "occurrences" | "spans" | "actions"> & {
    settings: Pick<PortalState["settings"], "timezone">;
  };
}): CalendarModel {
  const { view, anchor, now, state } = input;
  const timezone = state.settings.timezone;
  const today = localDayKey(now, timezone);
  const sessionsFrom = nextDayKey(today, -HISTORY_WINDOW_DAYS);
  const rangeStart = view === "week" ? startOfWeek(anchor) : monthStart(anchor);
  const rangeEnd = view === "week" ? nextDayKey(rangeStart, 6) : monthEnd(anchor);
  const gridStart = startOfWeek(rangeStart);
  const gridEnd = nextDayKey(startOfWeek(rangeEnd), 6);

  const sessionsByDay = new Map<string, Session[]>();
  for (const session of [...state.completedToday].sort((a, b) => a.endedAt.localeCompare(b.endedAt))) {
    const key = localDayKey(new Date(session.endedAt), timezone);
    sessionsByDay.set(key, [...(sessionsByDay.get(key) ?? []), session]);
  }
  // A completed night with no sleep session (a sleep session's `actionId` is its plan's id) is one logged
  // by hand; it is dated by the day it ended, like a session, and kept for the same window.
  const sessionPlanIds = new Set(
    state.completedToday.filter((item) => item.targetType === "sleep").map((item) => item.actionId)
  );
  const sleepPlansByDay = new Map<string, CalendarEntry[]>();
  const loggedNights = state.sleepPlans
    .flatMap((plan) =>
      plan.status === "completed" && plan.actualStartAt && plan.actualWakeAt && !sessionPlanIds.has(plan.id)
        ? [{ ...plan, actualStartAt: plan.actualStartAt, actualWakeAt: plan.actualWakeAt }]
        : []
    )
    .sort((a, b) => Date.parse(a.actualWakeAt) - Date.parse(b.actualWakeAt));
  for (const plan of loggedNights) {
    const key = localDayKey(new Date(plan.actualWakeAt), timezone);
    if (key < sessionsFrom) continue;
    sleepPlansByDay.set(key, [...(sleepPlansByDay.get(key) ?? []), sleepPlanEntry(plan, timezone)]);
  }
  const occurrencesByDay = new Map<string, Occurrence[]>();
  for (const occurrence of state.occurrences) {
    if (occurrence.status !== "completed" && occurrence.status !== "missed") continue;
    occurrencesByDay.set(occurrence.localDate, [...(occurrencesByDay.get(occurrence.localDate) ?? []), occurrence]);
  }

  const weeks: CalendarWeek[] = [];
  let anyBeforeWindow = false;
  for (let weekStart = gridStart; weekStart <= gridEnd; weekStart = nextDayKey(weekStart, 7)) {
    const days: CalendarDay[] = [];
    for (let offset = 0; offset < 7; offset += 1) {
      const key = nextDayKey(weekStart, offset);
      const sessions = sessionsByDay.get(key) ?? [];
      const beforeSessionWindow = key < sessionsFrom;
      const inRange = key >= rangeStart && key <= rangeEnd;
      if (beforeSessionWindow && inRange) anyBeforeWindow = true;
      days.push({
        key,
        dayOfMonth: Number(key.slice(8)),
        inRange,
        isToday: key === today,
        beforeSessionWindow,
        sessions: sessions.filter((item) => item.targetType !== "sleep").map((item) => sessionEntry(item, timezone)),
        sleep: [
          ...sessions.filter((item) => item.targetType === "sleep").map((item) => sessionEntry(item, timezone)),
          ...(sleepPlansByDay.get(key) ?? [])
        ],
        occurrences: (occurrencesByDay.get(key) ?? []).map((item) => occurrenceEntry(item, state))
      });
    }
    weeks.push({ days, ...bandsForWeek(weekStart, state.spans) });
  }

  const title =
    view === "month"
      ? monthName().format(utc(rangeStart))
      : `${dayMonth().format(utc(rangeStart))} – ${dayMonthYear().format(utc(rangeEnd))}`;
  return { view, title, rangeStart, rangeEnd, weeks, ...(anyBeforeWindow ? { notice: OLDER_THAN_WINDOW_NOTICE } : {}) };
}
