import { withRoute } from "@/server/logging";
import { deleteWatchImport } from "@/server/persistence/postgres/watch-history-store";
import { sqlPool } from "@/server/persistence/postgres/sql-pool";
import { databaseUrl } from "@/server/runtime-env";

const notFound = () => Response.json({ error: "No such watch-history import." }, { status: 404 });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Undoes one watch-history import: the import and exactly the events it added (not ones an earlier file held). */
export const DELETE = withRoute(
  "/api/imports/watch-history/[id]",
  async (_request: Request, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    if (!UUID.test(id)) return notFound();
    const connectionString = databaseUrl();
    if (!connectionString) return Response.json({ error: "Watch history requires PostgreSQL." }, { status: 503 });
    return (await deleteWatchImport(sqlPool(connectionString), id)) ? Response.json({ deleted: true }) : notFound();
  }
);
