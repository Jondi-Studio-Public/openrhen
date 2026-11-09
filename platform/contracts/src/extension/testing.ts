// Test-only helpers for registries made by createRegistry. Imported as `@openrhen/contracts/testing`, never by
// production code: a registry has no `reset`, because core code must not be able to empty a seam.
import { resetCore } from "./registry-internal.js";
import type { Registry } from "./registry.js";

/** Empties a registry and unfreezes it, so each test starts from the registrations core makes at import time. */
export function resetRegistry<V>(registry: Registry<V>): void {
  resetCore(registry);
}
