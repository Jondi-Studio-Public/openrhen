import type { ActivityCommand, CanDoNowItem } from "@openrhen/contracts";
import type { PortalState } from "@/state/portal-state";
import { createClientId } from "@/shared/client-id";
import { versionIn } from "@/shared/version-in";

/**
 * The authoring module for `CanDoNowList`'s single command site. Unlike the twenty-five
 * `features/now/components/` sites on `command-authoring.test.ts`'s shrinking allowlist, a can-do-now
 * item's step isn't handed down through a precedence chain as a prop already carrying its version —
 * `CanDoNowList` looks its step up in `state.routineSteps` itself, which is exactly the live-version
 * case `versionIn` exists for, so it belongs behind
 * a builder rather than added to the allowlist.
 */
export function startCanDoNowStepCommand(item: CanDoNowItem, state: PortalState): ActivityCommand {
  return {
    commandId: createClientId(),
    expectedVersion: versionIn(state.routineSteps, item.stepId),
    type: "start_activity",
    targetType: "routine_step",
    targetId: item.stepId,
    plannedMinutes: item.durationMinutes
  };
}
