import { beforeEach, describe, expect, it, vi } from "vitest";

const wakeResult = {
  outcome: "logged_night",
  sleepPlanId: "22222222-2222-4222-8222-222222222222",
  sleptAt: "2026-10-27T22:30:00.000Z",
  wokeAt: "2026-10-28T06:30:00.000Z",
  startAssumed: false
};
const runWakeCommand = vi.hoisted(() =>
  vi.fn(async () => ({ wake: wakeResult as unknown, state: { marker: "state" } }))
);
const agent = vi.hoisted(() => ({ name: null as string | null }));
vi.mock("@/server/persistence/state-store", () => ({ getStateStore: () => ({ runWakeCommand }) }));
vi.mock("@/server/agent-actor", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/agent-actor")>()),
  requestAgent: () => agent.name
}));

import { POST } from "./route";

const body = { commandId: "6f1c7a3e-3c1b-4d56-8d7e-0a1b2c3d4e5f", type: "wake" };

const call = (payload: unknown) =>
  POST(new Request("http://localhost/api/commands/wake", { method: "POST", body: JSON.stringify(payload) }), {
    params: Promise.resolve({})
  } as never);

beforeEach(() => {
  runWakeCommand.mockClear();
  agent.name = null;
});

describe("POST /api/commands/wake", () => {
  it("answers with the state and what the wake settled", async () => {
    const response = await call({ ...body, at: "2026-10-28T06:30:00Z", sleptAt: "2026-10-27T22:30:00Z" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ state: { marker: "state" }, wake: wakeResult });
    expect(runWakeCommand).toHaveBeenCalledWith({
      ...body,
      at: "2026-10-28T06:30:00Z",
      sleptAt: "2026-10-27T22:30:00Z"
    });
  });

  it("names the command id as revertible when an agent made the wake, so one undo reverses it", async () => {
    agent.name = "companion";
    const response = await call(body);
    expect(await response.json()).toEqual({ state: { marker: "state" }, wake: wakeResult, revertible: body.commandId });
  });

  it("answers with the state alone when the command had already been applied", async () => {
    runWakeCommand.mockResolvedValueOnce({ wake: null, state: { marker: "state" } });
    const response = await call(body);
    expect(await response.json()).toEqual({ state: { marker: "state" } });
  });

  it("rejects an invalid command without running it, saying why", async () => {
    for (const payload of [
      { type: "wake" },
      { ...body, at: "this morning" },
      { ...body, at: "2026-10-28T06:30:00Z", sleptAt: "2026-10-28T06:30:00Z" }
    ]) {
      const response = await call(payload);
      expect(response.status).toBe(400);
      expect(typeof ((await response.json()) as { error: unknown }).error).toBe("string");
    }
    expect(runWakeCommand).not.toHaveBeenCalled();
  });
});
