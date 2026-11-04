import { withRoute } from "@/server/logging";
import { readDoctorReport } from "@/server/persistence/postgres/doctor";
import { sqlPool } from "@/server/persistence/postgres/sql-pool";
import { databaseUrl } from "@/server/runtime-env";

/**
 * The data health check: a ranked list of what to fix so the engine can work at
 * its best, derived on read. Read-only; there is no switch.
 */
export const GET = withRoute("/api/doctor", async () => {
  const connectionString = databaseUrl();
  if (!connectionString) return Response.json({ error: "Doctor requires PostgreSQL." }, { status: 503 });
  return Response.json(await readDoctorReport(sqlPool(connectionString)));
});
