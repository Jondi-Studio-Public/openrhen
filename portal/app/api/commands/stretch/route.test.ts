import { beforeEach, describe, expect, it, vi } from "vitest";

const runStretchCommand = vi.hoisted(() => vi.fn());
vi.mock("@/server/persistence/state-store", () => ({ getStateStore: () => ({ runStretchCommand }) }));

import { CommandConflictError } from "@/server/persistence/postgres/command-errors";
import { POST } from "./route";

const commandId = "6f1c7a3e-3c1b-4d56-8d7e-0a1b2c3d4e5f";
const call = (payload: unknown) =>
  POST(new Request("http://localhost/api/commands/stretch", { method: "POST", body: JSON.stringify(payload) }), {
    params: Promise.resolve({})
  } as never);

beforeEach(() => {
  runStretchCommand.mockReset();
});

describe("POST /api/commands/stretch", () => {
  it("applies a valid answer and names its command id as revertible", async () => {
    runStretchCommand.mockResolvedValue({ result: { outcome: "accepted", revertible: commandId }, state: {} });
    const response = await call({ commandId, choice: "accept", actionId: "act-1" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ revertible: commandId, result: { outcome: "accepted" } });
    expect(runStretchCommand).toHaveBeenCalledWith(
      expect.objectContaining({ commandId, choice: "accept", actionId: "act-1", basis: "inferred" })
    );
  });

  it("gives the owner's browser a command id of its own when it sends none", async () => {
    runStretchCommand.mockResolvedValue({ result: { revertible: "x" }, state: {} });
    expect((await call({ choice: "decline_all" })).status).toBe(200);
    expect(runStretchCommand).toHaveBeenCalledWith(
      expect.objectContaining({ commandId: expect.stringMatching(/^[0-9a-f-]{36}$/), choice: "decline_all" })
    );
  });

  it("rejects a body that is not an answer with a 400 and writes nothing", async () => {
    expect((await call(null)).status).toBe(400);
    expect((await call([])).status).toBe(400);
    expect((await call({ commandId, choice: "maybe" })).status).toBe(400);
    expect((await call({ commandId, choice: "accept" })).status).toBe(400);
    expect((await call({ commandId, choice: "decline", actionId: "a", basis: "stated" })).status).toBe(400);
    expect(runStretchCommand).not.toHaveBeenCalled();
  });

  it("answers a refusal with a 409 that carries the next call", async () => {
    runStretchCommand.mockRejectedValue(
      new CommandConflictError("There is no stretch offer now. Nothing was changed.", {
        nextCall: { tool: "rhen_status", arguments: {} }
      })
    );
    const response = await call({ commandId, choice: "accept", actionId: "act-1" });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ nextCall: { tool: "rhen_status" } });
  });
});
