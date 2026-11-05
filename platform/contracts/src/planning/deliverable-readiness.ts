import type { EnergyType } from "../core.js";
import { evaluateConditions, resolveSituation, type CommitmentWindow } from "./context-match.js";
import type { ConditionDefinition, ConditionMatch, CurrentSituation, RequirementPathway } from "./context-model.js";
import type { DeliverableProjection, ExecutionOption } from "./deliverable-projection.js";

/**
 * The single implementation of "what can be worked on inside this deliverable right now".
 *
 * It lives here, next to the projection it produces, because two callers need the same answer: the
 * Deliverable Workspace, which shows the person their executable steps and coverage problems, and the
 * plan-forecast request builder, which tells the engine what the deliverable offers. A second copy on
 * either side would drift, and the two would disagree about what is executable.
 *
 * It owns only the structural half of the question — prerequisites, blockers, remaining required work,
 * contract coverage — and calls the shared requirement matcher for situation fit, the same function
 * the engine calls. It deliberately decides nothing about energy compatibility, minimum useful
 * session, or the next protected boundary: those belong to the engine, and restating them here would
 * create the competing definition of feasibility the planning logic forbids.
 */

export type StepBlockReason = "complete" | "cancelled" | "blocked" | "prerequisite" | "situation";

export interface ReadinessStep {
  id: string;
  title: string;
  status: string;
  optimisticMinutes: number;
  expectedMinutes: number;
  pessimisticMinutes: number;
  remainingMinutes: number;
  energy: EnergyType;
  minimumSessionMinutes: number;
  maximumSessionMinutes: number;
  splittable: boolean;
  setupMinutes: number;
  required: boolean;
  dependencyIds: string[];
  requirementPathways: RequirementPathway[];
}

export interface ReadinessCriterion {
  id: string;
  title: string;
  required: boolean;
  state: string;
  stepIds: string[];
}
export interface ReadinessBlocker {
  id: string;
  state: string;
  stepIds: string[];
}

export interface ReadinessDeliverable {
  id: string;
  projectId: string;
  title: string;
  status: string;
  contractVersion: number;
  planVersion: number;
  contractApprovedAt?: string | undefined;
  planApprovedAt?: string | undefined;
  uncertainty: "known" | "some" | "high";
  importance: number;
  consequence: number;
  externalDeadlineAt?: string | undefined;
  internalDeadlineAt?: string | undefined;
  lastWorkedAt?: string | undefined;
  dependencyIds: string[];
  steps: ReadinessStep[];
  criteria: ReadinessCriterion[];
  blockers: ReadinessBlocker[];
}

export interface StepReadiness {
  stepId: string;
  executable: boolean;
  reason?: StepBlockReason;
  waitingOn: string[];
  blockerIds: string[];
  conditionMatch: ConditionMatch;
}

export type CoverageFailure =
  | { kind: "uncovered_criterion"; criterionId: string; title: string }
  | { kind: "uncontributing_step"; stepId: string; title: string }
  | { kind: "cyclic_prerequisite"; stepId: string; title: string };

export interface DeliverableReadiness {
  deliverableId: string;
  steps: StepReadiness[];
  executableStepIds: string[];
  stalled: boolean;
  openBlockerIds: string[];
  remainingMinutes: number | null;
  approved: boolean;
  coverageFailures: CoverageFailure[];
  contractSatisfied: boolean;
}

const OPEN_BLOCKER_STATES = new Set(["open", "awaiting_response", "possibly_resolved"]);
const FINISHED_STEP_STATES = new Set(["done", "cancelled", "archived"]);

export function assessDeliverable(args: {
  deliverable: ReadinessDeliverable;
  situation: CurrentSituation;
  conditionDefinitions: ConditionDefinition[];
  now: Date;
  /**
   * Minutes after which an asserted location is no longer trusted. Optional so callers that do not
   * pass one still get `resolveSituation`'s own default (`DEFAULT_LOCATION_STALE_AFTER_MINUTES`,
   * context-constants.ts) rather than a type error.
   */
  staleAfterMinutes?: number;
  /** Forwarded to `resolveSituation` for `commitment` contexts. Omit and every such context is unsatisfied. */
  commitments?: CommitmentWindow[];
}): DeliverableReadiness {
  const { deliverable } = args;
  const resolved = resolveSituation({
    situation: args.situation,
    definitions: args.conditionDefinitions,
    now: args.now,
    ...(args.staleAfterMinutes !== undefined ? { staleAfterMinutes: args.staleAfterMinutes } : {}),
    ...(args.commitments !== undefined ? { commitments: args.commitments } : {})
  });
  const stepById = new Map(deliverable.steps.map((step) => [step.id, step]));

  const openBlockers = deliverable.blockers.filter((blocker) => OPEN_BLOCKER_STATES.has(blocker.state));
  const blockersByStep = new Map<string, string[]>();
  for (const blocker of openBlockers) {
    for (const stepId of blocker.stepIds)
      blockersByStep.set(stepId, [...(blockersByStep.get(stepId) ?? []), blocker.id]);
  }

  const cyclicStepIds = new Set(cyclicSteps(deliverable.steps));

  const steps = deliverable.steps.map((step): StepReadiness => {
    const blockerIds = blockersByStep.get(step.id) ?? [];
    const waitingOn = step.dependencyIds.filter((id) => {
      const prerequisite = stepById.get(id);
      // A prerequisite that no longer exists cannot be proven complete, so it keeps the step waiting
      // rather than quietly disappearing as a constraint.
      return !prerequisite || prerequisite.status !== "done";
    });
    const conditionMatch = evaluateConditions({ pathways: step.requirementPathways, resolved, subjectId: step.id });
    const reason: StepBlockReason | undefined =
      step.status === "done"
        ? "complete"
        : step.status === "cancelled" || step.status === "archived"
          ? "cancelled"
          : blockerIds.length || step.status === "blocked"
            ? "blocked"
            : waitingOn.length || cyclicStepIds.has(step.id)
              ? "prerequisite"
              : conditionMatch.status !== "yes"
                ? "situation"
                : undefined;
    return {
      stepId: step.id,
      executable: reason === undefined,
      waitingOn,
      blockerIds,
      conditionMatch,
      ...(reason ? { reason } : {})
    };
  });

  const executableStepIds = steps.filter((step) => step.executable).map((step) => step.stepId);
  const unfinished = deliverable.steps.filter((step) => !FINISHED_STEP_STATES.has(step.status));
  const requiredRemaining = unfinished.filter((step) => step.required);
  // Versions retain history; approval timestamps say whether the *current* contract and plan are
  // accepted. Importing a reviewed requirement clears the timestamps without erasing that history.
  const approved =
    deliverable.contractVersion > 0 &&
    deliverable.planVersion > 0 &&
    Boolean(deliverable.contractApprovedAt) &&
    Boolean(deliverable.planApprovedAt);

  const contributingStepIds = new Set(deliverable.criteria.flatMap((criterion) => criterion.stepIds));
  const coverageFailures: CoverageFailure[] = [
    ...deliverable.criteria
      .filter((criterion) => criterion.required && !criterion.stepIds.length)
      .map((criterion): CoverageFailure => ({
        kind: "uncovered_criterion",
        criterionId: criterion.id,
        title: criterion.title
      })),
    ...deliverable.steps
      .filter((step) => step.required && !contributingStepIds.has(step.id))
      .map((step): CoverageFailure => ({ kind: "uncontributing_step", stepId: step.id, title: step.title })),
    ...deliverable.steps
      .filter((step) => cyclicStepIds.has(step.id))
      .map((step): CoverageFailure => ({ kind: "cyclic_prerequisite", stepId: step.id, title: step.title }))
  ];

  const requiredCriteriaSatisfied = deliverable.criteria
    .filter((criterion) => criterion.required)
    .every((criterion) => criterion.state === "satisfied" || criterion.state === "not_applicable");

  return {
    deliverableId: deliverable.id,
    steps,
    executableStepIds,
    stalled: requiredRemaining.length > 0 && executableStepIds.length === 0,
    openBlockerIds: openBlockers.map((blocker) => blocker.id),
    // An unapproved plan has not agreed what the work is. Reporting a total here would dress an
    // unknown amount of work up as a known one.
    remainingMinutes: approved ? unfinished.reduce((total, step) => total + step.remainingMinutes, 0) : null,
    approved,
    coverageFailures,
    // An empty contract satisfies "every required criterion" vacuously. Requiring an approved,
    // non-empty contract stops a deliverable nobody has broken down from reading as ready to finish.
    contractSatisfied:
      approved && deliverable.criteria.length > 0 && requiredCriteriaSatisfied && requiredRemaining.length === 0
  };
}

/** Every step that sits on a prerequisite cycle. Reported so the plan can be fixed, not just refused. */
export function cyclicSteps(steps: { id: string; dependencyIds: string[] }[]): string[] {
  const edges = new Map(steps.map((step) => [step.id, [...step.dependencyIds].sort()]));
  const state = new Map<string, "visiting" | "done">();
  const onCycle = new Set<string>();
  const stack: string[] = [];
  const walk = (id: string) => {
    const seen = state.get(id);
    if (seen === "done") return;
    if (seen === "visiting") {
      for (const member of stack.slice(stack.indexOf(id))) onCycle.add(member);
      return;
    }
    state.set(id, "visiting");
    stack.push(id);
    for (const next of edges.get(id) ?? []) walk(next);
    stack.pop();
    state.set(id, "done");
  };
  for (const id of [...edges.keys()].sort()) walk(id);
  return [...onCycle].sort();
}

/**
 * Turns accepted deliverables into what the engine plans against. Every value here is derived from
 * facts the user already accepted; no proposal, document text or model output reaches the engine.
 *
 * `completeDeliverableIds` decides whether prerequisites are satisfied, and prerequisite titles are
 * carried so an exclusion can name what is in the way instead of counting it.
 */
export function buildDeliverableProjections(args: {
  deliverables: ReadinessDeliverable[];
  situation: CurrentSituation;
  conditionDefinitions: ConditionDefinition[];
  now: Date;
  /** Forwarded to `assessDeliverable` — see its own doc comment. */
  staleAfterMinutes?: number;
  /** Forwarded to `assessDeliverable` — see its own doc comment. */
  commitments?: CommitmentWindow[];
  /**
   * Unfinished prerequisites beyond the deliverable-to-deliverable ones, keyed `deliverable:<id>`
   * (`unmetPrerequisites`): a project or action it needs, and what its project is waiting on.
   */
  unmet?: ReadonlyMap<string, { kind: string; title: string; id: string }[]>;
}): DeliverableProjection[] {
  const titleById = new Map(args.deliverables.map((deliverable) => [deliverable.id, deliverable.title]));
  const complete = new Set(
    args.deliverables.filter((deliverable) => deliverable.status === "completed").map((deliverable) => deliverable.id)
  );
  return args.deliverables.map((deliverable): DeliverableProjection => {
    const readiness = assessDeliverable({
      deliverable,
      situation: args.situation,
      conditionDefinitions: args.conditionDefinitions,
      now: args.now,
      ...(args.staleAfterMinutes !== undefined ? { staleAfterMinutes: args.staleAfterMinutes } : {}),
      ...(args.commitments !== undefined ? { commitments: args.commitments } : {})
    });
    const executable = new Set(readiness.executableStepIds);
    const options = deliverable.steps
      .filter((step) => executable.has(step.id))
      .map((step): ExecutionOption => ({
        id: step.id,
        title: step.title,
        optimisticMinutes: Math.max(1, step.optimisticMinutes),
        expectedMinutes: Math.max(1, step.expectedMinutes),
        pessimisticMinutes: Math.max(1, step.pessimisticMinutes),
        remainingMinutes: step.remainingMinutes,
        energy: step.energy,
        minimumSessionMinutes: Math.max(1, step.minimumSessionMinutes),
        maximumSessionMinutes: Math.max(1, step.maximumSessionMinutes),
        splittable: step.splittable,
        setupMinutes: step.setupMinutes,
        requirementPathways: step.requirementPathways
      }));
    const incompletePrerequisites = [
      ...deliverable.dependencyIds
        .filter((id) => !complete.has(id))
        .map((id) => ({ id, title: titleById.get(id) ?? id })),
      ...(args.unmet?.get(`deliverable:${deliverable.id}`) ?? []).filter(
        (ref) => !(ref.kind === "deliverable" && deliverable.dependencyIds.includes(ref.id))
      )
    ].map(({ id, title }) => ({ id, title }));
    return {
      id: deliverable.id,
      projectId: deliverable.projectId,
      title: deliverable.title,
      status: deliverable.status as DeliverableProjection["status"],
      approved: readiness.approved,
      remainingMinutes: readiness.remainingMinutes,
      minimumUsefulSessionMinutes: options.length
        ? Math.min(...options.map((option) => option.minimumSessionMinutes))
        : null,
      // Open blockers with work still available is the partially blocked case the engine keeps eligible.
      partiallyBlocked: readiness.openBlockerIds.length > 0 && options.length > 0,
      hasOpenBlockers: readiness.openBlockerIds.length > 0,
      dependenciesSatisfied: incompletePrerequisites.length === 0,
      incompletePrerequisites,
      uncertainty: deliverable.uncertainty,
      importance: deliverable.importance,
      consequence: deliverable.consequence,
      executionOptions: options,
      hasSteps: deliverable.steps.length > 0,
      ...(deliverable.externalDeadlineAt ? { externalDeadlineAt: deliverable.externalDeadlineAt } : {}),
      ...(deliverable.internalDeadlineAt ? { internalDeadlineAt: deliverable.internalDeadlineAt } : {}),
      ...(deliverable.lastWorkedAt ? { lastWorkedAt: deliverable.lastWorkedAt } : {})
    };
  });
}
