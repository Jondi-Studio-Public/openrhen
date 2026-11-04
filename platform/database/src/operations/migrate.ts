import { config } from "dotenv";
import { resolve } from "node:path";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDatabase } from "../index.js";
import { loadMigrationSets, migratorOptions } from "./migration-sets.js";

config({ path: resolve(process.cwd(), "../../.env"), quiet: true });

const { db, close } = createDatabase();
try {
  // Core first, then the add-on set when ./addon-drizzle (or ADDON_MIGRATIONS_FOLDER) holds a journal. Dev only:
  // baseline adoption belongs to migrate-on-deploy.
  const { all } = loadMigrationSets({ coreFolder: resolve(process.cwd(), "drizzle") });
  for (const set of all) await migrate(db, migratorOptions(set));
} finally {
  await close();
}
