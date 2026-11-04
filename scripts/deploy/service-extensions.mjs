/**
 * Registry of compose services the OpenRhen export leaves out: the deploy tooling reads its
 * dependency and secret maps from the core plus whatever is registered here. `private/index.mjs` registers each on
 * import and `compose-addons.mjs` registers what the merged compose model adds; the export excludes that folder and ships an empty `index.mjs`, so the maps hold only the core services.
 */
const services = [];
const listeners = [];

/** Calls `listener(entry)` for each service registered now or later, so maps built from the registry stay current. */
export function onDeployServiceRegistered(listener) {
  listeners.push(listener);
  services.forEach(listener);
}

/** `{ service, dependsOn, secrets, builds }`: the service's direct `depends_on`, the secrets it needs and whether it is built. */
export function registerDeployService(entry) {
  if (services.some((existing) => existing.service === entry.service)) return;
  services.push(entry);
  listeners.forEach((listener) => listener(entry));
}

export function deployServiceExtensions() {
  return services;
}
