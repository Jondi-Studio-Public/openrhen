import { importWatchHistorySchema, WATCH_IMPORT_MAX_BODY_BYTES } from "@openrhen/contracts";
import { withRoute } from "@/server/logging";
import { parseWatchHistoryUpload, WatchHistoryParseError } from "@/server/imports/watch-history-parser";
import { importWatchHistory } from "@/server/persistence/postgres/watch-history-store";
import { sqlPool } from "@/server/persistence/postgres/sql-pool";
import { databaseUrl } from "@/server/runtime-env";

const TOO_LARGE = "That file is too large. Export a shorter date range from Takeout and try again.";

/**
 * Imports a Google Takeout YouTube watch history: a bare `watch-history.json` or the Takeout zip, sent as JSON
 * (`{filename, encoding: "base64" | "text", data}`). Parsed on the server, inserted in batches inside one
 * transaction, and idempotent: uploading the same file again adds nothing. The person's own record: no agent route.
 */
export const POST = withRoute("/api/imports/watch-history", async (request, _context, log) => {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > WATCH_IMPORT_MAX_BODY_BYTES) return Response.json({ error: TOO_LARGE }, { status: 413 });
  const body = await request.text();
  if (Buffer.byteLength(body) > WATCH_IMPORT_MAX_BODY_BYTES)
    return Response.json({ error: TOO_LARGE }, { status: 413 });
  let input: unknown = null;
  try {
    input = JSON.parse(body);
  } catch {
    /* validation below returns a safe error */
  }
  const parsed = importWatchHistorySchema.safeParse(input);
  if (!parsed.success) return Response.json({ error: "Watch history upload validation failed." }, { status: 400 });
  const connectionString = databaseUrl();
  if (!connectionString) return Response.json({ error: "Watch history requires PostgreSQL." }, { status: 503 });
  let history;
  try {
    const bytes =
      parsed.data.encoding === "base64"
        ? new Uint8Array(Buffer.from(parsed.data.data, "base64"))
        : new TextEncoder().encode(parsed.data.data);
    history = await parseWatchHistoryUpload(bytes);
  } catch (error) {
    if (
      error instanceof WatchHistoryParseError ||
      (error instanceof Error && /too large|too many entries/.test(error.message))
    )
      return Response.json({ error: error.message }, { status: 400 });
    log.setError(error);
    return Response.json({ error: "That file could not be read as a Takeout watch history." }, { status: 400 });
  }
  if (history.events.length === 0)
    return Response.json(
      { error: "No watches with a time were found in that file. Choose YouTube, then History, in JSON format." },
      { status: 400 }
    );
  log.setCommandType("import_watch_history");
  return Response.json(await importWatchHistory(sqlPool(connectionString), parsed.data.filename, history));
});
