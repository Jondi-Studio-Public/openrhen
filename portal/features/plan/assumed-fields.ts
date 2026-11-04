import { isAssumableActionField, type AssumableActionField } from "@openrhen/contracts";
import type { StoredAction } from "@/state/portal-state";
import type { ActionDraft } from "@/features/plan/plan-drafts";

/** The word the portal uses for a default or a guess that nobody has confirmed (blueprint principle 8). */
export const ASSUMED_LABEL = "assumed";

/** Whether the action's stored record lists `field` as assumed. */
export function isAssumed(
  action: Pick<StoredAction, "assumedFields"> | undefined,
  field: AssumableActionField
): boolean {
  return action?.assumedFields?.includes(field) ?? false;
}

/** " (assumed)" after a value the action lists as assumed, else nothing: for a value printed in a line of text. */
export function assumedMark(action: Pick<StoredAction, "assumedFields">, field: AssumableActionField): string {
  return isAssumed(action, field) ? ` (${ASSUMED_LABEL})` : "";
}

/**
 * The fields to label in the editor: those the stored action lists as assumed whose value the draft still has.
 * Changing a value is giving one, and the save then stops calling it assumed (the server keeps a stored field
 * only while its value is unchanged), so the label goes as soon as the value does. A new action has none.
 */
export function assumedInDraft(stored: StoredAction | undefined, draft: ActionDraft): Set<AssumableActionField> {
  const assumed = new Set<AssumableActionField>();
  if (!stored?.assumedFields?.length) return assumed;
  for (const field of stored.assumedFields)
    if (isAssumableActionField(field) && Object.is(stored[field], draft[field])) assumed.add(field);
  return assumed;
}
