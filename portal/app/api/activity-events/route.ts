import {
  ACTIVITY_MAX_BODY_BYTES,
  ACTIVITY_READ_MAX_LIMIT,
  withheldActivitySources,
  type ActivityIngestResult
} from "@openrhen/contracts";
import { requestAgent, requestScopes } from "@/server/agent-actor";
import { activityBodyTooLarge, parseActivityBody } from "@/server/activity-ingest";
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

/**
 * One sentence on message copies dropped because another source holds the message (they are part of `alreadyHeld`),
 * ending with the exact next call: the coverage row that reports how far the source has been read.
 */
function duplicatesSentence(duplicates: ActivityIngestResult["duplicates"]): string {
  const byId = duplicates.filter((copy) => copy.by === "message_id").length;
  const byText = duplicates.length - byId;
  const how = [
    byId > 0 ? `${byId} by message id` : null,
    byText > 0 ? `${byText} by matching sender, time and text` : null
  ].filter((part) => part !== null);
  const copies = duplicates.length === 1 ? "1 of those is a copy" : `${duplicates.length} of those are copies`;
  return `${copies} of messages another source already holds (${how.join(", ")}), so nothing is stored for them and nothing needs resending (see "duplicates" for which were dropped and which were kept). To report how far "${duplicates[0]!.source}" has been read, post a coverage row: POST /api/activity-events {"source": "${duplicates[0]!.source}", "kind": "coverage", ...}`;
}

/** Plain English for what happened to a batch: a phone shortcut shows the response body as it is. */
function messageFor(result: ActivityIngestResult): string {
  const parts = [`Saved ${result.added} event${result.added === 1 ? "" : "s"}`];
  if (result.alreadyHeld > 0) parts.push(`${result.alreadyHeld} already held`);
  if (result.duplicates.length > 0) parts.push(duplicatesSentence(result.duplicates));
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
    if (error instanceof BodyTooLargeError) return activityBodyTooLarge();
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
 * `to` exclusive), `limit` (up to 1000) and `after` (the `next` of the previous page). `include=evidence` (limit 100 or
 * less) adds to each `fact` row its span resolved to the mail text, marked untrusted, or `source_removed` /
 * `source_changed`. `as_of` (RFC 3339) reads as the
 * store stood then: rows ingested at or before it, and the derived extractor version that was active at that time.
 * Rows of source `derived` come from the active extractor version only. Content comes back too, so a
 * token needs `read:activity-event`; the owner session may always read. Sources of a class (`health`: physiology and the
 * legacy health sources; `whereabouts`) are left out for a token without that class's read scope, and named in `withheld`
 * with a count per class in `withheldClasses`.
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
  // `as_of` fixes the read in time (rows ingested by then, and the extractor version active then), so it must not be
  // ambiguous: an RFC 3339 time with its offset, not a date alone or a time in the server's zone.
  const asOf = () => {
    const raw = params.get("as_of");
    if (raw === null) return undefined;
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(raw) ||
      Number.isNaN(Date.parse(raw))
    )
      throw new ActivityInputError("as_of must be an RFC 3339 time with its offset, such as 2026-11-07T00:00:00Z.");
    return new Date(raw);
  };
  try {
    const rawLimit = params.get("limit");
    const limit = rawLimit === null ? undefined : Number(rawLimit);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > ACTIVITY_READ_MAX_LIMIT))
      throw new ActivityInputError(`limit must be a whole number from 1 to ${ACTIVITY_READ_MAX_LIMIT}.`);
    const include = params.get("include");
    if (include !== null && include !== "evidence")
      throw new ActivityInputError(
        'include must be "evidence" (resolve each fact\'s span to its mail text) or left out. Repeat the call as GET /api/activity-events?source=derived&kind=fact&include=evidence&limit=100, or drop include.'
      );
    return Response.json(
      await readActivityEvents(sqlPool(connectionString), {
        includeEvidence: include === "evidence",
        source: params.get("source") ?? undefined,
        kind: params.get("kind") ?? undefined,
        from: date("from"),
        to: date("to"),
        asOf: asOf(),
        after: params.get("after") ?? undefined,
        limit,
        // A database token without a class's read scope (read:activity-health, read:activity-whereabouts) does not see that class's sources; the owner and background writers hold no token scopes.
        excludeSources: withheldActivitySources(requestScopes())
      }),
      { headers: { "cache-control": "no-store" } }
    );
  } catch (error) {
    if (error instanceof ActivityInputError) return Response.json({ error: error.message }, { status: error.status });
    throw error;
  }
});
