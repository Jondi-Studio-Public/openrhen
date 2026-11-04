import "./private/index.mjs";
import { onDeployServiceRegistered } from "./service-extensions.mjs";

/**
 * Which services a manual-fallback deploy builds and brings up. Kept apart from deploy-home-server.mjs
 * (which deploys on import) so it can be unit-tested.
 */

/**
 * Each compose service's direct `depends_on` (compose.yaml), for the services that have any.
 * Keep in step with compose.yaml; `service-selection.test.mjs` fails when they drift.
 */
export const DEPENDS_ON = {
  portal: ["engine-service", "outbound-proxy", "migrate"],
  "engine-worker": ["engine-service", "migrate"]
};

/** The services that wait for `migrate` to exit 0 directly: the ones that must not be writing while it runs. */
export const MIGRATE_DEPENDENTS = ["portal", "engine-worker"];

// A registered service adds its dependencies (a core service keeps its own) and, when it waits for migrate, joins the writers.
onDeployServiceRegistered((entry) => {
  DEPENDS_ON[entry.service] = [...new Set([...(DEPENDS_ON[entry.service] ?? []), ...entry.dependsOn])];
  if (DEPENDS_ON[entry.service].includes("migrate") && !MIGRATE_DEPENDENTS.includes(entry.service)) {
    MIGRATE_DEPENDENTS.push(entry.service);
  }
});

/** Whether `migrate` is `service` itself or one of its direct or transitive dependencies. */
export function reachesMigrate(service, seen = new Set()) {
  if (service === "migrate") return true;
  if (seen.has(service)) return false;
  seen.add(service);
  return (DEPENDS_ON[service] ?? []).some((dependency) => reachesMigrate(dependency, seen));
}

/** `services` with every direct and transitive `depends_on`: what `compose up` starts, since it starts dependencies too. */
export function dependencyClosure(services) {
  const closure = new Set();
  const visit = (service) => {
    if (closure.has(service)) return;
    closure.add(service);
    for (const dependency of DEPENDS_ON[service] ?? []) visit(dependency);
  };
  services.forEach(visit);
  return [...closure];
}

/**
 * The request, widened so `migrate` never runs beside live writers. `up` stops each service it recreates
 * before `migrate` starts, so whenever `migrate` is in the dependency closure of a selected service
 * (including `migrate` itself, and a service that reaches it through another), all four direct dependents
 * and `migrate` are deployed too.
 */
export function deployServicesFor(requested) {
  return requested.some((service) => reachesMigrate(service))
    ? [...new Set([...requested, ...MIGRATE_DEPENDENTS, "migrate"])]
    : requested;
}

/**
 * The `up` arguments after `up`. Compose recreates only a container whose image or config changed, and the
 * fallback tags every build `dev`, so a cached rebuild can leave a writer running through the migration.
 * Whenever `migrate` is deployed (every widened run), `--force-recreate` stops and recreates the writers
 * before `migrate` starts; `migrate` is a one-shot, so recreating it just runs it fresh. Runs that never
 * reach `migrate` (engine-service, outbound-proxy) are not force-recreated.
 */
export function upArgsFor(deployServices) {
  return ["-d", "--no-build", ...(deployServices.includes("migrate") ? ["--force-recreate"] : []), ...deployServices];
}
