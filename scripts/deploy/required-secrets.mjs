import { existsSync, readFileSync } from "node:fs";
import "./private/index.mjs";
import { deployServiceExtensions } from "./service-extensions.mjs";

/** The fallback `compose.yaml` gives the service tokens when the variable is unset. */
export const PLACEHOLDER = "replace-before-lan-use";

/**
 * The secrets `compose.yaml` interpolates for each service, limited to the ones with no usable
 * fallback. Compose fills an unset `${VAR:-}` with a blank and an unset token with the placeholder
 * above, and `up -d` then recreates the container with that quietly, so a deploy that ran without
 * the secrets looks identical to one that had them. A tunnel service is absent on purpose: its
 * token is only set where the portal is exposed. The outbound proxy needs the VAPID
 * pair, because leave-by push silently sends nothing without it; the pulse publish URL and secret stay
 * optional, since an unset pair is the supported "no tracker configured" state.
 */
export const SERVICE_SECRETS = {
  portal: ["DATABASE_URL", "PLAN_FORECAST_SERVICE_TOKEN", "OUTBOUND_PROXY_TOKEN"],
  "engine-service": ["PLAN_FORECAST_SERVICE_TOKEN"],
  "engine-worker": ["DATABASE_URL", "PLAN_FORECAST_SERVICE_TOKEN"],
  "outbound-proxy": [
    "OUTBOUND_PROXY_TOKEN",
    "WEB_PUSH_VAPID_PUBLIC_KEY",
    "WEB_PUSH_VAPID_PRIVATE_KEY",
    "WEB_PUSH_SUBJECT"
  ],
  migrate: ["DATABASE_URL"],
  // A service the export leaves out names its own (`service-extensions.mjs`).
  ...Object.fromEntries(deployServiceExtensions().map((entry) => [entry.service, entry.secrets]))
};

/** Parses a dotenv file into an object; a missing file gives an empty one. */
export function readDotenv(path) {
  const env = {};
  if (!existsSync(path)) return env;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const raw = match[2].trim();
    env[match[1]] = /^(["']).*\1$/.test(raw) ? raw.slice(1, -1) : raw.replace(/\s+#.*$/, "");
  }
  return env;
}

/**
 * Secrets the given services need that are unset, blank or still the placeholder. `env` should be
 * what compose will see: the shell environment layered over `.env`, shell winning, as compose does.
 */
export function findUnusableSecrets(services, env) {
  const names = [...new Set(services.flatMap((service) => SERVICE_SECRETS[service] ?? []))];
  return names.filter((name) => {
    const value = env[name]?.trim();
    return !value || value === PLACEHOLDER;
  });
}
