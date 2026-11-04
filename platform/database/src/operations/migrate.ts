import { config } from "dotenv";
import { resolve } from "node:path";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDatabase } from "../index.js";

config({ path: resolve(process.cwd(), "../../.env"), quiet: true });

const { db, close } = createDatabase();
try {
  await migrate(db, { migrationsFolder: resolve(process.cwd(), "drizzle") });
} finally {
  await close();
}
