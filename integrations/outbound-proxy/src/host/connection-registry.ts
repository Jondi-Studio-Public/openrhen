import type { BoundConnection } from "./connection-api.js";

/**
 * Connections the host serves beyond its core list (`bundled-connections.ts`). A folder `drop-ins/<name>/register.ts`
 * adds one by calling `registerConnection` when `src/drop-ins.ts` imports it, so the host builds, serves and tests
 * with none present. Registering an id twice is a no-op.
 */
const registered: BoundConnection[] = [];

export function registerConnection(connection: BoundConnection): void {
  if (!registered.some((existing) => existing.manifest.id === connection.manifest.id)) registered.push(connection);
}

/** In registration order (drop-in folders load sorted by name). */
export function registeredConnections(): readonly BoundConnection[] {
  return registered;
}
