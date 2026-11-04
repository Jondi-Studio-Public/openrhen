/**
 * Registry of compose services the OpenRhen export leaves out: the deploy tooling reads its
 * dependency and secret maps from the core plus whatever is registered here. `private/index.mjs` registers each on
 * import; the export excludes that folder and ships an empty `index.mjs`, so the maps hold only the core services.
 */
const services = [];

/** `{ service, dependsOn, secrets, builds }`: the service's direct `depends_on`, the secrets it needs and whether it is built. */
export function registerDeployService(entry) {
  if (!services.some((existing) => existing.service === entry.service)) services.push(entry);
}

export function deployServiceExtensions() {
  return services;
}
