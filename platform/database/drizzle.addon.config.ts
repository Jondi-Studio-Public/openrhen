import { defineConfig } from "drizzle-kit";
import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), "../../.env"), quiet: true });

/**
 * Generates the add-on migration set from `src/schema/private/` alone, so `drizzle-kit generate --config
 * drizzle.addon.config.ts` diffs the add-on and not core. Output goes to `addon-drizzle/`, the folder
 * `migrate-on-deploy` reads as the second set. Foreign keys into core tables must come out as plain `REFERENCES`
 * (check the generated SQL); where drizzle-kit cannot, write the migration by hand.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/private/index.ts",
  out: "./addon-drizzle",
  migrations: { table: "__drizzle_migrations_addon", schema: "drizzle" },
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgresql://openrhen:openrhen@localhost:5432/openrhen"
  }
});
