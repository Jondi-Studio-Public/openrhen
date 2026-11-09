import type { Chooser, ChooserRequest, ReplayCase, ReplayTarget } from "./replay-case.js";

/**
 * Chooser stubs for the judge path. A real backend never runs in CI. The contract is the issue's:
 * a quote and at most five code-built cards in, `cN` / `none` / `unsure` out, no tools.
 */

/** The deterministic path: a reconciler must not call it, and treats a case that needs it as unanswered. */
export const never: Chooser = Object.assign(
  (_request: ChooserRequest): string => {
    throw new Error("the deterministic path must not call a chooser");
  },
  { unavailable: true as const }
);

const goldIds = (gold: ReplayCase["gold"]): Set<string> =>
  new Set(
    [gold.target, ...(gold.acceptableTargets ?? [])].filter((t): t is ReplayTarget => t !== undefined).map((t) => t.id)
  );

/** The ceiling: the gold card if it is shown, `unsure` where gold is a question, else `none`. */
export function oracle(gold: ReplayCase["gold"]): Chooser {
  const wanted = goldIds(gold);
  return ({ cards }) =>
    gold.endState === "asked" ? "unsure" : (cards.find((card) => wanted.has(card.id))?.label ?? "none");
}

/** Always the first card, or `unsure` with none. Code must hold even against this. */
export const adversarial: Chooser = ({ cards }) => cards[0]?.label ?? "unsure";

/** FNV-1a, so a draw depends on the seed and the case, not on the order cases run in. */
function unitHash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h / 0x100000000;
}

/** The oracle with probability `p`, else the adversarial answer: a weaker model's effect on false merges. */
export function noisy(p: number, seed: string, caseId: string, gold: ReplayCase["gold"]): Chooser {
  const right = oracle(gold);
  return (request) => (unitHash(`${seed}:${caseId}`) < p ? right(request) : adversarial(request));
}
