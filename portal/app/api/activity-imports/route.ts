import { withRoute } from "@/server/logging";
import { findActivityImport, listActivityImports } from "@/server/persistence/postgres/activity-store";
import { sqlPool } from "@/server/persistence/postgres/sql-pool";
import { databaseUrl } from "@/server/runtime-env";

/**
 * `?sha256=<hex>` says whether that file is already held (`{held, importId?, ...}`), so an importer can skip it. With
 * no `sha256` it lists the recent imports. Takes the capture scope (`write:activity-event`); the owner session may always call it.
 */
export const GET = withRoute("/api/activity-imports", async (request) => {
  const connectionString = databaseUrl();
  if (!connectionString) return Response.json({ error: "The activity store requires PostgreSQL." }, { status: 503 });
  const sha256 = new URL(request.url).searchParams.get("sha256");
  const sql = sqlPool(connectionString);
  if (sha256 === null)
    return Response.json({ imports: await listActivityImports(sql) }, { headers: { "cache-control": "no-store" } });
  if (!/^[0-9a-f]{64}$/.test(sha256))
    return Response.json(
      { error: "sha256 must be 64 lowercase hex characters, the SHA-256 of the whole file." },
      { status: 400 }
    );
  return Response.json(await findActivityImport(sql, sha256), { headers: { "cache-control": "no-store" } });
});
