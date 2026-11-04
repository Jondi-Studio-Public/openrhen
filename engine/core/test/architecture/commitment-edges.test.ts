import { describe, expect, it } from "vitest";

/**
 * `@types/node` is not a dependency of this package (only the packages that already needed Node
 * builtins carry it, and adding it here would touch the lockfile, out of this task's scope). A
 * plain `import … from "node:fs"` needs those ambient types even to name the module, so the three
 * builtins this file needs are loaded through a non-literal dynamic `import()` instead — TypeScript
 * cannot look up a dynamic import's module against its known-builtins list when the specifier isn't a
 * string literal, so it falls back to `Promise<any>`, and the cast below gives back just the shapes
 * used here.
 */
interface DirEntry {
  name: string;
  isDirectory(): boolean;
}
interface FsModule {
  readdirSync(path: string, options: { withFileTypes: true }): DirEntry[];
  readFileSync(path: string, encoding: "utf8"): string;
}
interface PathModule {
  join(...paths: string[]): string;
  relative(from: string, to: string): string;
  resolve(...paths: string[]): string;
  dirname(path: string): string;
}
interface UrlModule {
  fileURLToPath(url: string): string;
}

const nodeModule = <T>(specifier: string): Promise<T> => import(specifier) as Promise<T>;
const fs = await nodeModule<FsModule>("node:fs");
const path = await nodeModule<PathModule>("node:path");
const url = await nodeModule<UrlModule>("node:url");

/**
 * Resolved from this test file, never the repo root: an agent worktree may hold stale copies of the
 * repo elsewhere on disk, and a root-relative resolution would happily scan those too.
 */
const src = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "../../src");

/**
 * The one file allowed to compute with these fields — everywhere else reads its answer instead. See
 * The commitment timeline design note, "The timeline" and "Consumers that change (engine)".
 */
const EXEMPT_FILE = "model/commitment-timeline.ts";

const FIELDS = [
  "setupBeforeMinutes",
  "transitionAfterMinutes",
  "travelBeforeMinutes",
  "travelAfterMinutes",
  "trackedEndedAt"
];

/**
 * Matches one of the five fields taking part in arithmetic: a binary `+ - * /` against an adjacent
 * token, `?? 0) *` style coalesce-then-multiply, or `.getTime() +`/`.getTime() -` chained off it.
 * Deliberately loose (a false positive just needs a copy-shaped rewrite; a false negative would let
 * the edges drift again, which is what this test exists to catch) rather than a full parser.
 */
function arithmeticPattern(field: string): RegExp {
  const f = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    // field (optionally through `?.` / `!`) followed by optional `?? <num>)`* then an arithmetic operator,
    // or an arithmetic operator followed by the field, or `.getTime()` immediately after the field then +/-.
    `(?:${f})\\s*(?:\\?\\.[A-Za-z0-9_]+)?\\s*(?:\\?\\?\\s*[^)]*\\))?\\s*(?:\\.getTime\\(\\))?\\s*[-+*/]` +
      `|[-+*/]\\s*(?:[A-Za-z0-9_.]+\\.)?(?:${f})\\b`,
    "g"
  );
}

/**
 * Strips `//` line comments and `/* … *‍/` block comments so a JSDoc mention never false-positives,
 * replacing each stripped character with a space (never removing a newline) so every match's line
 * number still lands on the real source line.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/\/\/.*$/gm, (line) => line.replace(/[^\n]/g, " "));
}

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(entryPath);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [entryPath] : [];
  });
}

/** Line number (1-based) of the first character index in `text`. */
function lineOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

describe("commitment edges stay in one place", () => {
  it("fails a self-test on inline arithmetic vs. copy samples before scanning the real tree", () => {
    const arithmeticSample =
      "const freeAt = commitment.endsAt.getTime() + (commitment.transitionAfterMinutes ?? 0) * MINUTE;";
    const copySample =
      "const step = { transitionAfterMinutes: item.transitionAfterMinutes, tracked: item.trackedEndedAt };";
    const roundSample = "travelBeforeMinutes: Math.round(before.minutes)";
    const truthySample = "if (commitment.travelBeforeMinutes) return true;";

    const hitsArithmetic = FIELDS.some((field) => arithmeticPattern(field).test(stripComments(arithmeticSample)));
    const hitsCopy = FIELDS.some((field) => arithmeticPattern(field).test(stripComments(copySample)));
    const hitsRound = FIELDS.some((field) => arithmeticPattern(field).test(stripComments(roundSample)));
    const hitsTruthy = FIELDS.some((field) => arithmeticPattern(field).test(stripComments(truthySample)));

    expect(hitsArithmetic).toBe(true);
    expect(hitsCopy).toBe(false);
    expect(hitsRound).toBe(false);
    expect(hitsTruthy).toBe(false);
  });

  it("finds no arithmetic on setupBeforeMinutes, transitionAfterMinutes, travelBeforeMinutes, travelAfterMinutes or trackedEndedAt outside commitment-timeline.ts", () => {
    const errors: string[] = [];
    for (const file of sourceFiles(src)) {
      const relPath = path.relative(src, file).replaceAll("\\", "/");
      if (relPath === EXEMPT_FILE) continue;
      const raw = fs.readFileSync(file, "utf8");
      const text = stripComments(raw);
      for (const field of FIELDS) {
        const pattern = arithmeticPattern(field);
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(text))) {
          errors.push(`${relPath}:${lineOf(text, match.index)} — arithmetic on \`${field}\`: \`${match[0].trim()}\``);
        }
      }
    }
    expect(errors).toEqual([]);
  });
});
