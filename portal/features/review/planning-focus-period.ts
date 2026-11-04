import { dateTimeFormat, displayLocale } from "@/shared/locale";
/**
 * The current weekly or monthly period boundary in the given timezone. Both `/review` (to read the
 * stored focus selection) and `/review/focus` (to edit it) need to resolve the same boundary to find
 * or write the matching `planning_focus` record, so it lives here once rather than twice.
 */
export function periodFor(kind: "weekly" | "monthly", now: Date, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(now)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );
  const date = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
  if (kind === "weekly") {
    const offset = (date.getUTCDay() + 6) % 7;
    const start = new Date(date.getTime() - offset * 86_400_000);
    const end = new Date(start.getTime() + 6 * 86_400_000);
    return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
  }
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

/** The projects a focus period can hold: active and undated (a dated project forecasts on its own). */
export function focusableProjects<
  T extends { id: string; status: string; internalDeadlineAt?: unknown; externalDeadlineAt?: unknown }
>(projects: readonly T[]): T[] {
  return projects.filter(
    (project) => project.status === "active" && !project.internalDeadlineAt && !project.externalDeadlineAt
  );
}

/**
 * A stored selection reduced to the projects it can still hold. A project that has since gained a
 * deadline, finished or been archived stays in the saved record until the next save, but it is not
 * shown as a checkbox, so counting it would say "3 selected" over a list with nothing ticked.
 */
export function focusSelection(
  ids: readonly string[],
  projects: readonly { id: string; status: string; internalDeadlineAt?: unknown; externalDeadlineAt?: unknown }[]
): string[] {
  const allowed = new Set(focusableProjects(projects).map((project) => project.id));
  return ids.filter((id) => allowed.has(id));
}

/** "26 Oct – 1 Nov 2026" for a week, "October 2026" for a month (period dates are plain YYYY-MM-DD). */
export function periodLabel(kind: "weekly" | "monthly", period: { start: string; end: string }): string {
  const day = (value: string) => new Date(`${value}T00:00:00Z`);
  if (kind === "monthly")
    return dateTimeFormat(displayLocale(), { month: "long", year: "numeric", timeZone: "UTC" }).format(
      day(period.start)
    );
  const short = dateTimeFormat(displayLocale(), { day: "numeric", month: "short", timeZone: "UTC" });
  const year = dateTimeFormat(displayLocale(), { year: "numeric", timeZone: "UTC" });
  return `${short.format(day(period.start))} – ${short.format(day(period.end))} ${year.format(day(period.end))}`;
}
