import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentTokenError } from "@/server/agent-token-store";

/** The routes' framing: owner only, the status each store refusal maps to, and that a list never leaks a secret. */
vi.mock("@/server/runtime-env", () => ({ databaseUrl: () => "postgres://test" }));
vi.mock("@/server/persistence/postgres/sql-pool", () => ({ sqlPool: () => ({}) }));
const store = vi.hoisted(() => ({
  createAgentToken: vi.fn(),
  listAgentTokens: vi.fn(),
  revokeAgentToken: vi.fn(),
  setAgentTokenDirectWrites: vi.fn()
}));
vi.mock("@/server/agent-token-store", async (original) => ({
  ...(await original<typeof import("@/server/agent-token-store")>()),
  ...store
}));

const collection = await import("./route");
const item = await import("./[id]/route");

const ID = "11111111-1111-4111-8111-111111111111";
const create = (data: unknown, agent?: string) =>
  collection.POST(
    new Request("http://localhost/api/agent-tokens", {
      method: "POST",
      headers: { "content-type": "application/json", ...(agent ? { "x-openrhen-agent": agent } : {}) },
      body: JSON.stringify(data)
    }),
    undefined
  );

beforeEach(() => {
  for (const mock of Object.values(store)) mock.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("POST /api/agent-tokens", () => {
  it("issues a token once, with no-store, and validates scopes against the vocabulary", async () => {
    store.createAgentToken.mockResolvedValue({ token: "pri_secret", summary: { id: ID, name: "companion" } });
    const response = await create({ name: "Companion", scopes: ["read:plan", "propose:capture"] });
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ token: "pri_secret", agentToken: { id: ID, name: "companion" } });
    expect(store.createAgentToken.mock.calls[0]![1]).toMatchObject({
      name: "companion",
      scopes: ["read:plan", "propose:capture"],
      directWrites: {},
      expiresInDays: 90
    });
  });

  it("refuses admin scopes, unknown scopes and unknown direct-write classes with 400", async () => {
    for (const data of [
      { name: "a", scopes: ["admin:tokens"] },
      { name: "a", scopes: ["read:nothing"] },
      { name: "a", scopes: ["read:plan"], directWrites: { settings: "on" } },
      { name: "system", scopes: ["read:plan"] },
      { name: "a", scopes: [] }
    ])
      expect((await create(data)).status, JSON.stringify(data)).toBe(400);
    expect(store.createAgentToken).not.toHaveBeenCalled();
  });

  it("refuses any request that carries an agent identity", async () => {
    expect((await create({ name: "a", scopes: ["read:plan"] }, "scribe")).status).toBe(403);
    expect(store.createAgentToken).not.toHaveBeenCalled();
  });

  it("relays a name clash as 409", async () => {
    store.createAgentToken.mockRejectedValue(new AgentTokenError(409, "already exists"));
    expect((await create({ name: "a", scopes: ["read:plan"] })).status).toBe(409);
  });
});

describe("GET and DELETE", () => {
  it("lists tokens for the owner only", async () => {
    store.listAgentTokens.mockResolvedValue([{ id: ID, name: "a" }]);
    expect(
      (await (await collection.GET(new Request("http://localhost/api/agent-tokens"), undefined)).json()).tokens
    ).toEqual([{ id: ID, name: "a" }]);
    const refused = await collection.GET(
      new Request("http://localhost/api/agent-tokens", { headers: { "x-openrhen-agent": "scribe" } }),
      undefined
    );
    expect(refused.status).toBe(403);
  });

  it("revokes by id, answers 404 for a bad or unknown id, and refuses an agent", async () => {
    store.revokeAgentToken.mockResolvedValue({ id: ID, revokedAt: "2026-10-18T00:00:00.000Z" });
    const call = (id: string, agent?: string) =>
      item.DELETE(
        new Request(`http://localhost/api/agent-tokens/${id}`, {
          method: "DELETE",
          headers: agent ? { "x-openrhen-agent": agent } : {}
        }),
        { params: Promise.resolve({ id }) }
      );
    expect((await call(ID)).status).toBe(200);
    expect((await call("nope")).status).toBe(404);
    expect((await call(ID, "scribe")).status).toBe(403);
    store.revokeAgentToken.mockRejectedValue(new AgentTokenError(404, "That token does not exist."));
    expect((await call("22222222-2222-4222-8222-222222222222")).status).toBe(404);
  });
});

describe("PATCH /api/agent-tokens/[id]", () => {
  const patch = (id: string, body: unknown, agent?: string) =>
    item.PATCH(
      new Request(`http://localhost/api/agent-tokens/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", ...(agent ? { "x-openrhen-agent": agent } : {}) },
        body: typeof body === "string" ? body : JSON.stringify(body)
      }),
      { params: Promise.resolve({ id }) }
    );

  it("sets the direct-write map for the owner and returns the token", async () => {
    store.setAgentTokenDirectWrites.mockResolvedValue({ id: ID, directWrites: { action: "on" } });
    const response = await patch(ID, { directWrites: { action: "on" } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ agentToken: { id: ID, directWrites: { action: "on" } } });
    expect(store.setAgentTokenDirectWrites.mock.calls[0]![1]).toBe(ID);
    expect(store.setAgentTokenDirectWrites.mock.calls[0]![2]).toEqual({ action: "on" });
  });

  it("refuses an agent identity, so an approved agent cannot widen itself", async () => {
    expect((await patch(ID, { directWrites: { action: "on" } }, "scribe")).status).toBe(403);
    expect(store.setAgentTokenDirectWrites).not.toHaveBeenCalled();
  });

  it("answers 404 for a bad id, 400 for a body without directWrites, and relays store refusals", async () => {
    expect((await patch("nope", { directWrites: {} })).status).toBe(404);
    for (const body of ["{", "[]", "null", { other: 1 }]) expect((await patch(ID, body)).status).toBe(400);
    expect(store.setAgentTokenDirectWrites).not.toHaveBeenCalled();
    store.setAgentTokenDirectWrites.mockRejectedValueOnce(new AgentTokenError(400, "not a class"));
    expect((await patch(ID, { directWrites: { settings: "on" } })).status).toBe(400);
    store.setAgentTokenDirectWrites.mockRejectedValueOnce(new AgentTokenError(404, "gone"));
    expect((await patch(ID, { directWrites: {} })).status).toBe(404);
  });
});
