import { isClosedStatus } from "@openrhen/contracts";
import type { StoredArea, StoredOutcome, StoredProject } from "@/state/portal-state";

/**
 * Where a project lives when nothing on it points at a real area at all: its outcome is missing, or
 * the outcome's own area was removed, and the legacy `project.area` name matches nothing either. A
 * reserved id rather than `null`, so it can be a route (`/plan/unassigned`) the same way a real area
 * id is.
 */
export const UNASSIGNED_AREA_ID = "unassigned";

/**
 * A project's area, in order of how much it should be trusted: the outcome it belongs to names an
 * area directly, which is what every project saved through the current editors has. Older data saved
 * before outcomes existed only has `project.area` as free text, so that name is matched against the
 * areas that exist now as a fallback. Failing both, the project is unassigned rather than silently
 * dropped from every area's count.
 */
export function resolveProjectAreaId(project: StoredProject, outcomes: StoredOutcome[], areas: StoredArea[]): string {
  const outcome = outcomes.find((item) => item.id === project.outcomeId);
  const byOutcome = outcome ? areas.find((area) => area.id === outcome.areaId) : undefined;
  if (byOutcome) return byOutcome.id;
  const byLegacyName = areas.find((area) => area.name === project.area);
  return byLegacyName ? byLegacyName.id : UNASSIGNED_AREA_ID;
}

/** Where a project sits in Plan: its area's page, scrolled to its card (`AreaDetail` reads the hash). */
export function projectPlanHref(project: StoredProject, outcomes: StoredOutcome[], areas: StoredArea[]): string {
  return `/plan/${resolveProjectAreaId(project, outcomes, areas)}#project-${project.id}`;
}

/** Where an outcome sits in Plan; an outcome whose area is gone is listed under Unassigned. */
export function outcomePlanHref(outcome: StoredOutcome, areas: StoredArea[]): string {
  const areaId = areas.some((area) => area.id === outcome.areaId) ? outcome.areaId : UNASSIGNED_AREA_ID;
  return `/plan/${areaId}#outcome-${outcome.id}`;
}

/** Every project that resolves to the given area id (or to `UNASSIGNED_AREA_ID`). */
export function projectsForArea(
  areaId: string,
  projects: StoredProject[],
  outcomes: StoredOutcome[],
  areas: StoredArea[]
): StoredProject[] {
  return projects.filter((project) => resolveProjectAreaId(project, outcomes, areas) === areaId);
}

/**
 * The projects a picker offers: closed ones (archived or cancelled) are left out so new work does not land in
 * them, except the one already chosen, which stays listed so an existing record still shows where it sits.
 */
export function selectableProjects<T extends { id: string; status: string }>(projects: T[], selectedId: string): T[] {
  return projects.filter((project) => project.id === selectedId || !isClosedStatus(project.status));
}

/** Areas in the order `/plan` shows them: `sortOrder` first, then name for anything tied. */
export function sortedAreas(areas: StoredArea[]): StoredArea[] {
  return [...areas].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
}

/**
 * The areas `/plan` shows in its grid, and the archived ones it folds away at the end — each half in
 * `sortedAreas` order. Archiving an area is how it leaves the plan without losing its history, so it
 * should not stand in the grid looking like a live one.
 */
export function partitionArchivedAreas(areas: StoredArea[]): { live: StoredArea[]; archived: StoredArea[] } {
  const ordered = sortedAreas(areas);
  return {
    live: ordered.filter((area) => area.status !== "archived"),
    archived: ordered.filter((area) => area.status === "archived")
  };
}
