import { BUILTIN_CONNECTIONS } from "./connections/builtin-connections.js";
import { manifests } from "./connections/manifest-store.js";
import { suspendContractsExtensions } from "./extensions.js";

/**
 * Runs `run` with only core's contracts: no extension and no registered connection manifest beyond the built-in
 * ones. For a test that holds a file core owns (the OpenClaw plugin's SKILL.md) to core's own text: in a deployment
 * that adds extensions the same test then still compares core with core. With nothing registered (this repository
 * alone) it changes nothing. Synchronous on purpose, so nothing else can read the registries while they are cut back.
 */
export function withoutContractsExtensions<T>(run: () => T): T {
  const restoreExtensions = suspendContractsExtensions();
  const held = [...manifests];
  manifests.splice(0, manifests.length, ...BUILTIN_CONNECTIONS);
  try {
    return run();
  } finally {
    manifests.splice(0, manifests.length, ...held);
    restoreExtensions();
  }
}
