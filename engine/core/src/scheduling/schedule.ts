import { EFFORT_STALE_DAYS, atRiskHealth, effortAge, type EnergyType } from "@openrhen/contracts";
import { computeProjectAdherence, isMaintenanceProject } from "./adherence.js";
import { analyzeDependencies } from "./dependencies.js";
import { projectEffort } from "./effort.js";
import {
  indexSlotOffers,
  normalizePlanningSlots,
  slotCapacityForAction,
  usableFractionForAction,
  type SlotOfferIndex
} from "./slots.js";
import type {
  Action,
  ActionOccurrence,
  AgedInput,
  AllocationBlock,
  CapacityEnvelope,
  CapacityWindow,
  FixedCommitment,
  ForecastConfidence,
  ForecastIntervention,
  ForecastProposal,
  HorizonBandConfig,
  HorizonBandKind,
  PlanningConfig,
  PlanningResult,
  PlanningSlot,
  Project,
  ProjectEnvelope,
  ProjectForecast
} from "../model/types.js";
import { ARRIVAL_MARGIN_MINUTES, SESSION_BREAK_MINUTES, defaultPlanningConfig } from "../model/types.js";

const MINUTE_MS = 60_000;
/** Below this, a shortfall is float dust from summing many small slot consumes, not real minutes. */
const RESERVE_EPSILON = 1e-6;
const DAY_MS = 86_400_000;
const terminalStatuses = new Set(["done", "cancelled", "archived"]);

export interface ScheduleArguments {
  now: Date;
  horizonEnd: Date;
  projects: Project[];
  actions: Action[];
  capacityWindows: CapacityWindow[];
  commitments: FixedCommitment[];
  config?: PlanningConfig;
  submissionBufferMinutes?: number;
  submissionBufferPercent?: number;
  focusedProjectIds?: string[];
  projectedDailyProtectedMinutes?: number;
  /** Minutes to be at a place before a commitment starts, on top of travel time. Defaults to
   * `ARRIVAL_MARGIN_MINUTES` when absent — production always supplies `state.settings.arrivalMarginMinutes`. */
  arrivalMarginMinutes?: number;
  /**
   * The gap an exact session owes once it reaches `maximumSessionMinutes`: the same action cannot be
   * reserved again until this many minutes of wall-clock time have passed, though the gap itself is
   * free for other work. Defaults to `SESSION_BREAK_MINUTES` when absent — production always supplies
   * `state.settings.sessionBreakMinutes`. Detailed-band placement only: the later bands are aggregate
   * minutes with no session shape at all.
   */
  sessionBreakMinutes?: number;
  /**
   * Deliverables holding an unknown amount of work, keyed by project and named for the explanation.
   * A project cannot be forecast responsibly while one of these is outstanding: the missing effort is
   * unknown, not zero, and letting the rest of the project forecast normally would quietly assert
   * that the unbroken-down work costs nothing.
   */
  unknownEffortDeliverables?: { projectId: string; title: string }[];
  /**
   * Materialised occurrence records (`state.occurrences`), read only for a maintenance project's
   * recurring actions — see `scheduling/adherence.ts`. Absent treats every recurring action as having
   * no history, which understates its adherence rather than overstating it.
   */
  occurrences?: ActionOccurrence[];
}

/**
 * The quarter-hour slots a plan reasons over: the detailed band, with every commitment's protected
 * window subtracted.
 *
 * Exported because the live recommendation occasionally needs the same slots with one anchor's own
 * window handed back — see `recommend`'s `freeAnchorIds`. Deriving the band's end a second time
 * elsewhere is how the live view and the plan would quietly come to disagree about where the
 * detailed horizon is.
 */
export function planningSlots(args: {
  now: Date;
  horizonEnd: Date;
  capacityWindows: CapacityWindow[];
  commitments: FixedCommitment[];
  config?: PlanningConfig;
  boundaries?: Date[];
  arrivalMarginMinutes?: number;
}): PlanningSlot[] {
  const config = args.config ?? defaultPlanningConfig;
  const detailedEnd = detailedBandEnd(args.now, args.horizonEnd, config);
  return splitDetailedSlots(
    normalizePlanningSlots({
      from: args.now,
      until: detailedEnd,
      capacityWindows: args.capacityWindows,
      commitments: args.commitments,
      boundaries: (args.boundaries ?? []).filter((boundary) => boundary <= detailedEnd),
      arrivalMarginMinutes: args.arrivalMarginMinutes ?? ARRIVAL_MARGIN_MINUTES
    })
  );
}

function detailedBandEnd(now: Date, horizonEnd: Date, config: PlanningConfig): Date {
  const configuredEnd = new Date(now.getTime() + config.forecastHorizonDays * DAY_MS);
  const forecastEnd = new Date(Math.min(horizonEnd.getTime(), configuredEnd.getTime()));
  return new Date(Math.min(forecastEnd.getTime(), now.getTime() + config.horizonBands[0]!.endDay * DAY_MS));
}

export function planSchedule(args: ScheduleArguments): PlanningResult {
  const config = args.config ?? defaultPlanningConfig;
  const arrivalMarginMinutes = args.arrivalMarginMinutes ?? ARRIVAL_MARGIN_MINUTES;
  const sessionBreakMinutes = args.sessionBreakMinutes ?? SESSION_BREAK_MINUTES;
  const configuredEnd = new Date(args.now.getTime() + config.forecastHorizonDays * DAY_MS);
  const forecastEnd = new Date(Math.min(args.horizonEnd.getTime(), configuredEnd.getTime()));
  const detailedEnd = detailedBandEnd(args.now, args.horizonEnd, config);
  const remainingActions = args.actions.filter((action) => !terminalStatuses.has(action.status));
  // Grouped once instead of rescanned per project, and the project's remaining effort measured once
  // instead of recomputed for the effort ledger, again for the internal deadline, and again inside the
  // forecast loop. All three asked the same question of the same actions.
  const actionsByProject = new Map(args.projects.map((project) => [project.id, [] as Action[]]));
  for (const action of remainingActions) actionsByProject.get(action.projectId)?.push(action);
  const actionsOf = (projectId: string) => actionsByProject.get(projectId) ?? [];
  // A cadence action leaves the deadline pipeline entirely: it is never in a project's
  // forecastable effort or reservation, whatever its project's deadline, so it is excluded here, at
  // the one place every project's remaining-effort figure (deadline resolution, the CPM pass, and
  // the per-project loop's own `projectEfforts`) is measured from. `actionsOf` itself still returns
  // it — `isMaintenanceProject`/`computeProjectAdherence` in the per-project loop below still need to
  // see it, to measure a cadence-only project by adherence instead of falling through to "no action
  // is estimable".
  const nonCadence = (list: Action[]) => list.filter((action) => action.schedulingMode !== "cadence");
  const remainingEffort = new Map(
    args.projects.map(
      (project) => [project.id, projectEffort(nonCadence(actionsOf(project.id)), project, config)] as const
    )
  );
  const efforts = args.projects.flatMap((project) => remainingEffort.get(project.id)!.efforts);
  const effortByAction = new Map(efforts.map((effort) => [effort.actionId, effort]));
  const dependencies = analyzeDependencies(args.actions, efforts);
  const focus = new Set(args.focusedProjectIds ?? []);
  // A stored internal date later than the external one is silently overridden above. Say so on the
  // forecast rather than letting the plan run to a date the project no longer holds: the reason is
  // the only place the person can see why the boundary is not the date they typed.
  const clampedDeadlineReasons = new Map<string, string>();
  // Whose date the project is measured against, read off the same resolution that picks the date.
  // "none" is a project with no deadline at all (a focused one is still planned, to the end of the
  // horizon, but that end is not a deadline).
  const deadlineSources = new Map<string, NonNullable<ProjectForecast["deadlineSource"]>>();
  const deadlines = new Map(
    args.projects.map((project) => {
      const deadline = resolveInternalDeadline(
        project,
        remainingEffort.get(project.id)!.riskAdjustedMinutes,
        args.submissionBufferMinutes ?? 60,
        args.submissionBufferPercent ?? 0.1
      );
      deadlineSources.set(
        project.id,
        !deadline
          ? "none"
          : project.internalDeadlineAt && deadline.getTime() === project.internalDeadlineAt.getTime()
            ? "internal"
            : "external"
      );
      if (
        project.internalDeadlineAt &&
        project.externalDeadlineAt &&
        project.internalDeadlineAt.getTime() > project.externalDeadlineAt.getTime()
      )
        clampedDeadlineReasons.set(
          project.id,
          `The internal date ${project.internalDeadlineAt.toISOString()} is later than the externally committed date ${project.externalDeadlineAt.toISOString()}; the external date governs, so this forecast runs to ${deadline!.toISOString()}.`
        );
      return [project.id, deadline ?? (focus.has(project.id) ? forecastEnd : undefined)] as const;
    })
  );
  const slots = planningSlots({
    now: args.now,
    horizonEnd: args.horizonEnd,
    capacityWindows: args.capacityWindows,
    commitments: args.commitments,
    config,
    boundaries: [...deadlines.values()].filter((deadline): deadline is Date => Boolean(deadline)),
    arrivalMarginMinutes
  });
  const knownBandSlots = new Map<HorizonBandKind, PlanningSlot[]>();
  const capacityEnvelopes = buildCapacityEnvelopes(args, config, detailedEnd, forecastEnd, slots, knownBandSlots);
  // Per-slot band ledgers: each later band keeps a real ledger over its own window segments,
  // not one shared aggregate number. A band's segments are built the same way the detailed slots
  // are, scaled so their sum matches the band's own `adjustedCapacityMinutes` exactly — the same
  // total the old aggregate math produced, distributed across real, context- and energy-specific
  // capacity instead of a single pool every project drew from regardless of compatibility. See
  // `buildBandSlots` for the scaling. Concatenated with the detailed slots (ascending in time,
  // since each band starts where the previous one ends), this is the single combined ledger every
  // reservation and every capacity estimate below reads from; `detailedBoundaryIndex` is where the
  // real, session-shaped detailed band ends and the aggregate-only bands begin.
  const bandSlotsByKind = new Map<HorizonBandKind, PlanningSlot[]>();
  for (const envelope of capacityEnvelopes) {
    if (envelope.kind === "detailed") continue;
    bandSlotsByKind.set(envelope.kind, buildBandSlots(envelope, knownBandSlots.get(envelope.kind) ?? []));
  }
  const allSlots: PlanningSlot[] = [...slots, ...[...bandSlotsByKind.values()].flat()];
  const slotBandKind = new Map<string, HorizonBandKind>();
  for (const [kind, bandSlots] of bandSlotsByKind) for (const slot of bandSlots) slotBandKind.set(slot.id, kind);
  const detailedBoundaryIndex = slots.length - 1;
  const slotRemaining = new Map(allSlots.map((slot) => [slot.id, slot.capacityMinutes]));
  const slotTimes = sortedSlotTimes(allSlots);
  const slotOffers = indexSlotOffers(allSlots);
  const allocations: AllocationBlock[] = [];
  const projectEnvelopes: ProjectEnvelope[] = [];
  const forecasts: ProjectForecast[] = [];
  const pendingProposals: PendingProposal[] = [];
  const pendingInterventions: PendingInterventions[] = [];
  const projectOrder = [...args.projects].sort(
    (a, b) =>
      (deadlines.get(a.id)?.getTime() ?? Number.MAX_SAFE_INTEGER) -
        (deadlines.get(b.id)?.getTime() ?? Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id)
  );
  const remainingActionsById = new Map(remainingActions.map((action) => [action.id, action]));
  const projectById = new Map(args.projects.map((project) => [project.id, project]));
  // A dependency edge can span any two projects — `analyzeDependencies` already resolved the graph
  // globally (`dependencies.order`); this is that same graph restated as successors, over live work
  // only, for the CPM pass and the two-way placement bounds below.
  const globalSuccessors = new Map(remainingActions.map((action) => [action.id, [] as string[]]));
  for (const action of remainingActions)
    for (const dependencyId of action.dependencyIds ?? [])
      if (globalSuccessors.has(dependencyId)) globalSuccessors.get(dependencyId)!.push(action.id);
  // Effective deadline: a backward pass over the global topological order. An action's effective
  // deadline is its own project's deadline, or earlier still if any dependant (in any project) needs
  // it finished sooner. Because `dependencies.order` lists every prerequisite before its dependants,
  // walking it in reverse guarantees a dependant's own effective deadline is already final by the
  // time its prerequisite asks for it.
  const effectiveDeadline = new Map<string, Date>();
  for (const id of [...dependencies.order].reverse()) {
    const action = remainingActionsById.get(id);
    if (!action) continue;
    let bound = deadlines.get(action.projectId);
    for (const successorId of globalSuccessors.get(id) ?? []) {
      const successorDeadline = effectiveDeadline.get(successorId);
      if (!successorDeadline) continue;
      const successorMinutes = effortByAction.get(successorId)?.riskAdjustedRemainingMinutes ?? 0;
      const candidate = new Date(successorDeadline.getTime() - successorMinutes * MINUTE_MS);
      if (!bound || candidate < bound) bound = candidate;
    }
    if (bound) effectiveDeadline.set(id, bound);
  }
  // Held-back chains (logic-design §6 extended to chains): a blocked/waiting action, or one sitting
  // in a project nothing will ever work, holds back everything transitively downstream of it, in any
  // project. `dependencies.order` lists prerequisites before dependants, so a dependant can always
  // read its prerequisite's already-settled verdict.
  const heldBack = new Map<string, boolean>();
  const stuckDependency = (dependencyId: string): boolean => {
    const dependency = remainingActionsById.get(dependencyId);
    if (!dependency) return false;
    if (dependency.status === "blocked" || dependency.status === "waiting") return true;
    const dependencyProject = projectById.get(dependency.projectId);
    if (!dependencyProject || dependencyProject.status !== "active" || dependencyProject.outcomeActive === false)
      return true;
    return heldBack.get(dependencyId) === true;
  };
  for (const id of dependencies.order) {
    const action = remainingActionsById.get(id);
    if (!action) continue;
    const selfStuck = action.status === "blocked" || action.status === "waiting" || Boolean(action.waitingOn?.length);
    heldBack.set(id, selfStuck || (action.dependencyIds ?? []).some(stuckDependency));
  }
  /** Names the nearest real obstacle in a held-back chain, walking toward it one hop at a time. */
  function heldBackReason(actionId: string): string {
    let cursor = actionId;
    const ownWaiting = remainingActionsById.get(actionId)?.waitingOn;
    if (ownWaiting?.length) return `waiting on: ${ownWaiting.join(", ")}`;
    for (let hop = 0; hop < 32; hop += 1) {
      const cursorAction = remainingActionsById.get(cursor);
      const stuckDependencyId = (cursorAction?.dependencyIds ?? []).find(stuckDependency);
      if (!stuckDependencyId) break;
      const dependency = remainingActionsById.get(stuckDependencyId)!;
      cursor = stuckDependencyId;
      if (!heldBack.get(stuckDependencyId) || dependency.status === "blocked" || dependency.status === "waiting") {
        const sameProject = dependency.projectId === remainingActionsById.get(actionId)!.projectId;
        return `waiting on: ${dependency.title}${sameProject ? "" : ` (${dependency.projectId})`}`;
      }
    }
    return "waiting on an unresolved prerequisite";
  }
  const placedStart = new Map<string, Date>();
  const placedEnd = new Map<string, Date>();
  /**
   * Tail-first per action, across every band ledger, ending in the detailed slots.
   *
   * `bandsOnly` (dated-project later recurring occurrences): when true, a shortfall the
   * band walk can't cover is left unreserved rather than falling through to `allocateAction` —
   * this action's own window never draws from, or displaces, a detailed-band slot at all. Used
   * only for a recurring series' later occurrences in the per-project loop below; every other
   * caller keeps the ordinary fallback.
   */
  function reserveTailFirst(action: Action, required: number, upperBound: Date, lowerBound: Date, bandsOnly = false) {
    const empty = {
      blocks: [] as AllocationBlock[],
      bandMinutes: new Map<HorizonBandKind, number>(),
      earliestStart: null as Date | null,
      latestEnd: null as Date | null,
      extraSetupMinutes: 0,
      topUpMinutes: 0,
      unfilledTopUpMinutes: 0
    };
    if (required <= 0) return empty;
    const latestIndex = latestSlotIndex(allSlots, upperBound, slotTimes);
    const earliestIndex = firstSlotIndexAtOrAfter(allSlots, lowerBound, slotTimes);
    if (latestIndex < 0 || latestIndex < earliestIndex) return empty;
    const bandMinutes = new Map<HorizonBandKind, number>();
    const blocks: AllocationBlock[] = [];
    let earliestStart: Date | null = null;
    let latestEnd: Date | null = null;
    const aggregateFloor = Math.max(earliestIndex, detailedBoundaryIndex + 1);
    const detailedLatestIndex = Math.min(latestIndex, detailedBoundaryIndex);
    /** Takes `want` minutes tail-first: band ledgers first, then the detailed slots. Returns what it took. */
    const place = (want: number): number => {
      let needed = want;
      for (let index = latestIndex; index >= aggregateFloor && needed > 0; index -= 1) {
        const slot = allSlots[index]!;
        const available = slotRemaining.get(slot.id) ?? 0;
        const capacity = Math.min(available, slotCapacityForAction(slot, action));
        if (capacity <= 0) continue;
        const take = Math.min(capacity, needed);
        slotRemaining.set(slot.id, available - take);
        needed -= take;
        const kind = slotBandKind.get(slot.id)!;
        bandMinutes.set(kind, (bandMinutes.get(kind) ?? 0) + take);
        if (!earliestStart || slot.startsAt < earliestStart) earliestStart = slot.startsAt;
        if (!latestEnd || slot.endsAt > latestEnd) latestEnd = slot.endsAt;
      }
      // A top-up is placed against what this action already holds, so it cannot join or fill the runs
      // and breaks the first placement made.
      const placed =
        !bandsOnly && needed > 0 && detailedLatestIndex >= earliestIndex
          ? allocateAction(
              action,
              needed,
              detailedLatestIndex,
              allSlots,
              slotRemaining,
              earliestIndex,
              sessionBreakMinutes,
              blocks
            )
          : [];
      for (const block of placed) {
        blocks.push(block);
        needed -= block.minutes;
        if (!earliestStart || block.startsAt < earliestStart) earliestStart = block.startsAt;
        if (!latestEnd || block.endsAt > latestEnd) latestEnd = block.endsAt;
      }
      return want - needed;
    };
    // How many separate runs the placement made. Band time is aggregate, so it cannot say where its
    // sessions fall; the fewest sessions of the action's maximum length that could hold it is the
    // count that is at least certain.
    const countAllRuns = () =>
      Math.ceil(sumOf(bandMinutes) / Math.max(1, action.maximumSessionMinutes)) +
      (blocks.length ? countRuns(blocks, action.maximumSessionMinutes) : 0);
    place(required);
    // Setup is paid at the start of every run, not once per action: the effort figure carries it once,
    // so each run actually placed beyond the first owes one more, whether or not the action fitted
    // whole. Setup is real wall-clock work, separate from the estimate's risk buffer: the full
    // owed setup is reserved from the ledger on top of the padding, the same figure the forecast
    // charges, so a later project cannot count those minutes (a fixed total the person typed is
    // theirs and is not added to).
    const setup = action.remainingMinutes > 0 ? Math.max(0, action.setupMinutes ?? 0) : 0;
    const project = projectById.get(action.projectId);
    let extraSetupMinutes = 0;
    let topUpMinutes = 0;
    let unfilledTopUpMinutes = 0;
    if (setup > 0 && project?.remainingEffortOverrideMinutes === undefined && blocks.length + bandMinutes.size > 0) {
      // Each top-up can itself add runs that owe setup, so this settles geometrically; it stops as
      // soon as nothing more is wanted or nothing more could be placed.
      for (let pass = 0; pass < 20; pass += 1) {
        const owed = setup * Math.max(0, countAllRuns() - 1);
        const want = Math.max(0, owed) - topUpMinutes;
        if (want <= RESERVE_EPSILON) break;
        const took = place(want);
        topUpMinutes += took;
        if (took <= RESERVE_EPSILON) break;
      }
      extraSetupMinutes = setup * Math.max(0, countAllRuns() - 1);
      // What the walk could not find room for; a bands-only caller can ask another window for it.
      unfilledTopUpMinutes = Math.max(0, extraSetupMinutes - topUpMinutes);
      if (unfilledTopUpMinutes <= RESERVE_EPSILON) unfilledTopUpMinutes = 0;
    }
    return { blocks, bandMinutes, earliestStart, latestEnd, extraSetupMinutes, topUpMinutes, unfilledTopUpMinutes };
  }
  // Recurring standing pass: every live recurring occurrence in a **maintenance** project (no
  // deadline, or one beyond the forecast horizon) reserves its own required minutes before any
  // deadline project's own loop runs — closing the maintenance-project hole named in the design:
  // such a project skips the ordinary per-project loop entirely below (see `isMaintenanceProject`
  // just above the loop), so without this pass its recurring occurrences, even this week's, would
  // reserve nothing at all. A recurring occurrence in a *dated* project (or a maintenance-shaped
  // project that happens to carry an in-horizon deadline) is left to the ordinary per-project loop:
  // its pending occurrence reserves correctly there exactly as any other action would. Its *later*
  // occurrences — the per-band aggregate actions `engine.ts`'s `prepare()` synthesizes for the
  // horizon beyond the pending week — are also reserved inside that same loop, but bounded to
  // their own band window and restricted to band ledgers only (`reserveTailFirst`'s `bandsOnly`,
  // below): never the wider project-deadline bound an ordinary action gets, and never allowed to
  // fall through into a detailed-band slot the way an ordinary shortfall would. Doing it inside the
  // existing loop, in the project's own turn, rather than as a separate pre-pass ahead of it, is
  // what keeps "project order stays by internal deadline" true for this demand too — a pre-pass
  // would let a far-off project's later-band demand jump ahead of a nearer-deadline project's own
  // reservation, which is exactly the priority inversion tail-first ordering exists to prevent — and
  // it is also what makes the reservation count as this project's own allocation for free: the same
  // `availableBefore`/`reservedEarlier` split every other action in the loop already gets.
  // `recurringResultByAction` lets the project loop fold each occurrence's own already-placed result
  // into that project's own bookkeeping instead of reserving it a second time (reachable today only
  // for a recurring action whose *own* project later stops being a maintenance project mid-forecast,
  // which cannot happen within one run, but keeps the two passes' bookkeeping consistent if the
  // maintenance test ever needs relaxing); `recurringReservedMinutesByProject` is what the project
  // loop's own `reservedEarlier`/`availableBefore` subtract back out, so a project's own series
  // reservations count as its own allocation, never as capacity "reserved for an earlier deadline".
  const recurringResultByAction = new Map<
    string,
    {
      blocks: AllocationBlock[];
      bandMinutes: Map<HorizonBandKind, number>;
      earliestStart: Date | null;
      extraSetupMinutes: number;
      topUpMinutes: number;
    }
  >();
  const recurringReservedMinutesByProject = new Map<string, number>();
  const recurringActions = remainingActions.filter((action) => {
    if (action.schedulingMode !== "recurring") return false;
    if (action.status === "blocked" || action.status === "waiting" || heldBack.get(action.id)) return false;
    const project = projectById.get(action.projectId);
    if (!project || project.status !== "active" || project.outcomeActive === false) return false;
    const projectDeadline = deadlines.get(action.projectId);
    if (projectDeadline && projectDeadline <= forecastEnd) return false;
    return isMaintenanceProject(actionsOf(action.projectId));
  });
  const recurringOrder = [...recurringActions].sort(
    (a, b) =>
      (a.deadlineAt?.getTime() ?? forecastEnd.getTime()) - (b.deadlineAt?.getTime() ?? forecastEnd.getTime()) ||
      a.id.localeCompare(b.id)
  );
  for (const action of recurringOrder) {
    const required = effortByAction.get(action.id)?.riskAdjustedRemainingMinutes ?? action.remainingMinutes;
    const upperBound = new Date(Math.min(action.deadlineAt?.getTime() ?? forecastEnd.getTime(), forecastEnd.getTime()));
    const lowerBound = action.availableFrom ?? args.now;
    const result = reserveTailFirst(action, required, upperBound, lowerBound);
    allocations.push(...result.blocks);
    if (result.earliestStart) placedStart.set(action.id, result.earliestStart);
    if (result.latestEnd) placedEnd.set(action.id, result.latestEnd);
    recurringResultByAction.set(action.id, {
      blocks: result.blocks,
      bandMinutes: result.bandMinutes,
      earliestStart: result.earliestStart,
      extraSetupMinutes: result.extraSetupMinutes,
      topUpMinutes: result.topUpMinutes
    });
    const reserved = result.blocks.reduce((sum, block) => sum + block.minutes, 0) + sumOf(result.bandMinutes);
    recurringReservedMinutesByProject.set(
      action.projectId,
      (recurringReservedMinutesByProject.get(action.projectId) ?? 0) + reserved
    );
  }
  // Undated prerequisite pre-pass: an active project with no deadline of its own still has to place
  // the units a dated dependant, anywhere, needs from it — otherwise "the prerequisite inherits the
  // earliest dependant deadline" would be meaningless for exactly the project that most needs it.
  // Ordered by effective deadline (most urgent first) and reserved from the same ledgers the project
  // loop below draws from, so whichever side — this or its dependant — is placed first bounds the
  // other (see the two-way bound applied in the project loop).
  const prereqNotesByProject = new Map<
    string,
    { actionId: string; latestSafeStart: Date | null; unplaced: boolean; reason: string }[]
  >();
  const undatedPrereqIds = remainingActions
    .filter((action) => {
      const project = projectById.get(action.projectId);
      if (!project || project.status !== "active" || project.outcomeActive === false) return false;
      if (deadlines.get(action.projectId)) return false;
      if (action.status === "blocked" || action.status === "waiting") return false;
      if (heldBack.get(action.id)) return false;
      return effectiveDeadline.has(action.id);
    })
    .map((action) => action.id)
    .sort((a, b) => effectiveDeadline.get(a)!.getTime() - effectiveDeadline.get(b)!.getTime() || a.localeCompare(b));
  for (const actionId of undatedPrereqIds) {
    const action = remainingActionsById.get(actionId)!;
    const required = effortByAction.get(actionId)?.riskAdjustedRemainingMinutes ?? action.remainingMinutes;
    const dependantStarts = (globalSuccessors.get(actionId) ?? [])
      .map((id) => placedStart.get(id)?.getTime())
      .filter((time): time is number => time !== undefined);
    const upperBound = new Date(
      Math.min(
        effectiveDeadline.get(actionId)!.getTime(),
        forecastEnd.getTime(),
        ...(dependantStarts.length ? dependantStarts : [Number.MAX_SAFE_INTEGER])
      )
    );
    const prereqEnds = (action.dependencyIds ?? [])
      .map((id) => placedEnd.get(id)?.getTime())
      .filter((time): time is number => time !== undefined);
    const lowerBound = prereqEnds.length ? new Date(Math.max(...prereqEnds)) : args.now;
    const { blocks, bandMinutes, earliestStart, latestEnd } = reserveTailFirst(
      action,
      required,
      upperBound,
      lowerBound
    );
    allocations.push(...blocks);
    if (earliestStart) placedStart.set(actionId, earliestStart);
    if (latestEnd) placedEnd.set(actionId, latestEnd);
    const reserved = blocks.reduce((sum, block) => sum + block.minutes, 0) + sumOf(bandMinutes);
    const expectedNeeded = expectedRemainingMinutesFor(action, projectById.get(action.projectId));
    const successorId = (globalSuccessors.get(actionId) ?? [])[0];
    const successor = successorId ? remainingActionsById.get(successorId) : undefined;
    const notes = prereqNotesByProject.get(action.projectId) ?? [];
    notes.push({
      actionId,
      latestSafeStart: blocks.length ? earliestStart : earliestStart ? roundDownToHour(earliestStart) : null,
      unplaced: reserved < expectedNeeded - RESERVE_EPSILON,
      reason: `Needed by ${successor?.title ?? "a dependent action"}${
        successor && successor.projectId !== action.projectId ? ` (${successor.projectId})` : ""
      } by ${effectiveDeadline.get(actionId)!.toISOString()}.`
    });
    prereqNotesByProject.set(action.projectId, notes);
  }

  for (const project of projectOrder) {
    const deadline = deadlines.get(project.id);
    const projectActions = actionsOf(project.id);
    // Keyed in sorted order, not input order. A record remembers the order its keys were inserted in,
    // so following the order the actions happened to arrive in made two runs over identical facts
    // serialize to different bytes — and the result is stored and compared as JSON, which turned a
    // reordering of the input into a spurious change of plan.
    const latestSafeStarts: Record<string, Date | null> = Object.fromEntries(
      projectActions
        .map((action) => action.id)
        .sort((a, b) => a.localeCompare(b))
        .map((id) => [id, null])
    );
    const band = deadline ? bandForDate(deadline, args.now, config.horizonBands) : null;
    if (project.status === "done") {
      forecasts.push(completed(project.id, deadline ?? forecastEnd, forecastEnd));
      continue;
    }
    if (project.status !== "active" || project.outcomeActive === false) {
      forecasts.push(
        unknown(
          project.id,
          project.outcomeActive === false ? "Parent outcome is not active." : "Project is not active.",
          latestSafeStarts,
          forecastEnd,
          args.now,
          deadline,
          band,
          // A paused or cancelled project must not surface in Review's overdue panel: nobody is
          // going to work it regardless of what its date says, so a past date here is not a signal.
          false
        )
      );
      continue;
    }
    const unbrokenDown = (args.unknownEffortDeliverables ?? []).filter(
      (deliverable) => deliverable.projectId === project.id
    );
    if (unbrokenDown.length) {
      forecasts.push(
        unknown(
          project.id,
          `${unbrokenDown[0]!.title} has not been broken down, so its remaining effort is unknown.`,
          latestSafeStarts,
          forecastEnd,
          args.now,
          deadline,
          band
        )
      );
      continue;
    }
    // A maintenance project — every live action recurring or cadence — is only rescued from
    // the no-deadline and beyond-horizon guards immediately below: a recurring action can carry a real
    // project deadline (a goal-based series with an end date), and when it does the ordinary
    // feasibility pipeline already measures it correctly and is left alone. Only when neither guard
    // would otherwise resolve does adherence take over. The top-level `health` stays "unknown" — see
    // the comment on `ProjectAdherence` in model/types.ts for why — and `adherence.health` carries the
    // classification adherence actually produced.
    // extends this one further: a project whose only live actions are cadence has no deadline
    // *to be feasible against* even when it carries one — cadence actions never enter the deadline
    // pipeline at all — so it is measured by adherence whatever its own project deadline says,
    // replacing `logic-design.md:218`'s narrower "only where the ordinary guards would have answered
    // Unknown" rule for this one case.
    const cadenceOnly =
      projectActions.length > 0 && projectActions.every((action) => action.schedulingMode === "cadence");
    if ((!deadline || deadline > forecastEnd || cadenceOnly) && isMaintenanceProject(projectActions)) {
      const adherence = computeProjectAdherence(projectActions, args.occurrences ?? [], args.now);
      forecasts.push({
        projectId: project.id,
        health: "unknown",
        overdue: false,
        protectedRemainingMinutes: null,
        pessimisticRemainingMinutes: null,
        compatibleCapacityMinutes: null,
        grossCompatibleCapacityMinutes: null,
        reservedByEarlierDeadlinesMinutes: 0,
        requiredPaceMinutesPerWeek: null,
        forecastBand: null,
        confidence: null,
        forecastThrough: forecastEnd,
        expectedMarginMinutes: null,
        pessimisticMarginMinutes: null,
        marginRatio: null,
        scheduleVariance: null,
        unallocatedExpectedMinutes: 0,
        blockedEffortMinutes: 0,
        schedulingBlocked: false,
        latestSafeStarts,
        healthBasis: "adherence",
        adherence: { health: adherence.health, ratio: adherence.ratio, actions: adherence.actions },
        reasons: [adherence.reason]
      });
      continue;
    }
    if (!deadline) {
      const base = unknown(
        project.id,
        "No deadline is set and the project is not selected in Review.",
        latestSafeStarts,
        forecastEnd,
        args.now
      );
      // Merged from the undated-prerequisite pre-pass above: the project still has no deadline of
      // its own to be feasible against, but a unit in it may have been reserved for a dated
      // dependant elsewhere, and that placement — and its reason — belongs on this forecast.
      const notes = prereqNotesByProject.get(project.id) ?? [];
      if (notes.length) {
        for (const note of notes) base.latestSafeStarts[note.actionId] = note.latestSafeStart;
        const unplacedIds = notes.filter((note) => note.unplaced).map((note) => note.actionId);
        if (unplacedIds.length) base.unplacedUnitIds = unplacedIds;
        base.reasons = [...base.reasons, ...notes.map((note) => note.reason)];
      }
      forecasts.push(base);
      continue;
    }
    if (deadline > forecastEnd) {
      forecasts.push(
        unknown(
          project.id,
          "The deadline is outside the current six-month forecast.",
          latestSafeStarts,
          forecastEnd,
          args.now,
          deadline
        )
      );
      continue;
    }
    if (!projectActions.length) {
      forecasts.push(
        unknown(
          project.id,
          "No remaining action estimates are available.",
          latestSafeStarts,
          forecastEnd,
          args.now,
          deadline,
          band
        )
      );
      continue;
    }
    const dependencyProblem = dependencies.errors.find((error) =>
      projectActions.some((action) => error.includes(action.id))
    );
    if (dependencyProblem) {
      forecasts.push(unknown(project.id, dependencyProblem, latestSafeStarts, forecastEnd, args.now, deadline, band));
      continue;
    }
    // A blocked action makes its own timing unknown, not the whole project's. Forecast the
    // resolvable work, report the blocked and held-back effort separately, and lower confidence one
    // step. Held back extends the same treatment to a chain stuck behind a blocked, waiting, or
    // unreachable (inactive-project) prerequisite in any project.
    const blockedActions = projectActions.filter(
      (action) => action.status === "blocked" || action.status === "waiting"
    );
    const heldBackActions = projectActions.filter(
      (action) => heldBack.get(action.id) && !blockedActions.includes(action)
    );
    const excludedActions = [...blockedActions, ...heldBackActions];
    // A cadence action is excluded here, not folded into `excludedActions`/`blockedMinutes` below: it
    // is not blocked or held back, it simply left the deadline pipeline entirely and so
    // reports no reason and no blocked-effort minutes — it is invisible to this project's forecast,
    // exactly as data this forecast never received would be.
    const forecastableActions = projectActions.filter(
      (action) => !excludedActions.includes(action) && action.schedulingMode !== "cadence"
    );
    if (!forecastableActions.length) {
      const cause = blockedActions.length
        ? `${blockedActions[0]!.title} has unresolved timing`
        : `${heldBackActions[0]!.title} is held back (${heldBackReason(heldBackActions[0]!.id)})`;
      forecasts.push(
        unknown(
          project.id,
          `${cause} and no other action is estimable.`,
          latestSafeStarts,
          forecastEnd,
          args.now,
          deadline,
          band
        )
      );
      continue;
    }
    const blockedMinutes = excludedActions.length
      ? projectEffort(excludedActions, project, config).riskAdjustedMinutes
      : 0;
    const projectEfforts = projectEffort(forecastableActions, project, config);

    const { grossBefore, availableBefore: rawAvailableBefore } = capacityBefore(
      projectActions,
      allSlots,
      slotOffers,
      slotRemaining,
      deadline
    );
    // The recurring standing pass already ran, consuming the shared ledger before this project's
    // own loop — so the raw ledger reading already treats this project's own recurring series the same
    // as capacity an earlier deadline used. That is the one case the design says is wrong: a project's
    // own series is its own allocation, already fully counted in `projectEfforts.riskAdjustedMinutes`
    // and in `totalReserved` below, so it is added back here rather than double-charged against margin
    // and reported as reserved by someone else.
    const ownRecurringReserved = recurringReservedMinutesByProject.get(project.id) ?? 0;
    const availableBefore = Math.min(grossBefore, rawAvailableBefore + ownRecurringReserved);
    const reservedEarlier = Math.max(0, grossBefore - availableBefore);
    // With no deadline the finish is when the free capacity, taken from now, has accumulated to the
    // project's effort: read before this project reserves anything, so its own reservation is not
    // mistaken for time that is gone.
    const noDeadline = deadlineSources.get(project.id) === "none";
    // Per action, against the capacity that action can use (its energy and contexts), and the latest
    // wins: work that needs a place or energy not free until later finishes then, whatever else is free.
    let estimatedFinishAt: Date | undefined;
    if (noDeadline) {
      let latest: Date | null = args.now;
      // The actions share the ledger: each one's minutes come off a scratch copy as its finish is
      // found, in dependency order, so two actions never count the same free minutes.
      const finishRemaining = new Map(slotRemaining);
      const effortOf = new Map(projectEfforts.efforts.map((effort) => [effort.actionId, effort]));
      for (const actionId of backwardActionOrder(forecastableActions).reverse()) {
        const effort = effortOf.get(actionId);
        const own = projectActions.find((item) => item.id === actionId);
        if (!effort || !own || effort.riskAdjustedRemainingMinutes <= 0) continue;
        const at = earliestInstantAfter(
          args.now,
          effort.riskAdjustedRemainingMinutes,
          [own],
          { allSlots, slotRemaining: finishRemaining },
          true
        );
        if (!at) {
          latest = null;
          break;
        }
        if (latest && at > latest) latest = at;
      }
      if (latest && latest > args.now) estimatedFinishAt = latest;
    }
    const unplacedThisProject: string[] = [];
    const atRiskActions: { action: Action; shortfall: number }[] = [];
    let totalReserved = 0;
    // Setup for each run beyond an action's first, charged on top of the per-action figures.
    let extraSetupCharged = 0;
    /**
     * Folds one action's placement result (fresh or already reserved by the recurring standing pass,
     * the standing pass) into this project's own bookkeeping: band envelopes, `totalReserved`, `latestSafeStarts`,
     * and the unplaced/at-risk split. Shared by the ordinary per-action reservation below and by a
     * recurring action's own standing-pass result, so both update the same fields the same way.
     */
    function applyReservation(
      action: Action,
      required: number,
      result: {
        blocks: AllocationBlock[];
        bandMinutes: Map<HorizonBandKind, number>;
        earliestStart: Date | null;
        extraSetupMinutes?: number;
        topUpMinutes?: number;
      }
    ) {
      for (const [kind, minutes] of result.bandMinutes) {
        const envelope = capacityEnvelopes.find((item) => item.kind === kind)!;
        const existing = projectEnvelopes.find((item) => item.projectId === project.id && item.kind === kind);
        if (existing) existing.reservedMinutes += minutes;
        else
          projectEnvelopes.push({
            projectId: project.id,
            kind,
            confidence: envelope.confidence,
            startsAt: envelope.startsAt,
            // `deadline` is guaranteed defined by this point in the outer loop (every `!deadline` path
            // above already `continue`d), but a nested function declaration doesn't inherit that
            // narrowing from TypeScript's control-flow analysis, hence the assertion.
            endsAt: new Date(Math.min(envelope.endsAt.getTime(), deadline!.getTime())),
            reservedMinutes: minutes,
            requiredPaceMinutes: requiredPace(
              projectEfforts.riskAdjustedMinutes,
              args.now,
              deadline!,
              envelope.startsAt,
              envelope.endsAt
            )
          });
      }
      // The action's own placement; setup reserved on top of it is accounted apart so it can never
      // make up for work that was not placed.
      const reservedForAction =
        result.blocks.reduce((sum, block) => sum + block.minutes, 0) +
        sumOf(result.bandMinutes) -
        (result.topUpMinutes ?? 0);
      totalReserved += reservedForAction;
      extraSetupCharged += result.extraSetupMinutes ?? 0;
      latestSafeStarts[action.id] = result.blocks.length
        ? (result.earliestStart ?? null)
        : result.earliestStart
          ? roundDownToHour(result.earliestStart)
          : null;
      const expectedNeeded = expectedRemainingMinutesFor(action, project);
      if (reservedForAction < expectedNeeded - RESERVE_EPSILON) unplacedThisProject.push(action.id);
      else if (reservedForAction < required - RESERVE_EPSILON)
        atRiskActions.push({ action, shortfall: Math.round(required - reservedForAction) });
    }
    for (const actionId of backwardActionOrder(forecastableActions)) {
      const action = forecastableActions.find((item) => item.id === actionId)!;
      const required = effortByAction.get(action.id)?.riskAdjustedRemainingMinutes ?? action.remainingMinutes;
      // Recurring standing pass: this action was already reserved, before any deadline project's
      // own loop, against the same shared ledger — reusing that result here (rather than reserving it
      // again) is what makes it count as this project's own allocation, not something "reserved for an
      // earlier deadline" (see the matching subtraction in `reservedEarlier` below).
      const standingResult = recurringResultByAction.get(action.id);
      if (standingResult) {
        applyReservation(action, required, standingResult);
        continue;
      }
      const dependantStarts = (globalSuccessors.get(actionId) ?? [])
        .map((id) => placedStart.get(id)?.getTime())
        .filter((time): time is number => time !== undefined);
      const effectiveCap = effectiveDeadline.get(actionId);
      const genericUpperBound = new Date(
        Math.min(
          deadline.getTime(),
          forecastEnd.getTime(),
          effectiveCap ? effectiveCap.getTime() : Number.MAX_SAFE_INTEGER,
          ...(dependantStarts.length ? dependantStarts : [Number.MAX_SAFE_INTEGER])
        )
      );
      const prereqEnds = (action.dependencyIds ?? [])
        .map((id) => placedEnd.get(id)?.getTime())
        .filter((time): time is number => time !== undefined);
      const genericLowerBound = prereqEnds.length ? new Date(Math.max(...prereqEnds)) : args.now;
      // A recurring series' later occurrence: its own window — this band's own start and
      // end, exactly as `engine.ts`'s `prepare()` synthesized it, the same fields the maintenance
      // standing pass above bounds its own actions by — narrows the generic bound rather than
      // replacing it, so a dependency or an earlier effective deadline still applies. Reserved
      // bands-only (see `reserveTailFirst`'s `bandsOnly`): this is aggregate band demand, with no
      // detailed-band slot of its own to fall back to.
      const laterRecurring =
        action.schedulingMode === "recurring" &&
        action.availableFrom !== undefined &&
        action.availableFrom.getTime() >= detailedEnd.getTime();
      const upperBound = laterRecurring
        ? new Date(Math.min(genericUpperBound.getTime(), action.deadlineAt?.getTime() ?? forecastEnd.getTime()))
        : genericUpperBound;
      const lowerBound = laterRecurring
        ? new Date(Math.max(genericLowerBound.getTime(), action.availableFrom!.getTime()))
        : genericLowerBound;
      let result = reserveTailFirst(action, required, upperBound, lowerBound, laterRecurring);
      // A later occurrence's own band can be oversubscribed by the time this project's turn comes
      // up — other, earlier-processed projects' ordinary work can fill it — and unlike a maintenance
      // project's standing pass (which runs before any of them), there is no detailed-band slot this
      // demand may fall back to. But the per-band split is only ever an aggregate approximation
      // (`engine.ts`'s `prepare()`: "nothing this far out actually knows this series will occupy
      // that exact quarter-hour"), not a placement the series is truly pinned to, so a genuine
      // remainder is real only if the *project's* own wider capacity can't cover it either. Reserve
      // the shortfall the same way any other action of this project would be bounded — bands only,
      // never detailed — rather than reporting a shortage the project's own margin contradicts.
      if (laterRecurring) {
        // The top-up is setup, not the series' own work: leave it out, as `placedOf` below does, or it
        // would pass for work placed and shrink the overflow asked for.
        const reservedSoFar =
          result.blocks.reduce((sum, block) => sum + block.minutes, 0) +
          sumOf(result.bandMinutes) -
          result.topUpMinutes;
        const stillNeeded = required - reservedSoFar;
        if (stillNeeded > RESERVE_EPSILON) {
          // The first part's own setup top-up that found no room is asked for here too, as top-up.
          const overflow = reserveTailFirst(
            action,
            stillNeeded + result.unfilledTopUpMinutes,
            genericUpperBound,
            genericLowerBound,
            true
          );
          const overflowPlaced =
            overflow.blocks.reduce((sum, block) => sum + block.minutes, 0) + sumOf(overflow.bandMinutes);
          const carriedTopUp = Math.min(
            result.unfilledTopUpMinutes,
            Math.max(0, overflowPlaced - overflow.topUpMinutes - stillNeeded)
          );
          // Each part charged (runs − 1) for its own runs; joining two placements is one more run
          // boundary, owed only when both actually placed something. Charged to margin, not reserved.
          const placedOf = (part: typeof result) =>
            part.blocks.reduce((sum, block) => sum + block.minutes, 0) + sumOf(part.bandMinutes) - part.topUpMinutes;
          const setup = action.remainingMinutes > 0 ? Math.max(0, action.setupMinutes ?? 0) : 0;
          const joinSetup =
            setup > 0 &&
            projectById.get(action.projectId)?.remainingEffortOverrideMinutes === undefined &&
            placedOf(result) > RESERVE_EPSILON &&
            placedOf(overflow) > RESERVE_EPSILON
              ? setup
              : 0;
          result = {
            blocks: [...result.blocks, ...overflow.blocks],
            bandMinutes: mergeBandMinutes(result.bandMinutes, overflow.bandMinutes),
            earliestStart: earliestOf(result.earliestStart, overflow.earliestStart),
            latestEnd: latestOf(result.latestEnd, overflow.latestEnd),
            extraSetupMinutes: result.extraSetupMinutes + overflow.extraSetupMinutes + joinSetup,
            topUpMinutes: result.topUpMinutes + overflow.topUpMinutes + carriedTopUp,
            unfilledTopUpMinutes: 0
          };
        }
      }
      allocations.push(...result.blocks);
      if (result.earliestStart) placedStart.set(action.id, result.earliestStart);
      if (result.latestEnd) placedEnd.set(action.id, result.latestEnd);
      applyReservation(action, required, result);
    }
    // A tail-first walk sums many small floating consumes across every slot it touches — far more of
    // them than the old single aggregate lump — so a fully-placed project can land a dust-sized
    // residue below true zero. `RESERVE_EPSILON` is the same tolerance `slots.ts` already uses for
    // its own consume ledger; without it that dust alone flipped a fully-reserved project to At risk.
    //
    // The scheduler reserves each action's own protected figure, which add up to far more than the
    // project's honest total (see `projectEffort`), so the unreserved share is measured against what
    // the actions asked for and applied to the honest total.
    const protectedTotal = projectEfforts.riskAdjustedMinutes + extraSetupCharged;
    const requested = projectEfforts.reservedProtectedMinutes;
    const unreservedShare = requested > 0 ? Math.max(0, requested - totalReserved) / requested : 0;
    const shortfall = unreservedShare * projectEfforts.riskAdjustedMinutes;
    // Whole minutes, rounded up: the share is a ratio, and a person reads "11 minutes", not a float.
    const needed = shortfall < RESERVE_EPSILON ? 0 : Math.ceil(shortfall);
    const expectedMargin = availableBefore - protectedTotal;
    const pessimisticMargin = availableBefore - (projectEfforts.pessimisticMinutes + extraSetupCharged);
    const marginRatio = expectedMargin / Math.max(protectedTotal, 1);
    const scheduleVariance =
      project.actualCompletionRatio !== undefined && project.requiredCompletionRatio !== undefined
        ? project.actualCompletionRatio - project.requiredCompletionRatio
        : null;
    const health = classifyHealth({
      unallocated: needed,
      expectedMargin,
      pessimisticMargin,
      marginRatio,
      scheduleVariance,
      config
    });
    const schedulingBlocked = needed > 0 && expectedMargin >= 0;
    // A weekly pace only means something against a real, future deadline. An overdue project has no
    // weeks left (the old clamp turned that into "finish it all in one day", 7x the remaining effort)
    // and a project without a deadline is measured against the horizon end, which is only where
    // planning stops: both report no pace (F1-10).
    const pace =
      noDeadline || deadline.getTime() <= args.now.getTime()
        ? null
        : Math.ceil(protectedTotal / Math.max((deadline.getTime() - args.now.getTime()) / (7 * DAY_MS), 1 / 7));
    const reestimated = projectEfforts.efforts.filter((effort) => effort.remainingExceedsBaseline).length;
    // Effort stays a number: an estimate nobody has confirmed in two weeks is still used as given, so ranking
    // and placement are untouched. On a project that is already behind or at risk, though, that figure is
    // what the whole verdict hangs on, so the forecast says so and trusts itself one band less.
    const agedInputs = atRiskHealth(health) ? agedEstimates(forecastableActions, args.now) : [];
    const confidence = lowerConfidence(
      band?.confidence ?? null,
      (blockedActions.length ? 1 : 0) + (agedInputs.length ? 1 : 0)
    );
    const reasons = [
      `${protectedTotal} risk-adjusted minutes remain.`,
      ...(project.remainingEffortOverrideMinutes !== undefined
        ? [
            `A project remaining-effort override of ${Math.max(0, Math.ceil(project.remainingEffortOverrideMinutes))} minutes is authoritative.`
          ]
        : []),
      ...(reestimated
        ? [
            `${reestimated} action${reestimated === 1 ? " has" : "s have"} been re-estimated above the original baseline; the revised remaining effort is authoritative.`
          ]
        : []),
      `${grossBefore} gross compatible minutes are projected before ${deadline.toISOString()}.`,
      `${reservedEarlier} minutes are reserved for earlier deadlines; ${availableBefore} remain available to this project.`,
      schedulingBlocked
        ? `${needed} minutes fit the remaining capacity but not its shape; an indivisible action or minimum session cannot be placed.`
        : needed
          ? `${needed} minutes could not be reserved.`
          : `All expected work fits with ${expectedMargin} minutes of slack.`,
      ...(blockedActions.length
        ? [
            `${blockedActions.length} blocked or waiting action${blockedActions.length === 1 ? "" : "s"} holding ${projectEffort(blockedActions, project, config).riskAdjustedMinutes} minutes are excluded until their timing resolves.`
          ]
        : []),
      ...heldBackActions.map((action) => `${action.title} is held back: ${heldBackReason(action.id)}.`),
      ...atRiskActions.map(
        ({ action, shortfall }) => `${shortfall} minutes of ${action.title}'s risk buffer can't be reserved.`
      ),
      ...(pace !== null ? [`Required pace is ${pace} minutes per week.`] : []),
      // named evidence for scheduleVariance, not just the number — the phrasing that lets
      // classifyHealth's "ahead" (a comfortably positive variance) and "at_risk" (a sufficiently
      // negative one) read as a fact about the project rather than an opaque threshold crossing.
      ...(scheduleVariance !== null
        ? [
            `Done ${Math.round((project.actualCompletionRatio ?? 0) * 100)}% of the work with ${Math.round((project.requiredCompletionRatio ?? 0) * 100)}% of the time used.`
          ]
        : []),
      ...(agedInputs.length
        ? [
            agedInputs.length === 1
              ? `The remaining time on ${agedInputs[0]!.title} was last set ${agedDays(agedInputs[0]!, args.now)} days ago; it is used as given and confidence drops one band.`
              : `${agedInputs.length} remaining times were last set ${EFFORT_STALE_DAYS} days ago or more, the oldest on ${agedInputs[0]!.title} (${agedDays(agedInputs[0]!, args.now)} days); they are used as given and confidence drops one band.`
          ]
        : []),
      `Forecast confidence is ${confidence?.replace("_", " ") ?? "unknown"}.`,
      ...(slots.some((slot) => slot.energy === "unconfirmed" && slot.capacityMinutes > 0)
        ? ["Time capacity is calculated, but future energy suitability is unconfirmed."]
        : [])
    ];
    // With no deadline there is nothing to be on track, behind or at risk against: the horizon end is
    // only where planning stops, so the answer is when the work finishes, never a verdict (§7).
    if (noDeadline)
      reasons.unshift(
        estimatedFinishAt
          ? `No deadline is set; at the available capacity this finishes around ${estimatedFinishAt.toISOString()}.`
          : `No deadline is set; the remaining work does not fit before ${deadline.toISOString()}.`
      );
    const reportedHealth = noDeadline ? "unknown" : health;
    const overdue = deadline < args.now;
    if (overdue)
      pendingProposals.push({
        projectId: project.id,
        actions: projectActions,
        required: protectedTotal,
        deadline,
        externalDeadlineAt: project.externalDeadlineAt ?? null,
        now: args.now
      });
    if (!overdue && !noDeadline && (health === "behind" || health === "at_risk")) {
      const spreads = projectEfforts.efforts
        .map((effort) => ({
          actionId: effort.actionId,
          spread: effort.pessimisticRemainingMinutes - effort.riskAdjustedRemainingMinutes
        }))
        .filter((item) => item.spread > 0)
        .sort((a, b) => b.spread - a.spread || a.actionId.localeCompare(b.actionId));
      pendingInterventions.push({
        projectId: project.id,
        actions: forecastableActions,
        deadline,
        // Health was measured against `deadline`, so the intervention takes that deadline's owner: an
        // explicit internal target before the external date is self-set (move it), not an extension request.
        external: Boolean(
          project.externalDeadlineAt &&
          (!project.internalDeadlineAt || project.internalDeadlineAt.getTime() >= project.externalDeadlineAt.getTime())
        ),
        now: args.now,
        needed,
        expectedMargin,
        pessimisticMargin,
        reservedEarlier,
        schedulingBlocked,
        unplaced: unplacedThisProject.map((id) => forecastableActions.find((action) => action.id === id)!),
        bufferShortfalls: [...atRiskActions]
          .sort((a, b) => b.shortfall - a.shortfall || a.action.id.localeCompare(b.action.id))
          .map(({ action, shortfall }) => ({ action, minutes: shortfall })),
        spreadActions: spreads
          .slice(0, 3)
          .map((item) => forecastableActions.find((action) => action.id === item.actionId)!)
      });
    }
    forecasts.push({
      projectId: project.id,
      health: reportedHealth,
      overdue,
      protectedRemainingMinutes: protectedTotal,
      pessimisticRemainingMinutes: projectEfforts.pessimisticMinutes + extraSetupCharged,
      expectedRemainingMinutes: Math.round((projectEfforts.meanMinutes + extraSetupCharged) * 100) / 100,
      remainingDeviationMinutes: Math.round(projectEfforts.deviationMinutes * 100) / 100,
      ...(estimatedFinishAt ? { estimatedFinishAt } : {}),
      compatibleCapacityMinutes: availableBefore,
      grossCompatibleCapacityMinutes: grossBefore,
      reservedByEarlierDeadlinesMinutes: reservedEarlier,
      requiredPaceMinutesPerWeek: pace,
      forecastBand: band?.kind ?? null,
      confidence,
      forecastThrough: forecastEnd,
      expectedMarginMinutes: expectedMargin,
      pessimisticMarginMinutes: pessimisticMargin,
      marginRatio,
      scheduleVariance,
      internalDeadlineAt: deadline,
      unallocatedExpectedMinutes: needed,
      blockedEffortMinutes: blockedMinutes,
      ...(agedInputs.length ? { agedInputs } : {}),
      schedulingBlocked,
      latestSafeStarts,
      ...(unplacedThisProject.length ? { unplacedUnitIds: unplacedThisProject } : {}),
      healthBasis: "feasibility",
      reasons
    });
  }
  // Leads the reasons: it explains why every number below it was measured against a date other than
  // the one on the project.
  for (const forecast of forecasts) {
    const clamped = clampedDeadlineReasons.get(forecast.projectId);
    if (clamped) forecast.reasons = [clamped, ...forecast.reasons];
    const source = deadlineSources.get(forecast.projectId);
    if (source) forecast.deadlineSource = source;
  }
  // Every band, including the detailed one, now keeps its own real per-slot ledger, so its finished
  // reservedMinutes/freeMinutes read directly off that ledger rather than off a proportional guess.
  for (const envelope of capacityEnvelopes) {
    const kindSlots = envelope.kind === "detailed" ? slots : (bandSlotsByKind.get(envelope.kind) ?? []);
    const remaining = kindSlots.reduce((sum, slot) => sum + (slotRemaining.get(slot.id) ?? 0), 0);
    envelope.reservedMinutes = Math.max(0, envelope.adjustedCapacityMinutes - remaining);
    envelope.freeMinutes = Math.max(0, remaining);
  }
  // Proposals read the ledgers after every project has reserved, so the date offered is one that
  // displaces nobody: the earliest instant at which the overdue project's remaining effort fits the
  // capacity still free. Same inputs, same proposal.
  const jointDates = jointEarliestFeasible(pendingProposals, { allSlots, slotRemaining });
  for (const pending of pendingProposals) {
    const forecast = forecasts.find((item) => item.projectId === pending.projectId)!;
    forecast.proposal = proposeDeadline(pending, { allSlots, slotRemaining });
    forecast.proposal.jointEarliestFeasibleAt = jointDates.get(pending.projectId) ?? null;
  }
  for (const pending of pendingInterventions) {
    const forecast = forecasts.find((item) => item.projectId === pending.projectId)!;
    const interventions = proposeInterventions(pending, { allSlots, slotRemaining });
    if (interventions.length) forecast.interventions = interventions;
  }
  return {
    slots,
    allocations: allocations.sort(
      (a, b) => a.startsAt.getTime() - b.startsAt.getTime() || a.actionId.localeCompare(b.actionId)
    ),
    capacityEnvelopes,
    projectEnvelopes,
    forecasts: args.projects.map((project) => forecasts.find((forecast) => forecast.projectId === project.id)!),
    dependencyOrder: dependencies.order,
    dependencyErrors: dependencies.errors
  };
}

function splitDetailedSlots(slots: PlanningSlot[]): PlanningSlot[] {
  const quantum = 15 * MINUTE_MS;
  return slots.flatMap((slot) => {
    if (slot.availability === "fixed" || slot.endsAt.getTime() - slot.startsAt.getTime() <= quantum) return [slot];
    const result: PlanningSlot[] = [];
    const totalDuration = Math.max(1, slot.endsAt.getTime() - slot.startsAt.getTime());
    let assignedCapacity = 0;
    for (
      let cursor = slot.startsAt.getTime(), index = 0;
      cursor < slot.endsAt.getTime();
      cursor += quantum, index += 1
    ) {
      const end = Math.min(slot.endsAt.getTime(), cursor + quantum);
      const isLast = end === slot.endsAt.getTime();
      const capacityMinutes = isLast
        ? Math.max(0, slot.capacityMinutes - assignedCapacity)
        : slot.capacityMinutes * ((end - cursor) / totalDuration);
      assignedCapacity += capacityMinutes;
      result.push({
        ...slot,
        id: `${slot.id}:${index}`,
        startsAt: new Date(cursor),
        endsAt: new Date(end),
        capacityMinutes
      });
    }
    return result;
  });
}

function buildCapacityEnvelopes(
  args: ScheduleArguments,
  config: PlanningConfig,
  detailedEnd: Date,
  forecastEnd: Date,
  detailedSlots: PlanningSlot[],
  /** Filled with each later band's slots net of commitments, which `buildBandSlots` scales. */
  knownBandSlots: Map<HorizonBandKind, PlanningSlot[]>
): CapacityEnvelope[] {
  const arrivalMarginMinutes = args.arrivalMarginMinutes ?? ARRIVAL_MARGIN_MINUTES;
  return config.horizonBands.map((band) => {
    const startsAt = new Date(Math.min(forecastEnd.getTime(), args.now.getTime() + band.startDay * DAY_MS));
    const endsAt = new Date(Math.min(forecastEnd.getTime(), args.now.getTime() + band.endDay * DAY_MS));
    const rawSlots =
      endsAt > startsAt
        ? normalizePlanningSlots({
            from: startsAt,
            until: endsAt,
            capacityWindows: args.capacityWindows,
            commitments: [],
            boundaries: []
          })
        : [];
    const raw = rawSlots.reduce((sum, slot) => sum + slot.capacityMinutes, 0);
    const rawWallClockMinutes = rawSlots.reduce(
      (sum, slot) => sum + (slot.capacityMinutes > 0 ? slotMinutes(slot) : 0),
      0
    );
    const knownSlots =
      band.kind === "detailed"
        ? detailedSlots
        : normalizePlanningSlots({
            from: startsAt,
            until: endsAt,
            capacityWindows: args.capacityWindows,
            commitments: args.commitments,
            boundaries: [],
            arrivalMarginMinutes
          });
    if (band.kind !== "detailed") knownBandSlots.set(band.kind, knownSlots);
    const knownAvailable = knownSlots.reduce((sum, slot) => sum + slot.capacityMinutes, 0);
    // Routine protection is projected across every band beyond the exact horizon, where real
    // commitments no longer exist. The detailed band already subtracts them as commitments.
    const days = Math.max(0, (endsAt.getTime() - startsAt.getTime()) / DAY_MS);
    const projected =
      band.kind === "detailed"
        ? 0
        : Math.round(inCapacityUnits((args.projectedDailyProtectedMinutes ?? 0) * days, raw, rawWallClockMinutes));
    const protectedKnown = Math.max(0, raw - knownAvailable) + projected;
    const adjusted = Math.max(0, Math.floor((raw - protectedKnown) * band.capacityFactor));
    return {
      kind: band.kind,
      confidence: band.confidence,
      capacityFactor: band.capacityFactor,
      startsAt,
      endsAt,
      rawCapacityMinutes: raw,
      adjustedCapacityMinutes: adjusted,
      protectedKnownMinutes: protectedKnown,
      reservedMinutes: 0,
      freeMinutes: adjusted
    };
  });
}

const confidenceLadder: ForecastConfidence[] = ["high", "medium_high", "medium", "low_medium", "low"];
/**
 * Unresolved blocked work, or an aged estimate on an at-risk project, makes the forecast less trustworthy, not
 * unusable: one band down for each, never below the bottom of the ladder.
 */
function lowerConfidence(confidence: ForecastConfidence | null, bands = 1): ForecastConfidence | null {
  if (!confidence) return null;
  const index = confidenceLadder.indexOf(confidence);
  return confidenceLadder[Math.min(confidenceLadder.length - 1, index + bands)] ?? confidence;
}

function agedDays(input: AgedInput, now: Date): number {
  return Math.floor((now.getTime() - input.setAt.getTime()) / DAY_MS);
}

/**
 * The actions this forecast prices whose remaining-effort estimate was set 14 days ago or more, oldest first
 * (`effortAge`, the one rule the Now needs list reads too). A recurring unit carries its template's date but its
 * minutes come from the series, not an estimate, so it is left out; an action with no date is of unknown age
 * and is left out as well.
 */
function agedEstimates(actions: Action[], now: Date): AgedInput[] {
  return actions
    .filter(
      (action) =>
        action.schedulingMode !== "recurring" &&
        action.remainingMinutes > 0 &&
        action.remainingSetAt !== undefined &&
        effortAge(action.remainingSetAt, now)?.stale === true
    )
    .map((action) => ({ actionId: action.id, title: action.title, setAt: action.remainingSetAt! }))
    .sort((a, b) => a.setAt.getTime() - b.setAt.getTime() || a.actionId.localeCompare(b.actionId));
}

function bandForDate(date: Date, now: Date, bands: HorizonBandConfig[]) {
  const day = (date.getTime() - now.getTime()) / DAY_MS;
  return bands.find((band) => day <= band.endDay) ?? null;
}
function requiredPace(total: number, now: Date, deadline: Date, startsAt: Date, endsAt: Date) {
  const weekly = total / Math.max((deadline.getTime() - now.getTime()) / (7 * DAY_MS), 1 / 7);
  return Math.ceil(weekly * Math.max(0, (endsAt.getTime() - startsAt.getTime()) / (7 * DAY_MS)));
}
/**
 * A band's own real per-slot ledger: the same window-segment slots `normalizePlanningSlots`
 * would give the detailed band, scaled uniformly so their sum matches this band's own
 * `adjustedCapacityMinutes` exactly (invariant 1 — a single project's own compatible capacity is
 * unchanged within rounding; only *placement* moves). The scale folds the band's capacity factor
 * and its projected-protection share into one number and applies it identically to every slot's
 * capacity and to every one of its capacity options' usable fractions, so `slotCapacityForAction`
 * keeps answering off the same real window compatibility (context, energy) it always has — it is
 * only the ceiling that is smaller. That is what lets two context-disjoint projects each see their
 * own real, disjoint capacity in this band instead of sharing one pool neither of them could
 * actually reach in full.
 *
 * `base` is the band's slots net of commitments, exactly as `buildCapacityEnvelopes` built them to
 * measure the band; reused rather than normalised a second time from the same arguments.
 */
function buildBandSlots(envelope: CapacityEnvelope, base: PlanningSlot[]): PlanningSlot[] {
  if (envelope.endsAt <= envelope.startsAt) return [];
  const baseTotal = base.reduce((sum, slot) => sum + slot.capacityMinutes, 0);
  const scale = baseTotal > 0 ? envelope.adjustedCapacityMinutes / baseTotal : 0;
  return scale === 1 ? base : base.map((slot) => scaleSlot(slot, scale));
}
function scaleSlot(slot: PlanningSlot, scale: number): PlanningSlot {
  return {
    ...slot,
    capacityMinutes: slot.capacityMinutes * scale,
    usableFraction: slot.usableFraction * scale,
    capacityOptions: slot.capacityOptions.map((option) => ({
      ...option,
      usableFraction: option.usableFraction * scale
    }))
  };
}
/**
 * Every slot's start and end as numbers, when both run in non-decreasing order — which the combined
 * ledger always does, being ascending detailed slots followed by each later band's — so the two index
 * lookups below can binary-search it. Every action reserved asks both, and a linear scan of a
 * six-month ledger per action was a quarter of the plan's time. Checked rather than
 * assumed: a ledger out of order gets `null` and the original scans, which answer for any order.
 */
interface SlotTimes {
  starts: Float64Array;
  ends: Float64Array;
}
function sortedSlotTimes(slots: PlanningSlot[]): SlotTimes | null {
  const starts = new Float64Array(slots.length);
  const ends = new Float64Array(slots.length);
  for (let index = 0; index < slots.length; index += 1) {
    starts[index] = slots[index]!.startsAt.getTime();
    ends[index] = slots[index]!.endsAt.getTime();
    // Written as a negated `>=` so a NaN (an invalid date) also counts as out of order.
    if (index > 0 && !(starts[index]! >= starts[index - 1]! && ends[index]! >= ends[index - 1]!)) return null;
  }
  if (slots.length && !(starts[0]! === starts[0]! && ends[0]! === ends[0]!)) return null;
  return { starts, ends };
}
/** The first index in an ascending-time slot array whose window starts at or after `boundary`. */
function firstSlotIndexAtOrAfter(slots: PlanningSlot[], boundary: Date, times: SlotTimes | null = null) {
  if (!times) {
    for (let index = 0; index < slots.length; index += 1) if (slots[index]!.startsAt >= boundary) return index;
    return slots.length;
  }
  const target = boundary.getTime();
  let low = 0;
  let high = slots.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (times.starts[middle]! >= target) high = middle;
    else low = middle + 1;
  }
  return low;
}
function roundDownToHour(date: Date): Date {
  const HOUR_MS = 3_600_000;
  return new Date(Math.floor(date.getTime() / HOUR_MS) * HOUR_MS);
}
function sumOf(minutesByKind: Map<HorizonBandKind, number>): number {
  let total = 0;
  for (const minutes of minutesByKind.values()) total += minutes;
  return total;
}
/** Combines two `reserveTailFirst` results' per-band minutes, keyed by band kind. */
function mergeBandMinutes(
  a: Map<HorizonBandKind, number>,
  b: Map<HorizonBandKind, number>
): Map<HorizonBandKind, number> {
  const merged = new Map(a);
  for (const [kind, minutes] of b) merged.set(kind, (merged.get(kind) ?? 0) + minutes);
  return merged;
}
function earliestOf(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}
function latestOf(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}
/**
 * Expected (not risk-adjusted) remaining minutes: the same `remainingRatio`/`setup` scaling
 * `effort.ts` applies to the risk-adjusted figure, applied here to the PERT expected estimate
 * instead. Deliberately duplicated rather than added to `ActionEffort` — this is a single-purpose
 * threshold for "was even the unbuffered estimate unplaceable", not a figure any other consumer
 * reads, and adding an unused field to a widely-shared interface for it would be dead plumbing.
 */
function expectedRemainingMinutesFor(action: Action, project: Project | undefined): number {
  const baseline = Math.max(1, action.expectedMinutes);
  const optimistic = action.optimisticMinutes;
  const pessimistic = action.pessimisticMinutes;
  const hasPert =
    optimistic !== undefined && pessimistic !== undefined && optimistic <= baseline && baseline <= pessimistic;
  const expected =
    (hasPert ? (optimistic + 4 * baseline + pessimistic) / 6 : baseline) * (project?.estimateCalibration?.factor ?? 1);
  const remainingRatio = action.remainingMinutes / baseline;
  const setup = action.remainingMinutes > 0 ? Math.max(0, action.setupMinutes ?? 0) : 0;
  return Math.max(0, Math.ceil(expected * remainingRatio) + setup);
}
/**
 * The most capacity any of these actions could take from this slot.
 *
 * Spelt as a loop rather than `Math.max(0, ...actions.map(...))` only to stop allocating an array and
 * spreading it for every slot of every band of every project — the comparison, and so the answer, is
 * the same one.
 */
function bestCapacityForAny(slot: PlanningSlot, actions: Action[]): number {
  let best = 0;
  for (const action of actions) {
    const minutes = slotCapacityForAction(slot, action);
    if (minutes > best) best = minutes;
  }
  return best;
}
/**
 * Both figures read a single combined ledger — the detailed slots followed by every band's own real
 * per-slot ledger (`buildBandSlots`) — instead of the detailed slots plus a separately-shaped
 * envelope estimate. That is the whole of the fix: the same per-slot compatibility question, asked
 * of the same real capacity, whichever band it falls in. Computed together in one pass over
 * `allSlots`, breaking at the deadline rather than filtering the whole array first, since every
 * project asks this once and the array can run to the low thousands over a six-month horizon.
 */
function capacityBefore(
  actions: Action[],
  allSlots: PlanningSlot[],
  offers: SlotOfferIndex,
  remaining: Map<string, number>,
  deadline: Date
): { grossBefore: number; availableBefore: number } {
  // `bestCapacityForAny` per slot, restated per offer: a slot's capacity for an action is its whole
  // minutes times the action's fraction of the offer, and multiplying by the same non-negative minutes
  // preserves which fraction is largest, so the best over the actions is the minutes times the best
  // fraction — the same number, found once per distinct offer instead of once per slot per action.
  // Every project asks this over the whole ledger up to its deadline, and asking it slot by slot was
  // the largest single cost left in a plan. The sums run in the same order over the same
  // values, so they come to the same bytes.
  const bestFraction = new Float64Array(offers.representatives.length);
  for (let offer = 0; offer < offers.representatives.length; offer += 1) {
    let best = 0;
    for (const action of actions) {
      const fraction = usableFractionForAction(offers.representatives[offer]!, action);
      if (fraction > best) best = fraction;
    }
    bestFraction[offer] = best;
  }
  const deadlineMs = deadline.getTime();
  let gross = 0;
  let available = 0;
  for (let index = 0; index < allSlots.length; index += 1) {
    if (offers.starts[index]! >= deadlineMs) break;
    const offer = offers.offer[index]!;
    if (offer < 0) continue;
    const capacity = offers.minutes[index]! * bestFraction[offer]!;
    if (capacity <= 0) continue;
    gross += capacity;
    available += Math.min(remaining.get(allSlots[index]!.id) ?? 0, capacity);
  }
  return { grossBefore: Math.floor(gross), availableBefore: Math.floor(available) };
}

function slotMinutes(slot: PlanningSlot) {
  return (slot.endsAt.getTime() - slot.startsAt.getTime()) / MINUTE_MS;
}

interface PendingProposal {
  projectId: string;
  actions: Action[];
  required: number;
  /** The effective (internal) deadline that has passed. */
  deadline: Date;
  /** The project's external date, whether or not it has passed; null for a self-set project. */
  externalDeadlineAt: Date | null;
  now: Date;
}

/**
 * The earliest instant by which `required` compatible minutes accumulate from the capacity nobody
 * has reserved, walking the combined ledger (detailed slots, then every band's own real slots, in
 * ascending time) slot by slot. Null when the horizon runs out first. Aggregate minutes only:
 * session shape is not re-checked here.
 */
function proposeDeadline(
  pending: PendingProposal,
  ledger: { allSlots: PlanningSlot[]; slotRemaining: Map<string, number> }
): ForecastProposal {
  // The external date has only passed when it is itself behind `now`. The effective deadline sits
  // earlier than it (the submission buffer, or the owner's own target), so it passing says nothing about
  // the commitment to someone else: only an external date in the past is reported as missed.
  const externalPassed = Boolean(
    pending.externalDeadlineAt && pending.externalDeadlineAt.getTime() < pending.now.getTime()
  );
  const externalAhead = pending.externalDeadlineAt && !externalPassed ? pending.externalDeadlineAt : null;
  const earliestFeasibleAt = earliestFeasibleInstant(pending, ledger);
  const missedAt = externalPassed ? pending.externalDeadlineAt! : pending.deadline;
  const passed = missedAt.toISOString();
  const reason = externalPassed
    ? `The externally committed date passed at ${passed}; renegotiate it or record the outcome.${
        earliestFeasibleAt
          ? ` The remaining work would fit by ${earliestFeasibleAt.toISOString()} without displacing anything.`
          : " The remaining work does not fit anywhere inside the forecast horizon."
      }`
    : externalAhead
      ? ownTargetPassedReason(passed, externalAhead, earliestFeasibleAt)
      : earliestFeasibleAt
        ? `The self-set date passed at ${passed}. Move it to ${earliestFeasibleAt.toISOString()}, the earliest date the remaining work fits without displacing anything, or mark the project done or paused.`
        : `The self-set date passed at ${passed} and the remaining work does not fit anywhere inside the forecast horizon; mark the project done or paused, or reduce it.`;
  return {
    kind: "move_deadline",
    deadlineOwner: externalPassed ? "external" : "internal",
    missedDeadlineAt: missedAt,
    earliestFeasibleAt,
    reason
  };
}

/**
 * The wording for a self-set target (or the submission buffer before the external date) that has
 * passed while the external date is still ahead. It never says the commitment was missed: it names
 * the target, the external date that still stands, and whether the remaining work still fits before it.
 */
function ownTargetPassedReason(passed: string, externalAt: Date, earliestFeasibleAt: Date | null): string {
  const lead = `Your own target passed at ${passed}, but the external date ${externalAt.toISOString()} is still ahead.`;
  if (!earliestFeasibleAt)
    return `${lead} The remaining work does not fit anywhere inside the forecast horizon; move your target, or reduce the work.`;
  return earliestFeasibleAt.getTime() <= externalAt.getTime()
    ? `${lead} The remaining work would fit by ${earliestFeasibleAt.toISOString()} without displacing anything, before the external date; move your target there or finish inside the buffer.`
    : `${lead} The earliest the remaining work fits without displacing anything is ${earliestFeasibleAt.toISOString()}, after the external date; reduce the work, add time, or talk to whoever holds that date.`;
}

/**
 * Each overdue project's date when all of them are taken together. `earliestFeasibleAt` reads the
 * same unreserved ledger for every project, so two projects can both count the same free minutes;
 * moving one reserves them before its new date and pushes the other's real date later. This walks the
 * projects in the order the scheduler reserved them, on a scratch copy of the ledger, and debits the
 * minutes each one would consume before assigning the next, so the dates fit side by side. A project
 * that fits nowhere gets null and debits nothing.
 */
function jointEarliestFeasible(
  pendings: PendingProposal[],
  ledger: Parameters<typeof proposeDeadline>[1]
): Map<string, Date | null> {
  const scratch = new Map(ledger.slotRemaining);
  const dates = new Map<string, Date | null>();
  for (const pending of pendings) {
    const at = earliestFeasibleInstant(pending, { allSlots: ledger.allSlots, slotRemaining: scratch });
    dates.set(pending.projectId, at);
    if (!at || pending.required <= 0) continue;
    let left = pending.required;
    for (const slot of ledger.allSlots) {
      if (left <= 0) break;
      const taken = Math.min(scratch.get(slot.id) ?? 0, bestCapacityForAny(slot, pending.actions), left);
      if (taken <= 0) continue;
      scratch.set(slot.id, (scratch.get(slot.id) ?? 0) - taken);
      left -= taken;
    }
  }
  return dates;
}

function earliestFeasibleInstant(pending: PendingProposal, ledger: Parameters<typeof proposeDeadline>[1]): Date | null {
  if (pending.required <= 0) return pending.now;
  let accumulated = 0;
  for (const slot of ledger.allSlots) {
    const minutes = Math.min(ledger.slotRemaining.get(slot.id) ?? 0, bestCapacityForAny(slot, pending.actions));
    if (minutes <= 0) continue;
    accumulated += minutes;
    if (accumulated >= pending.required) return slot.endsAt;
  }
  return null;
}

interface PendingInterventions {
  projectId: string;
  actions: Action[];
  deadline: Date;
  external: boolean;
  now: Date;
  needed: number;
  expectedMargin: number;
  pessimisticMargin: number;
  reservedEarlier: number;
  schedulingBlocked: boolean;
  unplaced: Action[];
  bufferShortfalls: { action: Action; minutes: number }[];
  spreadActions: Action[];
}

/**
 * the smallest useful interventions for a live project that does not fit, smallest first,
 * each built only from what the forecast already measured. Read after every project has reserved,
 * so a proposed date displaces nobody. See `ForecastIntervention`.
 */
function proposeInterventions(
  pending: PendingInterventions,
  ledger: { allSlots: PlanningSlot[]; slotRemaining: Map<string, number> }
): ForecastIntervention[] {
  const interventions: ForecastIntervention[] = [];
  const titles = (actions: Action[]) => listTitles(actions.map((action) => action.title));
  const due = pending.deadline.toISOString();
  const shortage = pending.needed > 0 && !pending.schedulingBlocked;
  if (pending.bufferShortfalls.length && !pending.unplaced.length) {
    const actions = pending.bufferShortfalls.map((item) => item.action);
    const minutes = pending.bufferShortfalls.reduce((sum, item) => sum + item.minutes, 0);
    interventions.push({
      kind: "clarify_estimate",
      actionIds: actions.map((action) => action.id),
      minutes,
      reason: `The expected work fits, but ${minutes} minutes of risk buffer for ${titles(actions)} do not. Narrow the estimate: break it down, or answer what makes it uncertain.`
    });
  } else if (
    pending.needed <= 0 &&
    pending.expectedMargin >= 0 &&
    pending.pessimisticMargin < 0 &&
    pending.spreadActions.length
  ) {
    const minutes = Math.ceil(-pending.pessimisticMargin);
    interventions.push({
      kind: "clarify_estimate",
      actionIds: pending.spreadActions.map((action) => action.id),
      minutes,
      reason: `The work fits as expected but not at its pessimistic estimate, which needs ${minutes} more minutes. Narrowing the range on ${titles(pending.spreadActions)} would settle it.`
    });
  }
  if (pending.schedulingBlocked && pending.unplaced.length) {
    const whole = pending.unplaced.filter((action) => action.splittable === false);
    const actions = whole.length ? whole : pending.unplaced;
    interventions.push({
      kind: "split_work",
      actionIds: actions.map((action) => action.id),
      minutes: pending.needed,
      shape: whole.length ? "whole" : "minimum_session",
      reason: whole.length
        ? `There is enough time before ${due}, but no window fits ${titles(whole)} whole. Allow it to be split across sessions.`
        : `There is enough time before ${due}, but not in sessions as long as ${titles(actions)} needs. Shorten its minimum session.`
    });
  }
  if (shortage) {
    const minutes = Math.ceil(Math.max(pending.needed, -pending.expectedMargin));
    interventions.push({
      kind: "add_time",
      actionIds: [],
      minutes,
      reason: `${minutes} more compatible minutes are needed before ${due}.${
        pending.reservedEarlier > 0
          ? ` ${pending.reservedEarlier} minutes before then are held for earlier deadlines.`
          : ""
      } Add time, or pause other work to free it.`
    });
    const proposedDeadlineAt = earliestInstantAfter(pending.deadline, minutes, pending.actions, ledger);
    const when = proposedDeadlineAt ? proposedDeadlineAt.toISOString() : null;
    interventions.push(
      pending.external
        ? {
            kind: "request_extension",
            actionIds: [],
            minutes,
            proposedDeadlineAt,
            reason: when
              ? `Ask for an extension to ${when}, the earliest the remaining work fits without displacing anything, or hand ${minutes} minutes to someone else.`
              : `The remaining work does not fit inside the forecast horizon. Ask for an extension, hand ${minutes} minutes to someone else, or reduce the scope.`
          }
        : {
            kind: "move_deadline",
            actionIds: [],
            minutes,
            proposedDeadlineAt,
            reason: when
              ? `Move the self-set date to ${when}, the earliest the remaining work fits without displacing anything.`
              : `The remaining work does not fit inside the forecast horizon. Reduce the scope, or move the self-set date past it.`
          }
    );
  }
  return interventions;
}

/**
 * The earliest instant `required` compatible minutes accumulate from free capacity at or after
 * `after`, counting only the part of a straddling slot past it. Capacity still free before a live
 * project's deadline is capacity that project already failed to use (a fragment below its minimum
 * session, time past its maximum), so it never counts toward the shortfall. Null past the horizon.
 */
function earliestInstantAfter(
  after: Date,
  required: number,
  actions: Action[],
  ledger: { allSlots: PlanningSlot[]; slotRemaining: Map<string, number> },
  consumeLedger = false
): Date | null {
  let accumulated = 0;
  const taken: Array<[string, number]> = [];
  for (const slot of ledger.allSlots) {
    if (slot.endsAt <= after) continue;
    const available = ledger.slotRemaining.get(slot.id) ?? 0;
    const minutes = Math.min(available, bestCapacityForAny(slot, actions));
    if (minutes <= 0) continue;
    const span = slot.endsAt.getTime() - slot.startsAt.getTime();
    const past = slot.endsAt.getTime() - Math.max(slot.startsAt.getTime(), after.getTime());
    const usable = span > 0 ? minutes * (past / span) : 0;
    const needed = required - accumulated;
    taken.push([slot.id, Math.min(usable, Math.max(0, needed))]);
    accumulated += usable;
    if (accumulated >= required - RESERVE_EPSILON) {
      // Deduct only on a hit: a miss leaves the ledger as it was.
      if (consumeLedger)
        for (const [id, took] of taken) ledger.slotRemaining.set(id, (ledger.slotRemaining.get(id) ?? 0) - took);
      return slot.endsAt;
    }
  }
  return null;
}

function listTitles(titles: string[]) {
  if (titles.length <= 1) return titles[0] ?? "";
  return `${titles.slice(0, -1).join(", ")} and ${titles[titles.length - 1]}`;
}

/**
 * Protected time is measured in wall-clock minutes but capacity totals are already discounted by
 * each window's usable fraction. Scale the protection into the same units before subtracting it.
 */
function inCapacityUnits(protectedWallClockMinutes: number, capacityMinutes: number, wallClockMinutes: number) {
  if (protectedWallClockMinutes <= 0 || wallClockMinutes <= 0) return 0;
  return protectedWallClockMinutes * (capacityMinutes / wallClockMinutes);
}

function submissionBuffer(protectedMinutes: number, minimumBufferMinutes: number, bufferPercent: number) {
  return Math.min(1_440, Math.max(minimumBufferMinutes, Math.ceil(protectedMinutes * bufferPercent)));
}

/**
 * The external date governs. An internal date later than the external one is not a plan — most
 * writers validate the pair, but not every path does — and returning it unclamped hid overdue
 * external work from the severity ladder outright: the project ranked ordinary while its committed
 * date receded into the past. An explicit internal date is therefore capped at the external date,
 * and only at the external date: the submission buffer belongs to the derived branch, which stands
 * in for a target nobody typed. Applying it to a typed date pulled valid targets inside the buffer
 * window into the past and ranked a not-yet-due project overdue. See.
 */
export function resolveInternalDeadline(
  project: Project,
  protectedMinutes: number,
  minimumBufferMinutes = 60,
  bufferPercent = 0.1
): Date | undefined {
  if (project.internalDeadlineAt) {
    const external = project.externalDeadlineAt;
    return external && project.internalDeadlineAt.getTime() > external.getTime()
      ? external
      : project.internalDeadlineAt;
  }
  if (!project.externalDeadlineAt) return undefined;
  return new Date(
    project.externalDeadlineAt.getTime() -
      submissionBuffer(protectedMinutes, minimumBufferMinutes, bufferPercent) * MINUTE_MS
  );
}
/** The last index whose window ends at or before `boundary`, or -1; see `sortedSlotTimes`. */
function latestSlotIndex(slots: PlanningSlot[], boundary: Date, times: SlotTimes | null = null) {
  if (!times) {
    let latest = -1;
    for (let index = 0; index < slots.length; index += 1) if (slots[index]!.endsAt <= boundary) latest = index;
    return latest;
  }
  const target = boundary.getTime();
  let low = 0;
  let high = slots.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (times.ends[middle]! <= target) low = middle + 1;
    else high = middle;
  }
  return low - 1;
}
const actionEnergyRank: Record<EnergyType, number> = { high: 3, medium: 2, low: 1, recovery: 0 };
function backwardActionOrder(actions: Action[]) {
  const byId = new Map(actions.map((action) => [action.id, action]));
  const predecessors = new Map(
    actions.map((action) => [action.id, (action.dependencyIds ?? []).filter((id) => byId.has(id))])
  );
  const remainingSuccessors = new Map(actions.map((action) => [action.id, 0]));
  for (const values of predecessors.values())
    for (const id of values) remainingSuccessors.set(id, (remainingSuccessors.get(id) ?? 0) + 1);
  const ready = actions.filter((action) => remainingSuccessors.get(action.id) === 0);
  const order: string[] = [];
  while (ready.length) {
    ready.sort((a, b) => actionEnergyRank[b.energy] - actionEnergyRank[a.energy] || a.id.localeCompare(b.id));
    const action = ready.shift()!;
    order.push(action.id);
    for (const id of predecessors.get(action.id) ?? []) {
      const next = (remainingSuccessors.get(id) ?? 0) - 1;
      remainingSuccessors.set(id, next);
      if (next === 0) ready.push(byId.get(id)!);
    }
  }
  return order;
}
function allocateAction(
  action: Action,
  required: number,
  latestIndex: number,
  slots: PlanningSlot[],
  remaining: Map<string, number>,
  earliestIndex = 0,
  sessionBreakMinutes: number = SESSION_BREAK_MINUTES,
  prior: AllocationBlock[] = []
) {
  if (required <= 0 || latestIndex < 0 || latestIndex < earliestIndex) return [];
  // Bounded by the deadline before the capacity is measured rather than after. Every action was
  // costing a pass over the whole detailed ledger to build rows it then discarded, and a slot past the
  // boundary can never be a candidate whatever it offers. The dropped `slotFitsAction` check was
  // already implied: positive minutes mean the slot offered the action capacity. `earliestIndex`
  // does the same on the near side — a two-way dependency bound means a slot before an
  // already-placed prerequisite's end can never be a candidate either.
  const candidates: Array<{ slot: PlanningSlot; index: number; minutes: number }> = [];
  for (let index = earliestIndex; index <= latestIndex; index += 1) {
    const slot = slots[index]!;
    const minutes = Math.min(remaining.get(slot.id) ?? 0, slotCapacityForAction(slot, action));
    if (minutes > 0) candidates.push({ slot, index, minutes });
  }
  if (prior.length) limitByPriorRuns(candidates, prior, action.maximumSessionMinutes, sessionBreakMinutes);
  if (action.splittable === false) {
    const group = latestContiguousGroup(candidates, required);
    return group ? consume(action, required, group, remaining) : [];
  }
  return allocateSplittable(action, required, candidates, remaining, sessionBreakMinutes);
}
/**
 * How many separate runs a set of blocks makes: back-to-back blocks are one run until it reaches the
 * action's maximum session, and any gap starts another. Each run is a fresh sit-down, so each pays setup.
 */
function countRuns(blocks: AllocationBlock[], maximumSessionMinutes: number): number {
  const ordered = [...blocks].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  let runs = 0;
  let runMinutes = 0;
  let previousEnd = -Infinity;
  for (const block of ordered) {
    const continues = block.startsAt.getTime() <= previousEnd && runMinutes + block.minutes <= maximumSessionMinutes;
    if (continues) runMinutes += block.minutes;
    else {
      runs += 1;
      runMinutes = block.minutes;
    }
    previousEnd = block.endsAt.getTime();
  }
  return runs;
}
/**
 * A later call for an action that already holds `prior` blocks (a setup top-up) must continue those
 * runs rather than start afresh. Candidates touching a run may only fill the room it has left up to
 * the maximum session, and a run at the maximum owes a break on both sides, so nothing within it is a
 * candidate. Trims `candidates` in place and drops any left with no minutes.
 */
function limitByPriorRuns(
  candidates: Candidate[],
  prior: AllocationBlock[],
  maximumSessionMinutes: number,
  sessionBreakMinutes: number
) {
  const ordered = [...prior].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  const runs: Array<{ start: number; end: number; minutes: number }> = [];
  for (const block of ordered) {
    const run = runs.at(-1);
    if (run && block.startsAt.getTime() <= run.end && run.minutes + block.minutes <= maximumSessionMinutes) {
      run.end = block.endsAt.getTime();
      run.minutes += block.minutes;
    } else runs.push({ start: block.startsAt.getTime(), end: block.endsAt.getTime(), minutes: block.minutes });
  }
  const byIndex = new Map(candidates.map((candidate) => [candidate.index, candidate]));
  const breakMs = sessionBreakMinutes * MINUTE_MS;
  for (const run of runs) {
    if (run.minutes >= maximumSessionMinutes) {
      for (const candidate of candidates)
        if (
          candidate.slot.endsAt.getTime() > run.start - breakMs &&
          candidate.slot.startsAt.getTime() < run.end + breakMs
        )
          candidate.minutes = 0;
      continue;
    }
    // Room left in a run that is not full is shared by the leftover of the slots the run itself sits in
    // (a block records the whole slot but holds only its minutes, so the slot can still offer more) and
    // by the whole chain of candidates touching either edge.
    let room = maximumSessionMinutes - run.minutes;
    for (const candidate of candidates)
      if (candidate.slot.startsAt.getTime() >= run.start && candidate.slot.endsAt.getTime() <= run.end) {
        candidate.minutes = Math.min(candidate.minutes, room);
        room -= candidate.minutes;
      }
    // The later edge draws first: placement is tail-first, so the room goes to the side nearer the
    // deadline, the way the main placement would have filled it.
    for (const [edge, step] of [
      [run.end, 1],
      [run.start, -1]
    ] as const) {
      const first = candidates.find((candidate) =>
        step < 0 ? candidate.slot.endsAt.getTime() === edge : candidate.slot.startsAt.getTime() === edge
      );
      for (let index = first?.index; index !== undefined && byIndex.has(index); index += step) {
        const candidate = byIndex.get(index)!;
        candidate.minutes = Math.min(candidate.minutes, room);
        room -= candidate.minutes;
      }
    }
  }
  for (let index = candidates.length - 1; index >= 0; index -= 1)
    if (candidates[index]!.minutes <= 0) candidates.splice(index, 1);
}
type Candidate = { slot: PlanningSlot; index: number; minutes: number };
/**
 * Groups the tail-first (latest-index-first) candidate list into contiguous runs, then walks each
 * group latest-first, deciding how much of it to take (monotone — a take is shrunk to protect
 * a future remainder from falling under the minimum session only when that remainder could still be
 * legally placed elsewhere; otherwise the shrink is skipped and the full take stands, so asking for
 * more never places less) and splitting what it takes into runs of at most `maximumSessionMinutes`
 * with a `sessionBreakMinutes` gap owed after any run that reaches the maximum —
 * `consumeSessionShaped` carries that run/break state across groups for this one action. A group too
 * small to stand on its own is folded into the run already open for this action instead of being
 * dropped, when doing so still fits within the maximum — `maximumSessionMinutes` is the only
 * condition the design states, so a group is eligible whenever a run is open and not on a break,
 * whatever the wall-clock distance to it: the accounting is focused minutes, not elapsed time, and a
 * break is the only thing that ever resets it.
 */
function allocateSplittable(
  action: Action,
  required: number,
  candidates: Candidate[],
  remaining: Map<string, number>,
  sessionBreakMinutes: number
) {
  const sorted = [...candidates].sort((a, b) => b.index - a.index);
  const groups: Candidate[][] = [];
  for (const item of sorted) {
    const group = groups.at(-1);
    if (!group || group.at(-1)!.index - 1 !== item.index) groups.push([item]);
    else group.push(item);
  }
  const totalCapacity = groups.reduce((sum, group) => sum + group.reduce((s, item) => s + item.minutes, 0), 0);
  const blocks: AllocationBlock[] = [];
  let needed = required;
  let consumedGroupsCapacity = 0;
  // Session-shape state for this one action, carried across groups: null once the last run placed
  // stopped short of the maximum (owes nothing, a fresh run may start immediately); a boundary once
  // it reached the maximum (no further slot of this action may be consumed until past it).
  let breakUntil: Date | null = null;
  // The open (not yet broken) run's own accumulated minutes, so a too-small later group can still be
  // folded into it rather than dropped. `hasOpenRun` distinguishes "no run yet" (nothing placed, so a
  // too-small first group has nothing to join) from "run is open at zero" (never actually reached,
  // since a run only opens by placing minutes, but kept explicit rather than inferring it from
  // `openRunMinutes > 0`, which a zero-minute fold could otherwise misread as no run).
  let openRunMinutes = 0;
  let hasOpenRun = false;
  for (const group of groups) {
    if (needed <= 0) break;
    const capacity = group.reduce((sum, item) => sum + item.minutes, 0);
    consumedGroupsCapacity += capacity;
    const capacityElsewhere = totalCapacity - consumedGroupsCapacity;
    let take = Math.min(needed, capacity);
    const remainder = needed - take;
    if (remainder > 0 && remainder < action.minimumSessionMinutes && capacityElsewhere >= action.minimumSessionMinutes)
      take -= action.minimumSessionMinutes - remainder;
    const tooSmallAlone = take < action.minimumSessionMinutes && required >= action.minimumSessionMinutes;
    if (tooSmallAlone) {
      const canFold =
        breakUntil === null && hasOpenRun && openRunMinutes + Math.min(take, capacity) <= action.maximumSessionMinutes;
      if (!canFold) continue;
      const folded = consumeSessionShaped(action, Math.min(needed, capacity), group, remaining, sessionBreakMinutes, {
        breakUntil: null,
        openRunMinutes
      });
      blocks.push(...folded.blocks);
      needed -= folded.blocks.reduce((sum, block) => sum + block.minutes, 0);
      breakUntil = folded.breakUntil;
      openRunMinutes = folded.breakUntil ? 0 : folded.openRunMinutes;
      if (folded.blocks.length) hasOpenRun = true;
      continue;
    }
    const result = consumeSessionShaped(action, take, group, remaining, sessionBreakMinutes, {
      breakUntil,
      openRunMinutes: breakUntil ? 0 : openRunMinutes
    });
    blocks.push(...result.blocks);
    needed -= result.blocks.reduce((sum, block) => sum + block.minutes, 0);
    breakUntil = result.breakUntil;
    openRunMinutes = result.breakUntil ? 0 : result.openRunMinutes;
    if (result.blocks.length) hasOpenRun = true;
  }
  return blocks;
}
/**
 * Consumes up to `take` minutes from one contiguous, tail-first-ordered group for one action,
 * splitting the result into runs of at most `maximumSessionMinutes` and, once a run reaches that
 * maximum, refusing to touch any slot within `sessionBreakMinutes` of wall-clock time before that
 * run's own earliest instant — the gap is simply left unconsumed by this action, so another action's
 * own call against the same shared `remaining` ledger is free to use it. A run that stops short
 * (capacity or boundary, not the maximum) owes nothing, and `openRunMinutes` carries forward so a
 * later, too-small group can still extend it (folding) instead of standing alone.
 */
function consumeSessionShaped(
  action: Action,
  take: number,
  group: Candidate[],
  remaining: Map<string, number>,
  sessionBreakMinutes: number,
  runState: { breakUntil: Date | null; openRunMinutes: number }
): { blocks: AllocationBlock[]; breakUntil: Date | null; openRunMinutes: number; lastIndex: number } {
  const blocks: AllocationBlock[] = [];
  let needed = take;
  let runMinutes = runState.openRunMinutes;
  let breakUntil = runState.breakUntil;
  let lastIndex = group[0]!.index;
  for (const { slot, index } of group) {
    if (needed <= 0) break;
    if (breakUntil && slot.endsAt.getTime() > breakUntil.getTime()) continue;
    if (breakUntil) {
      breakUntil = null;
      runMinutes = 0;
    }
    const available = remaining.get(slot.id) ?? 0;
    const roomInRun = action.maximumSessionMinutes - runMinutes;
    if (roomInRun <= 0) {
      // This run just reached its maximum on the previous slot: it owes a break measured from its
      // own earliest instant, which the last block pushed already carries as `startsAt`.
      const lastStart = blocks.at(-1)?.startsAt ?? slot.endsAt;
      breakUntil = new Date(lastStart.getTime() - sessionBreakMinutes * MINUTE_MS);
      runMinutes = 0;
      continue;
    }
    const minutes = Math.min(available, needed, roomInRun);
    if (minutes <= 0) continue;
    remaining.set(slot.id, available - minutes);
    blocks.push({
      actionId: action.id,
      projectId: action.projectId,
      slotId: slot.id,
      startsAt: slot.startsAt,
      endsAt: slot.endsAt,
      minutes
    });
    needed -= minutes;
    runMinutes += minutes;
    lastIndex = index;
  }
  return { blocks, breakUntil, openRunMinutes: runMinutes, lastIndex };
}
function latestContiguousGroup(
  candidates: Array<{ slot: PlanningSlot; index: number; minutes: number }>,
  required: number
) {
  const byIndex = new Map(candidates.map((candidate) => [candidate.index, candidate]));
  for (const endIndex of [...byIndex.keys()].sort((a, b) => b - a)) {
    const group: typeof candidates = [];
    let total = 0;
    for (let index = endIndex; byIndex.has(index); index -= 1) {
      const item = byIndex.get(index)!;
      group.push(item);
      total += item.minutes;
      if (total >= required) return group;
    }
  }
  return null;
}
/**
 * Debits the slot ledger (`remaining`, seeded from each slot's `capacityMinutes` — see the comment on
 * that field's computation in `slots.ts` for what a slot's remaining minutes mean when the windows
 * behind it overlap) by exactly what an action takes from each candidate slot, in candidate order,
 * stopping once `required` is met or the candidates run out.
 *
 * A partial consume is never rounded: `minutes` stays the same float `slotCapacityForAction` produced
 * (a duration times a usable fraction), and what is subtracted from `remaining` is exactly what is
 * recorded on the block, so nothing here can under- or over-state a slot by rounding it twice. A
 * consume can never take more than `available` — `Math.min(available, needed)` caps it — so
 * `available - minutes` can never go negative; when `minutes === available` the ledger reaches exactly
 * `0`, not a near-zero float, because subtracting a value from itself is exact in IEEE 754 regardless
 * of what that value is.
 */
function consume(
  action: Action,
  required: number,
  candidates: Array<{ slot: PlanningSlot; index: number; minutes: number }>,
  remaining: Map<string, number>
) {
  const blocks: AllocationBlock[] = [];
  let needed = required;
  for (const { slot } of candidates) {
    if (needed <= 0) break;
    const available = remaining.get(slot.id) ?? 0;
    const minutes = Math.min(available, needed);
    if (!minutes) continue;
    remaining.set(slot.id, available - minutes);
    blocks.push({
      actionId: action.id,
      projectId: action.projectId,
      slotId: slot.id,
      startsAt: slot.startsAt,
      endsAt: slot.endsAt,
      minutes
    });
    needed -= minutes;
  }
  return blocks;
}
function classifyHealth(args: {
  unallocated: number;
  expectedMargin: number;
  pessimisticMargin: number;
  marginRatio: number;
  scheduleVariance: number | null;
  config: PlanningConfig;
}): ProjectForecast["health"] {
  if (args.expectedMargin < 0) return "behind";
  if (args.unallocated > 0) return "at_risk";
  if (
    args.pessimisticMargin < 0 ||
    args.marginRatio < args.config.riskMarginRatio ||
    (args.scheduleVariance !== null && args.scheduleVariance <= -args.config.aheadVariance)
  )
    return "at_risk";
  if (
    args.marginRatio >= args.config.aheadMarginRatio &&
    args.scheduleVariance !== null &&
    args.scheduleVariance >= args.config.aheadVariance
  )
    return "ahead";
  return "on_track";
}
function unknown(
  projectId: string,
  reason: string,
  latestSafeStarts: Record<string, Date | null>,
  through: Date,
  now: Date,
  deadline?: Date,
  band?: HorizonBandConfig | null,
  overdueOverride?: boolean
): ProjectForecast {
  return {
    projectId,
    health: "unknown",
    overdue: overdueOverride ?? (deadline !== undefined && deadline < now),
    protectedRemainingMinutes: null,
    pessimisticRemainingMinutes: null,
    compatibleCapacityMinutes: null,
    grossCompatibleCapacityMinutes: null,
    reservedByEarlierDeadlinesMinutes: 0,
    requiredPaceMinutesPerWeek: null,
    forecastBand: band?.kind ?? null,
    confidence: band?.confidence ?? null,
    forecastThrough: through,
    expectedMarginMinutes: null,
    pessimisticMarginMinutes: null,
    marginRatio: null,
    scheduleVariance: null,
    ...(deadline ? { internalDeadlineAt: deadline } : {}),
    unallocatedExpectedMinutes: 0,
    blockedEffortMinutes: 0,
    schedulingBlocked: false,
    latestSafeStarts,
    healthBasis: "feasibility",
    reasons: [reason]
  };
}
function completed(projectId: string, deadline: Date, through: Date): ProjectForecast {
  return {
    projectId,
    health: "on_track",
    overdue: false,
    protectedRemainingMinutes: 0,
    pessimisticRemainingMinutes: 0,
    compatibleCapacityMinutes: 0,
    grossCompatibleCapacityMinutes: 0,
    reservedByEarlierDeadlinesMinutes: 0,
    requiredPaceMinutesPerWeek: 0,
    forecastBand: "detailed",
    confidence: "high",
    forecastThrough: through,
    expectedMarginMinutes: 0,
    pessimisticMarginMinutes: 0,
    marginRatio: 0,
    scheduleVariance: null,
    internalDeadlineAt: deadline,
    unallocatedExpectedMinutes: 0,
    blockedEffortMinutes: 0,
    schedulingBlocked: false,
    latestSafeStarts: {},
    healthBasis: "feasibility",
    reasons: ["No remaining work is recorded."]
  };
}
export function energyCapacity(slots: PlanningSlot[]): Record<EnergyType, number> {
  return {
    high: 0,
    medium: 0,
    low: 0,
    recovery: 0,
    ...Object.fromEntries(
      (["high", "medium", "low", "recovery"] as EnergyType[]).map((energy) => [
        energy,
        slots.filter((slot) => slot.energy === energy).reduce((sum, slot) => sum + slot.capacityMinutes, 0)
      ])
    )
  };
}
