/**
 * Title-similarity matcher, ported from a retired scanner. Kept generic over candidate shape so
 * both the extraction item type and plain `{title, date}` candidates from confirmed commitments,
 * actions, deliverables, or pending proposals can be matched against.
 *
 * Pure and side-effect-free: no database or Node-only APIs, so both the mail sync service
 * (via `@openrhen/contracts`) and the portal can import it.
 */

export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const STOP_WORDS = new Set(["the", "a", "an", "to", "of", "for", "at", "in", "on", "and", "or"]);

function tokens(title: string): Set<string> {
  return new Set(
    normalizeTitle(title)
      .split(" ")
      .filter((token) => token !== "" && !STOP_WORDS.has(token))
  );
}

/** Tokens match exactly, or by prefix for words of 4+ chars (renew/renewal, book/booking). */
function tokensMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return shorter.length >= 4 && longer.startsWith(shorter);
}

/** Token Jaccard similarity of two titles, ignoring punctuation, stop words, and simple suffixes. */
export function titleSimilarity(a: string, b: string): number {
  const tokensA = tokens(a);
  const tokensB = tokens(b);
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  const remaining = [...tokensB];
  let shared = 0;
  for (const token of tokensA) {
    const index = remaining.findIndex((candidate) => tokensMatch(token, candidate));
    if (index >= 0) {
      shared += 1;
      remaining.splice(index, 1);
    }
  }
  return shared / (tokensA.size + tokensB.size - shared);
}

const SIMILARITY_THRESHOLD = 0.6;

/** Two titles match when one normalized title contains the other or their similarity clears the threshold. */
export function titlesMatch(a: string, b: string): boolean {
  const normalizedA = normalizeTitle(a);
  const normalizedB = normalizeTitle(b);
  const contained =
    normalizedA.length > 0 &&
    normalizedB.length > 0 &&
    (normalizedA.includes(normalizedB) || normalizedB.includes(normalizedA));
  return contained || titleSimilarity(a, b) >= SIMILARITY_THRESHOLD;
}

/** The minimal shape the matcher needs from any candidate: extraction items, confirmed
 * commitments/actions/deliverables, or pending proposals all reduce to this. */
export interface TitleDateCandidate {
  title: string;
  date: string | null;
  kind: string;
}

/**
 * Returns the matching candidate this item duplicates, or null. Two items match when they fall on
 * the same date (or both have no date and share a kind) and their titles are similar or one
 * contains the other.
 */
export function findTitleDuplicate<T extends TitleDateCandidate>(
  candidate: TitleDateCandidate,
  existing: readonly T[]
): T | null {
  for (const item of existing) {
    const sameDate = candidate.date !== null && item.date === candidate.date;
    const bothUndatedSameKind = candidate.date === null && item.date === null && item.kind === candidate.kind;
    if (!sameDate && !bothUndatedSameKind) continue;

    if (titlesMatch(candidate.title, item.title)) return item;
  }
  return null;
}
