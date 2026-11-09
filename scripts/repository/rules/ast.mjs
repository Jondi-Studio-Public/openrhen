// The one TypeScript-aware parser every AST structure rule uses. openrhen pins typescript 7 (the native port), which
// ships no classic JS compiler API, so rules parse with oxc-parser (the parser rolldown already uses), pinned in the
// root package.json. Rules import `parse` from here and never import the parser themselves, so a parser change later
// is a change to this file only.
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { parseSync } from "oxc-parser";

const LANGS = {
  ".ts": "ts",
  ".mts": "ts",
  ".cts": "ts",
  ".tsx": "tsx",
  ".js": "js",
  ".mjs": "js",
  ".cjs": "js",
  ".jsx": "jsx"
};

// parse(file, source?) -> { file, source, body, errors, comments }. `body` is the top-level statement list
// (ESTree-shaped nodes with `start`/`end` offsets). `source` may be passed to parse text that is not on disk.
// A file that does not parse throws, naming the file and the first error, so a rule never silently skips it.
export function parse(file, source) {
  const lang = LANGS[extname(file)];
  if (!lang) {
    throw new Error(
      `ast.mjs cannot parse ${file}: extension ${extname(file) || "(none)"} is not one of ${Object.keys(LANGS).join(", ")}.`
    );
  }
  const text = source ?? readFileSync(file, "utf8");
  const result = parseSync(file, text, { lang, sourceType: "module" });
  if (result.errors.length > 0) {
    throw new Error(
      `ast.mjs could not parse ${file}: ${result.errors[0].message}. Fix the syntax error, or exclude the file from the rule.`
    );
  }
  return { file, source: text, body: result.program.body, errors: result.errors, comments: result.comments ?? [] };
}

// 1-based line of a node's start offset in `source`.
export function lineOf(source, node) {
  let line = 1;
  for (let i = 0; i < node.start; i += 1) if (source.charCodeAt(i) === 10) line += 1;
  return line;
}

// Depth-first walk over every node under `node`; visit(node, parent) may return false to skip a node's children.
export function walk(node, visit, parent = null) {
  if (!node || typeof node.type !== "string") return;
  if (visit(node, parent) === false) return;
  for (const key of Object.keys(node)) {
    if (key === "type" || key === "start" || key === "end") continue;
    const value = node[key];
    if (Array.isArray(value)) for (const child of value) walk(child, visit, node);
    else if (value && typeof value === "object") walk(value, visit, node);
  }
}
