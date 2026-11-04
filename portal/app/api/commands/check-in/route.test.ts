import { beforeEach, describe, expect, it, vi } from "vitest";

const runCheckInCommand = vi.hoisted(() => vi.fn(async () => ({ marker: "state" })));
const agent = vi.hoisted(() => ({ name: null as string | null }));
vi.mock("@/server/persistence/state-store", () => ({ getStateStore: () => ({ runCheckInCommand }) }));
vi.mock("@/server/agent-actor", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/agent-actor")>()),
  requestAgent: () => agent.name
}));

import { POST } from "./route";

const body = {
  commandId: "6f1c7a3e-3c1b-4d56-8d7e-0a1b2c3d4e5f",
  expectedVersion: 3,
  type: "answer_check_in",
  checkInId: "e9f6ac30-f59f-4852-a65b-d3074da3b090",
  status: "on_track",
  answerSource: "sheet"
};

const call = (payload: unknown) =>
  POST(new Request("http://localhost/api/commands/check-in", { method: "POST", body: JSON.stringify(payload) }), {
    params: Promise.resolve({})
  } as never);

beforeEach(() => {
  runCheckInCommand.mockClear();
  agent.name = null;
});

describe("POST /api/commands/check-in", () => {
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

  it("accepts a voluntary check-in that names no check-in id", async () => {
    const { checkInId: _omitted, ...rest } = body;
    const response = await call({ ...rest, type: "voluntary_check_in", expectedVersion: null });
    expect(response.status).toBe(200);
    expect(runCheckInCommand).toHaveBeenCalledOnce();
  });

  it("rejects an invalid answer without running it", async () => {
    agent.name = "companion";
    expect((await call({ ...body, status: "maybe" })).status).toBe(400);
    expect(runCheckInCommand).not.toHaveBeenCalled();
  });
});
