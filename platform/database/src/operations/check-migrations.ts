import { config } from "dotenv";
import { resolve } from "node:path";
import postgres from "postgres";
import { coreLegacyRows, loadMigrationSets } from "./migration-sets.js";
import { checkDatabaseMigrations, readLedgerRows, skippedMigrationsMessage } from "./skipped-migrations.js";

/**
 * Read-only: report which bundled migrations (core, and the add-on set when present) DATABASE_URL has not applied, and exit 1 if any was skipped
 * (`skipped-migrations.ts`). Runs one SELECT on drizzle.__drizzle_migrations and changes nothing.
 */
config({ path: resolve(process.cwd(), "../../.env"), quiet: true });

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const sql = postgres(url, { max: 1, connect_timeout: 15, onnotice: () => undefined });
try {
  const { core, addon } = loadMigrationSets({ coreFolder: resolve(process.cwd(), "drizzle") });
  const result = await checkDatabaseMigrations(sql, core.folder);
  // Core-only installs print exactly the old shape; an add-on set adds its own result under `addon`.
  const addonResult = addon
    ? await checkDatabaseMigrations(sql, addon.folder, addon.table, coreLegacyRows(core, await readLedgerRows(sql)))
    : null;
  console.log(JSON.stringify(addonResult ? { ...result, addon: addonResult } : result));
  if (result.skipped.length > 0) {
    console.error(skippedMigrationsMessage(result.skipped));
    process.exitCode = 1;
  }
  if (addonResult && addonResult.skipped.length > 0) {
    console.error(skippedMigrationsMessage(addonResult.skipped, "__drizzle_migrations_addon"));
    process.exitCode = 1;
  }
} finally {
  await sql.end();
}
