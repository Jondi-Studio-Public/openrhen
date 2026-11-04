import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentProposalError } from "@/server/agent-proposals/errors";

/**
 * The routes' framing: who may propose and resolve, the status each refusal maps to, and that a list is
 * scoped to the calling agent. The store itself is covered by its integration test.
 */
vi.mock("@/server/runtime-env", () => ({ databaseUrl: () => "postgres://test" }));
vi.mock("@/server/persistence/postgres/sql-pool", () => ({ sqlPool: () => ({}) }));
vi.mock("@/server/persistence/postgres/ensure-user", () => ({ ensureUser: async () => "user-1" }));
const store = vi.hoisted(() => ({
  proposeAgentChange: vi.fn(),
  listAgentProposals: vi.fn(),
  resolveAgentProposal: vi.fn(),
  PROPOSAL_LIST_DEFAULT_LIMIT: 20,
  PROPOSAL_LIST_MAX_LIMIT: 200
}));
vi.mock("@/server/agent-proposals/store", () => store);

const collection = await import("./route");
const resolve = await import("./[id]/resolve/route");

const ID = "11111111-1111-4111-8111-111111111111";
const body = { kind: "entity_command", summary: "Move the dentist", payload: { command: "save_project", body: {} } };
const post = (data: unknown, agent?: string) =>
  collection.POST(
    new Request("http://localhost/api/agent-proposals", {
      method: "POST",
      headers: { "content-type": "application/json", ...(agent ? { "x-openrhen-agent": agent } : {}) },
      body: JSON.stringify(data)
    }),
    undefined
  );
const list = (query = "", agent?: string) =>
  collection.GET(
    new Request(`http://localhost/api/agent-proposals${query}`, {
      headers: agent ? { "x-openrhen-agent": agent } : {}
    }),
    undefined
  );
const decide = (data: unknown, agent?: string, id = ID) =>
  resolve.POST(
    new Request(`http://localhost/api/agent-proposals/${id}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(agent ? { "x-openrhen-agent": agent } : {}) },
      body: JSON.stringify(data)
    }),
    { params: Promise.resolve({ id }) }
  );

beforeEach(() => {
  for (const mock of [store.proposeAgentChange, store.listAgentProposals, store.resolveAgentProposal]) mock.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("POST /api/agent-proposals", () => {
  it("passes the request's agent to the store and answers 201 for a new proposal", async () => {
    store.proposeAgentChange.mockResolvedValue({ proposal: { id: ID }, outcome: "created" });
    const response = await post(body, "scribe");
    expect(response.status).toBe(201);
    expect(store.proposeAgentChange.mock.calls[0]![1]).toBe("scribe");
    expect(store.proposeAgentChange.mock.calls[0]![2]).toMatchObject({ basis: "inferred", kind: "entity_command" });
  });

  it("drops the agent's own summary, so the store writes the line the person reads from the payload", async () => {
    store.proposeAgentChange.mockResolvedValue({ proposal: { id: ID }, outcome: "created" });
    await post({ ...body, summary: "Tidy sleep buffer" }, "scribe");
    expect(store.proposeAgentChange.mock.calls[0]![2]).not.toHaveProperty("summary");
    store.proposeAgentChange.mockClear();
    const { summary: _summary, ...withoutSummary } = body;
    expect((await post(withoutSummary, "scribe")).status).toBe(201);
  });

  it("answers 200 when the proposal already existed or was coalesced", async () => {
    store.proposeAgentChange.mockResolvedValue({ proposal: { id: ID }, outcome: "coalesced" });
    expect((await post(body, "scribe")).status).toBe(200);
  });

  it("hands the store no agent when the request names none, and relays its 400", async () => {
    store.proposeAgentChange.mockRejectedValue(new AgentProposalError(400, "Proposals come from a named agent."));
    const response = await post(body);
    expect(store.proposeAgentChange.mock.calls[0]![1]).toBeNull();
    expect(response.status).toBe(400);
  });

  it("relays the cap as a 429 with the cap in the body", async () => {
    store.proposeAgentChange.mockRejectedValue(new AgentProposalError(429, "Over the cap.", { cap: 50 }));
    const response = await post(body, "scribe");
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error: "Over the cap.", cap: 50 });
  });

  it("rejects an invalid proposal before the store", async () => {
    expect((await post({ ...body, summary: "x".repeat(301) }, "scribe")).status).toBe(400);
    expect((await post({ ...body, basis: "guess" }, "scribe")).status).toBe(400);
    expect(store.proposeAgentChange).not.toHaveBeenCalled();
  });
});

describe("GET /api/agent-proposals", () => {
  it("lets the person filter by agent and status", async () => {
    store.listAgentProposals.mockResolvedValue([]);
    expect((await list("?agent=scribe&status=pending&limit=5")).status).toBe(200);
    expect(store.listAgentProposals.mock.calls[0]![2]).toEqual({ agent: "scribe", status: "pending", limit: 5 });
  });

  it("scopes an agent to its own proposals whatever it asks for", async () => {
    store.listAgentProposals.mockResolvedValue([]);
    await list("?agent=someone-else", "scribe");
    expect(store.listAgentProposals.mock.calls[0]![2]).toMatchObject({ agent: "scribe" });
  });

  it("refuses a bad status, limit or agent name", async () => {
    expect((await list("?status=maybe")).status).toBe(400);
    expect((await list("?limit=201")).status).toBe(400);
    expect((await list("?agent=Bad%20Name")).status).toBe(400);
    expect(store.listAgentProposals).not.toHaveBeenCalled();
  });
});

describe("POST /api/agent-proposals/[id]/resolve", () => {
  it("resolves as the person: no agent identity reaches the store", async () => {
    store.resolveAgentProposal.mockResolvedValue({ id: ID, status: "confirmed" });
    const response = await decide({ decision: "confirm", revision: 1 });
    expect(response.status).toBe(200);
    expect(store.resolveAgentProposal.mock.calls[0]!.slice(1)).toEqual([
      null,
      ID,
      { decision: "confirm", revision: 1 }
    ]);
  });

  it("tells the store when an agent is the caller, and relays its 403", async () => {
    store.resolveAgentProposal.mockRejectedValue(new AgentProposalError(403, "Only the owner can confirm."));
    const response = await decide({ decision: "confirm", revision: 1 }, "scribe");
    expect(store.resolveAgentProposal.mock.calls[0]![1]).toBe("scribe");
    expect(response.status).toBe(403);
  });

  it("relays a stale refusal with its diff, and an unknown kind as 422", async () => {
    const conflicts = [{ entity: "project:p1", proposedAgainst: 1, current: 2 }];
    store.resolveAgentProposal.mockRejectedValueOnce(
      new AgentProposalError(409, "Changed.", { stale: true, conflicts })
    );
    const stale = await decide({ decision: "confirm", revision: 1 });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ stale: true, conflicts });
    store.resolveAgentProposal.mockRejectedValueOnce(new AgentProposalError(422, "Unknown kind."));
    expect((await decide({ decision: "confirm", revision: 1 })).status).toBe(422);
  });

  it("refuses a malformed decision or id", async () => {
    expect((await decide({ decision: "maybe" })).status).toBe(400);
    // A confirm must name the revision the card showed; a reject need not.
    expect((await decide({ decision: "confirm" })).status).toBe(400);
    expect((await decide({ decision: "confirm", revision: 1 }, undefined, "not-a-uuid")).status).toBe(404);
    expect(store.resolveAgentProposal).not.toHaveBeenCalled();
  });
});
