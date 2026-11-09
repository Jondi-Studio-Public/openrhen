/**
 * The privacy guard for committed replay fixtures. A fixture may carry only neutral vocabulary: a
 * pasted real message must fail here before it can merge. Pure; the test feeds it the fixture files.
 */

const ADDRESS = /[^\s@<>"',;]+@[^\s@<>"',;]+/g;
const EXAMPLE_ADDRESS = /^[a-z0-9._+-]+@example\.test$/;

/** Fields whose words must come from the lexicon. */
const WORD_FIELDS = new Set(["title", "quote", "name", "remoteTitleNorm", "localTitleNorm"]);

/** Author's commentary on a case: free prose, so it is held to a length cap (and the address and secret checks) instead. */
const NOTE_FIELDS = new Set(["note"]);
export const NOTE_MAX = 200;

/**
 * Every other string must look like a token (an id, a timestamp, an address, a timezone or an enum
 * value). The guard is fail-closed: a new field that carries prose is flagged until it is added to
 * `WORD_FIELDS`, so a free-text field cannot slip past by not being on a list.
 */
const TOKEN_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:@+/-]*$/;

/** Patterns of key- and token-shaped strings, built from parts so this file holds no token-shaped literal. */
const SECRET_PATTERNS: readonly RegExp[] = [
  new RegExp(["-----BEGIN", "[A-Z ]*PRIVATE KEY-----"].join(" ")),
  new RegExp(["\\b(?:sk|pk|rk)", "[-_][A-Za-z0-9_-]{16,}"].join("")),
  new RegExp(["\\b(?:AKIA|ASIA)", "[0-9A-Z]{16}\\b"].join("")),
  new RegExp(["\\b(?:ghp|gho|ghs|ghu)", "_[A-Za-z0-9]{20,}"].join("")),
  new RegExp(["\\beyJ[A-Za-z0-9_-]{10,}", "\\.[A-Za-z0-9_-]{10,}"].join("")),
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/i,
  /\b[A-Fa-f0-9]{32,}\b/,
  /\b[A-Za-z0-9+/_-]{40,}={0,2}(?![A-Za-z0-9])/
];

export interface Lexicon {
  words: readonly string[];
}

function visit(
  value: unknown,
  path: string,
  key: string | null,
  out: (path: string, key: string | null, text: string) => void
) {
  if (typeof value === "string") out(path, key, value);
  else if (Array.isArray(value)) value.forEach((item, i) => visit(item, `${path}[${i}]`, key, out));
  else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) visit(v, `${path}.${k}`, k, out);
  }
}

/** Everything wrong with a fixture value: words outside the lexicon, real addresses, secret-shaped text. */
export function fixtureProblems(fixture: unknown, lexicon: Lexicon, name = "fixture"): string[] {
  const known = new Set(lexicon.words);
  const problems: string[] = [];
  visit(fixture, name, null, (path, key, text) => {
    for (const address of text.match(ADDRESS) ?? []) {
      if (!EXAMPLE_ADDRESS.test(address)) problems.push(`${path}: address outside example.test`);
    }
    if (SECRET_PATTERNS.some((pattern) => pattern.test(text))) problems.push(`${path}: secret-shaped text`);
    if (key !== null && WORD_FIELDS.has(key)) {
      for (const word of text.toLowerCase().match(/\p{L}+/gu) ?? []) {
        if (!known.has(word)) problems.push(`${path}: word "${word}" is not in the lexicon`);
      }
    } else if (key !== null && NOTE_FIELDS.has(key)) {
      if (text.length > NOTE_MAX) problems.push(`${path}: note longer than ${NOTE_MAX} characters`);
    } else if (!TOKEN_VALUE.test(text)) {
      problems.push(`${path}: free text in a field the guard does not read`);
    }
  });
  return problems;
}
