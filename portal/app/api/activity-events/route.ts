import { ACTIVITY_MAX_BODY_BYTES, ACTIVITY_READ_MAX_LIMIT, type ActivityIngestResult } from "@openrhen/contracts";
import { requestAgent } from "@/server/agent-actor";
import { parseActivityBody } from "@/server/activity-ingest";
import { BodyTooLargeError, readBodyCapped } from "@/server/imports/capped-body";
import { withRoute } from "@/server/logging";
import {
  ActivityInputError,
  ingestActivityEvents,
  readActivityEvents
} from "@/server/persistence/postgres/activity-store";
import { sqlPool } from "@/server/persistence/postgres/sql-pool";
import { databaseUrl } from "@/server/runtime-env";

const NEEDS_DB = "The activity store requires PostgreSQL.";

/** Plain English for what happened to a batch: a phone shortcut shows the response body as it is. */
function messageFor(result: ActivityIngestResult): string {
  const parts = [`Saved ${result.added} event${result.added === 1 ? "" : "s"}`];
  if (result.alreadyHeld > 0) parts.push(`${result.alreadyHeld} already held`);
  if (result.contentDropped > 0)
    parts.push(`text dropped from ${result.contentDropped} (the content gate for that source is off)`);
  if (result.rejected.length > 0)
    parts.push(
      `${result.rejected.length} rejected: ${result.rejected.map((r) => `event ${r.index}: ${r.reason}`).join(" | ")}`
    );
  return `${parts.join("; ")}.`;
}

/**
 * Activity ingest. Takes a batch (`{schema: 1, events: [...]}`, up to 1000 events and 2 MB) or one event in the
 * shorthand (`{source, kind, start, ...}`). A bad event rejects itself, not the batch; a key already held is reported
 * as `alreadyHeld` and changes nothing. `withRoute` has already checked the `write:activity-event` scope.
 */
export const POST = withRoute("/api/activity-events", async (request, _context, log) => {
  let text: string;
  try {
    text = await readBodyCapped(request, ACTIVITY_MAX_BODY_BYTES);
  } catch (error) {
    if (error instanceof BodyTooLargeError)
      return Response.json(
        {
          error: `That request is over ${ACTIVITY_MAX_BODY_BYTES / (1024 * 1024)} MB. Send fewer events per request (at most 1000).`
        },
        { status: 413 }
      );
    throw error;
  }
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    return Response.json(
      {
        error:
          'The body is not valid JSON. Send an object like {"source": "...", "kind": "...", "start": "2026-11-07T14:02:11Z"}.'
      },
      { status: 400 }
    );
  }
  const parsed = parseActivityBody(body);
  if (!parsed.ok) return Response.json({ error: parsed.error, issues: parsed.issues ?? [] }, { status: 400 });
  const connectionString = databaseUrl();
  if (!connectionString) return Response.json({ error: NEEDS_DB }, { status: 503 });
  log.setCommandType("ingest_activity");
  try {
    const result = await ingestActivityEvents(sqlPool(connectionString), parsed.batch, requestAgent());
    const message = messageFor(result);
    // A single shorthand event that was refused is a failed request: the shortcut should show it as one.
    if (parsed.shorthand && result.rejected.length > 0)
      return Response.json({ error: result.rejected[0]!.reason, message, ...result }, { status: 400 });
    return Response.json({ message, ...result });
  } catch (error) {
    if (error instanceof ActivityInputError) return Response.json({ error: error.message }, { status: error.status });
    throw error;
  }
});

/**
 * Reads events back in time order (start, then id) for the predictor: `source`, `kind`, `from` and `to` (RFC 3339,
 * `to` exclusive), `limit` (up to 1000) and `after` (the `next` of the previous page). Content comes back too, so a
 * token needs `read:activity-event`; the owner session may always read.
 */
export const GET = withRoute("/api/activity-events", async (request) => {
  const connectionString = databaseUrl();
  if (!connectionString) return Response.json({ error: NEEDS_DB }, { status: 503 });
  const params = new URL(request.url).searchParams;
  const date = (name: string) => {
    const raw = params.get(name);
    if (raw === null) return undefined;
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime()))
      throw new ActivityInputError(`${name} must be an RFC 3339 time such as 2026-11-07T00:00:00Z.`);
    return parsed;
  };
  try {
    const rawLimit = params.get("limit");
    const limit = rawLimit === null ? undefined : Number(rawLimit);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > ACTIVITY_READ_MAX_LIMIT))
      throw new ActivityInputError(`limit must be a whole number from 1 to ${ACTIVITY_READ_MAX_LIMIT}.`);
    return Response.json(
      await readActivityEvents(sqlPool(connectionString), {
        source: params.get("source") ?? undefined,
        kind: params.get("kind") ?? undefined,
        from: date("from"),
        to: date("to"),
        after: params.get("after") ?? undefined,
        limit
      }),
      { headers: { "cache-control": "no-store" } }
    );
  } catch (error) {
    if (error instanceof ActivityInputError) return Response.json({ error: error.message }, { status: error.status });
    throw error;
  }
});
