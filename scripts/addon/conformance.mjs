#!/usr/bin/env node
// Add-on conformance: proves an add-on works with core by editing no core file.
//
//   node scripts/addon/conformance.mjs [--addon integrations/addon-example] [--keep]
//
// It copies the repository to a scratch folder (no .git, .env or node_modules), copies the add-on's `overlay/`
// tree over the copy, and checks the result:
//   1. only add-on owned paths and the documented single-slot stubs differ from core;
//   2. `pnpm structure:check` (node scripts/repository/check-structure.mjs) passes on the merged tree;
//   3. `docker compose config` merges `compose.yaml` and `compose.addon.yaml` (COMPOSE_FILE) into a model the
//      deploy scripts accept: add-on services have profiles and depend on services that exist;
//      and registerComposeAddons (which the private deploy layer must call) registers its services;
//   4. the env fragments fold into a `.env` once (init-env), and a second run changes nothing;
//   5. no add-on page or route serves a URL a core route also serves.
// Every failure prints one line naming the path or key, and the exit code is 1. See docs/architecture/writing-an-addon.md.
//
// Exports: isAddonOwned, SINGLE_SLOT_STUBS, changedPaths, ownershipViolations, composeViolations, envViolations,
// routeViolations, conformance.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  addonEntries,
  CORE_COMPOSE_SERVICES,
  loadComposeModel,
  registerComposeAddons
} from "../deploy/compose-addons.mjs";
import { findCollisions, listRoutes, loadAddonWriters } from "../repository/addon-routes.mjs";
import { applyAddonEnv, findFragments, parseFragment } from "../setup/addon-env.mjs";

const root = resolve(fileURLToPath(import.meta.url), "../../..");
const posix = (value) => value.split(sep).join("/");

/**
 * The files core ships empty on purpose, one per seam that is a list in code rather than data. An add-on replaces
 * the whole file, so two add-ons cannot both use a slot: the layer that combines add-ons owns the file.
 */
export const SINGLE_SLOT_STUBS = ["platform/contracts/src/private/index.ts"];

/** Folders never copied: build output, dependencies, and anything that could hold a secret. */
const SKIPPED = new Set([".git", ".env", "node_modules", ".vinext", "dist", "var", "coverage"]);

/** Whether an add-on may add this repository-relative path: its compose file, its own `addons/<id>/`, the route group. */
export function isAddonOwned(path, id) {
  if (path.split("/").includes("..")) return false;
  return path === "compose.addon.yaml" || path.startsWith(`addons/${id}/`) || path.startsWith("portal/app/(addon)/");
}

function files(directory, base = directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (SKIPPED.has(entry.name)) return [];
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path, base) : [posix(relative(base, path))];
  });
}

/** Files in `mergedRoot` that are new or different compared with `coreRoot`, sorted by path. */
export function changedPaths(coreRoot, mergedRoot) {
  const changes = [];
  for (const path of files(mergedRoot).sort()) {
    const core = join(coreRoot, path);
    if (!existsSync(core)) changes.push({ path, kind: "added" });
    else if (!readFileSync(core).equals(readFileSync(join(mergedRoot, path)))) changes.push({ path, kind: "modified" });
  }
  return changes;
}

export function ownershipViolations(changes, id) {
  const errors = [];
  for (const { path, kind } of changes) {
    if (isAddonOwned(path, id)) continue;
    if (SINGLE_SLOT_STUBS.includes(path) && kind === "modified") continue;
    errors.push(
      SINGLE_SLOT_STUBS.includes(path)
        ? `${path} was ${kind}, but a single-slot stub must exist in core and be replaced`
        : `${path} was ${kind}: an add-on may change a core file only if it is a documented single-slot stub (${SINGLE_SLOT_STUBS.join(", ")}) and may add only compose.addon.yaml, addons/${id}/ and portal/app/(addon)/`
    );
  }
  return errors;
}

/** Checks the merged compose model (as `docker compose config --format json` prints it). */
export function composeViolations(model, { secretKeys }) {
  let entries;
  try {
    entries = addonEntries(model);
  } catch (error) {
    return [error.message];
  }
  const errors = [];
  const services = Object.keys(model.services ?? {});
  const own = entries.filter((entry) => !CORE_COMPOSE_SERVICES.includes(entry.service));
  if (own.length === 0) errors.push("the merged compose model has no add-on service");
  for (const entry of entries) {
    for (const dependency of entry.dependsOn)
      if (!services.includes(dependency))
        errors.push(`${entry.service} depends_on ${dependency}, which is not a service`);
    for (const secret of entry.secrets)
      if (!secretKeys.includes(secret))
        errors.push(
          `${entry.service} lists secret ${secret} in x-openrhen, but no env fragment declares it with @secret`
        );
  }
  return [...new Set(errors)];
}

/**
 * What the private deploy layer gets by calling `registerComposeAddons` (core never calls it; check-env reads the
 * model itself): at least one add-on service, registered in the deploy service registry.
 */
export function registrationViolations(model) {
  try {
    const entries = registerComposeAddons({
      env: { COMPOSE_FILE: "compose.yaml:compose.addon.yaml" },
      run: () => JSON.stringify(model)
    });
    return entries.some((entry) => !CORE_COMPOSE_SERVICES.includes(entry.service))
      ? []
      : ["registerComposeAddons registered no add-on service from the merged model"];
  } catch (error) {
    return [`registerComposeAddons failed: ${error.message}`];
  }
}

/** Checks the env fragments under `cwd/addons`. Returns the errors and the `@secret` keys. */
export function envViolations({ cwd, coreEnvExample }) {
  const fragments = findFragments(cwd);
  if (fragments.length === 0) return { errors: ["no addons/<id>/env.example fragment found"], secretKeys: [] };
  const errors = [];
  const coreKeys = new Set(parseFragment(coreEnvExample).map((entry) => entry.key));
  const secretKeys = [];
  for (const { id, path } of fragments)
    for (const entry of parseFragment(readFileSync(path, "utf8"))) {
      if (coreKeys.has(entry.key))
        errors.push(`addons/${id}/env.example sets ${entry.key}, which core's .env.example also sets`);
      if (entry.secret) secretKeys.push(entry.key);
    }
  let n = 0;
  const makeSecret = () => `generated-${(n += 1)}`;
  const first = applyAddonEnv({ cwd, text: coreEnvExample, makeSecret });
  const second = applyAddonEnv({ cwd, text: first.text, makeSecret });
  for (const conflict of first.conflicts) errors.push(conflict);
  for (const key of secretKeys)
    if (!first.generated.includes(key)) errors.push(`secret ${key} was not generated into .env`);
  if (second.text !== first.text || second.generated.length)
    errors.push("a second init-env run changed .env; the fragment is not idempotent");
  return { errors, secretKeys };
}

export function routeViolations(repoRoot) {
  const routes = listRoutes(repoRoot);
  const errors = [];
  if (!routes.some((route) => route.addon)) errors.push("no add-on route found under portal/app/(addon)/");
  errors.push(...findCollisions(routes), ...loadAddonWriters(repoRoot).errors);
  return errors;
}

function step(label, stdout, errors) {
  stdout.write(`${errors.length ? "FAIL" : "ok  "} ${label}\n`);
  for (const error of errors) stdout.write(`     ${error}\n`);
  return errors;
}

/** Runs every check. `run(args, { cwd, env })` returns docker's stdout; tests and callers may inject one. */
export function conformance({
  repoRoot = root,
  addonDir = "integrations/addon-example",
  run,
  stdout = process.stdout,
  keep = false
} = {}) {
  const overlay = resolve(repoRoot, addonDir, "overlay");
  const failures = [];
  if (!existsSync(overlay)) return [`${addonDir}/overlay does not exist`];
  const ids = existsSync(join(overlay, "addons")) ? readdirSync(join(overlay, "addons")) : [];
  if (ids.length !== 1) return [`${addonDir}/overlay/addons must hold exactly one add-on folder; found ${ids.length}`];
  const [id] = ids;

  const work = mkdtempSync(join(tmpdir(), "openrhen-conformance-"));
  try {
    cpSync(repoRoot, work, {
      recursive: true,
      filter: (source) => !SKIPPED.has(source.split(sep).at(-1)) || source === repoRoot
    });
    cpSync(overlay, work, { recursive: true, force: true });

    failures.push(
      ...step(
        "only add-on owned paths and single-slot stubs differ from core",
        stdout,
        ownershipViolations(changedPaths(repoRoot, work), id)
      )
    );

    const structure = spawnSync(process.execPath, ["scripts/repository/check-structure.mjs"], {
      cwd: work,
      encoding: "utf8"
    });
    failures.push(
      ...step(
        "structure:check passes on the merged tree",
        stdout,
        structure.status === 0 ? [] : [(structure.stdout + structure.stderr).trim()]
      )
    );

    const env = envViolations({ cwd: work, coreEnvExample: readFileSync(join(repoRoot, ".env.example"), "utf8") });
    failures.push(...step("env fragments fold into .env once", stdout, env.errors));

    let composeErrors;
    try {
      const model = loadComposeModel({
        cwd: work,
        env: { ...process.env, COMPOSE_FILE: "compose.yaml:compose.addon.yaml", COMPOSE_PATH_SEPARATOR: ":" },
        ...(run ? { run } : {})
      });
      composeErrors = [...composeViolations(model, { secretKeys: env.secretKeys }), ...registrationViolations(model)];
    } catch (error) {
      composeErrors = [`docker compose could not merge compose.yaml and compose.addon.yaml: ${error.message}`];
    }
    failures.push(...step("compose.yaml and compose.addon.yaml merge (COMPOSE_FILE)", stdout, composeErrors));

    failures.push(...step("no add-on URL collides with a core route", stdout, routeViolations(work)));
  } finally {
    if (keep) stdout.write(`kept ${work}\n`);
    else rmSync(work, { recursive: true, force: true });
  }
  return failures;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--addon");
  const failures = conformance({ addonDir: at >= 0 ? args[at + 1] : undefined, keep: args.includes("--keep") });
  if (failures.length) {
    process.stderr.write(`Add-on conformance failed: ${failures.length} problem${failures.length === 1 ? "" : "s"}.\n`);
    process.exit(1);
  }
  process.stdout.write("Add-on conformance passed.\n");
}
