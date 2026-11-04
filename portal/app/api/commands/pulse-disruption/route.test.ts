import { beforeEach, describe, expect, it, vi } from "vitest";

const recordDisruption = vi.hoisted(() => vi.fn());
vi.mock("@/server/persistence/state-store", () => ({ getStateStore: () => ({ recordDisruption }) }));

import { DisruptionIncompleteError } from "@/server/persistence/postgres/pulse-disruption";
import { POST } from "./route";

const commandId = "6f1c7a3e-3c1b-4d56-8d7e-0a1b2c3d4e5f";
const call = (payload: unknown) =>
  POST(
    new Request("http://localhost/api/commands/pulse-disruption", { method: "POST", body: JSON.stringify(payload) }),
    { params: Promise.resolve({}) } as never
  );

beforeEach(() => {
  recordDisruption.mockReset();
});

describe("POST /api/commands/pulse-disruption", () => {
  it("records a disruption and names its command id as revertible", async () => {
    recordDisruption.mockResolvedValue({ result: { recorded: true, revertible: commandId }, state: {} });
    const response = await call({
      commandId,
      doing: "Hospital",
      until: "2026-10-28T07:00:00.000Z",
      locationId: "hospital",
      contexts: ["phone"],
      exclusive: true
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ revertible: commandId, result: { recorded: true } });
    expect(recordDisruption).toHaveBeenCalledWith(expect.objectContaining({ exclusive: true, contexts: ["phone"] }));
  });

  it("answers an incomplete disruption with a 422 that carries the missing fields", async () => {
    const body = { code: "disruptionIncomplete", error: "nothing was recorded", missing: ["until"], choices: {} };
    recordDisruption.mockImplementation(async () => {
      throw new DisruptionIncompleteError("nothing was recorded", { ...body } as never);
    });
    const response = await call({ commandId });
    expect(response.status).toBe(422);
    expect(await response.json()).toStrictEqual({ ...body });
  });

  it("rejects a body that is not a command with a 400", async () => {
    expect((await call({ doing: "x" })).status).toBe(400);
    expect((await call({ commandId, exclusive: "yes" })).status).toBe(400);
    expect(recordDisruption).not.toHaveBeenCalled();
  });
});
