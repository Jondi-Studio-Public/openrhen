import type {
  ConfirmProjectWantedCommand,
  SaveActionCommand,
  SaveProjectCommand,
  PlanningEntityCommand
} from "@openrhen/contracts";
import type { StoredAction, StoredOutcome, StoredProject, PlanningFocus } from "@/state/portal-state";
import { createClientId } from "@/shared/client-id";
import { storedActionPayload } from "@/shared/stored-action-payload";

/**
 * The authoring module for `review`'s two single-command sites — see
 * The command authoring design note, decision 1. Both send exactly one command with no branch,
 * so both are builders rather than orchestrators.
 */

/**
 * Restates an entire stored action row to move its recurrence's end date or complete the series.
 * `mode` is `"complete"` or `"extend"`, which sets `status` to `"done"` or leaves it unchanged,
 * and for `"extend"`, sets `recurrence.endDate` seven days on from the later of the old end and `today`
 * (a `YYYY-MM-DD` date in the person's zone), so a series that ended long ago ends in the future, not still in the
 * past. Returns `null` when the action has no `recurrence`, mirroring how `versionIn` treats a missing record as
 * `null` rather than throwing. The page's early bail (convention rule 1) stays at the call site.
 */
export function updateSeriesCommand(
  action: StoredAction,
  mode: "complete" | "extend",
  today?: string
): SaveActionCommand | null {
  if (!action.recurrence) return null;
  const old = action.recurrence.endDate ?? today ?? "";
  const end = new Date(`${today && today > old ? today : old}T00:00:00Z`);
  if (mode === "extend") end.setUTCDate(end.getUTCDate() + 7);
  return {
    commandId: createClientId(),
    expectedVersion: action.version ?? null,
    action: storedActionPayload(action, {
      status: mode === "complete" ? "done" : action.status,
      schedulingMode: "recurring",
      recurrence: {
        ...action.recurrence,
        endDate: mode === "extend" ? end.toISOString().slice(0, 10) : action.recurrence.endDate
      }
    })
  };
}

/** Puts a series' end date back to `endDate` (the Undo after Extend), restating the stored row like Extend does. */
export function setSeriesEndCommand(action: StoredAction, endDate: string): SaveActionCommand | null {
  if (!action.recurrence) return null;
  return {
    commandId: createClientId(),
    expectedVersion: action.version ?? null,
    action: storedActionPayload(action, {
      status: action.status,
      schedulingMode: "recurring",
      recurrence: { ...action.recurrence, endDate }
    })
  };
}

/**
 * Sends a `planning_focus` entity for undated project focus. Its entity id is
 * `record?.id ?? createClientId()` — a fresh id when no record exists — and its version comes from
 * the same `record`. That pairing is the point: the id and the version are read off one `record`,
 * so the version always names the snapshot the entity identifies, and an absent record yields a new
 * id with `null` rather than a version belonging to something else.
 */
export function saveFocusCommand(
  kind: "weekly" | "monthly",
  period: { start: string; end: string },
  record: PlanningFocus | undefined,
  projectIds: string[],
  /** The local date the weekly review was finished; left out keeps the stored date. */
  reviewedOn?: string
): PlanningEntityCommand {
  return {
    commandId: createClientId(),
    expectedVersion: record?.version ?? null,
    type: "save_entity",
    entityType: "planning_focus",
    entity: {
      id: record?.id ?? createClientId(),
      kind,
      periodStart: period.start,
      periodEnd: period.end,
      projectIds,
      ...(reviewedOn ? { reviewedOn } : {})
    }
  };
}

/**
 * Restates a stored project with a changed status and/or internal deadline, for the weekly review's Pause and Drop
 * on a stale project, "Accept <date>" on an overdue one, and their Undo. Every other field goes back exactly as stored
 * (deadlines as their instants, not through a date input), and prerequisites are left out so the stored edges stay
 * untouched. `internalDeadlineAt: null` clears the internal date.
 */
function restateProject(
  project: StoredProject,
  changes: { status?: StoredProject["status"]; internalDeadlineAt?: string | null }
): SaveProjectCommand {
  const internal = "internalDeadlineAt" in changes ? changes.internalDeadlineAt : project.internalDeadlineAt;
  return {
    commandId: createClientId(),
    expectedVersion: project.version ?? null,
    project: {
      id: project.id,
      outcomeId: project.outcomeId,
      title: project.title,
      status: changes.status ?? project.status,
      uncertainty: project.uncertainty,
      consequence: project.consequence,
      ...(internal ? { internalDeadlineAt: internal } : {}),
      ...(project.externalDeadlineAt ? { externalDeadlineAt: project.externalDeadlineAt } : {}),
      ...(project.remainingEffortOverrideMinutes !== undefined && project.remainingEffortOverrideMinutes !== null
        ? { remainingEffortOverrideMinutes: project.remainingEffortOverrideMinutes }
        : {})
    }
  };
}

export function projectStatusCommand(project: StoredProject, status: StoredProject["status"]): SaveProjectCommand {
  return restateProject(project, { status });
}

/** The review's "Accept <date>" on an overdue project, and its Undo (`null` puts back "no internal date"). */
export function projectInternalDeadlineCommand(
  project: StoredProject,
  internalDeadlineAt: string | null
): SaveProjectCommand {
  return restateProject(project, { internalDeadlineAt });
}

/** Restates a stored action with only its status changed: the review's Unblock, and its Undo. */
export function actionStatusCommand(action: StoredAction, status: StoredAction["status"]): SaveActionCommand {
  return {
    commandId: createClientId(),
    expectedVersion: action.version ?? null,
    action: storedActionPayload(action, { status })
  };
}

/**
 * Restates a stored outcome with a new status and/or review date, for "Keep going" (review date pushed out),
 * "Close" (done), and their Undo. `reviewOn: null` clears the date. Everything else goes back as stored.
 */
export function outcomeReviewCommand(
  outcome: StoredOutcome,
  changes: { status?: StoredOutcome["status"]; reviewOn?: string | null }
): PlanningEntityCommand {
  const reviewOn = "reviewOn" in changes ? changes.reviewOn : outcome.reviewOn;
  return {
    commandId: createClientId(),
    expectedVersion: outcome.version ?? null,
    type: "save_entity",
    entityType: "outcome",
    entity: {
      id: outcome.id,
      areaId: outcome.areaId,
      title: outcome.title,
      definitionOfDone: outcome.definitionOfDone,
      value: outcome.value,
      status: changes.status ?? outcome.status,
      ...(outcome.deadlineAt ? { deadlineAt: outcome.deadlineAt } : {}),
      ...(reviewOn ? { reviewOn } : {})
    }
  };
}

/**
 * The review's Keep: confirms the project is still wanted. The server stamps `lastReviewedAt` (no ordinary
 * save can), read at the version the card showed, so a project edited elsewhere since conflicts instead of
 * being kept on stale information. Null when the project has no version yet (the page bails, as for a series).
 */
export function keepProjectCommand(project: StoredProject): ConfirmProjectWantedCommand | null {
  if (typeof project.version !== "number") return null;
  return { commandId: createClientId(), projectId: project.id, expectedVersion: project.version };
}

/** The review's "Seen, leave it" on an overdue project: stamps it seen for this review week, on the server. */
export function overdueSeenCommand(project: StoredProject): ConfirmProjectWantedCommand | null {
  const command = keepProjectCommand(project);
  return command && { ...command, kind: "overdue_seen" };
}

/**
 * Undo for Keep or Seen: sends the earlier stamp (`null` when there was none) back at the version the project has
 * now. `kind` names which stamp to restore (`last_reviewed_at` by default, `overdue_seen_at` for Seen).
 */
export function restoreReviewStampCommand(
  project: StoredProject,
  previous: string | null,
  kind: "keep" | "overdue_seen" = "keep"
): ConfirmProjectWantedCommand | null {
  if (typeof project.version !== "number") return null;
  return {
    commandId: createClientId(),
    projectId: project.id,
    expectedVersion: project.version,
    reviewedAt: previous,
    ...(kind === "overdue_seen" ? { kind } : {})
  };
}
