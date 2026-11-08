/** Context messages that go in a prompt: the newest few of the conversation. Both the eligibility check and the prompt builder use this. */
export const CONTEXT_MESSAGES = 3;

/**
 * The context messages a prompt carries: the LAST 3 of an oldest-first array (the newest, in their original order), with
 * the index each had in the input. One selector for `hostedEligibility` and `buildFactPrompt`, so the mail that is checked
 * is the mail that is sent. Holes (null, undefined) are skipped without shifting the other indexes.
 */
export function newestContext<T>(
  context: readonly (T | null | undefined)[] | null | undefined
): { index: number; message: T }[] {
  if (!Array.isArray(context)) return [];
  const picked: { index: number; message: T }[] = [];
  for (let index = context.length - 1; index >= 0 && picked.length < CONTEXT_MESSAGES; index--) {
    const message = context[index];
    if (message !== null && message !== undefined) picked.unshift({ index, message });
  }
  return picked;
}

declare const vetted: unique symbol;
/**
 * Context messages cleared to go in a prompt. Only `vettedContext` (after `hostedEligibility`, for the hosted tier) and
 * `localContext` (for a model on the owner's own machine, where nothing leaves it) make one, so `buildFactPrompt` cannot be
 * handed mail that nothing checked.
 */
export type VettedContext<T> = readonly T[] & { readonly [vetted]: true };

/** Context for a local model: the newest 3. Never use this for the hosted tier. */
export function localContext<T>(context: readonly (T | null | undefined)[] | null | undefined): VettedContext<T> {
  return newestContext(context).map((entry) => entry.message) as unknown as VettedContext<T>;
}
