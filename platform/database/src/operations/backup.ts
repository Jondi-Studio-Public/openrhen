import { config } from "dotenv";
import { resolve } from "node:path";
import postgres from "postgres";
import { writeBackup } from "./backup-run.js";

config({ path: resolve(process.cwd(), "../../.env"), quiet: true });

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const backupDirectory = resolve(process.cwd(), process.env.BACKUP_DIRECTORY ?? "../../var/backups");

const sql = postgres(databaseUrl, { max: 1, connect_timeout: 10, fetch_types: false });
try {
  const result = await writeBackup(sql, { databaseUrl, directory: backupDirectory });
  // `bytes` is logged each run so growth of the JSON toward V8's ~512 MB string limit is visible (S8-16); the streamed
  // sections are separate files and have no such limit.
  console.log(
    JSON.stringify({
      backup: result.path,
      records: result.records,
      bytes: result.bytes,
      checksum: result.checksum,
      ...(result.sections.length
        ? {
            sections: result.sections.map((section) => ({
              path: section.path,
              rows: section.rows,
              bytes: section.bytes,
              sha256: section.sha256
            }))
          }
        : {})
    })
  );
} finally {
  await sql.end();
}
