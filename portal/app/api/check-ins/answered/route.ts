import { withRoute } from "@/server/logging";
import { ensureUser } from "@/server/persistence/postgres/ensure-user";
import { decodeAnsweredCursor, readAnsweredCheckIns } from "@/server/persistence/postgres/readers/check-in-read";
import { sqlPool } from "@/server/persistence/postgres/sql-pool";
import { databaseUrl } from "@/server/runtime-env";

/**
 * Answered check-ins with their ids, newest answer first, so a reader can find one to tag
 * (`tag_check_in`) or quote. `since` and `before` are ISO 8601 instants on the answer time (page back by passing the
 * last `answeredAt` as `before`); `limit` defaults to 20 and is capped at 100.
 * `before` is a timestamp only, so paging back with it can skip rows that share the last instant. `next` in the
 * result (null on the last page), sent back as `cursor`, pages on (answer time to the microsecond, id) and never skips
 * or repeats; `cursor` and `before` do not combine. `untagged=1` keeps check-ins with no tag, `with-words=1` those
 * where the owner left words.
 */
export const GET = withRoute("/api/check-ins/answered", async (request) => {
  const params = new URL(request.url).searchParams;
  const instant = (name: string): Date | null | "bad" => {
    const raw = params.get(name);
    if (raw === null || raw === "") return null;
    const at = new Date(raw);
    return Number.isNaN(at.getTime()) ? "bad" : at;
  };
  const since = instant("since");
  const before = instant("before");
  if (since === "bad" || before === "bad")
    return Response.json({ error: "since and before must be ISO 8601 times." }, { status: 400 });
  const rawLimit = params.get("limit");
  const limit = rawLimit === null || rawLimit === "" ? undefined : Number(rawLimit);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1))
    return Response.json({ error: "limit must be a whole number of 1 or more (at most 100)." }, { status: 400 });
  const rawCursor = params.get("cursor");
  let cursor: ReturnType<typeof decodeAnsweredCursor> = null;
  if (rawCursor !== null && rawCursor !== "") {
    if (before)
      return Response.json(
        {
          error:
            "Send cursor or before, not both: cursor is the next value from the previous result; before is an ISO 8601 time. Omit before to page with cursor."
        },
        { status: 400 }
      );
    cursor = decodeAnsweredCursor(rawCursor);
    if (!cursor)
      return Response.json(
        {
          error:
            "cursor must be the next value from the previous result, copied exactly. Omit cursor to start from the newest answer."
        },
        { status: 400 }
      );
  }
  const flag = (name: string): boolean | "bad" => {
    const raw = params.get(name);
    if (raw === null || raw === "" || raw === "0" || raw === "false") return false;
    return raw === "1" || raw === "true" ? true : "bad";
  };
  const untagged = flag("untagged");
  const withWords = flag("with-words");
  for (const [name, value] of [
    ["untagged", untagged],
    ["with-words", withWords]
  ] as const)
    if (value === "bad")
      return Response.json(
        { error: `${name} must be 1 or left out. Send ${name}=1, or omit ${name}.` },
        { status: 400 }
      );
  const connectionString = databaseUrl();
  if (!connectionString) return Response.json({ error: "Check-ins require PostgreSQL." }, { status: 503 });
  const sql = sqlPool(connectionString);
  const userId = await ensureUser(sql);
  const result = await readAnsweredCheckIns(sql, userId, {
    ...(since ? { since } : {}),
    ...(before ? { before } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(cursor ? { cursor } : {}),
    ...(untagged === true ? { untagged: true } : {}),
    ...(withWords === true ? { withWords: true } : {})
  });
  return Response.json(result);
});
