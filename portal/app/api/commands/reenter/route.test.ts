import { beforeEach, describe, expect, it, vi } from "vitest";

const reenter = vi.hoisted(() => vi.fn());
vi.mock("@/server/persistence/state-store", () => ({ getStateStore: () => ({ reenter }) }));

import { ReentryIncompleteError } from "@/server/persistence/postgres/reenter";
import { POST } from "./route";

const commandId = "6f1c7a3e-3c1b-4d56-8d7e-0a1b2c3d4e5f";
const call = (payload: unknown) =>
  POST(new Request("http://localhost/api/commands/reenter", { method: "POST", body: JSON.stringify(payload) }), {
    params: Promise.resolve({})
  } as never);

beforeEach(() => {
  reenter.mockReset();
});

describe("POST /api/commands/reenter", () => {
  it("applies a valid command and names its command id as revertible", async () => {
    reenter.mockResolvedValue({ result: { reentered: true, revertible: commandId }, state: {} });
    const response = await call({ commandId, locationId: "home", energy: "low", contexts: [] });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ revertible: commandId, result: { reentered: true } });
    expect(reenter).toHaveBeenCalledWith(expect.objectContaining({ locationId: "home", contexts: [] }));
  });

  it("answers an incomplete re-entry with a 422 that carries the missing list", async () => {
    const body = { code: "reentryIncomplete", error: "nothing was written", tier: "today", missing: ["energy"] };
    reenter.mockImplementation(async () => {
      throw new ReentryIncompleteError("nothing was written", { ...body } as never);
    });
    const response = await call({ commandId });
    expect(response.status).toBe(422);
    expect(await response.json()).toStrictEqual({ ...body });
  });

  it("gives an empty body a command id of its own, so the refusal can say what is missing", async () => {
    const body = {
      code: "reentryIncomplete",
      error: "nothing was written",
      tier: "today",
      missing: ["energy", "contexts"]
    };
    reenter.mockImplementation(async () => {
      throw new ReentryIncompleteError("nothing was written", { ...body } as never);
    });
    for (const payload of [{}, { locationId: "home" }]) {
      const response = await call(payload);
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ missing: ["energy", "contexts"] });
    }
    expect(reenter).toHaveBeenCalledWith(
      expect.objectContaining({ commandId: expect.stringMatching(/^[0-9a-f-]{36}$/) })
    );
  });

  it("rejects a body that is not a command with a 400", async () => {
    expect((await call(null)).status).toBe(400);
    expect((await call([])).status).toBe(400);
    expect((await call({ commandId, energy: "tired" })).status).toBe(400);
    expect(reenter).not.toHaveBeenCalled();
  });
});
