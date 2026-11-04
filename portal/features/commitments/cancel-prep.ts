import { openPrepFor, type SaveActionCommand } from "@openrhen/contracts";
import type { StoredAction } from "@/state/portal-state";
import { createClientId } from "@/shared/client-id";

/**
 * Cancelling a commitment offers to cancel the prep attached to it (`CONTEXT.md` "Prep"; design:
 * email-reasoning §7, "Cancelling the commitment offers to cancel its open prep"). `openPrepFor` says
 * which prep is still open; this restates such an action with its status `cancelled`, as a plain
 * `save_action`, so the cancellation goes through the one write path like any other edit.
 */

/** The prep for `commitmentId` that is still open. */
export function openPrepOf(actions: readonly StoredAction[], commitmentId: string): StoredAction[] {
  return commitmentId ? openPrepFor(actions, commitmentId) : [];
}

/** The action as stored, with only its status changed to `cancelled`. */
export function cancelPrepCommand(action: StoredAction): SaveActionCommand {
  return {
    commandId: createClientId(),
    expectedVersion: action.version ?? null,
    action: {
      id: action.id,
      projectId: action.projectId,
      title: action.title,
      status: "cancelled",
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
      ...(action.deadlineAt ? { deadlineAt: action.deadlineAt } : {}),
      ...(action.availableFrom ? { availableFrom: action.availableFrom } : {}),
      ...(action.latestStartAt ? { latestStartAt: action.latestStartAt } : {}),
      ...(action.notes ? { notes: action.notes } : {}),
      ...(action.private !== undefined ? { private: action.private } : {})
    }
  };
}

/** Cancels each of `prep` in turn, stopping at the first refusal so the rest are left as they were. */
export async function cancelPrep(
  prep: readonly StoredAction[],
  save: (command: SaveActionCommand) => Promise<void>
): Promise<void> {
  for (const action of prep) await save(cancelPrepCommand(action));
}
