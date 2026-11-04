import type { SaveActionCommand } from "@openrhen/contracts";
import type { StoredAction } from "@/state/portal-state";

/**
 * Restates a stored action as the `action` of a `save_action` command, losing nothing the editor can
 * author: every requirement route (not only the first, which is all `contexts` mirrors),
 * preferences, dates, and the recurrence. A one-field change from outside the editor (block, wait,
 * complete a series, cancel) builds from this and overrides only what it changes, so it cannot wipe
 * what it never meant to touch. `notes`, `prerequisites` and `prepForCommitmentId` are left out on
 * purpose: absent keeps the stored value, edges and attachment. Notes in particular must not be resent,
 * because imports can store more than the command's 5000-character cap and the restatement would then
 * fail validation.
 */
export function storedActionPayload(
  action: StoredAction,
  overrides: Partial<SaveActionCommand["action"]> = {}
): SaveActionCommand["action"] {
  return {
    id: action.id,
    projectId: action.projectId,
    title: action.title,
    status: action.status,
    optimisticMinutes: action.optimisticMinutes,
    expectedMinutes: action.expectedMinutes,
    pessimisticMinutes: action.pessimisticMinutes,
    remainingMinutes: action.remainingMinutes,
    energy: action.energy,
    minimumSessionMinutes: action.minimumSessionMinutes,
    maximumSessionMinutes: action.maximumSessionMinutes,
    splittable: action.splittable,
    setupMinutes: action.setupMinutes,
    importance: action.importance,
    consequence: action.consequence,
    contexts: action.contexts,
    dependencyIds: action.dependencyIds,
    // Sent back as stored: left out, `contexts` alone would be folded into a single route and
    // replace the action's alternatives.
    requirementPathways: action.requirementPathways,
    preferences: action.preferences,
    schedulingMode: action.schedulingMode ?? "one_off",
    ...(action.recurrence ? { recurrence: action.recurrence } : {}),
    ...(action.availableFrom ? { availableFrom: action.availableFrom } : {}),
    ...(action.deadlineAt ? { deadlineAt: action.deadlineAt } : {}),
    ...(action.latestStartAt ? { latestStartAt: action.latestStartAt } : {}),
    ...(action.private !== undefined ? { private: action.private } : {}),
    ...overrides
  };
}
