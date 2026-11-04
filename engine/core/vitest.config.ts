import { defineConfig } from "vitest/config";

/**
 * Pure unit tests — no database, no globalSetup — so files already run side by side on every core.
 *
 * The timeout is the only thing worth stating. The system suites under `test/system/` drive the
 * whole engine over generated scenarios (`properties.test.ts` asserts 100 fast-check runs per
 * property) and real captured snapshots, and the heaviest of them sit a little under vitest's 5 s
 * default when the machine is idle. That is no margin at all: this repo expects several agents to
 * run the gate at once, and under that contention they fail as `Test timed out in 5000ms` — a
 * scheduling artefact indistinguishable, in a report, from a real regression. Thirty seconds is far
 * enough above the real cost that a timeout here means the engine got slower, not that the laptop
 * was busy.
 */
export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 30_000
  }
});
