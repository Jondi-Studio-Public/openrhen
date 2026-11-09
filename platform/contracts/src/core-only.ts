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
  const restore = enterCoreOnly();
  try {
    return run();
  } finally {
    restore();
  }
}

/**
 * The same cut-back as `withoutContractsExtensions`, for a test suite that is async and so cannot run inside a
 * callback: call it in `beforeAll` and call the function it returns in `afterAll`. Test-only. A core integration test
 * that reads the live registry (data-flow, doctor, attention) asserts core's own sets, which a composed build's
 * extensions would otherwise change; a suite that covers extensions registers its fixture after entering core-only,
 * and the restore removes it again. Vitest runs each test file in its own module registry, so one file's cut-back
 * cannot reach another.
 */
export function enterCoreOnly(): () => void {
  const restoreExtensions = suspendContractsExtensions();
  const held = [...manifests];
  manifests.splice(0, manifests.length, ...BUILTIN_CONNECTIONS);
  return () => {
    manifests.splice(0, manifests.length, ...held);
    restoreExtensions();
  };
}
