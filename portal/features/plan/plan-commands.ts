import type {
  EndRecurrenceGoalCommand,
  PlanningEntityCommand,
  RecordCadenceCompletionCommand,
  SaveActionCommand,
  SaveProjectCommand
} from "@openrhen/contracts";
import type { PortalState, StoredAction, StoredArea, StoredDeliverable } from "@/state/portal-state";
import { createClientId } from "@/shared/client-id";
import { dateOnly, dateValue } from "@/features/plan/plan-formatting";
import type { ActionDraft, AreaDraft, DeliverableDraft, OutcomeDraft, ProjectDraft } from "@/features/plan/plan-drafts";
import { versionIn } from "@/shared/version-in";
import { validatePrerequisiteChoice } from "@/features/plan/prerequisite-choices";

/** The rest of the plan a prerequisite check needs beyond the draft's own kind. */
type PlanSlice = Pick<PortalState, "projects" | "deliverables" | "actions">;

/**
 * Turning a Plan draft into a command is deliberately separate from the form that collected it: the
 * validation messages and the payload are the part worth testing, while the page keeps only the
 * "await it, then clear the form or show the failure" wrapper around each save.
 */
export function validateAreaDraft(draft: AreaDraft, areas: StoredArea[]): string | null {
  const name = draft.name.trim();
  if (!name) return "Area name is required.";
  if (areas.some((item) => item.id !== draft.id && item.name.toLowerCase() === name.toLowerCase()))
    return "Area names must be unique.";
  return null;
}

export function areaCommand(draft: AreaDraft, state: PortalState, newId?: string): PlanningEntityCommand {
  const id = draft.id || newId || createClientId();
  const existing = state.areas.find((item) => item.id === id);
  return {
    commandId: createClientId(),
    expectedVersion: versionIn(state.areas, id),
    type: "save_entity",
    entityType: "area",
    entity: {
      id,
      name: draft.name.trim(),
      status: draft.status,
      sortOrder: existing?.sortOrder ?? state.areas.length,
      private: draft.private,
      ...(draft.description.trim() ? { description: draft.description.trim() } : {})
    }
  };
}

export function validateOutcomeDraft(draft: OutcomeDraft): string | null {
  if (!draft.areaId || !draft.title.trim() || !draft.definitionOfDone.trim())
    return "Outcome area, title, and definition of done are required.";
  return null;
}

export function outcomeCommand(draft: OutcomeDraft, state: PortalState, newId?: string): PlanningEntityCommand {
  const id = draft.id || newId || createClientId();
  return {
    commandId: createClientId(),
    expectedVersion: versionIn(state.outcomes, id),
    type: "save_entity",
    entityType: "outcome",
    entity: {
      id,
      areaId: draft.areaId,
      title: draft.title.trim(),
      definitionOfDone: draft.definitionOfDone.trim(),
      value: draft.value,
      status: draft.status,
      ...(dateValue(draft.deadlineAt, state.settings.timezone)
        ? { deadlineAt: dateValue(draft.deadlineAt, state.settings.timezone) }
        : {}),
      ...(draft.reviewOn ? { reviewOn: draft.reviewOn } : {})
    }
  };
}

export function validateProjectDraft(draft: ProjectDraft, timezone: string, plan?: PlanSlice): string | null {
  if (!draft.outcomeId || !draft.title.trim()) return "Project outcome and title are required.";
  const internal = dateValue(draft.internalDeadlineAt, timezone);
  const external = dateValue(draft.externalDeadlineAt, timezone);
  if (internal && external && new Date(internal) > new Date(external))
    return "The internal deadline cannot be after the external deadline.";
  if (plan && draft.prerequisites?.length)
    return validatePrerequisiteChoice(
      { kind: "project", id: draft.id },
      { dependencyIds: [], prerequisites: draft.prerequisites },
      plan
    );
  return null;
}

export function projectCommand(draft: ProjectDraft, state: PortalState, newId?: string): SaveProjectCommand {
  const internal = dateValue(draft.internalDeadlineAt, state.settings.timezone);
  const external = dateValue(draft.externalDeadlineAt, state.settings.timezone);
  const id = draft.id || newId || createClientId();
  return {
    commandId: createClientId(),
    expectedVersion: versionIn(state.projects, id),
    project: {
      id,
      outcomeId: draft.outcomeId,
      title: draft.title.trim(),
      status: draft.status,
      uncertainty: draft.uncertainty,
      consequence: draft.consequence,
      private: draft.private,
      ...(draft.prerequisites ? { prerequisites: draft.prerequisites } : {}),
      ...(internal ? { internalDeadlineAt: internal } : {}),
      ...(external ? { externalDeadlineAt: external } : {}),
      ...(draft.remainingEffortOverrideMinutes
        ? { remainingEffortOverrideMinutes: Number(draft.remainingEffortOverrideMinutes) }
        : {})
    }
  };
}

export function validateActionDraft(
  draft: ActionDraft,
  actions: StoredAction[],
  plan?: Pick<PlanSlice, "projects" | "deliverables">
): string | null {
  if (!draft.projectId || !draft.title.trim()) return "Action project and title are required.";
  if (!(draft.optimisticMinutes <= draft.expectedMinutes && draft.expectedMinutes <= draft.pessimisticMinutes))
    return "Effort must follow optimistic ≤ expected ≤ pessimistic.";
  if (draft.remainingMinutes < 0 || draft.remainingMinutes > draft.pessimisticMinutes)
    return "Remaining effort must be between zero and the pessimistic estimate.";
  if (draft.minimumSessionMinutes < 1 || draft.minimumSessionMinutes > draft.maximumSessionMinutes)
    return "Minimum session length cannot exceed the maximum.";
  if (draft.id && createsDependencyCycle(draft.id, draft.dependencyIds, actions))
    return "Those dependencies would create a cycle.";
  if (plan) {
    const invalid = validatePrerequisiteChoice(
      { kind: "action", id: draft.id, projectId: draft.projectId },
      { dependencyIds: draft.dependencyIds, prerequisites: draft.prerequisites ?? [] },
      { ...plan, actions }
    );
    if (invalid) return invalid;
  }
  if (
    draft.schedulingMode === "cadence" &&
    !(Number(draft.intervalDays) >= 1 && Number.isInteger(Number(draft.intervalDays)))
  )
    return "A cadence needs a whole number of days between suggestions.";
  if (
    draft.schedulingMode === "cadence" &&
    draft.completionMode === "total_minutes" &&
    !(Number(draft.targetTotalMinutes) > 0)
  )
    return "A total-time goal needs a target in minutes.";
  if (draft.schedulingMode === "cadence" && draft.periodUnit && draft.periodUnit !== "interval") {
    if (
      draft.periodUnit === "days" &&
      !(Number(draft.periodLength) >= 1 && Number.isInteger(Number(draft.periodLength)))
    )
      return "The period needs a whole number of days.";
    if (!(Number(draft.targetOccurrences) >= 1 && Number.isInteger(Number(draft.targetOccurrences))))
      return "Times per period needs a whole number, at least one.";
    const minSpacing = Number(draft.minSpacingDays);
    if (draft.minSpacingDays && !(minSpacing >= 0 && Number.isInteger(minSpacing)))
      return "Minimum days apart must be a whole number, zero or more.";
    if (
      draft.periodUnit === "days" &&
      minSpacing > 0 &&
      minSpacing * Number(draft.targetOccurrences) > Number(draft.periodLength)
    )
      return "Minimum days apart times the target occurrences does not fit within the period.";
  }
  return null;
}

export function actionCommand(draft: ActionDraft, state: PortalState, newId?: string): SaveActionCommand {
  const id = draft.id || newId || createClientId();
  const existing = state.actions.find((item) => item.id === id);
  const existingWindow = (name: string) => existing?.recurrence?.windows.find((item) => item.name === name);
  return {
    commandId: createClientId(),
    expectedVersion: versionIn(state.actions, id),
    action: {
      id,
      projectId: draft.projectId,
      title: draft.title.trim(),
      status: draft.status,
      optimisticMinutes: draft.optimisticMinutes,
      expectedMinutes: draft.expectedMinutes,
      pessimisticMinutes: draft.pessimisticMinutes,
      remainingMinutes: draft.remainingMinutes,
      energy: draft.energy,
      minimumSessionMinutes: draft.minimumSessionMinutes,
      maximumSessionMinutes: draft.maximumSessionMinutes,
      splittable: draft.splittable,
      setupMinutes: draft.setupMinutes,
      importance: draft.importance,
      consequence: draft.consequence,
      // The legacy flat list stays in step with the first route, so anything still reading it sees
      // the primary way of doing the work rather than an accidental union of every alternative.
      contexts: draft.pathways[0] ?? [],
      dependencyIds: draft.dependencyIds,
      ...(draft.prerequisites ? { prerequisites: draft.prerequisites } : {}),
      requirementPathways: draft.pathways.filter((route) => route.length),
      preferences: draft.preferences,
      private: draft.private,
      ...(dateValue(draft.availableFrom, state.settings.timezone)
        ? { availableFrom: dateValue(draft.availableFrom, state.settings.timezone)! }
        : {}),
      // The due date and latest start are authored-but-unread once an action repeats: `prepare`
      // hydrates a recurring unit from its occurrence's window instead, and a cadence has no windows
      // to be early or late against. Omitting the keys clears them, since this is a full save rather
      // than a patch — the write route sets whatever the payload does not carry to null.
      ...(draft.schedulingMode === "one_off" && dateValue(draft.deadlineAt, state.settings.timezone)
        ? { deadlineAt: dateValue(draft.deadlineAt, state.settings.timezone)! }
        : {}),
      ...(draft.schedulingMode === "one_off" && dateValue(draft.latestStartAt, state.settings.timezone)
        ? { latestStartAt: dateValue(draft.latestStartAt, state.settings.timezone)! }
        : {}),
      // Always sent, even empty: an absent `notes` now means "keep the stored notes", so emptying the
      // box has to say so explicitly for the server to clear them.
      notes: draft.notes.trim(),
      schedulingMode: draft.schedulingMode,
      // A cadence keeps a rule and no windows: an interval, a start, and how the series ends.
      ...(draft.schedulingMode === "cadence"
        ? {
            recurrence: {
              id: existing?.recurrence?.id ?? createClientId(),
              timezone: state.settings.timezone,
              startDate:
                draft.recurrenceStart ??
                existing?.recurrence?.startDate ??
                dateOnly(new Date(), state.settings.timezone),
              intervalDays: Math.max(1, Math.round(Number(draft.intervalDays) || 1)),
              completionMode: draft.completionMode ?? "manual",
              ...(draft.completionMode === "end_date"
                ? {
                    endDate:
                      draft.recurrenceEnd ??
                      existing?.recurrence?.endDate ??
                      dateOnly(new Date(Date.now() + 56 * 86_400_000), state.settings.timezone)
                  }
                : {}),
              ...(draft.completionMode === "total_minutes" && draft.targetTotalMinutes
                ? { targetTotalMinutes: Number(draft.targetTotalMinutes) }
                : {}),
              // a period takes over from the plain interval above; "interval" (the default)
              // leaves it unset so intervalDays keeps deciding due-ness, exactly as before this field existed.
              ...(draft.periodUnit === "days"
                ? {
                    period: { unit: "days" as const, length: Math.max(1, Math.round(Number(draft.periodLength) || 1)) }
                  }
                : draft.periodUnit === "month"
                  ? { period: { unit: "month" as const } }
                  : {}),
              ...(draft.periodUnit !== "interval" && draft.periodUnit
                ? { targetOccurrences: Math.max(1, Math.round(Number(draft.targetOccurrences) || 1)) }
                : {}),
              ...(draft.periodUnit !== "interval" && draft.periodUnit && Number(draft.minSpacingDays) > 0
                ? { minSpacingDays: Math.round(Number(draft.minSpacingDays)) }
                : {}),
              ...(draft.periodUnit !== "interval" && draft.periodUnit && draft.eligibleWeekdays?.length
                ? { eligibleWeekdays: [...draft.eligibleWeekdays].sort((a, b) => a - b) }
                : {}),
              windows: []
            }
          }
        : {}),
      ...(draft.schedulingMode === "recurring"
        ? {
            recurrence: {
              id: existing?.recurrence?.id ?? createClientId(),
              timezone: state.settings.timezone,
              startDate:
                draft.recurrenceStart ??
                existing?.recurrence?.startDate ??
                dateOnly(new Date(), state.settings.timezone),
              intervalDays: 1,
              completionMode: draft.completionMode ?? "end_date",
              ...(draft.completionMode !== "total_minutes" && draft.completionMode !== "manual"
                ? {
                    endDate:
                      draft.recurrenceEnd ??
                      existing?.recurrence?.endDate ??
                      dateOnly(new Date(Date.now() + 56 * 86_400_000), state.settings.timezone)
                  }
                : {}),
              ...(draft.completionMode === "total_minutes" && draft.targetTotalMinutes
                ? { targetTotalMinutes: Number(draft.targetTotalMinutes) }
                : {}),
              windows: [
                {
                  id: existingWindow("Morning")?.id ?? createClientId(),
                  name: "Morning",
                  anchor: "wake" as const,
                  startOffsetMinutes: 0,
                  endOffsetMinutes: 180,
                  fallback: {
                    startTime: draft.morningFallbackStart ?? existingWindow("Morning")?.fallback?.startTime ?? "05:00",
                    endTime: draft.morningFallbackEnd ?? existingWindow("Morning")?.fallback?.endTime ?? "08:00"
                  }
                },
                {
                  id: existingWindow("Bedtime")?.id ?? createClientId(),
                  name: "Bedtime",
                  anchor: "sleep_start" as const,
                  startOffsetMinutes: -180,
                  endOffsetMinutes: 0,
                  fallback: {
                    startTime: draft.bedtimeFallbackStart ?? existingWindow("Bedtime")?.fallback?.startTime ?? "20:00",
                    endTime: draft.bedtimeFallbackEnd ?? existingWindow("Bedtime")?.fallback?.endTime ?? "21:00"
                  }
                }
              ]
            }
          }
        : {})
    }
  };
}

export function validateDeliverableDraft(
  draft: DeliverableDraft,
  timezone: string,
  editingId?: string,
  plan?: PlanSlice
): string | null {
  if (!draft.projectId || !draft.title) return "A deliverable needs a project and a title.";
  const internal = dateValue(draft.internalDeadlineAt, timezone);
  const external = dateValue(draft.externalDeadlineAt, timezone);
  if (internal && external && new Date(internal) > new Date(external))
    return "The internal deadline cannot be after the external deadline.";
  if (editingId && draft.dependencyIds.includes(editingId)) return "A deliverable cannot depend on itself.";
  if (plan && (draft.dependencyIds.length || draft.prerequisites?.length))
    return validatePrerequisiteChoice(
      { kind: "deliverable", id: editingId, projectId: draft.projectId },
      { dependencyIds: draft.dependencyIds, prerequisites: draft.prerequisites ?? [] },
      plan
    );
  return null;
}

/** The planning metadata a draft carries, in the stored shape; absent dates are omitted, not nulled. */
function deliverablePlanningFields(draft: DeliverableDraft, timezone: string) {
  const externalDeadlineAt = dateValue(draft.externalDeadlineAt, timezone);
  const internalDeadlineAt = dateValue(draft.internalDeadlineAt, timezone);
  return {
    uncertainty: draft.uncertainty,
    importance: draft.importance,
    consequence: draft.consequence,
    dependencyIds: [...draft.dependencyIds],
    ...(draft.prerequisites ? { prerequisites: draft.prerequisites } : {}),
    private: draft.private,
    ...(externalDeadlineAt ? { externalDeadlineAt } : {}),
    ...(internalDeadlineAt ? { internalDeadlineAt } : {})
  };
}

export function deliverableCommand(draft: DeliverableDraft, state: PortalState): PlanningEntityCommand {
  return {
    commandId: createClientId(),
    expectedVersion: null,
    type: "save_entity",
    entityType: "deliverable",
    entity: {
      id: createClientId(),
      projectId: draft.projectId,
      title: draft.title,
      status: "needs_breakdown",
      contractVersion: 0,
      planVersion: 0,
      sortOrder: state.deliverables.length,
      sourceIds: [],
      sourceFiles: [],
      steps: [],
      criteria: [],
      blockers: [],
      contractProposals: [],
      ...deliverablePlanningFields(draft, state.settings.timezone)
    }
  };
}

/**
 * Changes only a registered deliverable's planning metadata — deadlines, uncertainty, prerequisites,
 * importance, consequence — and re-saves the aggregate otherwise as stored. Contract, steps and
 * blockers are authored in-session and are carried through untouched; the store rewrites the whole
 * aggregate, so they must travel with the command rather than be omitted.
 */
export function deliverableUpdateCommand(
  stored: StoredDeliverable,
  draft: DeliverableDraft,
  timezone: string
): PlanningEntityCommand {
  const { externalDeadlineAt: _external, internalDeadlineAt: _internal, ...rest } = stored;
  return {
    commandId: createClientId(),
    expectedVersion: stored.version ?? null,
    type: "save_entity",
    entityType: "deliverable",
    entity: { ...rest, projectId: draft.projectId, title: draft.title, ...deliverablePlanningFields(draft, timezone) }
  };
}

export function createsDependencyCycle(
  actionId: string,
  proposedDependencies: string[],
  actions: StoredAction[]
): boolean {
  const dependencies = new Map(
    actions.map((item) => [item.id, item.id === actionId ? proposedDependencies : item.dependencyIds])
  );
  const visit = (id: string, path: Set<string>): boolean => {
    if (path.has(id)) return true;
    const nextPath = new Set(path).add(id);
    return (dependencies.get(id) ?? []).some((dependencyId) => visit(dependencyId, nextPath));
  };
  return visit(actionId, new Set());
}

/**
 * Marks a recurring goal done without writing an instance — a finish that happened away from the
 * app. Fire-and-forget; the caller does not await. The version comes from the action record
 * already in hand, not from a lookup (conventions rule 1 — never wrap a record you already hold).
 */
export function recurrenceGoalEndCommand(item: StoredAction): EndRecurrenceGoalCommand {
  return {
    commandId: createClientId(),
    expectedVersion: item.version ?? null,
    type: "end_recurrence_goal",
    actionId: item.id
  };
}

/**
 * Records a cadence cycle done without a session — a run that happened away from the app.
 * Fire-and-forget; the caller does not await. The version comes from the action record already in
 * hand, not from a lookup (conventions rule 1 — never wrap a record you already hold).
 */
export function cadenceCompletionCommand(item: StoredAction): RecordCadenceCompletionCommand {
  return {
    commandId: createClientId(),
    expectedVersion: item.version ?? null,
    type: "record_cadence_completion",
    actionId: item.id
  };
}
