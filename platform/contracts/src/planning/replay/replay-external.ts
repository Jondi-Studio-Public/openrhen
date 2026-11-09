import { parseReplayCase, type ReplayCase } from "./replay-case.js";

/**
 * Cases kept outside git (for example reviewed real cases) use the same format as the golden file:
 * each file holds one case object or an array of them. Reading the directory is the caller's job
 * (`scripts/test/replay-case-files.mjs`), because contracts has no filesystem; this parses what it
 * read. With no files there are no cases, so an absent directory costs nothing.
 */
export interface CaseFile {
  name: string;
  text: string;
}

export function parseExternalCases(files: readonly CaseFile[]): ReplayCase[] {
  const cases = [...files]
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap(({ name, text }) => {
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        throw new Error(`external replay case file ${name} is not JSON`);
      }
      return (Array.isArray(raw) ? raw : [raw]).map(parseReplayCase);
    });
  const ids = new Set<string>();
  for (const c of cases) {
    if (ids.has(c.id)) throw new Error(`duplicate external case id ${c.id}`);
    ids.add(c.id);
  }
  return cases;
}
