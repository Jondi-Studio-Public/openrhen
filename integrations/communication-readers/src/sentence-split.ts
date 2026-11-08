/**
 * The sentence splitter whose version is part of every n2 fact id. Frozen like the normaliser: the golden vectors in
 * fact-id-n2.test.ts pin its output, and changing a rule means a new version string (`s2`) and new vectors, never an
 * edit of this one, because a unit that moves changes the fact id of every stored fact in it and orphans its statuses,
 * overrides and labels.
 */
export const SPLITTER_VERSION = "s1";
/** A unit is at most this many code points; a longer one is cut at the nearest whitespace at or before the limit. */
export const MAX_SENTENCE_CODE_POINTS = 400;

export interface SentenceUnit {
  /** Offsets in Unicode code points into the content, end exclusive, with no leading or trailing whitespace. */
  start: number;
  end: number;
  text: string;
}

const WHITESPACE = /^\s$/u;
const TERMINATORS = new Set([".", "!", "?", "…"]);
/** Full stops that need no whitespace after them to end a sentence. */
const CJK_TERMINATORS = new Set(["。", "！", "？"]);
const CLOSERS = new Set(['"', "'", ")", "]", "}", "»", "”", "’", "」", "』", "）"]);
const ABBREVIATIONS = new Set([
  "mr",
  "mrs",
  "ms",
  "dr",
  "prof",
  "sr",
  "jr",
  "st",
  "vs",
  "no",
  "fig",
  "approx",
  "inc",
  "ltd",
  "co",
  "cf",
  "e.g",
  "i.e"
]);

const isSpace = (point: string | undefined) => point !== undefined && WHITESPACE.test(point);

/** The word ending just before index `dot`: the run of non-space code points, without leading brackets or quotes. */
function wordBefore(points: readonly string[], dot: number): string {
  let from = dot;
  while (from > 0 && !isSpace(points[from - 1])) from--;
  return points
    .slice(from, dot)
    .join("")
    .replace(/^[("'[“‘]+/u, "")
    .toLowerCase();
}

/** True when the word before a lone full stop means the stop does not end the sentence. */
function stopIsNotAnEnd(points: readonly string[], dot: number, unitStart: number): boolean {
  const word = wordBefore(points, dot);
  if (ABBREVIATIONS.has(word)) return true;
  if (/^\p{L}$/u.test(word)) return true;
  // A dotted initialism such as U.S.A. (its final stop included): "u.s.a" before the stop.
  if (/^(?:\p{L}\.)+\p{L}$/u.test(word)) return true;
  // "1." at the start of a unit is a list number.
  return /^\d{1,3}$/u.test(word) && points.slice(unitStart, dot).join("").trim() === word;
}

/** Whether the line starting at `index` (just after a newline) begins with a bullet or a list number. */
function startsBullet(points: readonly string[], index: number): boolean {
  let i = index;
  while (i < points.length && (points[i] === " " || points[i] === "\t")) i++;
  const first = points[i];
  if (first !== undefined && "-*•·".includes(first)) return isSpace(points[i + 1]);
  let digits = 0;
  while (/^\d$/u.test(points[i + digits] ?? "")) digits++;
  return (
    digits >= 1 &&
    digits <= 3 &&
    (points[i + digits] === "." || points[i + digits] === ")") &&
    isSpace(points[i + digits + 1])
  );
}

const startsQuote = (points: readonly string[], index: number): boolean => {
  let i = index;
  while (i < points.length && (points[i] === " " || points[i] === "\t")) i++;
  return points[i] === ">";
};

/** The ends (exclusive, in code points) of the raw segments the rules cut the content into, before trimming and capping. */
function segmentEnds(points: readonly string[]): number[] {
  const ends: number[] = [];
  let unitStart = 0;
  let i = 0;
  while (i < points.length) {
    const point = points[i]!;
    if (isSpace(point)) {
      let j = i;
      let newlines = 0;
      let lastNewline = -1;
      while (j < points.length && isSpace(points[j])) {
        if (points[j] === "\n") {
          newlines++;
          lastNewline = j;
        }
        j++;
      }
      const afterLine = lastNewline + 1;
      const quoteChange = newlines > 0 && j < points.length && startsQuote(points, afterLine) !== inQuote(points, i);
      if (newlines >= 2 || (newlines === 1 && (startsBullet(points, afterLine) || quoteChange))) {
        ends.push(i);
        unitStart = j;
      }
      i = j;
      continue;
    }
    if (TERMINATORS.has(point) || CJK_TERMINATORS.has(point)) {
      let j = i;
      while (j < points.length && (TERMINATORS.has(points[j]!) || CJK_TERMINATORS.has(points[j]!))) j++;
      const stops = j;
      while (j < points.length && CLOSERS.has(points[j]!)) j++;
      const cjk = CJK_TERMINATORS.has(points[stops - 1]!);
      const atBoundary = j >= points.length || isSpace(points[j]) || cjk;
      const lone = stops - i === 1 && point === ".";
      if (atBoundary && !(lone && j === stops && stopIsNotAnEnd(points, i, unitStart))) {
        ends.push(j);
        unitStart = j;
      }
      i = j;
      continue;
    }
    i++;
  }
  ends.push(points.length);
  return ends;
}

/** Whether the line that ends at `index` (a whitespace run start) began with a quote marker. */
function inQuote(points: readonly string[], index: number): boolean {
  let i = index;
  while (i > 0 && points[i - 1] !== "\n") i--;
  return startsQuote(points, i);
}

/** Cuts [start, end) into units of at most the cap, each at the nearest whitespace at or before the limit. */
function capUnit(points: readonly string[], start: number, end: number, out: SentenceUnit[]): void {
  let from = start;
  while (from < end) {
    let to = end;
    if (to - from > MAX_SENTENCE_CODE_POINTS) {
      to = from + MAX_SENTENCE_CODE_POINTS;
      let cut = to;
      while (cut > from && !isSpace(points[cut])) cut--;
      if (cut > from) to = cut;
    }
    let a = from;
    let b = to;
    while (a < b && isSpace(points[a])) a++;
    while (b > a && isSpace(points[b - 1])) b--;
    if (b > a) out.push({ start: a, end: b, text: points.slice(a, b).join("") });
    from = to;
  }
}

/**
 * Splits message text into sentence units (splitter `s1`). A unit ends after a run of `. ! ? …` (and closing quotes or
 * brackets) followed by whitespace or the end, or after `。！？`; a lone full stop after an abbreviation, an initial or a
 * leading list number does not end one. A blank line, a newline before a bullet or a numbered line, and a newline where
 * `>` quoting starts or stops also end one; a single newline does not, because mail is hard-wrapped. Units are trimmed and
 * capped at 400 code points. Offsets are code points, as in the evidence span. A dotted initialism (U.S.A.) does not end a
 * sentence even when it is the last word of one, so such a sentence runs into the next: a known, stable trade-off.
 */
export function splitSentences(content: string): SentenceUnit[] {
  const points = Array.from(content);
  const units: SentenceUnit[] = [];
  let from = 0;
  for (const end of segmentEnds(points)) {
    capUnit(points, from, end, units);
    from = end;
  }
  return units;
}

/** The unit that contains the code point at `offset`, or null in the whitespace between units or outside the content. */
export function sentenceAt(content: string, offset: number): SentenceUnit | null {
  return splitSentences(content).find((unit) => offset >= unit.start && offset < unit.end) ?? null;
}
