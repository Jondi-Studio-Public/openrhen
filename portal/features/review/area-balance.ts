import type { PortalState } from "@/state/portal-state";
import { resolveProjectAreaId, sortedAreas, UNASSIGNED_AREA_ID } from "@/features/plan/area-grouping";

/** Four whole weeks: long enough that one busy week does not hide an area, short enough to be this month. */
export const AREA_BALANCE_WINDOW_DAYS = 28;

export interface AreaBalanceRow {
  areaId: string;
  name: string;
  recordedMinutes: number;
  /** This area's share of all recorded time in the window, 0 to 1; 0 when nothing was recorded. */
  share: number;
  activeOutcomes: number;
  activeProjects: number;
  /** Has active outcomes or projects, yet no time was recorded against it in the window. */
  neglected: boolean;
}

/**
 * Where recorded time went, by area, over the last `AREA_BALANCE_WINDOW_DAYS` (a review
 * signal only, never a ranking term). Projects resolve to areas the same way Plan groups them. Every
 * active area is listed, busiest first; the unassigned bucket appears only when time landed in it.
 */
export function areaBalance(
  state: Pick<PortalState, "areas" | "outcomes" | "projects">,
  recorded: { projectId: string; minutes: number }[]
): AreaBalanceRow[] {
  const minutesByArea = new Map<string, number>();
  for (const entry of recorded) {
    const project = state.projects.find((item) => item.id === entry.projectId);
    const areaId = project ? resolveProjectAreaId(project, state.outcomes, state.areas) : UNASSIGNED_AREA_ID;
    minutesByArea.set(areaId, (minutesByArea.get(areaId) ?? 0) + entry.minutes);
  }
  const total = [...minutesByArea.values()].reduce((sum, minutes) => sum + minutes, 0);
  const rows: AreaBalanceRow[] = sortedAreas(state.areas)
    .filter((area) => area.status === "active")
    .map((area) => {
      const recordedMinutes = minutesByArea.get(area.id) ?? 0;
      const activeOutcomes = state.outcomes.filter(
        (outcome) => outcome.areaId === area.id && outcome.status === "active"
      ).length;
      const activeProjects = state.projects.filter(
        (project) =>
          project.status === "active" && resolveProjectAreaId(project, state.outcomes, state.areas) === area.id
      ).length;
      return {
        areaId: area.id,
        name: area.name,
        recordedMinutes,
        share: total ? recordedMinutes / total : 0,
        activeOutcomes,
        activeProjects,
        neglected: recordedMinutes === 0 && activeOutcomes + activeProjects > 0
      };
    });
  const unassigned = minutesByArea.get(UNASSIGNED_AREA_ID) ?? 0;
  if (unassigned > 0)
    rows.push({
      areaId: UNASSIGNED_AREA_ID,
      name: "Unassigned",
      recordedMinutes: unassigned,
      share: unassigned / total,
      activeOutcomes: 0,
      activeProjects: 0,
      neglected: false
    });
  return rows.sort((a, b) => b.recordedMinutes - a.recordedMinutes);
}
