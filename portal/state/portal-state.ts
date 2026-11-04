import type { EnergyType, PortalStateContract } from "@openrhen/contracts";
import { DEFAULT_START_BY_WARNING_MINUTES, DEFAULT_TIME_BANDS, DEFAULT_TIMEZONE } from "@openrhen/contracts";
import type { PortalPlanningRuntimeState } from "@/features/planning/planning-runtime";

/**
 * The portal stores exactly what `portalStateSchema` accepts, so every shape below is read out of
 * `PortalStateContract` instead of being restated. Adding a field to the contract is the only way
 * to add one here, which is what stops the two descriptions of portal state from drifting apart.
 */
export type PlanningSettings = PortalStateContract["settings"];
export type StoredArea = PortalStateContract["areas"][number];
export type StoredOutcome = PortalStateContract["outcomes"][number];
export type StoredProject = PortalStateContract["projects"][number];
export type StoredAction = PortalStateContract["actions"][number];
export type StoredRecurrenceRule = NonNullable<StoredAction["recurrence"]>;
export type StoredOccurrence = PortalStateContract["occurrences"][number];

export type StoredDeliverable = PortalStateContract["deliverables"][number];
export type StoredDeliverableStep = StoredDeliverable["steps"][number];
export type StoredDeliverableCriterion = StoredDeliverable["criteria"][number];
export type StoredDeliverableBlocker = StoredDeliverable["blockers"][number];
export type StoredDeliverableContractProposal = StoredDeliverable["contractProposals"][number];
export type StoredDeliverableSourceFile = StoredDeliverable["sourceFiles"][number];

export type DeliverableStatus = StoredDeliverable["status"];
export type DeliverableStepStatus = StoredDeliverableStep["status"];
export type CriterionState = StoredDeliverableCriterion["state"];
export type BlockerCategory = StoredDeliverableBlocker["category"];
export type BlockerState = StoredDeliverableBlocker["state"];

export type StoredCommitment = PortalStateContract["commitments"][number];
export type StoredCommitmentRecurrenceRule = PortalStateContract["commitmentRecurrenceRules"][number];
export type StoredRoutineStep = PortalStateContract["routineSteps"][number];
export type RoutinePreset = PortalStateContract["routinePresets"][number];
export type RoutinePresetStep = RoutinePreset["steps"][number];
export type StoredSpan = PortalStateContract["spans"][number];
export type StoredSleepPlan = PortalStateContract["sleepPlans"][number];

export type EnergyLevel = EnergyType;

export const defaultPlanningSettings = (): PlanningSettings => ({
  timezone: DEFAULT_TIMEZONE,
  planningHorizonEnd: "22:00",
  defaultUsableFraction: 0.85,
  defaultSetupBufferMinutes: 10,
  defaultTransitionBufferMinutes: 10,
  submissionBufferMinutes: 60,
  submissionBufferPercent: 0.1,
  energyMeanings: {
    high: "Deep focus",
    medium: "Steady concentration",
    low: "Light effort",
    recovery: "Rest and reset"
  },
  estimateBucketsMinutes: [5, 15, 30, 60, 90, 120],
  preferredBedtime: "22:00",
  preferredWakeTime: "06:00",
  desiredSleepMinutes: 480,
  minimumSleepMinutes: 360,
  maxAwakeHours: 20,
  bedtimeDeviationMinutes: 180,
  recoveryStartTime: null,
  recoveryEndTime: null,
  recoveryWeekdays: [0, 1, 2, 3, 4, 5, 6],
  disruptionKindLabels: { work: "Work", family: "Family", life_admin: "Life admin", other: "Other" },
  disruptionWhenPresets: [
    { id: "now", label: "Now", delayMinutes: 0 },
    { id: "in_15", label: "+15m", delayMinutes: 15 },
    { id: "in_30", label: "+30m", delayMinutes: 30 },
    { id: "in_60", label: "+60m", delayMinutes: 60 }
  ],
  disruptionDurationPresets: [
    { id: "30m", label: "30 min", kind: "minutes", minutes: 30 },
    { id: "1h", label: "1 hour", kind: "minutes", minutes: 60 },
    { id: "2h", label: "2 hours", kind: "minutes", minutes: 120 },
    { id: "3h", label: "3 hours", kind: "minutes", minutes: 180 },
    { id: "rest_of_day", label: "Rest of day", kind: "rest_of_day" },
    { id: "unknown", label: "No idea", kind: "unknown" }
  ],
  disruptionRetroFallbackMinutes: 60,
  arrivalMarginMinutes: 2,
  sessionBreakMinutes: 15,
  calendarShareEnabled: false,
  sharePrimaryEvents: false,
  pulsePublishEnabled: false,
  estimateCalibrationEnabled: true,
  timeBands: [...DEFAULT_TIME_BANDS],
  startByWarningMinutes: DEFAULT_START_BY_WARNING_MINUTES,
  leaveByLeadMinutes: 10
});

export type CaptureItem = PortalStateContract["captures"][number];
export type ProposalType = CaptureItem["proposalType"];
export type ProposalStatus = CaptureItem["status"];

export type ActiveSession = NonNullable<PortalStateContract["activeSession"]>;
export type SessionHistoryItem = PortalStateContract["completedToday"][number];
export type DailyPlan = NonNullable<PortalStateContract["dailyPlan"]>;
export type PlanningFocus = PortalStateContract["planningFocus"][number];

/**
 * The persisted contract plus the one thing the browser holds that is never stored: the engine's
 * last plan, kept so a re-render does not have to ask for it again.
 */
export interface PortalState extends PortalStateContract {
  planning?: PortalPlanningRuntimeState;
}

const iso = (date: Date) => date.toISOString();
const addMinutes = (date: Date, minutes: number) => new Date(date.getTime() + minutes * 60_000);

export function createSeedState(now = new Date()): PortalState {
  const deadline = addMinutes(now, 7 * 24 * 60);
  return {
    settings: defaultPlanningSettings(),
    areas: [
      { id: "area-study", name: "Study", status: "active", sortOrder: 0 },
      { id: "area-home", name: "Home and administration", status: "active", sortOrder: 1 }
    ],
    outcomes: [
      {
        id: "outcome-networking",
        areaId: "area-study",
        title: "Complete Networking Assignment 2",
        definitionOfDone: "Assignment submitted and receipt confirmed",
        value: 5,
        status: "active",
        deadlineAt: iso(deadline)
      },
      {
        id: "outcome-room",
        areaId: "area-home",
        title: "Make the bedroom calm and usable",
        definitionOfDone: "Floor clear, surfaces reset, and items put away",
        value: 3,
        status: "active"
      }
    ],
    projects: [
      {
        id: "networking-assignment",
        title: "Submit Networking Assignment 2",
        area: "Study",
        outcomeId: "outcome-networking",
        status: "active",
        uncertainty: "some",
        internalDeadlineAt: iso(addMinutes(deadline, -12 * 60)),
        externalDeadlineAt: iso(deadline),
        value: 5,
        consequence: 5,
        actualCompletionRatio: 0.18,
        requiredCompletionRatio: 0.2
      },
      {
        id: "clean-room",
        title: "Reset and clean my room",
        area: "Home and administration",
        outcomeId: "outcome-room",
        status: "active",
        uncertainty: "high",
        value: 3,
        consequence: 2
      }
    ],
    actions: [
      {
        id: "networking-section-one",
        projectId: "networking-assignment",
        title: "Draft networking assignment section 1",
        status: "active",
        optimisticMinutes: 60,
        expectedMinutes: 90,
        splittable: true,
        setupMinutes: 5,
        remainingMinutes: 90,
        pessimisticMinutes: 130,
        energy: "high",
        minimumSessionMinutes: 25,
        maximumSessionMinutes: 50,
        importance: 5,
        consequence: 5,
        contexts: ["laptop"],
        dependencyIds: [],
        schedulingMode: "one_off",
        requirementPathways: [],
        preferences: [],
        deadlineAt: iso(deadline)
      },
      {
        id: "room-floor",
        projectId: "clean-room",
        title: "Sort the bedroom floor",
        status: "active",
        optimisticMinutes: 30,
        expectedMinutes: 45,
        splittable: true,
        setupMinutes: 0,
        remainingMinutes: 45,
        pessimisticMinutes: 75,
        energy: "low",
        minimumSessionMinutes: 15,
        maximumSessionMinutes: 30,
        importance: 3,
        consequence: 2,
        contexts: ["home"],
        dependencyIds: [],
        schedulingMode: "one_off",
        requirementPathways: [],
        preferences: []
      }
    ],
    commitments: [
      {
        id: "dinner",
        title: "Dinner and reset",
        startsAt: iso(addMinutes(now, 120)),
        endsAt: iso(addMinutes(now, 180)),
        status: "confirmed",
        setupBeforeMinutes: 0,
        transitionAfterMinutes: 10
      }
    ],
    commitmentRecurrenceRules: [],
    deliverables: [],
    routineSteps: [],
    routinePresets: [],
    occurrences: [],
    sleepPlans: [],
    spans: [],
    captures: [],
    completedToday: [],
    assertedConditions: ["home", "laptop"],
    currentEnergy: "medium",
    conditionDefinitions: [],
    currentSituation: {
      locationId: null,
      overrides: {},
      carrying: {},
      transportModes: ["car", "bike", "walk"],
      travel: {},
      travelOff: false
    },
    pendingLocationSuggestion: null,
    horizonEnd: iso(addMinutes(now, 7 * 24 * 60)),
    activeSession: null,
    lastEndedSessions: [],
    planningFocus: [],
    estimateCalibration: { overall: null, areas: [] }
  };
}

export function normalizePortalState(input: PortalState): PortalState {
  const legacy = input as PortalState & { areas?: StoredArea[]; outcomes?: StoredOutcome[] };
  const areas: StoredArea[] = legacy.areas?.length
    ? legacy.areas
    : [...new Set(input.projects.map((project) => project.area))].map((name, sortOrder) => ({
        id: `legacy-area:${name}`,
        name,
        status: "active",
        sortOrder
      }));
  const outcomes: StoredOutcome[] = legacy.outcomes?.length
    ? legacy.outcomes
    : input.projects.map((project) => ({
        id: `legacy-outcome:${project.id}`,
        areaId: areas.find((area) => area.name === project.area)!.id,
        title: project.title,
        definitionOfDone: `Complete ${project.title}`,
        value: project.value,
        status: project.status,
        ...(project.externalDeadlineAt ? { deadlineAt: project.externalDeadlineAt } : {})
      }));
  return {
    ...input,
    settings: {
      ...defaultPlanningSettings(),
      ...input.settings,
      energyMeanings: { ...defaultPlanningSettings().energyMeanings, ...input.settings?.energyMeanings },
      estimateBucketsMinutes: input.settings?.estimateBucketsMinutes?.length
        ? input.settings.estimateBucketsMinutes
        : defaultPlanningSettings().estimateBucketsMinutes
    },
    // State persisted before deliverables existed has no array at all.
    deliverables: input.deliverables ?? [],
    areas,
    outcomes,
    projects: input.projects.map((project) => ({
      ...project,
      outcomeId: project.outcomeId ?? `legacy-outcome:${project.id}`
    })),
    actions: input.actions.map((action) => ({
      ...action,
      optimisticMinutes: action.optimisticMinutes ?? Math.max(1, Math.round(action.remainingMinutes * 0.75)),
      expectedMinutes: action.expectedMinutes ?? Math.max(1, action.remainingMinutes),
      splittable: action.splittable ?? true,
      setupMinutes: action.setupMinutes ?? 0,
      dependencyIds: action.dependencyIds ?? [],
      schedulingMode: action.schedulingMode ?? "one_off",
      requirementPathways: action.requirementPathways ?? [],
      preferences: action.preferences ?? []
    })),
    commitments: input.commitments.map((commitment) => ({
      ...commitment,
      status: commitment.status ?? "confirmed",
      setupBeforeMinutes: commitment.setupBeforeMinutes ?? 0,
      transitionAfterMinutes: commitment.transitionAfterMinutes ?? 0
    })),
    commitmentRecurrenceRules: input.commitmentRecurrenceRules ?? [],
    routineSteps: (input.routineSteps ?? []).map((step, index, list) => ({
      ...step,
      dependencyIds: step.dependencyIds ?? (index ? [list[index - 1]!.id] : [])
    })),
    routinePresets: (input.routinePresets ?? []).map((preset) => ({
      ...preset,
      activityName: preset.activityName ?? preset.name,
      steps: preset.steps.map((step, index, list) => ({
        ...step,
        dependencyIds: step.dependencyIds ?? (index ? [list[index - 1]!.id] : [])
      }))
    })),
    occurrences: input.occurrences ?? [],
    sleepPlans: input.sleepPlans ?? [],
    spans: input.spans ?? [],
    captures: input.captures.map((capture) => ({
      ...capture,
      status: capture.status ?? "pending",
      proposalType: capture.proposalType ?? "unclassified",
      proposedFields: capture.proposedFields ?? { text: capture.text },
      sourceType: capture.sourceType ?? "manual_capture"
    })),
    completedToday: (input.completedToday ?? []).map((item, index) =>
      normalizeSessionHistoryItem(item, input.actions, index)
    ),
    activeSession: input.activeSession ? normalizeActiveSession(input.activeSession, input.actions) : null,
    planningFocus: input.planningFocus ?? [],
    currentEnergy: input.currentEnergy ?? "medium",
    conditionDefinitions: input.conditionDefinitions ?? [],
    // A snapshot captured before travel existed carries a situation without transport or travel; the
    // panels index into both, so a replay of an older report must not crash on the shape of its day.
    currentSituation: normalizeCurrentSituation(input.currentSituation),
    // Absent on state persisted before this existed, and on every capture taken before the phone
    // path did — a replay of either must show no pending question rather than crash on its absence.
    pendingLocationSuggestion: input.pendingLocationSuggestion ?? null
  };
}

/**
 * A snapshot captured before travel existed carries a situation without transport or travel (or none
 * at all); the panels index into both, so a replay of an older report must not crash on the shape of
 * its day. Typed loosely on purpose: the whole point is that the input may predate the contract.
 */
function normalizeCurrentSituation(
  input: Partial<PortalState["currentSituation"]> | undefined
): PortalState["currentSituation"] {
  return {
    ...input,
    locationId: input?.locationId ?? null,
    overrides: input?.overrides ?? {},
    carrying: input?.carrying ?? {},
    transportModes: input?.transportModes ?? ["car", "bike", "walk"],
    travel: input?.travel ?? {},
    travelOff: input?.travelOff ?? false
  };
}

export function activeFocusProjectIds(state: PortalState, now: Date): string[] {
  const localDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: state.settings.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(now);
  return [
    ...new Set(
      (state.planningFocus ?? [])
        .filter((focus) => focus.periodStart <= localDate && localDate <= focus.periodEnd)
        .flatMap((focus) => focus.projectIds)
    )
  ];
}

export function projectedDailyProtectionMinutes(state: PortalState): number {
  // Mirrors engine/core's own `projectedDailyProtectionMinutes`: a sleep-anchored step is
  // excluded here too, so this forecast number does not silently move with the storage migration.
  const routineWeeklyMinutes = state.routineSteps
    .filter((step) => step.anchorType === "commitment" && step.status !== "completed" && step.status !== "cancelled")
    .reduce((sum, step) => sum + step.durationMinutes, 0);
  return state.settings.desiredSleepMinutes + Math.ceil(routineWeeklyMinutes / 7);
}

function normalizeSessionHistoryItem(
  item: SessionHistoryItem | { actionTitle: string; minutes: number; completedAt: string },
  actions: StoredAction[],
  index: number
): SessionHistoryItem {
  if ("endedAt" in item) return item;
  const action = actions.find((candidate) => candidate.title === item.actionTitle);
  const endedAt = item.completedAt;
  const startedAt = new Date(new Date(endedAt).getTime() - item.minutes * 60_000).toISOString();
  return {
    id: `legacy-session:${endedAt}:${index}`,
    actionId: action?.id ?? "",
    actionTitle: item.actionTitle,
    result: "completed",
    startedAt,
    endedAt,
    plannedMinutes: item.minutes,
    activeMinutes: item.minutes,
    remainingBeforeMinutes: item.minutes,
    remainingAfterMinutes: 0
  };
}

function normalizeActiveSession(session: ActiveSession, actions: StoredAction[]): ActiveSession {
  const plannedMinutes = Math.max(
    1,
    Math.round((new Date(session.plannedEndAt).getTime() - new Date(session.startedAt).getTime()) / 60_000)
  );
  const action = actions.find((candidate) => candidate.id === session.actionId);
  return {
    ...session,
    id: session.id ?? `legacy-active:${session.actionId}:${session.startedAt}`,
    plannedMinutes: session.plannedMinutes ?? plannedMinutes,
    remainingBeforeMinutes: session.remainingBeforeMinutes ?? action?.remainingMinutes ?? plannedMinutes,
    activeElapsedSeconds: session.activeElapsedSeconds ?? 0,
    ...(session.status === "running" && !session.segmentStartedAt ? { segmentStartedAt: session.startedAt } : {})
  };
}
