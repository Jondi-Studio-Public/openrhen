import { spawnSync } from "node:child_process";
import { registerDeployService } from "./service-extensions.mjs";

/**
 * The add-on compose seam. An add-on ships `compose.addon.yaml`; the layer merges it with `compose.yaml`
 * through `COMPOSE_FILE` (set in `.env`, which compose and the setup scripts read; join the paths with
 * `COMPOSE_PATH_SEPARATOR`, `:` by default and `;` on Windows). Compose does the merge, so this module reads
 * the result (`docker compose config --format json`) and tells the deploy scripts what it added:
 *
 * - a service the core file does not own: its `depends_on`, whether it builds, and its secrets;
 * - secrets an add-on appends to a core service (`portal`, `engine-worker`), so the deploy guard checks them.
 *
 * An add-on names the secrets a service needs with a service-level extension field, which compose keeps in
 * the merged model: `x-openrhen: { secrets: [NAME, ...] }`. Every add-on service sets `profiles` (use
 * `["planning", "app"]`), so none starts in a stack that did not ask for it.
 */

/** The services `compose.yaml` itself defines. Anything else in the merged model comes from an add-on. */
export const CORE_COMPOSE_SERVICES = [
  "backup",
  "engine-service",
  "engine-worker",
  "migrate",
  "outbound-proxy",
  "portal",
  "postgres",
  "setup"
];

/** Whether the environment asks for a merged compose model at all. */
export function usesAddons(env) {
  return Boolean(env?.COMPOSE_FILE?.trim());
}

function dockerRunner(args, { cwd, env }) {
  const result = spawnSync("docker", args, { cwd, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`docker ${args.slice(0, 2).join(" ")} failed: ${(result.stderr ?? "").trim().split("\n").pop()}`);
  }
  return result.stdout;
}

/**
 * The merged compose model as an object. `run(args, { cwd, env })` returns stdout; tests inject one that
 * returns a JSON fixture. `--profile "*"` includes services of every profile, and `--no-interpolate`
 * keeps the read independent of which variables are set (the secrets guard is what checks those).
 */
export function loadComposeModel({ cwd = process.cwd(), env = process.env, run = dockerRunner } = {}) {
  const args = ["compose", "--profile", "*", "config", "--format", "json", "--no-interpolate"];
  const text = run(args, { cwd, env });
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("docker compose config did not print JSON");
  }
}

function dependencyNames(dependsOn) {
  if (!dependsOn) return [];
  return Array.isArray(dependsOn) ? [...dependsOn] : Object.keys(dependsOn);
}

/** `{ service, dependsOn, secrets, builds }` for each add-on service and each core service an add-on adds secrets to. */
export function addonEntries(model) {
  const entries = [];
  for (const [service, spec] of Object.entries(model?.services ?? {})) {
    const secrets = [...(spec["x-openrhen"]?.secrets ?? [])];
    if (CORE_COMPOSE_SERVICES.includes(service)) {
      if (secrets.length) entries.push({ service, dependsOn: [], secrets, builds: false });
      continue;
    }
    if (!spec.profiles?.length) {
      throw new Error(`add-on service ${service} has no profiles; set profiles: ["planning", "app"]`);
    }
    entries.push({ service, dependsOn: dependencyNames(spec.depends_on), secrets, builds: Boolean(spec.build) });
  }
  return entries;
}

/** Reads the merged model and registers what the add-ons add. Does nothing, and never runs compose, without `COMPOSE_FILE`. */
export function registerComposeAddons(options = {}) {
  const { env = process.env } = options;
  if (!usesAddons(env)) return [];
  const entries = addonEntries(loadComposeModel(options));
  entries.forEach(registerDeployService);
  return entries;
}
