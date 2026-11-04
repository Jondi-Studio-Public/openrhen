import { createHash } from "node:crypto";
import { withRoute } from "@/server/logging";
import { getStateStore } from "@/server/persistence/state-store";

/**
 * The state document is ~780 KB and the portal re-reads it on every load, reconnect and `state` event, most
 * often to find nothing changed. A weak ETag over the body lets the browser revalidate (`no-cache`) and get a
 * 304 instead of the body, and lets the portal skip re-parsing and re-rendering an identical answer.
 * Weak, because a compressing proxy re-encodes the bytes without changing what they mean.
 */
function etagFor(body: string): string {
  return `W/"${createHash("sha1").update(body).digest("base64url")}"`;
}

function matches(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) return false;
  return ifNoneMatch
    .split(",")
    .map((candidate) => candidate.trim().replace(/^W\//, ""))
    .some((candidate) => candidate === "*" || candidate === etag.replace(/^W\//, ""));
}

export const GET = withRoute("/api/state", async (request: Request) => {
  const state = await getStateStore().get();
  const body = JSON.stringify({ state });
  const etag = etagFor(body);
  // `private` and `vary` because the answer depends on who asks (owner cookie or agent token): a shared cache must
  // never hand one caller's state, or a 304 for it, to another.
  const headers = { etag, "cache-control": "private, no-cache", vary: "Cookie, Authorization" };
  if (matches(request.headers.get("if-none-match"), etag)) return new Response(null, { status: 304, headers });
  return new Response(body, { headers: { ...headers, "content-type": "application/json" } });
});

export const PUT = withRoute("/api/state", async (request: Request) => {
  void request;
  return Response.json(
    { error: "Whole-state writes are disabled. Use validated command endpoints." },
    { status: 405, headers: { Allow: "GET" } }
  );
});
