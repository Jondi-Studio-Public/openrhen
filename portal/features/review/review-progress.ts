import { isClosedStatus } from "@openrhen/contracts";
import type { PlanningFocus, PortalState } from "@/state/portal-state";
import type { ClientForecast } from "@/state/portal-provider";
import { focusableProjects, focusSelection, periodFor } from "./planning-focus-period";
import { isStaleProject, overdueSeenThisWeek } from "./stale-projects";

const OPEN_ACTION = (status: string) => !(status === "done" || isClosedStatus(status));
const DAY_MS = 24 * 60 * 60_000;

/** A `YYYY-MM-DD` date in `timeZone`. */
export function localDay(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/** The `YYYY-MM-DD` day a date or datetime string names: a plain date as written, a datetime as seen in `timeZone`. */
function dayOf(value: string, timeZone: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : localDay(new Date(value), timeZone);
}

/** `days` after a plain `YYYY-MM-DD` date, as a plain date. */
export function addDays(day: string, days: number): string {
  return new Date(new Date(`${day}T00:00:00Z`).getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Where the weekly review stands this week: what each of its three steps still holds, and whether it has been
 * finished (a saved `reviewedOn` date on this week's focus record). One place, so the Review page, the tab's
 * dot and Now's line cannot disagree about whether the review is due.
 *
 * An outcome is due when its review date has come, or its deadline has passed and no later review date is set:
 * "Keep going" pushes the review date out, which also quiets a passed deadline.
 */
export function reviewProgress(full: PortalState, forecasts: readonly ClientForecast[], now: Date) {
  // Partial states (a tab strip over a bare fixture) read as empty rather than throwing.
  const state = {
    ...full,
    actions: full.actions ?? [],
    outcomes: full.outcomes ?? [],
    projects: full.projects ?? [],
    planningFocus: full.planningFocus ?? []
  };
  const timezone = state.settings.timezone;
  const weeklyPeriod = periodFor("weekly", now, timezone);
  const monthlyPeriod = periodFor("monthly", now, timezone);
  const today = localDay(now, timezone);

  const stuck = state.actions.filter((action) => action.status === "blocked" || action.status === "waiting");
  const dueOutcomes = state.outcomes.filter((outcome) => {
    if (outcome.status !== "active") return false;
    // A review date is a day (or a datetime that falls on one) in the portal timezone, never UTC midnight.
    const reviewDay = outcome.reviewOn ? dayOf(outcome.reviewOn, timezone) : undefined;
    if (reviewDay && reviewDay <= today) return true;
    if (!outcome.deadlineAt || new Date(outcome.deadlineAt) >= now) return false;
    // A review date set after the passed deadline (Keep going) quiets it; an older one does not.
    return !(reviewDay && reviewDay > localDay(new Date(outcome.deadlineAt), timezone));
  });
  const endedSeries = state.actions.filter(
    (action) =>
      action.schedulingMode === "recurring" &&
      action.recurrence?.endDate &&
      action.recurrence.endDate < today &&
      OPEN_ACTION(action.status)
  );
  // An overdue project marked "Seen, leave it" this review week stops counting; the date is still missed.
  const seenOverdue = (projectId: string) => {
    const project = state.projects.find((item) => item.id === projectId);
    return project ? overdueSeenThisWeek(project, weeklyPeriod.start, timezone) : false;
  };
  const openForecasts = forecasts.filter((forecast) => !(forecast.overdue && seenOverdue(forecast.projectId)));
  const proposals = openForecasts.filter((forecast) => forecast.overdue || forecast.interventions?.length).length;
  const blockers = dueOutcomes.length + endedSeries.length + proposals;

  const weeklyRecord = state.planningFocus.find(
    (item) => item.kind === "weekly" && item.periodStart === weeklyPeriod.start
  );
  const monthlyRecord = state.planningFocus.find(
    (item) => item.kind === "monthly" && item.periodStart === monthlyPeriod.start
  );
  const weeklyIds = focusSelection(weeklyRecord?.projectIds ?? [], state.projects);
  const monthlyIds = focusSelection(monthlyRecord?.projectIds ?? [], state.projects);
  const selected = [...new Set([...weeklyIds, ...monthlyIds])];
  const stale = state.projects.filter((project) => isStaleProject(project, now, new Set(selected)));

  // Step 3 is done with a focus chosen, with "No focus this week" saved, or when there is nothing to choose from.
  const focusDone =
    weeklyIds.length > 0 ||
    (weeklyRecord !== undefined && weeklyRecord.projectIds.length === 0) ||
    focusableProjects(state.projects).length === 0;

  // Last week's focus, offered again while this week has none.
  const lastWeekStart = addDays(weeklyPeriod.start, -7);
  const lastWeekRecord = state.planningFocus.find(
    (item) => item.kind === "weekly" && item.periodStart === lastWeekStart
  );
  const lastWeekIds = focusSelection(lastWeekRecord?.projectIds ?? [], state.projects);

  const stepsOpen = [blockers > 0, stale.length > 0, !focusDone] as const;
  const stepsLeft = stepsOpen.filter(Boolean).length;
  const reviewedOn = weeklyRecord?.reviewedOn;
  return {
    timezone,
    today,
    weeklyPeriod,
    monthlyPeriod,
    stuck,
    dueOutcomes,
    endedSeries,
    openForecasts,
    proposals,
    blockers,
    weeklyRecord: weeklyRecord as PlanningFocus | undefined,
    weeklyIds,
    monthlyIds,
    selected,
    stale,
    focusDone,
    lastWeekIds,
    stepsOpen,
    stepsLeft,
    reviewedOn,
    /** Steps remain and the week has not been marked finished: the Review tab's dot and Now's line. */
    due: stepsLeft > 0 && !reviewedOn
  };
}
