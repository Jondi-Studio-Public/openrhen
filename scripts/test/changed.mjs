import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { readWorkspace } from "../ci/affected.mjs";

/**
 * The inner-loop test runner: run only the tests a change can actually reach.
 *
 * Vitest holds a real static module graph for every test file, so `vitest related` runs every suite
 * whose transitive imports touch a given file, across package boundaries. That is a dependency fact
 * rather than a name-matching heuristic, which is why it is safe to trust between edits. How much it
 * saves depends entirely on how a package is imported: a portal change typically selects a handful of
 * its 285 files, while `engine/core` re-exports everything through `src/index.ts`, so almost every one
 * of its tests is related to almost every one of its modules and the subset is barely a subset.
 *
 * What a module graph cannot see is the whole reason this script is more than one vitest call:
 *
 *  - A migration changes behaviour no test file imports. Only the integration suites can catch it,
 *    and they take upwards of ten minutes, so this script refuses to imply it has covered one: it
 *    says so and exits non-zero. Green here would be a lie.
 *  - Fixtures, snapshots and CSV/XLSX inputs are read from disk, never imported.
 *  - Configs, manifests and the lockfile have a blast radius the graph does not model.
 *
 * The first case escalates to a demand for `test:integration`; the second and third escalate to the
 * full unit suite. Everything else subsets. None of it replaces the gate in AGENTS.md — subsetting
 * also cannot see a failure that only appears in whole-suite ordering.
 *
 * `TEST_CHANGED_FILES` (comma-separated, repo-relative) overrides detection, for asking "what would a
 * change to this file run?" without having to make the change.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const posix = (value) => value.split(sep).join("/");

/** Changes only a database can prove. There is no honest subset for these. */
const NEEDS_INTEGRATION = [/^platform\/database\/drizzle\//, /^platform\/database\/src\/schema\.ts$/];

/** Changes whose effect an import graph cannot model, so the full unit suite is the only safe answer. */
const NEEDS_FULL_UNIT = [
  /^platform\/contracts\//, // the shared schema every package validates against
  /\/vitest[.\w-]*\.config\.ts$/, // test scope and environment itself
  /(^|\/)tsconfig[.\w-]*\.json$/,
  /(^|\/)package\.json$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)pnpm-workspace\.yaml$/,
  /\.(json|csv|sql|xlsx)$/ // fixtures and snapshots: read from disk, never imported
];

/** Every workspace with a `test` script. */
const PACKAGES = [
  "platform/contracts",
  "platform/database",
  "engine/core",
  "engine/service",
  "engine/worker",
  "integrations/outbound-proxy",
  "tools/cli",
  "portal"
];
// A package a carved provider adds is found from the workspace, so the export, which ships none, lists only the
// packages above.
for (const workspacePackage of readWorkspace(root))
  if (workspacePackage.scripts.test && !PACKAGES.includes(workspacePackage.dir)) PACKAGES.push(workspacePackage.dir);

function baseRef() {
  const requested = process.argv[2];
  if (requested) return requested;
  // Prefer the merge-base so a whole session's commits count, not just what is still uncommitted.
  for (const candidate of ["origin/main", "main"]) {
    try {
      return git("merge-base", "HEAD", candidate);
    } catch {
      // Not fetched, or no such branch — fall through to the working tree alone.
    }
  }
  return "HEAD";
}

function changedFiles(base) {
  const override = process.env.TEST_CHANGED_FILES;
  if (override)
    return override
      .split(",")
      .map((file) => posix(file.trim()))
      .filter(Boolean);
  const seen = new Set();
  const collect = (output) => {
    for (const line of output.split("\n")) if (line.trim()) seen.add(posix(line.trim()));
  };
  // The working tree against the base covers committed and uncommitted alike; untracked files appear
  // in no diff at all, so they are asked for separately — a brand new module is exactly the kind of
  // change a subset must not miss.
  if (base !== "HEAD") collect(git("diff", "--name-only", base));
  collect(git("diff", "--name-only"));
  collect(git("diff", "--name-only", "--cached"));
  collect(git("ls-files", "--others", "--exclude-standard"));
  return [...seen].filter((file) => existsSync(resolve(root, file)));
}

const listed = (files) => files.slice(0, 3).join(", ") + (files.length > 3 ? ", …" : "");

const base = process.env.TEST_CHANGED_FILES ? "TEST_CHANGED_FILES" : baseRef();
const changed = changedFiles(base);
if (changed.length === 0) {
  console.log(`test:changed — nothing changed against ${base}; nothing to run.`);
  process.exit(0);
}

const integrationOnly = changed.filter((file) => NEEDS_INTEGRATION.some((pattern) => pattern.test(file)));
const fullUnit = changed.filter((file) => NEEDS_FULL_UNIT.some((pattern) => pattern.test(file)));
let failed = false;

if (fullUnit.length > 0 || integrationOnly.length > 0) {
  console.log(
    `test:changed — ${listed([...fullUnit, ...integrationOnly])} reach past the import graph; full unit suite.`
  );
  try {
    execFileSync("pnpm", ["-r", "--if-present", "run", "test"], { cwd: root, stdio: "inherit", shell: true });
  } catch {
    failed = true;
  }
} else {
  const sources = changed.filter((file) => /\.(ts|tsx|mjs)$/.test(file));
  if (sources.length === 0) {
    console.log(`test:changed — no source changes against ${base}; nothing to run.`);
    process.exit(0);
  }
  console.log(`test:changed — ${sources.length} changed source file(s) against ${base}.`);
  // Every package is asked; none is guessed at. Selecting packages from a hand-maintained dependency
  // map would be faster still, and would be the one place this script could silently under-test — so
  // the packages with nothing to run are made cheap rather than skipped. Each pays only a vitest
  // startup, and paying ten of those at once costs about what paying one costs.
  const results = await Promise.all(
    PACKAGES.map((pkg) => {
      const cwd = resolve(root, pkg);
      const config = ["vitest.unit.config.ts", "vitest.config.ts"].find((name) => existsSync(resolve(cwd, name)));
      // `related` is vitest 4's own command for this; `--run` keeps it out of watch mode.
      const args = ["exec", "vitest", "related", "--run", "--passWithNoTests"];
      if (config) args.push("--config", config);
      args.push(...sources.map((file) => relative(cwd, resolve(root, file))));
      return new Promise((settle) => {
        const child = spawn("pnpm", args, { cwd, shell: true });
        let output = "";
        child.stdout.on("data", (chunk) => (output += chunk));
        child.stderr.on("data", (chunk) => (output += chunk));
        child.on("close", (code) => settle({ pkg, code, output }));
      });
    })
  );
  let silent = 0;
  for (const result of results) {
    // A package with nothing related says so, and is not worth a screenful.
    if (result.code === 0 && result.output.includes("No test files found")) {
      silent += 1;
      continue;
    }
    console.log(`\n--- ${result.pkg}`);
    console.log(result.output.trimEnd());
    if (result.code !== 0) failed = true;
  }
  if (silent > 0) console.log(`\n${silent} package(s) had no related tests.`);
}

if (integrationOnly.length > 0) {
  // Deliberately not run here: the integration suites take upwards of ten minutes, which is not an
  // inner loop. Exiting non-zero is the point — a schema change that reports green from a suite that
  // never opened a database is worse than no signal at all.
  console.error(
    `\ntest:changed — ${listed(integrationOnly)} changed. No unit test can prove a schema change; ` +
      `run \`corepack pnpm test:integration\` before calling this work done.`
  );
  process.exit(2);
}
process.exit(failed ? 1 : 0);
