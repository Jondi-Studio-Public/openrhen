import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The settle route through the real `withRoute`: nothing about the caller is faked below the wrapper, so this
 * proves the principal's scopes and `directWrites` really reach the route (route.test.ts fakes both). A database
 * token holding `write:catch-up` with direct writes on applies; everything else an agent can be is a proposal.
 */
const settleCatchUp = vi.hoisted(() =>
  vi.fn(async () => ({ result: { results: [], closed: false, remaining: 0 }, state: {} }))
);
const proposeAgentChange = vi.hoisted(() =>
  vi.fn(async (_sql: unknown, _agent: string, input: { summary: string }) => ({
    proposal: { id: "p1", summary: input.summary },
    outcome: "created"
  }))
);
vi.mock("@/server/persistence/state-store", () => ({ getStateStore: () => ({ settleCatchUp }) }));
vi.mock("@/server/agent-proposals/store", () => ({ proposeAgentChange }));
vi.mock("@/server/persistence/postgres/sql-pool", () => ({ sqlPool: () => ({}) }));
vi.mock("@/server/runtime-env", () => ({ databaseUrl: () => "postgres://test" }));

import { vouchForRequest, type AgentPrincipal } from "@/server/agent-tokens";
import { POST } from "./route";

const body = {
  commandId: "6f1c7a3e-3c1b-4d56-8d7e-0a1b2c3d4e5f",
  verdicts: [{ entryId: "occurrence:o1", verdict: "skipped" }],
  basis: "stated",
  evidence: "I skipped it Tuesday"
};

const settle = (principal?: AgentPrincipal, headers: Record<string, string> = {}) => {
  const request = new Request("http://localhost/api/commands/catch-up-settle", {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
  if (principal) vouchForRequest(request, principal);
  return POST(request, { params: Promise.resolve({}) } as never);
};

const dbToken = (scopes: string[], directWrites: AgentPrincipal["directWrites"]): AgentPrincipal => ({
  name: "companion",
  source: "db",
  tokenId: "t1",
  scopes,
  directWrites
});

beforeEach(() => {
  settleCatchUp.mockClear();
  proposeAgentChange.mockClear();
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("catch-up settle through withRoute", () => {
  it("applies a database token's settle when it holds write:catch-up and direct writes are on", async () => {
    const response = await settle(dbToken(["read:plan", "write:catch-up"], { action: "on" }));
    expect(response.status).toBe(200);
    expect(settleCatchUp).toHaveBeenCalledOnce();
    expect(proposeAgentChange).not.toHaveBeenCalled();
  });

  it("files a proposal when the Settings switch is off for that token, or every class is shadow", async () => {
    for (const directWrites of [{}, { action: "off" }, { action: "shadow", project: "shadow" }] as const) {
      const response = await settle(dbToken(["read:plan", "write:catch-up"], directWrites));
      expect(response.status, JSON.stringify(directWrites)).toBe(202);
    }
    expect(settleCatchUp).not.toHaveBeenCalled();
    expect(proposeAgentChange).toHaveBeenCalledTimes(3);
  });

  it("files a proposal for a token with only propose:catch-up, however its direct writes are set", async () => {
    const response = await settle(dbToken(["read:plan", "propose:catch-up"], { action: "on", project: "on" }));
    expect(response.status).toBe(202);
    expect(settleCatchUp).not.toHaveBeenCalled();
  });

  it("files a proposal for an environment token and for a name given only in the header", async () => {
    const env = await settle({ name: "envagent", source: "env", directWrites: {} });
    expect(env.status).toBe(202);
    const header = await settle(undefined, { "x-openrhen-agent": "companion" });
    expect(header.status).toBe(202);
    expect(settleCatchUp).not.toHaveBeenCalled();
    expect(proposeAgentChange).toHaveBeenCalledTimes(2);
    expect(proposeAgentChange).toHaveBeenLastCalledWith(
      expect.anything(),
      "companion",
      expect.objectContaining({ kind: "settle_catch_up" }),
      { origin: "server" }
    );
  });

  it("still applies the person's own settle", async () => {
    const response = await settle();
    expect(response.status).toBe(200);
    expect(settleCatchUp).toHaveBeenCalledOnce();
  });
});
