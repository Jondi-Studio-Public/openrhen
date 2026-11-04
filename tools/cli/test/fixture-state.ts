import { normaliseState, type PortalState } from "../src/client.js";

/** 09:30 on Wednesday 2026-09-03 in Australia/Sydney, the fixture's planning timezone. */
export const fixtureNow = new Date("2026-09-03T09:30:00+10:00");
export const fixtureTimeZone = "Australia/Sydney";

/**
 * The document the portal would send from `GET /api/state`, as raw JSON: contract defaults are not
 * filled in here, so `normaliseState` has something to do. Ids are readable on purpose; every test
 * that names one should read like the command line it is exercising.
 */
export function fixtureRawState(): Record<string, unknown> {
  return {
    settings: {
      timezone: fixtureTimeZone,
      planningHorizonEnd: "22:00",
      defaultUsableFraction: 0.85,
      defaultSetupBufferMinutes: 10,
      defaultTransitionBufferMinutes: 10,
      submissionBufferMinutes: 60,
      submissionBufferPercent: 0.1,
      energyMeanings: { high: "Deep focus", medium: "Steady", low: "Light", recovery: "Rest" },
      estimateBucketsMinutes: [5, 15, 30, 60, 90, 120],
      conditionCatalog: ["home", "laptop", "phone"],
      preferredBedtime: "22:30",
      preferredWakeTime: "06:30",
      desiredSleepMinutes: 480,
      minimumSleepMinutes: 420,
      maxAwakeHours: 17,
      homeLocationId: "ctx-home"
    },
    areas: [
      { id: "area-study", name: "Study", status: "active", sortOrder: 0 },
      { id: "area-home", name: "Home", status: "active", sortOrder: 1 }
    ],
    outcomes: [
      {
        id: "outcome-degree",
        areaId: "area-study",
        title: "Finish the degree",
        definitionOfDone: "Thesis accepted",
        value: 5,
        status: "active",
        deadlineAt: "2026-12-01T00:00:00+11:00"
      },
      {
        id: "outcome-house",
        areaId: "area-home",
        title: "A house that runs itself",
        definitionOfDone: "Weekly chores take under two hours",
        value: 3,
        status: "active"
      }
    ],
    projects: [
      {
        id: "project-thesis",
        title: "Thesis",
        area: "area-study",
        outcomeId: "outcome-degree",
        status: "active",
        uncertainty: "some",
        value: 5,
        consequence: 5,
        externalDeadlineAt: "2026-10-01T00:00:00+10:00",
        createdAt: "2026-06-01T09:00:00+10:00"
      },
      {
        id: "project-garden",
        title: "Garden",
        area: "area-home",
        outcomeId: "outcome-house",
        status: "active",
        uncertainty: "known",
        value: 2,
        consequence: 1,
        createdAt: "2026-08-20T09:00:00+10:00"
      }
    ],
    actions: [
      action({
        id: "action-draft",
        projectId: "project-thesis",
        title: "Draft chapter 3",
        status: "planned",
        remainingMinutes: 90,
        deadlineAt: "2026-09-10T17:00:00+10:00",
        importance: 5,
        createdAt: "2026-08-01T09:00:00+10:00"
      }),
      action({
        id: "action-cite",
        projectId: "project-thesis",
        title: "Fix citations",
        status: "active",
        remainingMinutes: 30,
        dependencyIds: ["action-draft"],
        energy: "low",
        createdAt: "2026-08-15T09:00:00+10:00",
        // Read shape: `GET /api/state` returns pathways as `{ id, contextIds }`, not the write
        // command's `string[][]` — this fixture exists to catch a read-modify-write save regressing.
        requirementPathways: [{ id: "p1", contextIds: ["home"] }]
      }),
      action({
        id: "action-weed",
        projectId: "project-garden",
        title: "Weed the beds",
        status: "inbox",
        remainingMinutes: 45,
        contexts: ["home"],
        createdAt: "2026-09-02T09:00:00+10:00"
      }),
      action({
        id: "action-done",
        projectId: "project-thesis",
        title: "Email supervisor",
        status: "done",
        remainingMinutes: 0,
        createdAt: "2026-08-30T09:00:00+10:00"
      })
    ],
    deliverables: [
      {
        id: "deliverable-chapter",
        projectId: "project-thesis",
        title: "Chapter 3 draft",
        status: "in_progress",
        uncertainty: "some",
        importance: 5,
        consequence: 4,
        externalDeadlineAt: "2026-09-12T17:00:00+10:00",
        createdAt: "2026-08-01T09:00:00+10:00",
        steps: [
          step({ id: "step-outline", title: "Outline", status: "done" }),
          step({ id: "step-write", title: "Write", status: "doing", dependencyIds: ["step-outline"] })
        ]
      }
    ],
    commitments: [
      {
        id: "commitment-gym",
        title: "Gym session",
        startsAt: "2026-09-03T17:00:00+10:00",
        endsAt: "2026-09-03T18:00:00+10:00",
        status: "confirmed",
        location: "Gym",
        locationId: "ctx-gym",
        setupBeforeMinutes: 10,
        transitionAfterMinutes: 10,
        presence: "blocking",
        recurrenceRuleId: "rule-gym",
        localDate: "2026-09-03",
        createdAt: "2026-08-01T09:00:00+10:00"
      },
      {
        id: "commitment-dentist",
        title: "Dentist",
        startsAt: "2026-09-01T10:00:00+10:00",
        endsAt: "2026-09-01T10:30:00+10:00",
        status: "confirmed",
        setupBeforeMinutes: 10,
        transitionAfterMinutes: 10,
        createdAt: "2026-08-25T09:00:00+10:00"
      },
      {
        id: "commitment-cancelled",
        title: "Cancelled catch-up",
        startsAt: "2026-09-04T12:00:00+10:00",
        endsAt: "2026-09-04T13:00:00+10:00",
        status: "cancelled",
        projectId: "project-garden",
        setupBeforeMinutes: 0,
        transitionAfterMinutes: 0,
        createdAt: "2026-09-01T09:00:00+10:00"
      }
    ],
    commitmentRecurrenceRules: [
      {
        id: "rule-gym",
        title: "Gym",
        timezone: fixtureTimeZone,
        startDate: "2026-08-05",
        repeat: { unit: "days", intervalDays: 7 },
        localStartTime: "17:00",
        localEndTime: "18:00",
        location: "Gym",
        locationId: "ctx-gym",
        setupBeforeMinutes: 10,
        transitionAfterMinutes: 10,
        status: "active"
      }
    ],
    routineSteps: [
      {
        id: "step-pack",
        commitmentId: "commitment-gym",
        title: "Pack gym bag",
        durationMinutes: 10,
        sequence: 0,
        timingRule: "flexible",
        energy: "low",
        contexts: ["home"],
        phase: "before",
        status: "pending",
        scheduledStartAt: "2026-09-03T16:20:00+10:00",
        scheduledEndAt: "2026-09-03T16:30:00+10:00"
      },
      {
        id: "step-shower",
        commitmentId: "commitment-gym",
        title: "Shower",
        durationMinutes: 15,
        sequence: 0,
        timingRule: "contiguous",
        energy: "recovery",
        contexts: ["home"],
        phase: "after",
        status: "pending"
      }
    ],
    routinePresets: [
      {
        id: "preset-gym",
        name: "Gym prep",
        activityName: "Gym",
        status: "active",
        steps: [
          {
            id: "preset-step-pack",
            title: "Pack gym bag",
            durationMinutes: 10,
            sequence: 0,
            timingRule: "flexible",
            energy: "low",
            contexts: ["home"]
          }
        ]
      }
    ],
    occurrences: [
      {
        id: "occurrence-weed",
        actionId: "action-weed",
        recurrenceRuleId: "rule-weed",
        windowId: "window-morning",
        windowName: "Morning",
        localDate: "2026-09-04",
        windowStartsAt: "2026-09-04T07:00:00+10:00",
        windowEndsAt: "2026-09-04T08:00:00+10:00",
        anchorSource: "preferred_wake",
        status: "pending"
      }
    ],
    sleepPlans: [
      {
        id: "sleep-tonight",
        plannedStartAt: "2026-09-03T22:30:00+10:00",
        plannedWakeAt: "2026-09-04T06:30:00+10:00",
        desiredMinutes: 480,
        allowedMinutes: 480,
        sleepDeficitMinutes: 0,
        anchorDeviationMinutes: 0,
        hardErrors: [],
        explanation: "A standard night.",
        status: "planned"
      }
    ],
    captures: [
      {
        id: "capture-dentist",
        text: "Book the dentist follow-up",
        createdAt: "2026-09-02T18:00:00+10:00",
        status: "pending",
        proposalType: "unclassified",
        proposedFields: {},
        sourceType: "manual"
      }
    ],
    completedToday: [
      {
        id: "session-email",
        actionId: "action-done",
        actionTitle: "Email supervisor",
        result: "completed",
        startedAt: "2026-09-03T08:30:00+10:00",
        endedAt: "2026-09-03T08:45:00+10:00",
        plannedMinutes: 15,
        activeMinutes: 15,
        remainingBeforeMinutes: 15,
        remainingAfterMinutes: 0
      }
    ],
    assertedConditions: ["home", "laptop"],
    currentEnergy: "high",
    horizonEnd: "2026-09-03T22:00:00+10:00",
    conditionDefinitions: [
      { id: "ctx-home", name: "Home", kind: "location", address: "12 Example Street" },
      { id: "ctx-gym", name: "Gym", kind: "location", address: "1 Fitness Street", travelMinutes: 15 },
      { id: "ctx-laptop", name: "Laptop", kind: "capability", portability: "portable" }
    ],
    currentSituation: { locationId: "ctx-home" },
    pendingLocationSuggestion: null,
    activeSession: null,
    dailyPlan: {
      id: "plan-today",
      localDate: "2026-09-03",
      desiredActionIds: ["action-draft", "action-cite", "action-done"],
      deferredItems: [{ actionId: "action-weed", reason: "Rain forecast" }]
    },
    planningFocus: [],
    currentRecommendationId: "6b1f5d0e-2a3b-4c5d-8e9f-0a1b2c3d4e5f",
    planning: {
      status: "current",
      lastSuccessfulAt: "2026-09-03T09:12:00+10:00",
      validUntil: "2026-09-03T10:12:00+10:00",
      awaitingRecalculation: false,
      result: {
        contractVersion: "1",
        requestId: "9c8b7a65-4321-4fed-9cba-0123456789ab",
        inputVersion: "input-1",
        engineVersion: "1.4.0",
        calculatedAt: "2026-09-03T09:12:00+10:00",
        validUntil: "2026-09-03T10:12:00+10:00",
        derivedState: { sleepPlans: [], occurrences: [], routineSteps: [] },
        schedule: {},
        recommendation: {},
        currentDirective: {
          kind: "action",
          targetId: "action-draft",
          title: "Draft chapter 3",
          recommendedMinutes: 45
        },
        upcomingDirectives: [
          { kind: "action", targetId: "action-cite", title: "Fix citations", recommendedMinutes: 30 },
          { kind: "commitment", targetId: "commitment-gym", title: "Gym session", recommendedMinutes: 60 }
        ],
        continuation: null,
        dayPlan: {
          through: "2026-09-03T22:00:00+10:00",
          mode: "policy_replay",
          truncated: false,
          blocks: [
            {
              startsAt: "2026-09-03T09:30:00+10:00",
              endsAt: "2026-09-03T10:15:00+10:00",
              kind: "action",
              targetId: "action-draft",
              title: "Draft chapter 3",
              projectId: "project-thesis",
              focusedMinutes: 45,
              wallClockMinutes: 45,
              tier: "deadline",
              reason: "Due in 7 days and the only chapter still unwritten.",
              confidence: "firm"
            },
            {
              startsAt: "2026-09-03T17:00:00+10:00",
              endsAt: "2026-09-03T18:00:00+10:00",
              kind: "commitment",
              targetId: "commitment-gym",
              title: "Gym session",
              focusedMinutes: 0,
              wallClockMinutes: 60,
              reason: "Fixed commitment.",
              confidence: "firm"
            }
          ]
        }
      }
    }
  };
}

/** The fixture as the CLI sees it after `normaliseState`: contract defaults filled, planning attached. */
export function fixtureState(overrides: Record<string, unknown> = {}): PortalState {
  const warnings: string[] = [];
  const state = normaliseState({ ...fixtureRawState(), ...overrides }, (message) => warnings.push(message));
  if (warnings.length) throw new Error(`fixture state is not contract-valid: ${warnings.join("; ")}`);
  return state;
}

/** The running fixture session's id: uuid-shaped because the command contracts require one. */
export const fixtureActiveSessionId = "5e551011-d0af-4d5a-9c1e-000000000001";

/** A running session on the draft, for tests that need one; spread the result into `overrides`. */
export function fixtureActiveSession(): Record<string, unknown> {
  return {
    activeSession: {
      id: fixtureActiveSessionId,
      actionId: "action-draft",
      status: "running",
      targetType: "action",
      targetId: "action-draft",
      targetTitle: "Draft chapter 3",
      startedAt: "2026-09-03T09:05:00+10:00",
      plannedEndAt: "2026-09-03T09:50:00+10:00",
      plannedMinutes: 45,
      remainingBeforeMinutes: 90,
      activeElapsedSeconds: 1500,
      segmentStartedAt: "2026-09-03T09:05:00+10:00"
    }
  };
}

/** `fields` may set the read shape's `requirementPathways: { id, contextIds }[]` (optional; omitted defaults to none). */
function action(fields: Record<string, unknown>): Record<string, unknown> {
  return {
    optimisticMinutes: 30,
    expectedMinutes: 60,
    pessimisticMinutes: 120,
    splittable: true,
    setupMinutes: 5,
    energy: "medium",
    minimumSessionMinutes: 15,
    maximumSessionMinutes: 90,
    importance: 3,
    consequence: 3,
    contexts: ["laptop"],
    dependencyIds: [],
    ...fields
  };
}

function step(fields: Record<string, unknown>): Record<string, unknown> {
  return {
    optimisticMinutes: 30,
    expectedMinutes: 60,
    pessimisticMinutes: 90,
    remainingMinutes: 60,
    minimumSessionMinutes: 15,
    maximumSessionMinutes: 90,
    energy: "medium",
    contexts: ["laptop"],
    dependencyIds: [],
    sequence: 0,
    ...fields
  };
}
