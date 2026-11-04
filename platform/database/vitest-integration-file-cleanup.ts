import { afterAll } from "vitest";
import { dropTrackedIntegrationDatabases } from "./src/operations/integration-database.js";

/**
 * A setup file, so it runs in every integration test file: once the file's own `afterAll` hooks have
 * closed its connections (vitest runs after-hooks in reverse order, and these are registered
 * first), drop the databases and roles the file named. Without it every file's database stays until
 * the run's teardown, which filled the Mac CI runners' RAM disk. Shared by the portal's config.
 */
afterAll(async () => {
  const adminUrl = process.env.POSTGRES_ADMIN_URL;
  if (!adminUrl) return;
  try {
    await dropTrackedIntegrationDatabases(adminUrl);
  } catch (error) {
    // Best effort: the run's teardown drops whatever is left.
    console.warn("Could not drop this file's integration databases:", error);
  }
});
