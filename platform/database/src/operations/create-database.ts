import { config } from "dotenv";
import { resolve } from "node:path";
import postgres from "postgres";

config({ path: resolve(process.cwd(), "../../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const databaseName = process.env.TARGET_DATABASE_NAME ?? "rhen";

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required");
if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(databaseName)) {
  throw new Error("TARGET_DATABASE_NAME must contain only letters, numbers, and underscores");
}

const sql = postgres(adminUrl, { max: 1, connect_timeout: 10 });
try {
  const existing = await sql<{ exists: boolean }[]>`
    SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = ${databaseName}) AS exists
  `;
  if (existing[0]?.exists) {
    console.log(`Database ${databaseName} already exists.`);
  } else {
    await sql.unsafe(`CREATE DATABASE "${databaseName}"`);
    console.log(`Database ${databaseName} created.`);
  }
} finally {
  await sql.end();
}
