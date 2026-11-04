import type { BlockerCategory, StoredDeliverable } from "@/state/portal-state";
import { createClientId } from "@/shared/client-id";

export type VerificationMethod = NonNullable<StoredDeliverable["criteria"][number]["verificationMethod"]>;

/**
 * What the assistant may add after the person agrees to it in the Breakdown conversation, or amend
 * mid-flight through extend_plan in Carry out.
 *
 * A criterion carries the same provenance the retired bulk extraction captured — where in the brief
 * it comes from, what would demonstrate it, how it gets verified — so pulling requirements out of an
 * attached source through conversation loses nothing by being incremental.
 *
 * A step whose title matches one that already exists is not recreated: `dependsOnStepTitles` is
 * instead read as ADDITIONAL prerequisites to splice onto that existing step — the retrofit a
 * revision loop needs to make an old handoff step wait on newly agreed steps it never knew about
 * when it was created. `details` and `reblockOnComplete` only ever apply to a step being created new.
 */
export interface WorkspaceAddition {
  criteria: {
    title: string;
    required: boolean;
    interpretation?: string;
    sourceDocument?: string;
    sourceLocation?: string;
    expectedEvidence?: string;
    verificationMethod?: VerificationMethod;
  }[];
  steps: {
    title: string;
    expectedMinutes: number;
    criteriaServed: string[];
    dependsOnStepTitles: string[];
    /** Provenance for a newly created step, e.g. "From teacher feedback: …". Ignored on retrofit. */
    details?: string;
    /**
     * Structural, conditional re-arm for a newly created resubmit/hand-back step: see
     * `StoredDeliverableStep.reblockOnComplete`. Ignored on retrofit.
     */
    reblockOnComplete?: { description: string; category: BlockerCategory };
  }[];
}

/**
 * What extend_plan may pass: the same step shape a breakdown addition uses, without criteria — steps
 * only, so a plan amendment mid-flight can never double as a route to changing completion criteria.
 */
export interface PlanExtension {
  steps: WorkspaceAddition["steps"];
}

export interface BreakdownMerge {
  deliverable: StoredDeliverable;
  addedCriteria: number;
  addedSteps: number;
  addedLinks: number;
  /** New prerequisite edges spliced onto steps that already existed before this addition. */
  addedDependencies: number;
  /**
   * Titles a step's `dependsOnStepTitles` named that resolved to nothing — not an existing step, not
   * a step created earlier in this same addition, or the step's own title. Reported rather than
   * silently dropped: a chain that failed to link would leave a step wrongly executable during a
   * blocker it was meant to inherit.
   */
  unresolvedDependencyTitles: string[];
  /**
   * The chain of step titles a dependency cycle this addition would create, starting and ending on the
   * same title — for example `["Resubmit and get approval", "Redraw the callouts", "Resubmit and get
   * approval"]`. Checked over the FULL resulting step graph, not just what this addition touched,
   * because a retrofit onto one existing step (extend_plan's whole purpose) can close a loop through
   * steps this call never names directly. Null when the resulting graph has no cycle. A step that
   * depends on itself through a cycle can never become the earliest, uncompleted, undepended-on step
   * the engine looks for, so it — and everything chained after it — would silently stall forever;
   * reported here rather than persisted, same as an unresolved dependency title above.
   */
  cyclePath: string[] | null;
  changed: boolean;
}

/**
 * Depth-first cycle detection over a step's `dependencyIds`, the same `visiting`/`visited` two-set
 * technique `entity-commands.ts` uses for a context definition's pathways. Returns the titles along
 * one discovered cycle (closing back on its own start) or null when the graph is a DAG — a diamond,
 * where two steps share a common dependency, is not a cycle and must not be reported as one.
 */
function findDependencyCycle(steps: StoredDeliverable["steps"]): string[] | null {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  const visit = (id: string): string[] | null => {
    if (visiting.has(id)) return [...stack.slice(stack.indexOf(id)), id];
    if (visited.has(id)) return null;
    visiting.add(id);
    stack.push(id);
    for (const dependencyId of byId.get(id)?.dependencyIds ?? []) {
      const found = visit(dependencyId);
      if (found) return found;
    }
    stack.pop();
    visiting.delete(id);
    visited.add(id);
    return null;
  };

  for (const step of steps) {
    const found = visit(step.id);
    if (found) return found.map((id) => byId.get(id)?.title ?? id);
  }
  return null;
}

/**
 * Merges a natural-language-approved addition into the aggregate deliverable record. Exact titles
 * are idempotent: if a tool call is retried after the state write landed but its confirmation was
 * interrupted, it links what is missing without creating duplicate criteria or steps.
 */
export function mergeBreakdownAddition(
  deliverable: StoredDeliverable,
  addition: WorkspaceAddition,
  createId: () => string = createClientId
): BreakdownMerge {
  const normalized = (title: string) => title.trim().toLocaleLowerCase();
  const criterionTitles = new Set(deliverable.criteria.map((item) => normalized(item.title)));
  const newCriteria: StoredDeliverable["criteria"] = [];
  for (const item of addition.criteria) {
    const key = normalized(item.title);
    if (criterionTitles.has(key)) continue;
    criterionTitles.add(key);
    newCriteria.push({
      id: createId(),
      key: createId(),
      title: item.title,
      required: item.required,
      state: "unsatisfied",
      sortOrder: deliverable.criteria.length + newCriteria.length,
      stepIds: [],
      ...(item.interpretation ? { interpretation: item.interpretation } : {}),
      ...(item.sourceDocument ? { sourceDocument: item.sourceDocument } : {}),
      ...(item.sourceLocation ? { sourceLocation: item.sourceLocation } : {}),
      ...(item.expectedEvidence ? { expectedEvidence: item.expectedEvidence } : {}),
      ...(item.verificationMethod ? { verificationMethod: item.verificationMethod } : {})
    });
  }

  const allCriteria = [
    ...deliverable.criteria.map((item) => ({ ...item, stepIds: [...item.stepIds] })),
    ...newCriteria
  ];
  const criteriaByTitle = new Map(allCriteria.map((item) => [normalized(item.title), item]));
  const allSteps = [...deliverable.steps];
  const stepIdsByTitle = new Map(allSteps.map((item) => [normalized(item.title), item.id]));
  const newSteps: StoredDeliverable["steps"] = [];
  let addedLinks = 0;
  let addedDependencies = 0;
  const unresolvedDependencyTitles: string[] = [];

  for (const item of addition.steps) {
    const key = normalized(item.title);
    let id = stepIdsByTitle.get(key);
    if (!id) {
      id = createId();
      stepIdsByTitle.set(key, id);
      // Resolved against every title known so far: the deliverable's existing steps, plus whatever
      // this same addition already created — a chain's later links can name an earlier one, never a
      // later one. A title that resolves to nothing, or to this step itself, is reported rather than
      // silently dropped or silently self-referential.
      const dependencyIds: string[] = [];
      for (const dependsOn of item.dependsOnStepTitles) {
        const dependencyId = stepIdsByTitle.get(normalized(dependsOn));
        if (!dependencyId || dependencyId === id) unresolvedDependencyTitles.push(dependsOn);
        else if (!dependencyIds.includes(dependencyId)) dependencyIds.push(dependencyId);
      }
      const step: StoredDeliverable["steps"][number] = {
        id,
        title: item.title,
        status: "planned",
        optimisticMinutes: Math.max(5, Math.round(item.expectedMinutes * 0.7)),
        expectedMinutes: item.expectedMinutes,
        pessimisticMinutes: Math.round(item.expectedMinutes * 1.5),
        remainingMinutes: item.expectedMinutes,
        energy: "medium",
        minimumSessionMinutes: Math.min(15, item.expectedMinutes),
        maximumSessionMinutes: Math.max(60, Math.min(item.expectedMinutes, 120)),
        splittable: true,
        setupMinutes: 0,
        required: true,
        sortOrder: deliverable.steps.length + newSteps.length,
        dependencyIds,
        requirementPathways: [],
        ...(item.details ? { details: item.details } : {}),
        ...(item.reblockOnComplete ? { reblockOnComplete: item.reblockOnComplete } : {})
      };
      newSteps.push(step);
      allSteps.push(step);
    } else {
      // Retrofit: an existing step can gain additional prerequisites without being recreated — for
      // example splicing newly agreed revision steps in front of a handoff step that already existed
      // when the blocker they answer was first recorded. Resolved against the same title universe as
      // a new step's chain above; a title that resolves to nothing or to the step itself is reported
      // the same way. `details` and `reblockOnComplete` are new-step-only and ignored here.
      const index = allSteps.findIndex((existing) => existing.id === id);
      const target = allSteps[index]!;
      const dependencyIds = [...target.dependencyIds];
      for (const dependsOn of item.dependsOnStepTitles) {
        const dependencyId = stepIdsByTitle.get(normalized(dependsOn));
        if (!dependencyId || dependencyId === id) unresolvedDependencyTitles.push(dependsOn);
        else if (!dependencyIds.includes(dependencyId)) {
          dependencyIds.push(dependencyId);
          addedDependencies += 1;
        }
      }
      if (dependencyIds.length !== target.dependencyIds.length) allSteps[index] = { ...target, dependencyIds };
    }
    for (const served of item.criteriaServed) {
      const criterion = criteriaByTitle.get(normalized(served));
      if (criterion && !criterion.stepIds.includes(id)) {
        criterion.stepIds.push(id);
        addedLinks += 1;
      }
    }
  }

  const changed = Boolean(newCriteria.length || newSteps.length || addedLinks || addedDependencies);
  // Checked whenever a dependency edge was actually added — a retrofit that only linked criteria, or
  // resolved to nothing new, cannot have changed the shape of the graph.
  const cyclePath = newSteps.length || addedDependencies ? findDependencyCycle(allSteps) : null;
  return {
    deliverable: changed ? { ...deliverable, criteria: allCriteria, steps: allSteps } : deliverable,
    addedCriteria: newCriteria.length,
    addedSteps: newSteps.length,
    addedLinks,
    addedDependencies,
    unresolvedDependencyTitles,
    cyclePath,
    changed
  };
}
