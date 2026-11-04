import type { Action, ActionEffort } from "../model/types.js";

export interface DependencyAnalysis {
  order: string[];
  errors: string[];
  unresolvedByAction: Record<string, string[]>;
  criticalMinutesByAction: Record<string, number>;
  /** The longest chain of remaining minutes that waits on this action: its critical path less itself. */
  downstreamMinutesByAction: Record<string, number>;
}

export function analyzeDependencies(actions: Action[], efforts: ActionEffort[] = []): DependencyAnalysis {
  const byId = new Map(actions.map((action) => [action.id, action]));
  const effortById = new Map(efforts.map((effort) => [effort.actionId, effort.riskAdjustedRemainingMinutes]));
  const indegree = new Map(actions.map((action) => [action.id, 0]));
  const successors = new Map(actions.map((action) => [action.id, [] as string[]]));
  const unresolvedByAction: Record<string, string[]> = {};

  for (const action of actions) {
    const missing = (action.dependencyIds ?? []).filter((id) => !byId.has(id));
    if (missing.length) unresolvedByAction[action.id] = missing;
    for (const dependencyId of action.dependencyIds ?? []) {
      if (!byId.has(dependencyId)) continue;
      indegree.set(action.id, (indegree.get(action.id) ?? 0) + 1);
      successors.get(dependencyId)!.push(action.id);
    }
  }

  const queue = actions
    .filter((action) => indegree.get(action.id) === 0)
    .map((action) => action.id)
    .sort();
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const successor of [...successors.get(id)!].sort()) {
      const next = (indegree.get(successor) ?? 0) - 1;
      indegree.set(successor, next);
      if (next === 0) {
        queue.push(successor);
        queue.sort();
      }
    }
  }

  const cyclic = actions
    .map((action) => action.id)
    .filter((id) => !order.includes(id))
    .sort();
  const errors = [
    ...(cyclic.length ? [`Dependency cycle includes: ${cyclic.join(", ")}.`] : []),
    ...Object.entries(unresolvedByAction).map(
      ([id, missing]) => `${id} has missing dependencies: ${missing.join(", ")}.`
    )
  ];
  const criticalMinutesByAction: Record<string, number> = {};
  const downstreamMinutesByAction: Record<string, number> = {};
  for (const id of [...order].reverse()) {
    const successorCritical = successors.get(id)!.map((successor) => criticalMinutesByAction[successor] ?? 0);
    downstreamMinutesByAction[id] = Math.max(0, ...successorCritical);
    criticalMinutesByAction[id] =
      (effortById.get(id) ?? byId.get(id)?.remainingMinutes ?? 0) + downstreamMinutesByAction[id];
  }
  return { order, errors, unresolvedByAction, criticalMinutesByAction, downstreamMinutesByAction };
}
