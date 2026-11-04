import type { PortalState, StoredAction } from "@/state/portal-state";

export interface DirectionScope {
  areaId: string;
  outcomeId: string;
  projectId: string;
}
export interface DirectionOption {
  id: string;
  label: string;
  detail?: string;
}

export const emptyDirectionScope: DirectionScope = { areaId: "", outcomeId: "", projectId: "" };
export const directionWinStatuses: StoredAction["status"][] = ["planned", "active", "doing"];

/** Drops a narrower choice when an ancestor choice no longer contains it, so the dropdowns stay consistent. */
export function normalizeDirectionScope(state: PortalState, scope: DirectionScope): DirectionScope {
  const outcome = state.outcomes.find((item) => item.id === scope.outcomeId);
  const outcomeId = outcome && (!scope.areaId || outcome.areaId === scope.areaId) ? outcome.id : "";
  const project = state.projects.find((item) => item.id === scope.projectId);
  const projectOutcome = state.outcomes.find((item) => item.id === project?.outcomeId);
  const projectMatches =
    project &&
    (!outcomeId || project.outcomeId === outcomeId) &&
    (!scope.areaId || projectOutcome?.areaId === scope.areaId);
  return {
    areaId: state.areas.some((item) => item.id === scope.areaId) ? scope.areaId : "",
    outcomeId,
    projectId: projectMatches ? project.id : ""
  };
}

export function directionAreaOptions(state: PortalState): DirectionOption[] {
  return state.areas.map((area) => ({ id: area.id, label: area.name }));
}

export function directionOutcomeOptions(state: PortalState, scope: DirectionScope): DirectionOption[] {
  return state.outcomes
    .filter((outcome) => !scope.areaId || outcome.areaId === scope.areaId)
    .map((outcome) => ({ id: outcome.id, label: outcome.title }));
}

export function directionProjectOptions(state: PortalState, scope: DirectionScope): DirectionOption[] {
  const outcomes = new Set(directionOutcomeOptions(state, scope).map((option) => option.id));
  return state.projects
    .filter((project) => (scope.outcomeId ? project.outcomeId === scope.outcomeId : outcomes.has(project.outcomeId)))
    .map((project) => ({ id: project.id, label: project.title }));
}

/** Actions available as desired wins inside the chosen folder, deepest choice wins. */
export function directionActionOptions(state: PortalState, scope: DirectionScope): DirectionOption[] {
  const projects = new Set(directionProjectOptions(state, scope).map((option) => option.id));
  return state.actions
    .filter((action) => directionWinStatuses.includes(action.status))
    .filter((action) => (scope.projectId ? action.projectId === scope.projectId : projects.has(action.projectId)))
    .map((action) => ({
      id: action.id,
      label: action.title,
      detail: state.projects.find((project) => project.id === action.projectId)?.title ?? "No project"
    }));
}

/** Area / outcome / project / action trail for a saved win, so a chip stays readable without opening the picker. */
export function directionActionPath(state: PortalState, actionId: string): string[] {
  const action = state.actions.find((item) => item.id === actionId);
  if (!action) return [];
  const project = state.projects.find((item) => item.id === action.projectId);
  const outcome = state.outcomes.find((item) => item.id === project?.outcomeId);
  const area = state.areas.find((item) => item.id === outcome?.areaId);
  return [area?.name, outcome?.title, project?.title, action.title].filter((value): value is string => Boolean(value));
}
