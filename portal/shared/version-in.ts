/**
 * The one way an authoring module resolves `expectedVersion`. Centralises the single invariant worth
 * sharing — *no record found means `null`, which means insert* — so every caller writes the coalesce
 * once rather than repeating `existing?.version ?? null` and one day forgetting the `?? null`.
 *
 * Takes the array, not a state key: a `versionIn(state, "deliverables", id)` form was considered and
 * rejected, since a string key must be kept in step with the state shape by hand and types worse than
 * passing the array (plan decision 4). Typed so any array of records carrying an `id` and an optional
 * `version` is accepted, and passing the wrong collection is a type error the language can see.
 *
 * Callers must pass the array from the same snapshot their command body was composed from — this
 * function only does the find and the coalesce; it does not, and cannot, protect against a stale read
 *
 */
export function versionIn<T extends { id: string; version?: number | undefined }>(
  collection: readonly T[],
  id: string
): number | null {
  return collection.find((item) => item.id === id)?.version ?? null;
}
