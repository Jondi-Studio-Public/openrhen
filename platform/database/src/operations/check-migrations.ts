import { config } from "dotenv";
import { resolve } from "node:path";
import postgres from "postgres";
import { checkDatabaseMigrations, skippedMigrationsMessage } from "./skipped-migrations.js";

/**
 * Read-only: report which bundled migrations DATABASE_URL has not applied, and exit 1 if any was skipped
 * (`skipped-migrations.ts`). Runs one SELECT on drizzle.__drizzle_migrations and changes nothing.
 */
config({ path: resolve(process.cwd(), "../../.env"), quiet: true });

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const sql = postgres(url, { max: 1, connect_timeout: 15, onnotice: () => undefined });
try {
  const result = await checkDatabaseMigrations(sql, resolve(process.cwd(), "drizzle"));
  console.log(JSON.stringify(result));
  if (result.skipped.length > 0) {
    console.error(skippedMigrationsMessage(result.skipped));
    process.exitCode = 1;
  }
} finally {
  await sql.end();
}
