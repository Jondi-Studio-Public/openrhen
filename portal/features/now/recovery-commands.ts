import type { PortalState } from "@/state/portal-state";
import { createClientId } from "@/shared/client-id";
import type { SaveEntityCommand } from "@/features/now/now-model";

/**
 * The authoring module for the recovery line's skip and undo: a
 * `daily_plan` save for `localDate` that carries the day's other fields through unchanged and sets
 * `recoverySkipped`. It leaves `horizonOverrideAt` out on purpose: the server keeps the row's own, and
 * the state's value may be one carried over from another day that must not be written into this row.
 */
export function recoverySkippedCommand(
  plan: PortalState["dailyPlan"] | undefined,
  localDate: string,
  recoverySkipped: boolean,
  /** The date is an overnight occurrence's start day, a row the client may not hold: flip the flag only. */
  flagOnly = false
): Parameters<SaveEntityCommand>[0] {
  const today = plan?.localDate === localDate ? plan : undefined;
  return {
    commandId: createClientId(),
    expectedVersion: flagOnly ? null : (today?.version ?? null),
    type: "save_entity",
    entityType: "daily_plan",
    entity: {
      localDate,
      ...(flagOnly
        ? { recoverySkippedOnly: true }
        : { desiredActionIds: today?.desiredActionIds ?? [], deferredItems: today?.deferredItems ?? [] }),
      recoverySkipped
    }
  };
}
