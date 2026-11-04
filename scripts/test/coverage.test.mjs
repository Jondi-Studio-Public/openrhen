import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEST_FILE, commands, coveredFiles, filesFor, testFiles, uncovered } from "./coverage.mjs";

test("splits a script into commands and unquotes globs", () => {
  assert.deepEqual(commands('vitest run --exclude test/a.test.ts && node --test "scripts/x/*.test.mjs"'), [
    ["vitest", "run", "--exclude", "test/a.test.ts"],
    ["node", "--test", "scripts/x/*.test.mjs"]
  ]);
});

test("counts .test and .spec files in every extension, and nothing else", () => {
  for (const file of ["a.test.ts", "a.test.tsx", "a.spec.js", "a.test.mjs", "a.integration.test.ts"])
    assert.ok(TEST_FILE.test(file), file);
  for (const file of ["a.ts", "test.ts", "a.test-helper.ts", "a.test.json"]) assert.ok(!TEST_FILE.test(file), file);
});

test("lists untracked test files, and not tracked ones deleted or renamed before staging", () => {
  const repo = mkdtempSync(join(tmpdir(), "coverage-"));
  try {
    const git = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo });
    git("init", "-q");
    writeFileSync(join(repo, "gone.test.ts"), "");
    writeFileSync(join(repo, "old.test.ts"), "");
    git("add", ".");
    git("commit", "-qm", "init");
    rmSync(join(repo, "gone.test.ts"));
    rmSync(join(repo, "old.test.ts"));
    writeFileSync(join(repo, "new.test.ts"), "");
    assert.deepEqual(testFiles(repo), ["new.test.ts"]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("commands that are not test runners run no files", () => {
  assert.equal(filesFor(["tsc", "-p", "."], "portal"), undefined);
});

test("a bare node --test takes node's default *.test.js files", () => {
  assert.deepEqual(filesFor(["node", "--test"], "integrations/openclaw-plugin"), [
    "integrations/openclaw-plugin/agent-time.test.js",
    "integrations/openclaw-plugin/no-personal-values.test.js",
    "integrations/openclaw-plugin/pack.test.js",
    "integrations/openclaw-plugin/stamp-url.test.js"
  ]);
});

test("node --test globs resolve from the package directory", () => {
  assert.ok(filesFor(["node", "--test", "scripts/test/*.test.mjs"], ".").includes("scripts/test/coverage.test.mjs"));
});

// The real repository, so a vitest config that narrows its include fails here as well as in `pnpm check`.
test("every vitest suite CI runs is asked, including file filters and excludes", () => {
  const covered = coveredFiles();
  for (const file of [
    "portal/server/search/plan-search.test.ts", // once matched by no config
    "portal/server/agent-contract.integration.test.ts", // the integration config
    "engine/core/test/system/performance.test.ts", // only `test:performance` runs it
    "platform/contracts/src/agent-routes.test.ts", // a package with no vitest of its own (hoisted)
    "scripts/backup/schedule.test.mjs", // the root's test:scripts
    "scripts/ci/affected.test.mjs" // only ci.yml's `node --test` step runs it
  ])
    // A file the export does not ship (scripts/ci/affected.test.mjs) is only asserted where it exists.
    if (existsSync(new URL(`../../${file}`, import.meta.url))) assert.ok(covered.has(file), file);
});

test("reports the files no suite covers, sorted", () => {
  assert.deepEqual(uncovered(["b.test.ts", "a.test.ts", "c.test.ts"], new Set(["c.test.ts"])), [
    "a.test.ts",
    "b.test.ts"
  ]);
});
