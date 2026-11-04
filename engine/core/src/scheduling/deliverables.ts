import { DEFAULT_LOCALE, type DeliverableProjection, type RequirementPathway } from "@openrhen/contracts";
import type { Action, EnergyDemand } from "../model/types.js";

/**
 * Turns accepted deliverable projections into the units the rest of the engine already knows how to
 * plan with, so a deliverable competes with ordinary actions under the existing rules rather than
 * through a parallel ranking of its own.
 *
 * Two different units come out of one projection, and they are never used together:
 *
 * - a **forecast unit** carries the deliverable's whole remaining effort, and is what `planSchedule`
 *   reserves capacity for;
 * - a **candidate unit** per execution option carries what could be started right now, and is what
 *   `recommend` ranks.
 *
 * Options are only the currently executable steps, so their effort does not sum to the remaining
 * total. Feeding both into the schedule would count the same work twice.
 */

const ENERGY_DEMAND: Record<EnergyDemand, number> = { recovery: 0, low: 1, medium: 2, high: 3 };
const FORECAST_UNIT = "deliverable";

export function forecastUnitId(deliverableId: string): string {
  return `${FORECAST_UNIT}:${deliverableId}`;
}

/**
 * The date a deliverable's urgency and severity race against: the earlier of an explicit internal
 * date and the external one, so a self-set date typed later than the external commitment can never
 * mask overdue work — the same rule `resolveInternalDeadline` applies to a project's own internal
 * deadline. Absent one date, the other stands alone; absent both, the unit carries none, and falls
 * back to whatever its project supplies through `effectiveDeadline`.
 */
export function effectiveDeliverableDeadline(projection: DeliverableProjection): Date | undefined {
  const internal = projection.internalDeadlineAt ? new Date(projection.internalDeadlineAt) : undefined;
  const external = projection.externalDeadlineAt ? new Date(projection.externalDeadlineAt) : undefined;
  if (internal && external) return internal.getTime() > external.getTime() ? external : internal;
  return internal ?? external;
}

/** Lifecycle states that hold no claim on ordinary work time. */
/** Titles of what a deliverable waits on, so the forecast holds it back rather than scheduling it. */
function waitingOnOf(projection: DeliverableProjection): { waitingOn?: string[] } {
  return projection.dependenciesSatisfied
    ? {}
    : { waitingOn: projection.incompletePrerequisites.map((prerequisite) => prerequisite.title) };
}

function inactive(projection: DeliverableProjection): boolean {
  return (
    projection.status === "completed" ||
    projection.status === "cancelled" ||
    projection.status === "archived" ||
    // Submitted and waiting on someone else. It should stop competing for time it cannot use.
    projection.status === "awaiting_result"
  );
}

/**
 * The setup one sit-down at this deliverable costs: the mean of its execution options' own setup, since
 * the unit stands for whichever option the person picks. Zero when no option states any.
 */
function setupOf(options: ReadonlyArray<{ setupMinutes?: number }>): number {
  if (!options.length) return 0;
  const total = options.reduce((sum, option) => sum + Math.max(0, option.setupMinutes ?? 0), 0);
  return Math.round(total / options.length);
}

/**
 * One unit per deliverable, holding all remaining effort. Deliverables whose breakdown is unapproved
 * produce nothing here — their effort is unknown, and a unit carrying zero would let the project
 * forecast quietly assume the work costs nothing. `unknownEffortDeliverables` reports them instead.
 */
export function deliverableForecastUnits(projections: DeliverableProjection[]): Action[] {
  return projections
    .filter(
      (projection) =>
        !inactive(projection) &&
        projection.approved &&
        projection.remainingMinutes !== null &&
        projection.remainingMinutes > 0
    )
    .map((projection): Action => {
      const remaining = projection.remainingMinutes!;
      const sessions = projection.executionOptions;
      const deadlineAt = effectiveDeliverableDeadline(projection);
      return {
        id: forecastUnitId(projection.id),
        projectId: projection.projectId,
        title: projection.title,
        // Blocked work is reported as blocked effort rather than silently dropped, which is what keeps
        // a stalled deliverable visible in the forecast instead of making the project look lighter.
        status: projection.executionOptions.length ? "planned" : "blocked",
        expectedMinutes: remaining,
        // Equal three-point figures state no spread, so the unit is padded by the project's uncertainty
        // multiplier like any single-figure estimate (`effort.ts`).
        optimisticMinutes: remaining,
        pessimisticMinutes: remaining,
        remainingMinutes: remaining,
        energy: mostDemandingEnergy(sessions),
        minimumSessionMinutes: projection.minimumUsefulSessionMinutes ?? 15,
        maximumSessionMinutes: Math.max(
          projection.minimumUsefulSessionMinutes ?? 15,
          ...sessions.map((option) => option.maximumSessionMinutes),
          60
        ),
        importance: projection.importance,
        consequence: projection.consequence,
        splittable: true,
        setupMinutes: setupOf(sessions),
        contexts: [],
        // Any option's route is a valid way to do some of this work, which is exactly OR-across-pathways.
        requirementPathways: sessions.flatMap((option) => option.requirementPathways),
        dependenciesComplete: projection.dependenciesSatisfied,
        ...waitingOnOf(projection),
        deliverableId: projection.id,
        ...(deadlineAt ? { deadlineAt } : {}),
        ...(projection.externalDeadlineAt ? { externalDeadlineAt: new Date(projection.externalDeadlineAt) } : {}),
        ...(projection.lastWorkedAt ? { lastWorkedAt: new Date(projection.lastWorkedAt) } : {})
      };
    });
}

/** Deliverables holding an unknown amount of work, so a forecast covering them cannot be responsible. */
export function unknownEffortDeliverables(projections: DeliverableProjection[]): Action[] {
  return projections
    .filter((projection) => !inactive(projection) && (!projection.approved || projection.remainingMinutes === null))
    .map((projection): Action => ({
      id: forecastUnitId(projection.id),
      projectId: projection.projectId,
      title: projection.title,
      status: "planned",
      expectedMinutes: 0,
      optimisticMinutes: 0,
      pessimisticMinutes: 0,
      remainingMinutes: 0,
      energy: "medium",
      minimumSessionMinutes: 15,
      maximumSessionMinutes: 60,
      importance: projection.importance,
      consequence: projection.consequence,
      contexts: [],
      dependenciesComplete: projection.dependenciesSatisfied,
      ...waitingOnOf(projection),
      deliverableId: projection.id
    }));
}

/**
 * One candidate per deliverable. The engine allocates attention to the enduring deliverable; it
 * never chooses a BCR phase or internal step. Before breakdown, a small provisional effort keeps the
 * deliverable rankable while the forecast still reports its total effort as unknown. Once accepted
 * steps exist, their deterministic summary supplies aggregate effort, session, energy and context
 * facts without exposing an internal execution choice to recommendation output.
 */
export function deliverableCandidateUnits(projections: DeliverableProjection[], locale?: string): Action[] {
  return projections
    .filter((projection) => !inactive(projection))
    .map((projection): Action => {
      const options = projection.executionOptions;
      const provisionalMinutes = projection.remainingMinutes ?? 60;
      const minimumSession = projection.minimumUsefulSessionMinutes ?? 5;
      const deadlineAt = effectiveDeliverableDeadline(projection);
      return {
        id: forecastUnitId(projection.id),
        projectId: projection.projectId,
        title: projection.title,
        status: "planned",
        optimisticMinutes: provisionalMinutes,
        expectedMinutes: provisionalMinutes,
        pessimisticMinutes: provisionalMinutes,
        remainingMinutes: provisionalMinutes,
        energy: mostDemandingEnergy(options),
        minimumSessionMinutes: minimumSession,
        maximumSessionMinutes: Math.max(minimumSession, ...options.map((option) => option.maximumSessionMinutes), 60),
        importance: projection.importance,
        consequence: projection.consequence,
        splittable: true,
        setupMinutes: setupOf(options),
        contexts: [],
        // One unrestricted way makes the aggregate deliverable reachable; otherwise any execution
        // route is enough to make some useful progress.
        requirementPathways: options.some((option) => !option.requirementPathways.length)
          ? []
          : options.flatMap((option) => option.requirementPathways),
        dependenciesComplete: projection.dependenciesSatisfied,
        ...waitingOnOf(projection),
        deliverableId: projection.id,
        forecastUnitId: forecastUnitId(projection.id),
        ...(projection.dependenciesSatisfied ? {} : { blockedReason: prerequisiteReason(projection, locale) }),
        ...(stalledReason(projection) ? { unavailableReason: stalledReason(projection)! } : {}),
        ...(deadlineAt ? { deadlineAt } : {}),
        ...(projection.externalDeadlineAt ? { externalDeadlineAt: new Date(projection.externalDeadlineAt) } : {}),
        ...(projection.lastWorkedAt ? { lastWorkedAt: new Date(projection.lastWorkedAt) } : {})
      };
    });
}

/**
 * Every currently-executable option's requirement pathways, flattened across every active
 * deliverable, for a caller that only wants to know whether *some* deliverable step could be worked
 * on in a hypothetical situation — not which step, or how much. Mirrors the OR-across-options
 * aggregation `deliverableCandidateUnits` builds for its single aggregate candidate: one option with
 * no requirement at all makes the whole answer unconstrained, because that option is workable
 * anywhere, and omitting it from the list would understate that.
 *
 * `undefined` means there is no executable deliverable step anywhere to ask about, which a caller must
 * not confuse with an empty pathway *list* — `evaluateConditions` reads `[]` as "no requirement, trivially
 * satisfied everywhere", the right answer for an unconstrained option but the wrong one for "nothing to
 * evaluate at all". Collapsing the two would make every hypothetical place read as workable the moment
 * a request carries zero deliverables, regardless of what is actually there.
 *
 * Options were themselves already filtered to "executable now" by `assessDeliverable` (dependencies,
 * blockers, status), so this answers "is any of that work workable here", not "could any drafted step
 * ever be workable here" — the same scope the rest of the engine already grants deliverable steps.
 */
export function deliverableRequirementPathways(projections: DeliverableProjection[]): RequirementPathway[] | undefined {
  const options = projections
    .filter((projection) => !inactive(projection))
    .flatMap((projection) => projection.executionOptions);
  if (!options.length) return undefined;
  if (options.some((option) => !option.requirementPathways.length)) return [];
  return options.flatMap((option) => option.requirementPathways);
}

/**
 * Names the prerequisite rather than counting it, so the exclusion reads as an explanation instead of
 * an unexplained refusal.
 */
export function prerequisiteReason(projection: DeliverableProjection, locale = DEFAULT_LOCALE): string {
  const names = projection.incompletePrerequisites.map((prerequisite) => prerequisite.title);
  if (!names.length) return `${projection.title} cannot start because a prerequisite deliverable is incomplete.`;
  const list = new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(names);
  return `${projection.title} cannot start because ${list} ${names.length === 1 ? "is" : "are"} incomplete.`;
}

/**
 * The most demanding energy any option needs. Aggregate remaining work covers steps nobody has
 * described yet, so assuming the easiest of them would overstate how much capacity actually suits it.
 */
function mostDemandingEnergy(options: { energy: EnergyDemand }[]): EnergyDemand {
  if (!options.length) return "medium";
  return options.reduce(
    (hardest, option) => (ENERGY_DEMAND[option.energy] > ENERGY_DEMAND[hardest] ? option.energy : hardest),
    options[0]!.energy
  );
}

/**
 * Why nothing inside this deliverable can be worked on, or null when something can.
 *
 * Before any step has been drafted, the useful work is Breakdown itself, so a deliverable with no
 * steps at all is never stalled — that is the provisional placeholder `deliverableCandidateUnits`
 * keeps rankable while the forecast still reports its total effort as unknown. But once a step has
 * been drafted — approved or not — it carries its own requirements (a location, a live class), and
 * those must be honoured even before a human has formally accepted the contract: an AI or the person
 * themself can write a presence-gated step, and it must stay gated from the moment it exists, not
 * only once someone clicks approve. If every drafted step is blocked, waiting on a prerequisite, or
 * unsuited to the moment, then time given to this deliverable buys nothing, and saying so is more
 * useful than recommending it anyway.
 *
 * A deliverable in Review still has work — reading the evidence against the contract — even though no
 * step is executable, so those states are never stalled either.
 */
export function stalledReason(projection: DeliverableProjection): string | null {
  // `approved` is kept alongside `hasSteps` for one reason only: a contract cannot be approved
  // without steps behind it, so `approved` is proof steps exist even when replaying a snapshot
  // captured before `hasSteps` was introduced (its default then reads false on frozen input that
  // predates the field). New projections always compute `hasSteps` directly.
  if (!projection.hasSteps && !projection.approved) return null;
  if (projection.status === "under_review" || projection.status === "ready_to_complete") return null;
  if (projection.executionOptions.length) return null;
  // remainingMinutes is null while the breakdown is unapproved (its total is unknown, not zero), and
  // that must not be mistaken for "nothing left to do" — only an explicit zero means genuinely done.
  if (projection.remainingMinutes === 0) return null;
  return projection.hasOpenBlockers
    ? `${projection.title} has no step that can be worked on until its open blockers are resolved.`
    : `${projection.title} has no step that can be worked on in the current situation.`;
}
