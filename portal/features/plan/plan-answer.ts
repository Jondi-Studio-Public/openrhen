import type { StoredProject } from "@/state/portal-state";
import type { ClientForecast } from "@/state/portal-provider";
import { displayHealth, isLapsedSelfSet } from "@/features/plan/plan-formatting";

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/**
 * Plan's one answer sentence: does the math work? Read from the active projects' forecasts, worst
 * first: a project past its real deadline or behind means no, at risk means tight, and otherwise it
 * works. A lapsed self-set date is stale rather than overdue, so it does
 * not count against the math here; the area row says it lapsed.
 */
export function planAnswer(projects: StoredProject[], forecasts: ClientForecast[], decisions: number): string {
  const active = new Set(projects.filter((project) => project.status === "active").map((project) => project.id));
  const read = forecasts.filter((forecast) => active.has(forecast.projectId));
  const behind = read.filter(
    (forecast) => (forecast.overdue && !isLapsedSelfSet(forecast)) || displayHealth(forecast) === "behind"
  ).length;
  const atRisk = read.filter((forecast) => !forecast.overdue && displayHealth(forecast) === "at_risk").length;
  const forecastable = read.filter((forecast) => displayHealth(forecast) !== "unknown").length;
  const math =
    behind > 0
      ? `The math does not work yet: ${plural(behind, "project is", "projects are")} behind.`
      : atRisk > 0
        ? `The math is tight: ${plural(atRisk, "project is", "projects are")} at risk.`
        : forecastable > 0
          ? "The math works: every dated project fits in the time you have."
          : "Nothing has a date and an estimate yet, so there is no math to check.";
  if (decisions === 0) return math;
  return `${math} ${decisions === 1 ? "One thing needs a decision before it can be planned." : `${decisions} things need a decision before they can be planned.`}`;
}
