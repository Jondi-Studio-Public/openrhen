import { searchEvidence, type EvidenceSpan } from "./evidence-span.js";
import { factIdN2, stripQuoteMarkers } from "./fact-id-n2.js";
import { sentenceAt, type SentenceUnit } from "./sentence-split.js";

/** A grounded span is at most this many code points. `DERIVED_SPAN_MAX_CODE_POINTS` in contracts is the validator's copy. */
export const MAX_QUOTE_CODE_POINTS = 200;
/** Message text longer than this is not read. `DERIVED_CONTENT_MAX_CODE_POINTS` in contracts is the validator's copy. */
export const MAX_CONTENT_CODE_POINTS = 200000;
/** A quote this long (before whitespace folding) is refused before any search, to bound the work a model can cause. */
const QUOTE_SEARCH_LIMIT = MAX_QUOTE_CODE_POINTS * 5;

/** Why a quote was not written: all of them mean "the model's quote is not a unique verbatim stretch of the message". */
export const GROUNDING_FAILURES = [
  "empty_quote",
  "too_long",
  "no_content",
  "content_too_long",
  "quoted_text",
  "no_text",
  "not_found",
  "ambiguous"
] as const;
export type GroundingFailure = (typeof GROUNDING_FAILURES)[number];

export type GroundingResult =
  { ok: true; span: EvidenceSpan; sentence: SentenceUnit; factId: string } | { ok: false; reason: GroundingFailure };

export interface GroundQuoteInput {
  /** The message text; null when it was removed or never stored. */
  content: string | null;
  /** What the model returned as its quote. Untrusted: anything that is not text is an empty quote. */
  quote: unknown;
  conversationKey: string;
  icsUid?: string | null | undefined;
}

/**
 * The grounding gate. A fact is written only if its quote matches the message text exactly once (after folding
 * whitespace; case sensitive) and the matched stretch is at most 200 code points. Anything else is rejected, never
 * repaired: the extractor does not write the row and counts the reason (`tallyGrounding`). On success it returns the
 * span to store, the sentence the quote starts in and the n2 fact id of that sentence. A span that touches a quoted
 * (`>`) line, its first line or any later one, is refused, so an old ask quoted in a reply never grounds a new fact; so are message text over 200,000 code
 * points and a sentence with no letter or digit.
 */
export function groundQuote(input: GroundQuoteInput): GroundingResult {
  if (typeof input.quote !== "string" || input.quote.trim().length === 0) return { ok: false, reason: "empty_quote" };
  if (input.content === null) return { ok: false, reason: "no_content" };
  if (input.content.length > MAX_CONTENT_CODE_POINTS && Array.from(input.content).length > MAX_CONTENT_CODE_POINTS)
    return { ok: false, reason: "content_too_long" };
  if (Array.from(input.quote).length > QUOTE_SEARCH_LIMIT) return { ok: false, reason: "too_long" };
  const found = searchEvidence(input.content, input.quote);
  if (found.state === "empty") return { ok: false, reason: "empty_quote" };
  if (found.state === "absent") return { ok: false, reason: "not_found" };
  if (found.state === "ambiguous") return { ok: false, reason: "ambiguous" };
  if (found.span.end - found.span.start > MAX_QUOTE_CODE_POINTS) return { ok: false, reason: "too_long" };
  if (touchesQuotedLine(input.content, found.span.start, found.span.end)) return { ok: false, reason: "quoted_text" };
  const sentence = sentenceAt(input.content, found.span.start);
  // The quote starts on a non-space code point, which always lies inside a unit; a missing one would be a splitter bug.
  if (sentence === null) return { ok: false, reason: "not_found" };
  // A sentence of emoji or punctuation alone would hash to the same id as any other such sentence in the thread.
  if (!/[\p{L}\p{N}]/u.test(stripQuoteMarkers(sentence.text))) return { ok: false, reason: "no_text" };
  return {
    ok: true,
    span: found.span,
    sentence,
    factId: factIdN2({ conversationKey: input.conversationKey, sentence: sentence.text, icsUid: input.icsUid })
  };
}

/** Whether any line the span [start, end) touches starts with a `>` quote marker (after spaces or tabs). */
function touchesQuotedLine(content: string, start: number, end: number): boolean {
  const points = Array.from(content);
  const quoted = (lineStart: number) => {
    let i = lineStart;
    while (points[i] === " " || points[i] === "\t") i++;
    return points[i] === ">";
  };
  let first = start;
  while (first > 0 && points[first - 1] !== "\n") first--;
  if (quoted(first)) return true;
  for (let i = start; i < end; i++) if (points[i] === "\n" && quoted(i + 1)) return true;
  return false;
}

export interface GroundingTally {
  total: number;
  grounded: number;
  rejected: number;
  failures: Record<GroundingFailure, number>;
}

/** Counts a run's results for the tick result and the report's grounding-rejection rate. */
export function tallyGrounding(results: Iterable<GroundingResult>): GroundingTally {
  const tally: GroundingTally = {
    total: 0,
    grounded: 0,
    rejected: 0,
    failures: Object.fromEntries(GROUNDING_FAILURES.map((reason) => [reason, 0])) as Record<GroundingFailure, number>
  };
  for (const result of results) {
    tally.total++;
    if (result.ok) tally.grounded++;
    else {
      tally.rejected++;
      tally.failures[result.reason]++;
    }
  }
  return tally;
}
