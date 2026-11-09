import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

/**
 * A match result with several equally good targets carries `tie: true` and still names the earliest in
 * `commitmentId` / `targetId`, so a reader of one id keeps compiling. This holds every non-test caller of the
 * matchers to reading `.tie` wherever it reads that id, so a tie can never be taken as a single answer.
 */
const ROOTS = ["platform", "portal", "integrations", "engine", "tools"];
const SKIP_DIRS = new Set(["node_modules", ".next", ".vinext", "dist", "build", "var", "coverage"]);
const MATCHER_CALL = /\b(matchCommitment|matchHandEntry|matchDeadline)\s*\(/;
const MATCHER_FILES = new Set(["source-match.ts", "deadline-match.ts"]);
const ID_READ = /\.(commitmentId|targetId)\b/;

export function violatesTieRule(name, text) {
  if (MATCHER_FILES.has(name)) return false;
  return MATCHER_CALL.test(text) && ID_READ.test(text) && !/\.tie\b/.test(text);
}

function* sources(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* sources(join(dir, entry.name));
    } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) {
      yield join(dir, entry.name);
    }
  }
}

test("every non-test reader of a match id also reads .tie", () => {
  const offenders = [];
  let callers = 0;
  for (const root of ROOTS) {
    for (const file of sources(root)) {
      const text = readFileSync(file, "utf8");
      const name = file.split("/").pop();
      if (!MATCHER_FILES.has(name) && MATCHER_CALL.test(text)) callers += 1;
      if (violatesTieRule(name, text)) offenders.push(file);
    }
  }
  assert.ok(callers >= 3, "the scan found the known callers");
  assert.deepEqual(offenders, []);
});

test("the rule flags a reader that takes the id without checking for a tie", () => {
  const bad = "const m = matchCommitment(a, b, []);\nreturn m.commitmentId;";
  const good = "const m = matchDeadline(a, b);\nif (m.tie) return null;\nreturn m.targetId;";
  assert.equal(violatesTieRule("reader.ts", bad), true);
  assert.equal(violatesTieRule("reader.ts", good), false);
  assert.equal(violatesTieRule("reader.ts", "const x = matchHandEntry(a, b);\nreturn x.kind;"), false);
});
