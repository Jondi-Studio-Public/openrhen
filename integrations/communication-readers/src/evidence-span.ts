import { createHash } from "node:crypto";

/** Hex characters kept of the content sha256. Short, so a stored span cannot confirm a guessed short message. */
export const EVIDENCE_HASH_HEX_CHARS = 12;

export interface EvidenceSpan {
  /** Offsets in Unicode code points into the stored content, end exclusive. */
  start: number;
  end: number;
  /** Truncated sha256 of the whole content the span was found in, to notice that the content later changed. */
  hash: string;
}

const contentHash = (content: string) =>
  createHash("sha256").update(content).digest("hex").slice(0, EVIDENCE_HASH_HEX_CHARS);

interface Folded {
  chars: string[];
  /** For each folded character, the original code-point index where it starts and the index just after it ends. */
  starts: number[];
  ends: number[];
}

/** Folds each whitespace run to one space, keeping a map back to the original code points. */
function fold(codePoints: readonly string[]): Folded {
  const folded: Folded = { chars: [], starts: [], ends: [] };
  for (let i = 0; i < codePoints.length;) {
    if (/^\s$/u.test(codePoints[i]!)) {
      let j = i + 1;
      while (j < codePoints.length && /^\s$/u.test(codePoints[j]!)) j++;
      folded.chars.push(" ");
      folded.starts.push(i);
      folded.ends.push(j);
      i = j;
    } else {
      folded.chars.push(codePoints[i]!);
      folded.starts.push(i);
      folded.ends.push(i + 1);
      i++;
    }
  }
  return folded;
}

export type EvidenceSearch =
  { state: "found"; span: EvidenceSpan } | { state: "empty" } | { state: "absent" } | { state: "ambiguous" };

/**
 * `locateEvidence` with the reason it found nothing: `empty` (no quote), `absent` (not in the content) or `ambiguous`
 * (more than one occurrence, overlaps counted), so a caller can count the three apart.
 */
export function searchEvidence(content: string, quote: string): EvidenceSearch {
  const needle = fold(Array.from(quote.trim())).chars;
  if (needle.length === 0) return { state: "empty" };
  const haystack = fold(Array.from(content));
  let found = -1;
  for (let i = 0; i + needle.length <= haystack.chars.length; i++) {
    let match = true;
    for (let k = 0; k < needle.length; k++)
      if (haystack.chars[i + k] !== needle[k]) {
        match = false;
        break;
      }
    if (!match) continue;
    if (found !== -1) return { state: "ambiguous" };
    found = i;
  }
  if (found === -1) return { state: "absent" };
  return {
    state: "found",
    span: { start: haystack.starts[found]!, end: haystack.ends[found + needle.length - 1]!, hash: contentHash(content) }
  };
}

/**
 * Finds `quote` (a verbatim quote, matched after folding whitespace, case sensitive) in `content`. Returns its span in
 * code points plus the truncated content hash, or null when the quote is empty, absent or occurs more than once
 * (overlaps count): the caller sends those to review rather than guessing which occurrence was meant.
 */
export function locateEvidence(content: string, quote: string): EvidenceSpan | null {
  const result = searchEvidence(content, quote);
  return result.state === "found" ? result.span : null;
}

export type ResolvedEvidence =
  { state: "ok"; text: string } | { state: "source_removed" } | { state: "source_changed" };

/**
 * The text a stored span points at, resolved at read. Null content (the source's text was removed or never stored)
 * resolves to `source_removed`; content whose hash no longer matches resolves to `source_changed`. The caller must show
 * the text as untrusted third-party text.
 */
export function resolveEvidence(content: string | null, span: EvidenceSpan): ResolvedEvidence {
  if (content === null) return { state: "source_removed" };
  if (contentHash(content) !== span.hash) return { state: "source_changed" };
  const points = Array.from(content);
  if (span.start < 0 || span.end > points.length || span.start >= span.end) return { state: "source_changed" };
  return { state: "ok", text: points.slice(span.start, span.end).join("") };
}
