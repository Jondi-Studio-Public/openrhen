import { activitySourceSettingsSchema } from "@openrhen/contracts";
import { withRoute } from "@/server/logging";
import { ActivityInputError, setActivitySourceSettings } from "@/server/persistence/postgres/activity-store";
import { sqlPool } from "@/server/persistence/postgres/sql-pool";
import { databaseUrl } from "@/server/runtime-env";

/**
 * Sets one source's content gate, retention and expected rhythm:
 * `{contentEnabled?: boolean, retentionDays?: number | null, expectedEveryMinutes?: number | null}`. The gate decides
 * whether text is stored from now on (it deletes nothing); `null` retention keeps the source permanently;
 * `expectedEveryMinutes` is how often the owner expects the source to send (a source that reports coverage is late after
 * 3 x that), and `null` returns it to learning its own rhythm.
 */
export const PUT = withRoute(
  "/api/activity-sources/[source]",
  async (request: Request, { params }: { params: Promise<{ source: string }> }) => {
    const { source } = await params;
    const parsed = activitySourceSettingsSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success)
      return Response.json(
        {
          error:
            'Send {"contentEnabled": true|false} and/or {"retentionDays": a whole number of days from 1 to 36500, or null to keep permanently} and/or {"expectedEveryMinutes": a whole number of minutes from 5 to 129600, how often you expect this source to send, or null to clear it}.'
        },
        { status: 400 }
      );
    const connectionString = databaseUrl();
    if (!connectionString) return Response.json({ error: "The activity store requires PostgreSQL." }, { status: 503 });
    try {
      return Response.json(await setActivitySourceSettings(sqlPool(connectionString), source, parsed.data));
    } catch (error) {
      if (error instanceof ActivityInputError) return Response.json({ error: error.message }, { status: error.status });
      throw error;
    }
  }
);
