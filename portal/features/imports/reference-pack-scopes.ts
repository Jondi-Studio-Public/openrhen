import { displayLocale } from "@/shared/locale";
import type { PortalState } from "@/state/portal-state";
import type { ReferencePackScope, ReferencePackScopeType } from "./reference-pack-types";

/**
 * The reference browser walks the plan as folders. A location is where the browser currently is; a
 * scope is what the user has ticked. They share names because entering a folder and selecting it are
 * the same node seen two ways, but only scopes are ever sent to the reference-pack routes.
 */
export type ReferenceLocation = { type: "root" } | ReferencePackScope;
export type ReferenceBrowserRow = {
  scope: ReferencePackScope;
  label: string;
  detail: string;
  childCount: number;
  location?: ReferenceLocation;
};

export function scopeKey(scope: ReferencePackScope) {
  return `${scope.type}:${scope.id ?? ""}`;
}

export function referenceScopeQuery(scopes: ReferencePackScope[]) {
  return scopes.map((scope) => `scope=${encodeURIComponent(scopeKey(scope))}`).join("&");
}

export function referenceRows(state: PortalState, location: ReferenceLocation): ReferenceBrowserRow[] {
  if (location.type === "root")
    return [
      {
        scope: { type: "plan" },
        label: "Entire plan",
        detail: "Areas, outcomes, projects, deliverables, and actions",
        childCount: state.areas.length,
        location: { type: "plan" }
      },
      {
        scope: { type: "fixed_commitments" },
        label: "Fixed commitments",
        detail: `${state.commitments.length} dated commitments`,
        childCount: state.commitments.length,
        location: { type: "fixed_commitments" }
      }
    ];
  if (location.type === "plan")
    return state.areas.map((item) => ({
      scope: { type: "area", id: item.id },
      label: item.name,
      detail: item.description || "Area",
      childCount: state.outcomes.filter((outcome) => outcome.areaId === item.id).length,
      location: { type: "area", id: item.id }
    }));
  if (location.type === "area")
    return state.outcomes
      .filter((item) => item.areaId === location.id)
      .map((item) => ({
        scope: { type: "outcome", id: item.id },
        label: item.title,
        detail: `Outcome · ${item.status}`,
        childCount: state.projects.filter((project) => project.outcomeId === item.id).length,
        location: { type: "outcome", id: item.id }
      }));
  if (location.type === "outcome")
    return state.projects
      .filter((item) => item.outcomeId === location.id)
      .map((item) => ({
        scope: { type: "project", id: item.id },
        label: item.title,
        detail: `Project · ${item.status}`,
        childCount:
          state.actions.filter((action) => action.projectId === item.id).length +
          state.deliverables.filter((deliverable) => deliverable.projectId === item.id).length,
        location: { type: "project", id: item.id }
      }));
  if (location.type === "project")
    return [
      ...state.deliverables
        .filter((item) => item.projectId === location.id)
        .map((item) => ({
          scope: { type: "deliverable" as const, id: item.id },
          label: item.title,
          detail: `Deliverable · ${item.status}`,
          childCount: 0
        })),
      ...state.actions
        .filter((item) => item.projectId === location.id)
        .map((item) => ({
          scope: { type: "action" as const, id: item.id },
          label: item.title,
          detail: `Action · ${item.status}`,
          childCount: 0
        }))
    ];
  if (location.type === "fixed_commitments")
    return state.commitments.map((item) => ({
      scope: { type: "fixed_commitment", id: item.id },
      label: item.title,
      detail: `${new Date(item.startsAt).toLocaleString(displayLocale())} · ${item.status}`,
      childCount: 0
    }));
  return [];
}

export function referenceCrumbs(
  state: PortalState,
  location: ReferenceLocation
): Array<{ label: string; location: ReferenceLocation }> {
  const crumbs: Array<{ label: string; location: ReferenceLocation }> = [
    { label: "Reference", location: { type: "root" } }
  ];
  if (location.type === "root") return crumbs;
  if (["plan", "area", "outcome", "project", "deliverable"].includes(location.type))
    crumbs.push({ label: "Entire plan", location: { type: "plan" } });
  if (location.type === "area")
    crumbs.push({ label: state.areas.find((item) => item.id === location.id)?.name ?? "Area", location });
  if (location.type === "outcome" || location.type === "project" || location.type === "deliverable") {
    const projectId =
      location.type === "project"
        ? location.id
        : location.type === "deliverable"
          ? state.deliverables.find((item) => item.id === location.id)?.projectId
          : undefined;
    const outcome =
      location.type === "outcome"
        ? state.outcomes.find((item) => item.id === location.id)
        : state.outcomes.find(
            (item) => item.id === state.projects.find((project) => project.id === projectId)?.outcomeId
          );
    const area = state.areas.find((item) => item.id === outcome?.areaId);
    if (area) crumbs.push({ label: area.name, location: { type: "area", id: area.id } });
    if (outcome) crumbs.push({ label: outcome.title, location: { type: "outcome", id: outcome.id } });
  }
  if (location.type === "project")
    crumbs.push({ label: state.projects.find((item) => item.id === location.id)?.title ?? "Project", location });
  if (location.type === "deliverable") {
    const deliverable = state.deliverables.find((item) => item.id === location.id);
    const project = state.projects.find((item) => item.id === deliverable?.projectId);
    if (project) crumbs.push({ label: project.title, location: { type: "project", id: project.id } });
    crumbs.push({ label: deliverable?.title ?? "Deliverable", location });
  }
  if (location.type === "fixed_commitments") crumbs.push({ label: "Fixed commitments", location });
  return crumbs;
}

/** Whether ticking `parent` already includes `child`, which is what greys the child's checkbox out. */
export function scopeCovers(state: PortalState, parent: ReferencePackScope, child: ReferencePackScope): boolean {
  if (scopeKey(parent) === scopeKey(child)) return true;
  if (parent.type === "all") return true;
  if (parent.type === "plan") return ["area", "outcome", "project", "deliverable", "action"].includes(child.type);
  if (parent.type === "fixed_commitments") return child.type === "fixed_commitment";
  const childAction = child.type === "action" ? state.actions.find((item) => item.id === child.id) : undefined;
  const childDeliverable =
    child.type === "deliverable" ? state.deliverables.find((item) => item.id === child.id) : undefined;
  const childProject =
    child.type === "project"
      ? state.projects.find((item) => item.id === child.id)
      : childAction
        ? state.projects.find((item) => item.id === childAction.projectId)
        : childDeliverable
          ? state.projects.find((item) => item.id === childDeliverable.projectId)
          : undefined;
  const childOutcome =
    child.type === "outcome"
      ? state.outcomes.find((item) => item.id === child.id)
      : childProject
        ? state.outcomes.find((item) => item.id === childProject.outcomeId)
        : undefined;
  if (parent.type === "area") return child.type !== "area" && childOutcome?.areaId === parent.id;
  if (parent.type === "outcome")
    return ["project", "deliverable", "action"].includes(child.type) && childOutcome?.id === parent.id;
  if (parent.type === "project")
    return ["deliverable", "action"].includes(child.type) && childProject?.id === parent.id;
  return false;
}

/**
 * What the download will actually contain. Selecting a leaf still pulls in the ancestors that give it
 * meaning and the prerequisites it depends on, so the count shown is the closure, not the ticks.
 */
export function referenceCounts(state: PortalState, scopes: ReferencePackScope[]) {
  const areaIds = new Set<string>();
  const outcomeIds = new Set<string>();
  const projectIds = new Set<string>();
  const deliverableIds = new Set<string>();
  const actionIds = new Set<string>();
  const commitmentIds = new Set<string>();
  for (const scope of scopes) {
    if (scope.type === "all" || scope.type === "plan") {
      state.areas.forEach((item) => areaIds.add(item.id));
      state.outcomes.forEach((item) => outcomeIds.add(item.id));
      state.projects.forEach((item) => projectIds.add(item.id));
      state.deliverables.forEach((item) => deliverableIds.add(item.id));
      state.actions.forEach((item) => actionIds.add(item.id));
    }
    if (scope.type === "area") {
      areaIds.add(scope.id!);
      state.outcomes.filter((item) => item.areaId === scope.id).forEach((item) => outcomeIds.add(item.id));
    }
    if (scope.type === "outcome") outcomeIds.add(scope.id!);
    if (scope.type === "project") projectIds.add(scope.id!);
    if (scope.type === "deliverable") deliverableIds.add(scope.id!);
    if (scope.type === "action") actionIds.add(scope.id!);
    if (scope.type === "all" || scope.type === "fixed_commitments")
      state.commitments.forEach((item) => commitmentIds.add(item.id));
    if (scope.type === "fixed_commitment") commitmentIds.add(scope.id!);
  }
  let changed = true;
  while (changed) {
    changed = false;
    state.projects
      .filter((item) => outcomeIds.has(item.outcomeId))
      .forEach((item) => {
        if (!projectIds.has(item.id)) {
          projectIds.add(item.id);
          changed = true;
        }
      });
    state.deliverables
      .filter((item) => projectIds.has(item.projectId))
      .forEach((item) => {
        if (!deliverableIds.has(item.id)) {
          deliverableIds.add(item.id);
          changed = true;
        }
      });
    state.actions
      .filter((item) => projectIds.has(item.projectId))
      .forEach((item) => {
        if (!actionIds.has(item.id)) {
          actionIds.add(item.id);
          changed = true;
        }
      });
    for (const deliverable of state.deliverables.filter((item) => deliverableIds.has(item.id)))
      for (const id of deliverable.dependencyIds)
        if (!deliverableIds.has(id) && state.deliverables.some((item) => item.id === id)) {
          deliverableIds.add(id);
          changed = true;
        }
    for (const action of state.actions.filter((item) => actionIds.has(item.id)))
      for (const id of action.dependencyIds)
        if (!actionIds.has(id) && state.actions.some((item) => item.id === id)) {
          actionIds.add(id);
          changed = true;
        }
  }
  state.deliverables.filter((item) => deliverableIds.has(item.id)).forEach((item) => projectIds.add(item.projectId));
  state.actions.filter((item) => actionIds.has(item.id)).forEach((item) => projectIds.add(item.projectId));
  state.projects.filter((item) => projectIds.has(item.id)).forEach((item) => outcomeIds.add(item.outcomeId));
  state.outcomes.filter((item) => outcomeIds.has(item.id)).forEach((item) => areaIds.add(item.areaId));
  return {
    areas: areaIds.size,
    outcomes: outcomeIds.size,
    projects: projectIds.size,
    deliverables: deliverableIds.size,
    actions: actionIds.size,
    commitments: commitmentIds.size
  };
}

export function scopeLabel(state: PortalState, scope: ReferencePackScope) {
  const labels: Partial<Record<ReferencePackScopeType, string>> = {
    all: "Entire reference set",
    plan: "Entire plan",
    fixed_commitments: "All fixed commitments"
  };
  if (labels[scope.type]) return labels[scope.type]!;
  if (scope.type === "area") return state.areas.find((item) => item.id === scope.id)?.name ?? "Area";
  if (scope.type === "outcome") return state.outcomes.find((item) => item.id === scope.id)?.title ?? "Outcome";
  if (scope.type === "project") return state.projects.find((item) => item.id === scope.id)?.title ?? "Project";
  if (scope.type === "deliverable")
    return state.deliverables.find((item) => item.id === scope.id)?.title ?? "Deliverable";
  if (scope.type === "action") return state.actions.find((item) => item.id === scope.id)?.title ?? "Action";
  return state.commitments.find((item) => item.id === scope.id)?.title ?? "Commitment";
}
