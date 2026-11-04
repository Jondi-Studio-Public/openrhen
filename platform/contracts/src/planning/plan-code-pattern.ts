/**
 * The reference-code pattern (course or unit codes) the plan map links by. It is a stored JavaScript regular
 * expression, so it is checked before it is saved and again before it is compiled: a stored pattern that fails is
 * treated as no pattern, never as an error in the planner.
 */

export const PLAN_CODE_PATTERN_MAX_LENGTH = 200;

/** Only the first part of a title is searched, so a long title cannot stall the planner. */
const SEARCH_LIMIT = 2_000;

/** Whether a `)` outside a character class is followed by a quantifier. Escaped characters are skipped. */
function hasQuantifiedGroup(source: string): boolean {
  let inClass = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]!;
    if (char === "\\") {
      i += 1;
      continue;
    }
    if (inClass) {
      if (char === "]") inClass = false;
      continue;
    }
    if (char === "[") inClass = true;
    else if (char === ")" && /[*+?{]/.test(source[i + 1] ?? "")) return true;
  }
  return false;
}

/** A plain sentence saying why the pattern cannot be used, or null when it is fine. */
export function planCodePatternProblem(source: string): string | null {
  const text = source.trim();
  const basic = "The code pattern must be a JavaScript regular expression of at most 200 characters.";
  if (text === "" || text.length > PLAN_CODE_PATTERN_MAX_LENGTH) return basic;
  let regex: RegExp;
  try {
    regex = new RegExp(text, "g");
  } catch {
    return basic;
  }
  if (/\\[1-9]|\\k</.test(text) || hasQuantifiedGroup(text)) {
    return "The code pattern cannot repeat a group or refer back to one, so a long title cannot stall the planner.";
  }
  if (new RegExp(regex.source, "g").test("")) return "The code pattern must not match empty text.";
  return null;
}

const compiled = new Map<string, RegExp | null>();

/** The pattern as a global regular expression, or null for none or any problem. */
export function compilePlanCodePattern(source: string | null | undefined): RegExp | null {
  if (source === null || source === undefined || source.trim() === "") return null;
  const cached = compiled.get(source);
  if (cached !== undefined) return cached;
  const result = planCodePatternProblem(source) === null ? new RegExp(source.trim(), "g") : null;
  compiled.set(source, result);
  return result;
}

/** The distinct codes in the first 2,000 characters of the text; none when there is no pattern. */
export function codesIn(text: string, source: string | null | undefined): string[] {
  const pattern = compilePlanCodePattern(source);
  if (!pattern) return [];
  const found = new Set<string>();
  for (const match of text.slice(0, SEARCH_LIMIT).matchAll(new RegExp(pattern.source, "g"))) found.add(match[0]);
  return [...found];
}
