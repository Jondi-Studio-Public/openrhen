import { defineConfig } from "vitest/config";

/**
 * Pure `.test.ts` files — no database, no `globalSetup`. Split out from `vitest.integration.config.ts`
 * the same way the portal's own unit/integration configs are, once this package's first pure-function
 * module (the check-in scheduler) needed somewhere to be unit-tested at all.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["**/*.integration.test.ts"]
  }
});
