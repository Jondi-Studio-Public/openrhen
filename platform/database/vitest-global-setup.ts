import { resolve } from "node:path";
import { config } from "dotenv";
import { dropIntegrationDatabases, ensureIntegrationDbSuffix } from "./src/operations/integration-database.js";
import { assertLoopbackTestDatabase } from "./src/operations/loopback-test-db.js";

/**
 * Runs once per vitest run, before workers fork: mints the per-run database suffix the suites
 * read through integrationDatabaseName, and drops that run's databases again on teardown. When
 * the suffix (or a suite's pinned name) came from the environment, cleanup is the caller's.
 */
export default function setup() {
  config({ path: resolve(process.cwd(), "../../.env"), quiet: true });
  assertLoopbackTestDatabase();
  const minted = ensureIntegrationDbSuffix();
  return async () => {
    const adminUrl = process.env.POSTGRES_ADMIN_URL;
    if (!minted || !adminUrl) return;
    await dropIntegrationDatabases(adminUrl, minted);
  };
}
