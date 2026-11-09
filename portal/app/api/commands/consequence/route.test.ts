import { beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({ url: "postgres://test" as string | undefined }));
vi.mock("@/server/runtime-env", () => ({ databaseUrl: () => env.url }));
vi.mock("@/server/persistence/postgres/sql-pool", () => ({ sqlPool: () => ({}) }));
vi.mock("@/server/persistence/postgres/ensure-user", () => ({ ensureUser: async () => "user-1" }));
vi.mock("@openrhen/database", () => ({ notifyStateChanged: vi.fn() }));
const rank = vi.hoisted(() => vi.fn());
vi.mock("@/server/persistence/postgres/consequence-commands", () => ({ runRankConsequenceGroup: rank }));

import { CommandConflictError } from "@/server/persistence/postgres/command-errors";
import { POST } from "./route";

const commandId = "6f1c7a3e-3c1b-4d56-8d7e-0a1b2c3d4e5f";
const call = (payload: unknown) =>
  POST(new Request("http://localhost/api/commands/consequence", { method: "POST", body: JSON.stringify(payload) }), {
    params: Promise.resolve({})
  } as never);

beforeEach(() => {
  env.url = "postgres://test";
  rank.mockReset();
});

describe("POST /api/commands/consequence", () => {
  it("records a valid answer and returns the result", async () => {
    rank.mockResolvedValue({ result: { comparisonId: "c1", groupId: "g1", replayed: false, by: "person" } });
    const response = await call({ commandId, groupId: "g1", rankedIds: ["a", "b", "c", "d"] });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      result: { comparisonId: "c1", groupId: "g1", replayed: false, by: "person" }
    });
    expect(rank).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ commandId, groupId: "g1", rankedIds: ["a", "b", "c", "d"] })
    );
  });

  it("gives the owner's browser a command id of its own when it sends none, and takes a tie", async () => {
    rank.mockResolvedValue({ result: {} });
    expect((await call({ groupId: "g1", tie: true })).status).toBe(200);
    expect(rank).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ commandId: expect.stringMatching(/^[0-9a-f-]{36}$/), tie: true })
    );
  });

  it("rejects an unreadable body, no order and no tie, and both, with a 400 and writes nothing", async () => {
    expect((await call(null)).status).toBe(400);
    expect((await call([])).status).toBe(400);
    expect((await call({ commandId })).status).toBe(400);
    const neither = await call({ commandId, groupId: "g1" });
    expect(neither.status).toBe(400);
    expect(((await neither.json()) as { error: string }).error).toContain("rankedIds");
    expect((await call({ commandId, groupId: "g1", tie: true, rankedIds: ["a"] })).status).toBe(400);
    expect((await call({ commandId, groupId: "g1", rankedIds: ["a"], wording: "nonsense" })).status).toBe(400);
    expect(rank).not.toHaveBeenCalled();
  });

  it("answers a refusal with a 409 that carries the next call", async () => {
    rank.mockRejectedValue(
      new CommandConflictError("Group g1 was already answered. Nothing was changed. Next: rhen_inbox {}", {
        nextCall: { tool: "rhen_inbox", arguments: { room: "compare" } }
      })
    );
    const response = await call({ commandId, groupId: "g1", tie: true });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ nextCall: { tool: "rhen_inbox" } });
  });

  it("says plainly when the portal has no database", async () => {
    env.url = undefined;
    expect((await call({ commandId, groupId: "g1", tie: true })).status).toBe(503);
    expect(rank).not.toHaveBeenCalled();
  });
});
