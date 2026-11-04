import { defineConfig } from "vitest/config";

/**
 * Every suite here derives its own `<base>_<suffix>_test` database (and the grants suite its own
 * role), so files run side by side. Four workers, for the same connection budget the portal's
 * integration config sets out — raised from two on 2026-09-10.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.integration.test.ts"],
    globalSetup: ["./vitest-global-setup.ts"],
    // Drops each file's database once the file finishes, so a run never holds them all at once.
    setupFiles: ["./vitest-integration-file-cleanup.ts"],
    fileParallelism: true,
    maxWorkers: Number(process.env.INTEGRATION_MAX_WORKERS) || 4,
    testTimeout: 30_000
  }
});
