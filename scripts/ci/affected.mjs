import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import "./private/index.mjs";
import { edgeExtensions } from "./edge-extensions.mjs";

/**
 * Which test suites a pull request needs, by workspace package (the org CI contract).
 *
 * A changed file belongs to the workspace package whose directory holds it. That package and every
 * package that depends on it, as their package.json files declare, run their unit suites; the ones
 * among them with integration suites run those; the engine benchmark runs when engine-core is
 * among them. The dependency graph is read from the manifests on every run rather than written
 * down here, so it cannot drift from the code.
 *
 * Three things widen that answer:
 *
 *  - The edges no package.json declares, in EXTRA_EDGES. `check-structure.mjs` fails on any
 *    relative import across packages that is neither a declared dependency nor listed there.
 *  - A file outside every package that is not known to be test-inert (the lockfile, the root
 *    manifests and configs, `.github/`, `scripts/`) runs everything: filters say what cannot matter,
 *    so a new kind of file costs time, never coverage.
 *  - Anything but a pull request (a push to main, a manual run), a diff that cannot be read, or one
 *    of more than MAX_FILES files runs everything. Main always runs the whole gate, so a narrowing
 *    mistake shows up there within one merge.
 *
 * Check and typecheck are not narrowed: they are cheap and police the whole repository.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Files no test suite reads: the root Markdown, docs/, and the agent folders. */
export const IGNORED = [/^[^/]+\.md$/, /^docs\//, /^\.agents\//, /^\.claude\//, /^\.codex\//];

/**
 * Dependencies no package.json declares. The portal's PostgreSQL integration suites drive the real
 * engine service in-process by relative path (see `deepImportExemptions` in check-structure.mjs),
 * so a change the engine service can see also runs the portal's integration suite. The OpenClaw
 * plugin's own suite tests its plain JavaScript; the CLI's unit suite reads its manifest and skills.
 */
export const EXTRA_EDGES = [
  { from: "engine/service", to: "portal", suite: "integration" },
  { from: "integrations/openclaw-plugin", to: "tools/cli", suite: "unit" },
  // The portal's vocabulary test reads the communication readers' source text to keep their copy of it equal.
  { from: "integrations/communication-readers", to: "portal", suite: "unit" },
  // Edges of packages the export leaves out are registered in private/index.mjs.
  ...edgeExtensions()
];

/** The package whose production build the click smoke (scripts/smoke/production-click.mjs) runs. */
export const SMOKE_PACKAGE = "portal";

/**
 * The packages the smoke's seed phase (scripts/smoke/seed-phase.mjs) also runs from their built bundles:
 * the engine service and worker, and the CLI the seed writes through. A change any of them can see runs
 * the smoke too, whether or not the portal imports it.
 */
export const SMOKE_ALSO_RUNS = ["engine/service", "engine/worker", "tools/cli"];

/** Past this, a change is a sweep (a rename, a formatter run) and selecting from it is not worth the risk. */
export const MAX_FILES = 300;

/** Every workspace package under `root`: its directory, name, scripts and workspace dependencies. */
export function readWorkspace(directory = root) {
  const patterns = [
    ...readFileSync(join(directory, "pnpm-workspace.yaml"), "utf8").matchAll(/^\s*-\s*["']?([^"'\s]+)/gm)
  ]
    .map((match) => match[1])
    .filter((pattern) => !pattern.startsWith("!"));
  const dirs = patterns.flatMap((pattern) => {
    if (!pattern.endsWith("/*")) return [pattern];
    const parent = pattern.slice(0, -2);
    if (!existsSync(join(directory, parent))) return [];
    return readdirSync(join(directory, parent), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${parent}/${entry.name}`);
  });
  const packages = dirs
    .filter((dir) => existsSync(join(directory, dir, "package.json")))
    .map((dir) => {
      const manifest = JSON.parse(readFileSync(join(directory, dir, "package.json"), "utf8"));
      const declared = { ...manifest.dependencies, ...manifest.devDependencies, ...manifest.peerDependencies };
      return {
        dir,
        name: manifest.name,
        entry: manifest.exports?.["."] ?? null,
        scripts: manifest.scripts ?? {},
        deps: Object.keys(declared)
      };
    });
  const names = new Set(packages.map((pkg) => pkg.name));
  for (const pkg of packages) pkg.deps = pkg.deps.filter((dep) => names.has(dep));
  return packages;
}

/** The package directory holding `file`, or undefined when it is outside every package. */
export function packageOf(file, packages) {
  return packages
    .map((pkg) => pkg.dir)
    .filter((dir) => file.startsWith(`${dir}/`))
    .sort((a, b) => b.length - a.length)[0];
}

const everything = (packages, reason) => ({
  all: true,
  reason,
  unit: packages.filter((pkg) => pkg.scripts.test).map((pkg) => pkg.dir),
  integration: packages.filter((pkg) => pkg.scripts["test:integration"]).map((pkg) => pkg.dir),
  smoke: packages.some((pkg) => pkg.dir === SMOKE_PACKAGE),
  benchmark: packages.some((pkg) => pkg.scripts["test:performance"])
});

/** The suites `files` need. `files` undefined means the change could not be read. */
export function select(files, packages, edges = EXTRA_EDGES) {
  if (files === undefined) return everything(packages, "the change could not be read");
  if (files.length > MAX_FILES) return everything(packages, `${files.length} files changed (over ${MAX_FILES})`);
  const changed = new Set();
  for (const file of files) {
    const dir = packageOf(file, packages);
    if (dir) changed.add(dir);
    else if (!IGNORED.some((pattern) => pattern.test(file)))
      return everything(packages, `${file} is outside every package and may reach any of them`);
  }
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const dependents = new Map(packages.map((pkg) => [pkg.dir, []]));
  for (const pkg of packages) for (const dep of pkg.deps) dependents.get(byName.get(dep).dir).push(pkg.dir);
  const affected = new Set();
  const queue = [...changed];
  while (queue.length > 0) {
    const dir = queue.shift();
    if (affected.has(dir)) continue;
    affected.add(dir);
    queue.push(...dependents.get(dir));
  }
  const unitReach = new Set(affected);
  for (const edge of edges) if (edge.suite === "unit" && affected.has(edge.from)) unitReach.add(edge.to);
  const integrationReach = new Set(affected);
  for (const edge of edges) if (edge.suite === "integration" && affected.has(edge.from)) integrationReach.add(edge.to);
  const byDir = new Map(packages.map((pkg) => [pkg.dir, pkg]));
  const sorted = (set) => packages.map((pkg) => pkg.dir).filter((dir) => set.has(dir));
  return {
    all: false,
    reason: changed.size === 0 ? "only files no suite reads changed" : `changed: ${sorted(changed).join(", ")}`,
    unit: sorted(unitReach).filter((dir) => byDir.get(dir).scripts.test),
    integration: sorted(integrationReach).filter((dir) => byDir.get(dir).scripts["test:integration"]),
    // The portal's bundle holds whatever it imports, so the smoke runs on the same reach as its integration suite,
    // plus whatever reaches a package the seed phase starts on its own.
    smoke: integrationReach.has(SMOKE_PACKAGE) || SMOKE_ALSO_RUNS.some((dir) => affected.has(dir)),
    benchmark: sorted(affected).some((dir) => byDir.get(dir).scripts["test:performance"])
  };
}

/** pnpm arguments that run a suite in exactly `dirs`; empty when every package runs (plain `pnpm -r`). */
export function filterArgs(dirs, all) {
  return all ? "" : dirs.map((dir) => `--filter=./${dir}`).join(" ");
}

/** The pull request's files: its merge commit against the base it merges into, as actions/changes reads them. */
function changedFiles() {
  try {
    const out = execFileSync("git", ["diff", "--name-only", "--no-renames", "HEAD^1", "HEAD"], {
      cwd: root,
      encoding: "utf8"
    });
    execFileSync("git", ["rev-parse", "-q", "--verify", "HEAD^2"], { cwd: root, stdio: "ignore" });
    return out.split("\n").filter(Boolean);
  } catch {
    return undefined;
  }
}

function main() {
  const packages = readWorkspace();
  const event = process.env.EVENT ?? "";
  const result = ["pull_request", "pull_request_target"].includes(event)
    ? select(changedFiles(), packages)
    : everything(packages, `\`${event || "a run outside a pull request"}\` runs the whole gate`);
  const outputs = {
    unit: result.unit.length > 0,
    "unit-filter": filterArgs(result.unit, result.all),
    integration: result.integration.length > 0,
    "integration-filter": filterArgs(result.integration, result.all),
    smoke: result.smoke,
    benchmark: result.benchmark
  };
  const list = (dirs) => (dirs.length === 0 ? "skipped" : result.all ? "all" : dirs.join(", "));
  const summary = [
    `### Affected packages: ${result.reason}`,
    "",
    `- **Unit**: ${list(result.unit)}`,
    `- **Integration**: ${list(result.integration)}`,
    `- **Production smoke**: ${result.smoke ? "runs" : "skipped"}`,
    `- **Engine benchmark**: ${result.benchmark ? "runs" : "skipped"}`
  ].join("\n");
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n\n`);
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      Object.entries(outputs)
        .map(([key, value]) => `${key}=${value}\n`)
        .join("")
    );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
