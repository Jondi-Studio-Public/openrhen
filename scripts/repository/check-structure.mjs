import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { EXTRA_EDGES, packageOf, readWorkspace } from "../ci/affected.mjs";
import { findCollisions, listRoutes, loadAddonWriters } from "./addon-routes.mjs";
import { findSecretReaderViolations, findStaleSecretReaderAllowances } from "./secret-reader-rule.mjs";
import { PLAN_INPUT_TABLES, WRITERS } from "./write-path-registry.mjs";

const ARCHIVE_DIR = ["docs", "archive"].join("/"); // the private repository's retired documents; absent in the export
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
// The export tooling (scripts/extract) and its carve rules exist only in the private repository: the OpenRhen export
// ships neither, so everything that measures the carve is skipped there.
const carveTools = existsSync(resolve(root, "scripts/extract/manifest.json"))
  ? {
      ...(await import("../extract/extract.mjs")),
      ...(await import("../extract/seams.mjs")),
      ...(await import("../extract/carve-plugin.mjs"))
    }
  : null;
const errors = [];
const expectedPackages = new Map([
  ["portal/package.json", "@openrhen/portal"],
  ["engine/core/package.json", "@openrhen/engine-core"],
  ["engine/service/package.json", "@openrhen/engine-service"],
  ["engine/worker/package.json", "@openrhen/engine-worker"],
  ["platform/contracts/package.json", "@openrhen/contracts"],
  ["platform/database/package.json", "@openrhen/database"],
  ["integrations/activity-importers/package.json", "@openrhen/activity-importers"],
  ["integrations/outbound-proxy/package.json", "@openrhen/outbound-proxy"],
  ["integrations/openclaw-plugin/package.json", "@openrhen/openclaw-plugin"],
  ["tools/cli/package.json", "@openrhen/cli"]
]);
// A workspace package a carved provider adds is checked by that provider's rule in scripts/repository/seams/, and its
// folder is maintained code like the rest: the roots below also take the first folder of every workspace package.
const maintainedRoots = [
  ...new Set([
    "engine",
    "integrations",
    "portal",
    "platform",
    "tools",
    "scripts",
    "docs",
    ...readWorkspace(root).map((workspacePackage) => workspacePackage.dir.split("/")[0])
  ])
];
const ignoredNames = new Set(["node_modules", "dist", "target", "coverage", ".next", ".vinext"]);
const genericDirectories = new Set(["common", "helpers", "misc", "utils"]);
const allowedIndexes = new Set([
  "engine/core/src/index.ts",
  "platform/contracts/src/index.ts",
  "platform/database/src/index.ts",
  // A workspace package whose entry point is `src/index.ts` (its `exports` says so) keeps that barrel.
  ...readWorkspace(root)
    .filter((workspacePackage) => workspacePackage.entry === "./src/index.ts")
    .map((workspacePackage) => `${workspacePackage.dir}/src/index.ts`),
  // The seams (scripts/extract/seams.mjs): each private index.ts is replaced by an empty file in the export overlay.
  ...Object.keys(carveTools?.SEAMS ?? {}).filter((seam) => seam.endsWith("/index.ts"))
]);
const staleFragments = [
  "apps/",
  "packages/",
  "@openrhen/web",
  "@openrhen/plan-forecast-engine",
  "@openrhen/plan-forecast-service",
  "@openrhen/plan-forecast-worker"
];
const skipStaleCheck = new Set(["scripts/repository/check-structure.mjs"]);
// PostgreSQL integration suites drive the real engine service in-process. It is not a workspace
// dependency of the portal — deliberately, so product code cannot reach it — so these two files are
// the only portal files allowed to reach across the workspace by relative path. The state-store
// journeys reach it through their shared harness, which is why the exemption names the harness and
// not the four test files that import it.
const deepImportExemptions = new Set([
  // Reads the export manifest from the repository's scripts folder to split the route table.
  "portal/scripts/generate-mcp-route-table.mjs",
  "portal/server/persistence/postgres/state-store-harness.ts",
  "portal/server/persistence/postgres/issue-snapshot-store.integration.test.ts"
]);

const posix = (value) => value.split(sep).join("/");
const read = (file) => readFileSync(resolve(root, file), "utf8");
function walk(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory() && ignoredNames.has(entry.name)) return [];
    const absolute = resolve(directory, entry.name);
    if (entry.isDirectory() && posix(relative(root, absolute)) === ARCHIVE_DIR) return [];
    if (entry.isDirectory()) return [absolute, ...walk(absolute)];
    return [absolute];
  });
}

for (const former of ["apps", "packages", "backups", "outputs", "portal/lib", "portal/db"]) {
  if (existsSync(resolve(root, former))) errors.push(`Former path still exists: ${former}`);
}
for (const [manifest, expectedName] of expectedPackages) {
  if (!existsSync(resolve(root, manifest))) {
    errors.push(`Missing workspace manifest: ${manifest}`);
    continue;
  }
  const actualName = JSON.parse(read(manifest)).name;
  if (actualName !== expectedName) errors.push(`${manifest} is named ${actualName}; expected ${expectedName}`);
}

const entries = maintainedRoots.flatMap((directory) => walk(resolve(root, directory)));
// The export ships no AGENTS.md (agent guidance is private-repository workflow), so it is measured only where it exists.
const rootFiles = ["README.md", "AGENTS.md", "package.json", "pnpm-workspace.yaml", "compose.yaml", ".env.example"]
  .map((file) => resolve(root, file))
  .filter((file) => existsSync(file));
const maintainedFiles = [...entries.filter((absolute) => !readdirSafe(absolute)), ...rootFiles];
for (const absolute of entries) {
  const source = posix(relative(root, absolute));
  if (source.startsWith("platform/database/drizzle/") || source.startsWith("portal/app/")) continue;
  // The example add-on's overlay mirrors core's layout, `(addon)` route group included. It is checked after it is
  // copied over core (scripts/addon/conformance.mjs runs this check on the merged tree), not where it is stored.
  if (source.startsWith("integrations/addon-example/overlay/")) continue;
  const statIsDirectory = readdirSafe(absolute);
  const name = source.split("/").at(-1);
  if (statIsDirectory) {
    if (name.startsWith(".")) continue;
    if (genericDirectories.has(name)) errors.push(`Catch-all directory is not permitted: ${source}`);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) errors.push(`Directory is not kebab-case: ${source}`);
    continue;
  }
  if (![".ts", ".tsx", ".mjs"].includes(extname(name))) continue;
  if (/\.(?:config|d)\.ts$/.test(name)) continue;
  // In the export (no carve tooling) the seam stand-ins (`private/index.ts`, shipped empty by the overlay) are allowed;
  // in the private repository only the listed seams are.
  if (
    name === "index.ts" &&
    !allowedIndexes.has(source) &&
    !(!carveTools && /(?:^|\/)private\/index\.ts$/.test(source))
  )
    errors.push(`Internal index.ts is not permitted: ${source}`);
  const stem = name
    .replace(/\.(?:integration\.)?test(?=\.)/, "")
    .replace(/\.(?:config|d)(?=\.)/, "")
    .replace(/\.(?:ts|tsx|mjs)$/, "");
  if (stem !== "index" && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(stem))
    errors.push(`Source filename is not kebab-case: ${source}`);
}

for (const absolute of maintainedFiles) {
  const source = posix(relative(root, absolute));
  if (!/\.(?:ts|tsx|mjs|json|md|yaml|yml)$/.test(source)) continue;
  if (source.startsWith(`${ARCHIVE_DIR}/`) || skipStaleCheck.has(source)) continue;
  const text = readFileSync(absolute, "utf8");
  for (const fragment of staleFragments)
    if (text.includes(fragment)) errors.push(`${source} contains stale path or package name: ${fragment}`);
  // A package's entry points (`@openrhen/contracts/readiness`) are the package: the boundary is the workspace
  // package, so they are checked as that package.
  const workspaceImports = [...text.matchAll(/(?:from\s+|import\s*\()(["'])(@openrhen\/[^"']+)\1/g)].map((match) =>
    match[2].replace(/^(@openrhen\/[^/]+)\/.*$/, "$1")
  );
  if (
    (source.startsWith("portal/") || source.startsWith("engine/worker/")) &&
    workspaceImports.includes("@openrhen/engine-core")
  ) {
    errors.push(`${source} imports the engine core across a forbidden boundary`);
  }
  if (source.startsWith("engine/service/")) {
    for (const dependency of workspaceImports)
      if (!["@openrhen/contracts", "@openrhen/engine-core"].includes(dependency))
        errors.push(`${source} imports forbidden workspace package ${dependency}`);
  }
  if (source.startsWith("integrations/outbound-proxy/")) {
    for (const dependency of workspaceImports)
      if (dependency !== "@openrhen/contracts")
        errors.push(`${source} imports forbidden workspace package ${dependency}`);
  }
  // A bundled connection is the future add-on package: beside its own
  // folder it may reach the host only through the connection API, the HTTP helpers and the cookie jar.
  const connectionFolder = /^(integrations\/outbound-proxy\/src\/connections\/[^/]+)\//.exec(source)?.[1];
  if (connectionFolder) {
    const allowedHost = ["connection-api", "http", "cookie-jar"].map(
      (name) => `integrations/outbound-proxy/src/host/${name}`
    );
    for (const match of text.matchAll(/(?:from\s+|import\s*\()(["'])(\.[^"']*)\1/g)) {
      const target = posix(join(dirname(source), match[2])).replace(/\.(?:js|ts)$/, "");
      if (!target.startsWith(`${connectionFolder}/`) && !allowedHost.includes(target))
        errors.push(`${source} imports ${match[2]}, which a connection may not reach`);
    }
  }
  if (source.startsWith("engine/core/")) {
    for (const dependency of workspaceImports)
      if (dependency !== "@openrhen/contracts")
        errors.push(`${source} imports forbidden workspace package ${dependency}`);
  }
  // The activity importers are pure streaming parsers: bytes in, event drafts out. They import no other workspace
  // package (not even the contracts), so the CLI is the only place that knows both the file formats and the wire.
  if (source.startsWith("integrations/activity-importers/")) {
    for (const dependency of workspaceImports)
      errors.push(`${source} imports forbidden workspace package ${dependency}`);
  }
  // The CLI is a LAN client of the portal, in the same trust position as the handheld: it reads and
  // writes only over the portal's HTTP routes, so it may share the wire contracts and nothing else; the one
  // other package it reads is the activity importers, which parse export files on the user's machine.
  // The one exception is a command-module drop-in (tools/cli/extensions/<name>/), which may also read its own
  // provider's contracts package: the core CLI loads none of them (the design notes, the seam rule).
  if (source.startsWith("tools/cli/")) {
    const dropIn = /^tools\/cli\/extensions\/([^/]+)\//.exec(source)?.[1];
    for (const dependency of workspaceImports)
      if (
        dependency !== "@openrhen/contracts" &&
        dependency !== "@openrhen/activity-importers" &&
        !(dropIn !== undefined && dependency === `@openrhen/${dropIn}-contracts`)
      )
        errors.push(`${source} imports forbidden workspace package ${dependency}`);
  }
  if (source.startsWith("platform/")) {
    for (const dependency of workspaceImports)
      if (dependency.startsWith("@openrhen/engine-") || dependency === "@openrhen/portal")
        errors.push(`${source} imports product code from platform: ${dependency}`);
  }
  const clientModule =
    !source.endsWith(".test.ts") &&
    (/^portal\/(?:components|features|shared|state)\//.test(source) ||
      (source.startsWith("portal/app/") && /^[\s\r\n]*["']use client["'];/.test(text)));
  if (clientModule) {
    if (/from\s+["']@\/server\//.test(text) || /from\s+["']@\/integrations\/[\w-]+\/[\w-]+-proxy-client/.test(text))
      errors.push(`${source} imports server-only portal code`);
  }
  if (source.startsWith("portal/") && !deepImportExemptions.has(source)) {
    if (/from\s+["']\.\.\/\.\.\//.test(text)) errors.push(`${source} uses a deep parent-relative import instead of @/`);
  }
}

// The add-on page and API route seam (portal/app/(addon)/): no add-on URL may also be a core URL, and an add-on's
// write-paths.json is well formed. Its entries join WRITERS in write-path-registry.mjs.
errors.push(...findCollisions(listRoutes(root)), ...loadAddonWriters(root).errors);

// One write path for plan input.
const writePathRoots = ["portal", "platform", "integrations", "tools"];
const writePathExclusions = [/\.test\.tsx?$/, /-test-fixtures\.ts$/];
const writePathFiles = writePathRoots
  .flatMap((directory) => walk(resolve(root, directory)))
  .filter((absolute) => !readdirSafe(absolute))
  .map((absolute) => posix(relative(root, absolute)))
  .filter((source) => [".ts", ".tsx", ".mjs"].includes(extname(source)))
  .filter((source) => !source.startsWith("platform/database/drizzle/"))
  .filter((source) => !writePathExclusions.some((pattern) => pattern.test(source)));

const writerEntries = Object.entries(WRITERS);
for (const [writerPath] of writerEntries) {
  if (!existsSync(resolve(root, writerPath)))
    errors.push(`write-path-registry.mjs entry does not exist: ${writerPath}`);
}

function isRegisteredWriter(source) {
  return writerEntries.some(([writerPath]) =>
    writerPath.endsWith("/") ? source.startsWith(writerPath) : source === writerPath
  );
}

const changeLogInsertPattern = /INSERT INTO write_rows/;
const enqueueCallPattern = /enqueuePlanForecastJob\(/;
const tablePattern = new RegExp(
  String.raw`\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(${PLAN_INPUT_TABLES.join("|")})\b`,
  "g"
);

for (const source of writePathFiles) {
  const text = readFileSync(resolve(root, source), "utf8");

  if (changeLogInsertPattern.test(text) && source !== "portal/server/persistence/postgres/planning-evidence.ts")
    errors.push(`${source} inserts write_rows outside planning-evidence.ts`);
  if (
    enqueueCallPattern.test(text) &&
    ![
      "portal/server/persistence/postgres/planning-evidence.ts",
      "platform/database/src/planning/plan-forecast-runtime.ts"
    ].includes(source)
  )
    errors.push(`${source} calls enqueuePlanForecastJob outside planning-evidence.ts and plan-forecast-runtime.ts`);

  const writtenTables = new Set([...text.matchAll(tablePattern)].map((match) => match[1]));
  for (const table of writtenTables)
    if (!isRegisteredWriter(source))
      errors.push(`${source} writes plan-input table ${table} but is not registered in write-path-registry.mjs`);
}

for (const [writerPath, entry] of writerEntries) {
  if (writerPath.endsWith("/")) continue;
  const text = readFileSync(resolve(root, writerPath), "utf8");
  if (entry.class === "owner" && !text.includes("recordStateChange("))
    errors.push(`${writerPath} is registered as an owner but does not call recordStateChange(`);
  if (entry.class === "helper") {
    if (!entry.owners?.length)
      errors.push(`${writerPath} is registered as a helper but names no owners in write-path-registry.mjs`);
    for (const ownerPath of entry.owners ?? []) {
      const ownerEntry = WRITERS[ownerPath];
      if (!ownerEntry || ownerEntry.class !== "owner")
        errors.push(
          `${writerPath} names ${ownerPath} as an owner, but it is not registered as an owner in write-path-registry.mjs`
        );
    }
  }
}

// A saved password or key is decrypted by `readSecret` and nothing else may import it but the proxy-call helper
// (scripts/repository/secret-reader-rule.mjs).
const secretReaderFiles = maintainedFiles
  .map((absolute) => posix(relative(root, absolute)))
  .filter((source) => [".ts", ".tsx", ".mjs"].includes(extname(source)))
  .map((source) => ({ source, text: readFileSync(resolve(root, source), "utf8") }));
errors.push(...findSecretReaderViolations(secretReaderFiles), ...findStaleSecretReaderAllowances(secretReaderFiles));

// Open-source core: a provider leaves the keep set by being excluded from the export, so
// nothing the export keeps may name it except through the registry or drop-in directory it registers with. The keep
// set is what scripts/extract/manifest.json selects; a drop-in folder, a file named for the provider and every other
// excluded path are outside it. `pending` lists the kept files that still name the provider, each with the carve
// step that removes it; the list only shrinks.
// Each rule is `scripts/repository/registry-only-<provider>.mjs` ({ name, term, via, pending }), named for the
// provider so the export drops it with the provider.
const registryOnly = [];
for (const file of readdirSync(resolve(root, "scripts/repository")).sort())
  if (/^registry-only-.*\.mjs$/.test(file))
    registryOnly.push((await import(pathToFileURL(resolve(root, "scripts/repository", file)).href)).default);
let keepSet = null;
try {
  if (!carveTools) throw new Error("no export tooling");
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 })
    .split("\0")
    .filter(Boolean);
  keepSet = carveTools.selectFiles(tracked, JSON.parse(read("scripts/extract/manifest.json"))).keep;
} catch {
  // No git checkout (a source archive): there is no tracked-file list to measure, so this block cannot run.
}
for (const { name, term, via, pending } of keepSet ? registryOnly : []) {
  for (const source of keepSet) {
    if (source.startsWith("platform/database/drizzle/") || Object.hasOwn(pending, source)) continue;
    const text = /\.(?:png|woff2|ico|jpg|jpeg|gif|zip)$/.test(source)
      ? ""
      : (carveTools?.readCarved ?? ((base, file) => readFileSync(resolve(base, file), "utf8")))(root, source);
    if (term.test(source) || term.test(text))
      errors.push(`${source} names ${name}, but the export keeps it: reach ${name} only through ${via}`);
  }
  for (const source of Object.keys(pending))
    if (!keepSet.includes(source) || !term.test(readFileSync(resolve(root, source), "utf8")))
      errors.push(`${source} no longer names ${name}: remove it from the pending list in check-structure.mjs`);
}

// The carve: code in a carved directory reaches a private (excluded-from-the-export) file only
// through a seam file, and every seam has an overlay stand-in, so the same source builds with and without them.
if (carveTools) {
  const { findExcludedImports, SEAMS } = carveTools;
  const manifest = JSON.parse(read("scripts/extract/manifest.json"));
  const carved = maintainedFiles.map((absolute) => posix(relative(root, absolute)));
  for (const { file, target } of findExcludedImports(carved, manifest, read))
    errors.push(
      `${file} imports ${target}, which the export excludes; reach it through a seam (scripts/extract/seams.mjs)`
    );
  for (const [seam, overlay] of Object.entries(SEAMS)) {
    if (!existsSync(resolve(root, seam))) errors.push(`Seam file does not exist: ${seam}`);
    if (!existsSync(resolve(root, overlay))) errors.push(`Seam ${seam} has no overlay stand-in at ${overlay}`);
  }
}

// The private repository's documentation layout; the export has its own (extract/overlay/docs).
const structureDoc = "docs/architecture/repository-structure.md";
if (carveTools) {
  if (!existsSync(resolve(root, structureDoc))) errors.push(`Missing ${structureDoc}`);
  else if (!read("docs/README.md").includes("architecture/repository-structure.md"))
    errors.push("docs/README.md does not route to the repository structure standard");
}

// CI runs a package's suites when it or a package it depends on changes (scripts/ci/affected.mjs). A
// relative import into another package is a dependency no package.json declares, so CI would miss
// it: each one must be a declared dependency or listed in that script's EXTRA_EDGES.
const workspacePackages = readWorkspace(root);
const workspaceDirs = new Map(workspacePackages.map((pkg) => [pkg.name, pkg.dir]));
for (const absolute of maintainedFiles) {
  const source = posix(relative(root, absolute));
  if (!/\.(?:ts|tsx|mjs)$/.test(source)) continue;
  const from = packageOf(source, workspacePackages);
  if (!from) continue;
  const declared = new Set(workspacePackages.find((pkg) => pkg.dir === from).deps.map((dep) => workspaceDirs.get(dep)));
  const text = readFileSync(absolute, "utf8");
  for (const match of text.matchAll(/(?:from\s+|import\s*\(\s*)(["'])(\.{1,2}\/[^"']+)\1/g)) {
    const target = packageOf(posix(relative(root, resolve(dirname(absolute), match[2]))), workspacePackages);
    if (!target || target === from || declared.has(target)) continue;
    if (!EXTRA_EDGES.some((edge) => edge.from === target && edge.to === from))
      errors.push(
        `${source} imports ${target} by relative path; declare it or add it to EXTRA_EDGES in scripts/ci/affected.mjs`
      );
  }
}

// Carve rules live as drop-ins in scripts/repository/seams/ (one module per carved provider, each exporting a
// default function (root) => string[]). The export excludes the provider-named ones, so this loop ships empty.
const seamsDirectory = resolve(root, "scripts/repository/seams");
if (existsSync(seamsDirectory)) {
  for (const name of readdirSync(seamsDirectory)
    .filter((file) => file.endsWith(".mjs") && !file.endsWith(".test.mjs"))
    .sort()) {
    const seam = await import(pathToFileURL(resolve(seamsDirectory, name)).href);
    errors.push(...seam.default(root));
  }
}

if (errors.length) {
  console.error("Repository structure checks failed:\n" + errors.map((error) => `- ${error}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(
    `Repository structure checks passed: ${expectedPackages.size} workspaces, ${maintainedFiles.length} maintained files.`
  );
}

function readdirSafe(absolute) {
  try {
    readdirSync(absolute);
    return true;
  } catch {
    return false;
  }
}
