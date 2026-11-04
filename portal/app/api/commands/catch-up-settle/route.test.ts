import { beforeEach, describe, expect, it, vi } from "vitest";

const settleCatchUp = vi.hoisted(() =>
  vi.fn(async () => ({ result: { results: [], closed: false, remaining: 0 }, state: {} }))
);
const proposeAgentChange = vi.hoisted(() =>
  vi.fn(async (_sql: unknown, _agent: string, input: { summary: string }) => ({
    proposal: { id: "p1", summary: input.summary },
    outcome: "created"
  }))
);
const agent = vi.hoisted(() => ({
  name: null as string | null,
  scopes: undefined as string[] | undefined,
  directWrites: undefined as Record<string, string> | undefined
}));
vi.mock("@/server/persistence/state-store", () => ({ getStateStore: () => ({ settleCatchUp }) }));
vi.mock("@/server/agent-proposals/store", () => ({ proposeAgentChange }));
vi.mock("@/server/agent-actor", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/agent-actor")>()),
  requestAgent: () => agent.name,
  requestScopes: () => agent.scopes,
  requestDirectWrites: () => agent.directWrites
}));
vi.mock("@/server/persistence/postgres/sql-pool", () => ({ sqlPool: () => ({}) }));
vi.mock("@/server/runtime-env", () => ({ databaseUrl: () => "postgres://test" }));

import { POST } from "./route";

const body = {
  commandId: "6f1c7a3e-3c1b-4d56-8d7e-0a1b2c3d4e5f",
  verdicts: [{ entryId: "occurrence:o1", verdict: "skipped" }],
  basis: "stated",
  evidence: "I skipped it Tuesday"
};

const call = (payload: unknown) =>
  POST(
    new Request("http://localhost/api/commands/catch-up-settle", { method: "POST", body: JSON.stringify(payload) }),
    { params: Promise.resolve({}) } as never
  );

beforeEach(() => {
  settleCatchUp.mockClear();
  proposeAgentChange.mockClear();
  agent.name = null;
  agent.scopes = undefined;
  agent.directWrites = undefined;
});

describe("POST /api/commands/catch-up-settle", () => {
  it("applies the person's settle directly", async () => {
    const response = await call(body);
    expect(response.status).toBe(200);
    expect(settleCatchUp).toHaveBeenCalledOnce();
    expect(proposeAgentChange).not.toHaveBeenCalled();
    expect(await response.json()).not.toHaveProperty("revertible");
  });

  it("names the settle's command id as revertible when an agent's settle changed something, and never on a proposal", async () => {
    agent.name = "companion";
    agent.scopes = ["write:catch-up"];
    agent.directWrites = { action: "on" };
    // Nothing applied and the window stayed open: no snapshot was saved, so there is nothing to revert.
    expect(await (await call(body)).json()).not.toHaveProperty("revertible");
    settleCatchUp.mockResolvedValueOnce({
      result: { results: [{ entryId: "occurrence:o1", outcome: "applied" }], closed: false, remaining: 0 },
      state: {}
    } as never);
    expect(await (await call(body)).json()).toMatchObject({ revertible: body.commandId });
    agent.directWrites = {};
    const held = await call(body);
    expect(held.status).toBe(202);
    expect(await held.json()).not.toHaveProperty("revertible");
  });

  it("applies a settle from a token that holds write:catch-up with direct writes on, whatever its basis", async () => {
    agent.name = "companion";
    agent.scopes = ["read:plan", "write:catch-up"];
    agent.directWrites = { action: "on" };
    for (const basis of [{ basis: "stated" }, { basis: "inferred" }, { basis: "observed" }, {}]) {
      settleCatchUp.mockClear();
      const response = await call({ ...body, ...basis });
      expect(response.status, JSON.stringify(basis)).toBe(200);
      expect(settleCatchUp).toHaveBeenCalledOnce();
    }
    expect(proposeAgentChange).not.toHaveBeenCalled();
  });

  it("applies a write:catch-up settle that drops an entry, uses a bulk form or lists more than 20", async () => {
    agent.name = "companion";
    agent.scopes = ["write:catch-up"];
    agent.directWrites = { action: "on", project: "on" };
    const many = Array.from({ length: 21 }, (_, index) => ({ entryId: `occurrence:o${index}`, verdict: "skipped" }));
    for (const verdicts of [[{ entryId: "occurrence:o1", verdict: "dropped" }], [{ bulk: "all_skipped" }], many])
      expect((await call({ ...body, verdicts })).status).toBe(200);
    expect(settleCatchUp).toHaveBeenCalledTimes(3);
    expect(proposeAgentChange).not.toHaveBeenCalled();
  });

  it("holds a write:catch-up settle as a proposal when direct writes are off or shadow for every class", async () => {
    agent.name = "companion";
    agent.scopes = ["write:catch-up"];
    for (const directWrites of [undefined, {}, { action: "off" }, { action: "shadow", project: "shadow" }]) {
      agent.directWrites = directWrites;
      const response = await call(body);
      expect(response.status, JSON.stringify(directWrites)).toBe(202);
    }
    expect(settleCatchUp).not.toHaveBeenCalled();
    expect(proposeAgentChange).toHaveBeenCalledTimes(4);
  });

  it("holds an agent's settle as a proposal when it has only propose:catch-up, a header name or an env token", async () => {
    agent.name = "companion";
    agent.directWrites = { action: "on" };
    for (const scopes of [["propose:catch-up"], ["write:entity:action"], [], undefined]) {
      agent.scopes = scopes;
      const response = await call(body);
      expect(response.status, JSON.stringify(scopes)).toBe(202);
    }
    expect(settleCatchUp).not.toHaveBeenCalled();
  });

  it("holds an agent's settle as a proposal, whatever its basis", async () => {
    agent.name = "companion";
    const response = await call(body);
    expect(response.status).toBe(202);
    expect(settleCatchUp).not.toHaveBeenCalled();
    expect(proposeAgentChange).toHaveBeenCalledWith(
      expect.anything(),
      "companion",
      expect.objectContaining({ kind: "settle_catch_up", basis: "stated", commandId: body.commandId })
    );
  });

  it("rejects a stated settle without evidence", async () => {
    const { evidence: _evidence, ...unevidenced } = body;
    expect((await call(unevidenced)).status).toBe(400);
    expect(settleCatchUp).not.toHaveBeenCalled();
  });
});
