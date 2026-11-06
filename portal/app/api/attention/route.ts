import { cancelPendingAttentionWakes } from "@openrhen/database";
import { requestAgent, requestScopes } from "@/server/agent-actor";
import { readAttentionCounts } from "@/server/attention/counts";
import { readAttention } from "@/server/attention/read-attention";
import { parseAttentionSince } from "@/server/attention/since";
import { withRoute } from "@/server/logging";
import { ensureUser } from "@/server/persistence/postgres/ensure-user";
import { sqlPool } from "@/server/persistence/postgres/sql-pool";
import { databaseUrl } from "@/server/runtime-env";

/**
 * The agent attention feed: what needs the agent or the owner right
 * now, ranked, with the exact next step. Derived on every call and read-only. `?counts=1` answers only the numbers the
 * status block shows.
 *
 * The answer depends on who asks (owner or agent view, the token's scopes, the agent name), so no cache may keep it.
 */
const HEADERS = {
  "cache-control": "private, no-store",
  vary: "Cookie, Authorization, X-OpenRhen-Token, X-OpenRhen-Agent"
};

const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: HEADERS });

export const GET = withRoute("/api/attention", async (request) => {
  const params = new URL(request.url).searchParams;
  const sinceRead = parseAttentionSince(params.get("since"));
  if (!sinceRead.ok) return reply({ error: sinceRead.error }, 400);
  const connectionString = databaseUrl();
  if (!connectionString)
    return reply({ error: "The attention feed requires PostgreSQL, and the portal has no database right now." }, 503);
  const sql = sqlPool(connectionString);
  const context = { agent: requestAgent(), scopes: requestScopes(), since: sinceRead.since };
  if (params.get("counts") === "1") return reply(await readAttentionCounts(sql, context));
  const result = await readAttention(sql, context);
  if ("lapsed" in result) {
    // The pulse lapsed after the gate read it: the same 428 body the gate builds, with no feed in it.
    const headers = new Headers(result.lapsed.headers);
    for (const [name, value] of Object.entries(HEADERS)) headers.set(name, value);
    return new Response(result.lapsed.body, { status: result.lapsed.status, headers });
  }
  // The feed was just read: a waiting-attention wake not yet sent has done its job. Best effort, never fails the read.
  try {
    await cancelPendingAttentionWakes(sql, await ensureUser(sql));
  } catch {
    // The wake then goes out and the agent finds the feed already read.
  }
  return reply(result.answer);
});
