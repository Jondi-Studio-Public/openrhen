import type { ModelCallRow } from "@/server/derived/call-policy";
import type { PoolSql } from "./sql-pool";

/**
 * `derived_model_calls`: the append-only audit of model sends (event key, tier, model, token counts and a short
 * reason; never message text or a key). `recordModelCall` is the only writer; the table refuses UPDATE.
 */
export async function recordModelCall(sql: PoolSql, userId: string, call: ModelCallRow): Promise<void> {
  await sql`
    INSERT INTO derived_model_calls (user_id, source_event_key, tier, model, tokens_in, tokens_out, reason)
    VALUES (${userId}, ${call.sourceEventKey}, ${call.tier}, ${call.model}, ${call.tokensIn}, ${call.tokensOut}, ${call.reason})`;
}

/** Hosted (`t3`) sends in the last 24 hours and the tokens they used (in plus out): what the daily caps count. */
export async function hostedUsageLast24Hours(
  sql: PoolSql,
  userId: string
): Promise<{ messages: number; tokens: number }> {
  const [row] = await sql<{ messages: string; tokens: string }[]>`
    SELECT count(*)::text AS messages, COALESCE(sum(tokens_in + tokens_out), 0)::text AS tokens
    FROM derived_model_calls
    WHERE user_id = ${userId} AND tier = 't3' AND at > now() - interval '24 hours'`;
  return { messages: Number(row?.messages ?? 0), tokens: Number(row?.tokens ?? 0) };
}
