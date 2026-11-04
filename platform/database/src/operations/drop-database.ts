import { config } from "dotenv";
import { resolve } from "node:path";
import postgres from "postgres";
import { assertTestDatabaseName } from "./test-database-guard.js";

config({ path: resolve(process.cwd(), "../../.env"), quiet: true });

/**
 * Drops one disposable database by name (`TARGET_DATABASE_NAME`), closing any session still connected to it.
 * The counterpart of `create-database.ts` for the production smoke's seed phase
 * (`scripts/smoke/seed-phase.mjs`), which makes a database of its own and removes it on every way out.
 * Only a name ending in `_test` is ever dropped, and a database that is already gone is not an error.
 */
const adminUrl = process.env.POSTGRES_ADMIN_URL;
const databaseName = process.env.TARGET_DATABASE_NAME;

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required");
if (!databaseName) throw new Error("TARGET_DATABASE_NAME is required");
assertTestDatabaseName(databaseName);

const sql = postgres(adminUrl, { max: 1, connect_timeout: 10, onnotice: () => {} });
try {
  await sql.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  console.log(`Database ${databaseName} dropped.`);
} finally {
  await sql.end();
}
