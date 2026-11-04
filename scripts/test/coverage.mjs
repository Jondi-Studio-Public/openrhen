import { execFileSync } from "node:child_process";
import { existsSync, globSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readWorkspace } from "../ci/affected.mjs";

/**
 * Fails when a test file in the repository is picked up by no suite CI runs.
 *
 * A vitest config's `include` decides which files a suite runs, and nothing complains about a file
 * it misses: the portal's unit config once listed server folders one by one, and tests in the
 * folders it left out sat unrun until someone noticed. This asks each suite which files it would
 * run, rather than re-implementing its globbing, so the answer cannot drift from the configs.
 *
 * A "suite CI runs" is one of these scripts, the ones the gate workflow and `pnpm check` call:
 * each workspace package's `test`, `test:integration` and `test:performance`, the root's
 * `test:scripts`, and any `run: node --test ...` step in `.github/workflows/` (the CI-runner-only
 * `scripts/ci` tests run that way, in the `changes` job, and stay out of the cross-platform
 * `pnpm check`). Each `vitest run ...` in them is replayed as `vitest list --filesOnly` with the
 * same arguments; each `node --test` takes its globs, or node's default `*.test.{js,mjs,cjs}` when
 * it names none.
 */
const root = resolve(fileURLToPath(import.meta.url), "../../..");
const posix = (value) => value.split(sep).join("/");

export const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
export const SUITE_SCRIPTS = ["test", "test:integration", "test:performance"];
const NODE_DEFAULT = /\.test\.[cm]?js$/;

/** Tracked and untracked (but not ignored) test files in the working tree, repo-relative. */
export function testFiles(directory = root) {
  return (
    execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
      cwd: directory,
      encoding: "utf8"
    })
      .split("\n")
      .filter((file) => TEST_FILE.test(file) && !file.split("/").includes("node_modules"))
      // The index still lists a file deleted or renamed but not yet staged; no suite can run it.
      .filter((file) => existsSync(join(directory, file)))
  );
}

/** The commands in a package script, split on `&&`, with their arguments. */
export function commands(script) {
  return script.split("&&").map((part) =>
    part
      .trim()
      .split(/\s+/)
      .map((arg) => arg.replace(/^"(.*)"$/, "$1"))
  );
}

/** Repo-relative files one command would run, or undefined when it runs no tests itself. */
export function filesFor(command, dir, directory = root) {
  const cwd = join(directory, dir);
  if (command[0] === "vitest" && command[1] === "run") {
    // The package's own vitest, resolved as node would from its directory (so a hoisted one is found
    // too) and run with this node: `node_modules/.bin/vitest` is a shell shim on Windows.
    const manifest = createRequire(join(cwd, "package.json")).resolve("vitest/package.json");
    const vitest = join(dirname(manifest), JSON.parse(readFileSync(manifest, "utf8")).bin.vitest);
    // Plain output, one path per line relative to the package. Not `--json`: it takes the next
    // argument as a file to write, so `--json test/x.test.ts` (a file filter, as in
    // `test:performance`) would overwrite that test.
    return execFileSync(process.execPath, [vitest, "list", "--filesOnly", ...command.slice(2)], {
      cwd,
      encoding: "utf8"
    })
      .split(/\r?\n/)
      .filter(Boolean)
      .map((file) => posix(relative(directory, resolve(cwd, file))));
  }
  if (command[0] === "node" && command.includes("--test")) {
    const globs = command.slice(1).filter((arg) => !arg.startsWith("-"));
    if (globs.length > 0)
      return globs.flatMap((pattern) => globSync(pattern, { cwd })).map((file) => posix(join(dir, file)));
    return globSync("**/*.{js,mjs,cjs}", { cwd, exclude: (name) => name === "node_modules" })
      .filter((file) => NODE_DEFAULT.test(file))
      .map((file) => posix(join(dir, file)));
  }
  return undefined;
}

/** The `node --test` commands workflow steps run from the repository root. */
export function workflowScripts(directory = root) {
  const workflows = join(directory, ".github", "workflows");
  // A checkout without workflows (the OpenRhen export before its own CI) has no CI-only steps to add.
  if (!existsSync(workflows)) return [];
  return readdirSync(workflows)
    .filter((name) => /\.ya?ml$/.test(name))
    .flatMap((name) => [
      ...readFileSync(join(workflows, name), "utf8").matchAll(/^\s*(?:-\s+)?run:\s*(node --test\b.*)$/gm)
    ])
    .map((match) => ({ dir: ".", script: match[1].trim() }));
}

/** Every file some CI suite runs. */
export function coveredFiles(directory = root) {
  const rootManifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  const suites = [
    ...readWorkspace(directory).flatMap((pkg) =>
      SUITE_SCRIPTS.filter((name) => pkg.scripts[name]).map((name) => ({ dir: pkg.dir, script: pkg.scripts[name] }))
    ),
    { dir: ".", script: rootManifest.scripts["test:scripts"] },
    ...workflowScripts(directory)
  ];
  const covered = new Set();
  for (const { dir, script } of suites)
    for (const command of commands(script))
      for (const file of filesFor(command, dir, directory) ?? []) covered.add(file);
  return covered;
}

export function uncovered(files, covered) {
  return files.filter((file) => !covered.has(file)).sort();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const missing = uncovered(testFiles(), coveredFiles());
  if (missing.length > 0) {
    console.error(`${missing.length} test file(s) are run by no suite CI runs:`);
    for (const file of missing) console.error(`  ${file}`);
    console.error("Widen the package's vitest config include, or the root test:scripts globs, to cover them.");
    process.exit(1);
  }
  console.log("Every test file is run by a CI suite.");
}
