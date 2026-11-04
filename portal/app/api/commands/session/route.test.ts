import { beforeEach, describe, expect, it, vi } from "vitest";

const runSessionCommand = vi.hoisted(() => vi.fn(async () => ({ marker: "state" })));
const agent = vi.hoisted(() => ({ name: null as string | null }));
vi.mock("@/server/persistence/state-store", () => ({ getStateStore: () => ({ runSessionCommand }) }));
vi.mock("@/server/agent-actor", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/agent-actor")>()),
  requestAgent: () => agent.name
}));

import { POST } from "./route";

const body = {
  commandId: "6f1c7a3e-3c1b-4d56-8d7e-0a1b2c3d4e5f",
  expectedVersion: 2,
  type: "pause",
  sessionId: "11111111-1111-4111-8111-111111111111"
};

const call = (payload: unknown) =>
  POST(new Request("http://localhost/api/commands/session", { method: "POST", body: JSON.stringify(payload) }), {
    params: Promise.resolve({})
  } as never);

beforeEach(() => {
  runSessionCommand.mockClear();
  agent.name = null;
});

describe("POST /api/commands/session", () => {
  it("answers the person with the state alone", async () => {
    const response = await call(body);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ state: { marker: "state" } });
  });

  it("names the command id as revertible when an agent made the write", async () => {
    agent.name = "companion";
    const response = await call(body);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ state: { marker: "state" }, revertible: body.commandId });
  });

  it("rejects an invalid command without running it", async () => {
    agent.name = "companion";
    expect((await call({ type: "pause" })).status).toBe(400);
    expect(runSessionCommand).not.toHaveBeenCalled();
  });
});
