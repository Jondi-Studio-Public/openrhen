/**
 * Prep is an action attached to one commitment (`CONTEXT.md` "Prep"; `actions.prep_for_commitment_id`).
 * This is the one place that says which of a commitment's prep is still open, so the offer made when
 * the commitment is cancelled ("Cancel its prep too?") and anything else asking the same question
 * agree.
 */

/** The action facts this module needs; a wire action satisfies it. */
export interface PrepCandidate {
  id: string;
  title: string;
  status: string;
  prepForCommitmentId?: string | undefined;
}

/** Statuses after which an action is no longer open work. */
const CLOSED_STATUSES: ReadonlySet<string> = new Set(["done", "cancelled", "archived"]);

/** The prep for `commitmentId` that has not been finished or cancelled, in the order given. */
export function openPrepFor<T extends PrepCandidate>(actions: readonly T[], commitmentId: string): T[] {
  return actions.filter((action) => action.prepForCommitmentId === commitmentId && !CLOSED_STATUSES.has(action.status));
}
