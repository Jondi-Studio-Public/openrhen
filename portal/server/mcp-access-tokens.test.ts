import { describe, expect, it } from "vitest";
import { MAX_LIVE_ACCESS_TOKENS, trimLiveAccessTokens } from "./mcp-access-tokens";
import type { PoolSql } from "./persistence/postgres/sql-pool";

describe("trimLiveAccessTokens", () => {
  it("deletes only one agent token's live rows beyond the newest cap, oldest first", async () => {
    const calls: { text: string; values: unknown[] }[] = [];
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ text: strings.join("?").replace(/\s+/g, " "), values });
      return Promise.resolve([]);
    }) as unknown as PoolSql;
    const now = new Date("2026-10-19T00:00:00Z");
    await trimLiveAccessTokens(sql, "agent-1", now);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toContain("DELETE FROM agent_access_tokens");
    expect(calls[0]!.text).toContain("agent_token_id = ?");
    expect(calls[0]!.text).toContain("expires_at > ?");
    expect(calls[0]!.text).toContain("ORDER BY created_at DESC");
    expect(calls[0]!.values).toEqual(["agent-1", now, MAX_LIVE_ACCESS_TOKENS]);
    expect(MAX_LIVE_ACCESS_TOKENS).toBe(20);
  });
});
