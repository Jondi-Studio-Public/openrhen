import { withRoute } from "@/server/logging";
import { deleteActivityImport } from "@/server/persistence/postgres/activity-store";
import { sqlPool } from "@/server/persistence/postgres/sql-pool";
import { databaseUrl } from "@/server/runtime-env";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () => Response.json({ error: "No such activity import." }, { status: 404 });

/** Undoes one import: its events and its record. The owner's own action. */
export const DELETE = withRoute(
  "/api/activity-imports/[id]",
  async (_request: Request, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    if (!UUID.test(id)) return notFound();
    const connectionString = databaseUrl();
    if (!connectionString) return Response.json({ error: "The activity store requires PostgreSQL." }, { status: 503 });
    const result = await deleteActivityImport(sqlPool(connectionString), id);
    return result.deleted ? Response.json(result) : notFound();
  }
);
