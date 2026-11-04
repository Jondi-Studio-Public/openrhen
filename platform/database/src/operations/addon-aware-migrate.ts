import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { hasAddon, loadMigrationSets, migratorOptions } from "./migration-sets.js";

/** The shape of drizzle's postgres-js migrator module, as far as the tests' `migrate(db, { migrationsFolder })` uses it. */
type Migrator = {
  migrate: (db: never, config: { migrationsFolder: string } & Record<string, unknown>) => Promise<void>;
};

/**
 * Integration suites build their databases by calling drizzle's `migrate` on core's `drizzle/` folder. A deployment
 * that adds tables of its own (`addon-drizzle/` beside it, with a journal) needs those tables in the same databases,
 * and the suites cannot each know. This wraps the migrator, in one place (the shared setup file
 * `vitest-integration-file-cleanup.ts` mocks the module with it): after a plain `migrate` of a folder named
 * `drizzle` it also applies the sibling add-on set, with that set's own ledger table, exactly as the deploy's
 * `migrate-on-deploy` does on a fresh database. Anything else (a custom ledger table, another folder, a folder
 * with no add-on journal beside it) passes through untouched, so a stock OpenRhen tree behaves as before.
 */
export function addonAwareMigrator<T extends Migrator>(actual: T): T {
  return {
    ...actual,
    async migrate(db, config) {
      await actual.migrate(db, config);
      if (config.migrationsTable || basename(config.migrationsFolder) !== "drizzle") return;
      const folder = resolve(config.migrationsFolder);
      const addonDir = process.env.ADDON_MIGRATIONS_FOLDER || join(dirname(folder), "addon-drizzle");
      if (!existsSync(addonDir) || !hasAddon(addonDir)) return;
      const { addon } = loadMigrationSets({ coreFolder: folder, addonFolder: addonDir });
      if (addon) await actual.migrate(db, migratorOptions(addon));
    }
  };
}
