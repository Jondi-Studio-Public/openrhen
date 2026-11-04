#!/usr/bin/env node
// Cross-platform version of the deploy's pre-deploy secrets guard (deploy-home-server.mjs): checks
// that `.env`, with the shell environment layered over it as Compose does, holds a usable value for
// every secret the selected services need. Prints variable names only, never values.
//
//   node scripts/setup/check-env.mjs
//
// Exports:
//   CORE_SERVICES                      -> string[]   the services of the `app` profile
//   PASSWORD_TOKEN                     -> string     the `__POSTGRES_PASSWORD__` template token
//   checkEnv({ cwd, env, stdout })     -> number     exit code (0 ok, 1 missing secrets)
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { addonEntries, loadComposeModel, usesAddons } from "../deploy/compose-addons.mjs";
import { SERVICE_SECRETS, findUnusableSecrets } from "../deploy/required-secrets.mjs";
import { readEnvValues } from "./env-file.mjs";

export const CORE_SERVICES = ["engine-service", "outbound-proxy", "migrate", "backup", "engine-worker", "portal"];
export const PASSWORD_TOKEN = "__POSTGRES_PASSWORD__";

export function checkEnv({ cwd = process.cwd(), env = process.env, stdout = process.stdout, run } = {}) {
  const file = readEnvValues(join(cwd, ".env"));
  const effective = { ...file };
  for (const [name, value] of Object.entries(env)) if (value !== undefined) effective[name] = value;

  const profiles = (effective.COMPOSE_PROFILES ?? "").split(",").map((part) => part.trim());
  // Add-ons (COMPOSE_FILE): read the merged model for their services in the active profiles and the secrets
  // they append to core services.
  const secrets = { ...SERVICE_SECRETS };
  const services = [...CORE_SERVICES];
  if (usesAddons(effective)) {
    const model = loadComposeModel({ cwd, env: { ...process.env, ...effective }, run });
    const active = profiles.filter(Boolean).length ? profiles : ["app"];
    for (const entry of addonEntries(model)) {
      secrets[entry.service] = [...new Set([...(secrets[entry.service] ?? []), ...entry.secrets])];
      const profile = model.services[entry.service].profiles ?? [];
      if (!services.includes(entry.service) && profile.some((name) => active.includes(name)))
        services.push(entry.service);
    }
  }
  const missing = findUnusableSecrets(services, effective, secrets);
  if (profiles.includes("bundled-db") && !effective.POSTGRES_PASSWORD?.trim()) {
    missing.push("POSTGRES_PASSWORD");
  }
  for (const name of ["DATABASE_URL", "POSTGRES_ADMIN_URL"]) {
    if (effective[name]?.includes(PASSWORD_TOKEN)) missing.push(name);
  }
  const unique = [...new Set(missing)];

  if (env.DATABASE_URL !== undefined && env.DATABASE_URL !== "") {
    stdout.write("warning: DATABASE_URL is set in your shell; Compose will use it instead of .env.\n");
  }
  if (unique.length) {
    stdout.write(
      `check-env: unset, blank or placeholder: ${unique.join(", ")}.\n` +
        "Run `node scripts/setup/init-env.mjs` (or `docker compose run --rm setup`) to generate them.\n"
    );
    return 1;
  }
  stdout.write("check-env: ok. Every secret the selected services need is set.\n");
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = checkEnv();
}
