import { BUILTIN_CONNECTIONS } from "./builtin-connections.js";
import type { ConnectionManifest } from "./manifest.js";

// The package subpath exports (./integrations/*, ./readiness, ./plan-map-navigator) do not load the barrel, so a file that
// imports only a subpath and calls the registry sees the core manifests only.
// A leaf module (no import of the barrel or the registry), so a manifest file under `../private/` can register
// during the barrel's own load without meeting a half-initialised registry.
export const manifests: ConnectionManifest[] = [...BUILTIN_CONNECTIONS];

/**
 * Adds a manifest for a connection the core list does not carry. A feature the OpenRhen export leaves out calls this
 * from `../private/`, which the barrel imports; registering an id twice is a no-op.
 */
export function registerConnectionManifest(manifest: ConnectionManifest): void {
  if (!manifests.some((existing) => existing.id === manifest.id)) manifests.push(manifest);
}
