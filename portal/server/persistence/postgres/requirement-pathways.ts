/**
 * A `SaveActionCommand`'s `requirementPathways` accepts each route as either a bare `string[]` or the
 * read shape's `{ id, contextIds }` object, so a caller that merges a stored action straight back into
 * a write payload does not have to convert — mirroring the dual-shape handling in deliverable-write.ts.
 */
export type RequirementPathwayInput = string[] | { id: string; contextIds?: string[] };

/**
 * Normalises a command's requirement pathways to plain routes for storage. An empty route is dropped:
 * a pathway with no requirements is unrepresentable in the model and invalidates the whole state
 * document. (`saveActionCommandSchema` already forbids an empty route at the type level; this filter
 * is kept as a defensive backstop for callers that bypass the schema.)
 */
export function normalizeRequirementPathways(routes: readonly RequirementPathwayInput[]): string[][] {
  return routes
    .map((entry) => (Array.isArray(entry) ? entry : (entry.contextIds ?? [])))
    .filter((entry) => entry.length > 0);
}

/**
 * The pathways a save should now hold, now that `action_contexts` is no longer its own store:
 * `requirementPathways` when the caller sent it — including an explicit `[]`, which clears them —
 * otherwise a single AND pathway built from the legacy flat `contexts` list, the same thing that field
 * always meant. `undefined` means the caller has nothing to say, so stored pathways are left alone.
 *
 * `storedFirstRoute` is the stored action's first route when the caller sent `contexts` only. The read
 * shape's flat `contexts` is exactly that first route, so a caller that echoes it back (a partial
 * payload built from a stored action) has not changed anything; folding it would collapse every
 * alternative route into the first. It is treated as a change, and folded, only when it differs.
 */
export function pathwaysToStore(
  requirementPathways: readonly RequirementPathwayInput[] | undefined,
  contexts: readonly string[],
  storedFirstRoute?: readonly string[]
): string[][] | undefined {
  if (requirementPathways) return normalizeRequirementPathways(requirementPathways);
  if (!contexts.length) return undefined;
  if (storedFirstRoute && sameContexts(contexts, storedFirstRoute)) return undefined;
  return normalizeRequirementPathways([[...contexts]]);
}

function sameContexts(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((context) => right.has(context));
}
