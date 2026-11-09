import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const checker = resolve(dirname(fileURLToPath(import.meta.url)), "../docs/check.mjs");

// Runs the docs checker against a throwaway tree holding one behaviour contract and a few test files, and returns
// only the proof-path complaints (the tree is too small to satisfy the other checks).
function proofProblems(contract) {
  const root = mkdtempSync(join(tmpdir(), "docs-proofs-"));
  try {
    mkdirSync(join(root, "scripts/docs"), { recursive: true });
    cpSync(checker, join(root, "scripts/docs/check.mjs"));
    mkdirSync(join(root, "docs/product"), { recursive: true });
    writeFileSync(join(root, "docs/product/behaviour-contract.md"), contract);
    mkdirSync(join(root, "engine/core/test/recurrence"), { recursive: true });
    writeFileSync(join(root, "engine/core/test/recurrence/stretch.test.ts"), "");
    mkdirSync(join(root, "node_modules/x"), { recursive: true });
    writeFileSync(join(root, "node_modules/x/ignored.test.ts"), "");
    const run = spawnSync(process.execPath, [join(root, "scripts/docs/check.mjs")], { encoding: "utf8" });
    return run.stderr.split("\n").filter((line) => line.includes("cites a test file"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("a bare test name resolves to a file of that name anywhere in the source trees", () => {
  assert.deepEqual(proofProblems("| `AT-A` | x | `stretch.test.ts` |\n"), []);
});

test("a path resolves from the repository root", () => {
  assert.deepEqual(proofProblems("| `AT-A` | x | `engine/core/test/recurrence/stretch.test.ts` |\n"), []);
});

test("a missing bare name, a missing path and a file under node_modules are all reported", () => {
  const problems = proofProblems("| `AT-A` | x | `nope.test.ts`, `engine/nope.test.ts`, `ignored.test.ts` |\n");
  assert.equal(problems.length, 3);
});
