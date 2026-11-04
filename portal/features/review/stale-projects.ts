import type { StoredProject } from "@/state/portal-state";

/** A project the review wakes up: nothing worked for this long, and not kept inside the Keep window. */
export const STALE_AFTER_DAYS = 7;
/** How long a Keep holds a project off the stale list. A parked project should not come back every week. */
export const KEEP_FOR_DAYS = 30;

const DAY_MS = 24 * 60 * 60_000;

/**
 * Active, not in this week's or month's focus, and neither worked on in the last week nor kept (the review's
 * Keep, `lastReviewedAt`) in the last 30 days. Keep is stored on the server, so it holds across devices and
 * browsers, and this is the one place the window is applied.
 */
export function isStaleProject(project: StoredProject, now: Date, focusIds: ReadonlySet<string> = new Set()): boolean {
  if (project.status !== "active" || focusIds.has(project.id)) return false;
  const worked = project.lastWorkedAt ? new Date(project.lastWorkedAt).getTime() : -Infinity;
  const kept = project.lastReviewedAt ? new Date(project.lastReviewedAt).getTime() : -Infinity;
  return worked < now.getTime() - STALE_AFTER_DAYS * DAY_MS && kept < now.getTime() - KEEP_FOR_DAYS * DAY_MS;
}

/**
 * Whether "Seen, leave it" was pressed on this project during the review week that starts on `weekStart`
 * (a `YYYY-MM-DD` date in `timeZone`). A new week asks again.
 */
export function overdueSeenThisWeek(project: StoredProject, weekStart: string, timeZone: string): boolean {
  if (!project.overdueSeenAt) return false;
  const day = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(project.overdueSeenAt));
  return day >= weekStart;
}
