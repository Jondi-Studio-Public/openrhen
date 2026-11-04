import { describe, expect, it, vi } from "vitest";
import { CommandConflictError, InvalidCommandError } from "@/server/persistence/postgres/command-errors";

const closeEntity = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => ({
    closed: {
      type: "project",
      id: "p1",
      status: "archived",
      version: 3,
      restore: { tool: "rhen_archive", arguments: {} }
    },
    state: { projects: [] }
  }))
);
const requestAgent = vi.hoisted(() => vi.fn<() => string | null>(() => null));
vi.mock("@/server/persistence/state-store", () => ({ getStateStore: () => ({ closeEntity }) }));
vi.mock("@/server/agent-actor", async (original) => ({ ...(await original<object>()), requestAgent }));

import { POST } from "./route";

const post = (body: unknown) =>
  POST(new Request("http://localhost/api/commands/close", { method: "POST", body: JSON.stringify(body) }), {
    params: Promise.resolve({})
  } as never);

const valid = { type: "project", id: "p1", verb: "archive", do: "close" };

describe("POST /api/commands/close", () => {
  it("passes a valid close to the store and answers with the result and the state", async () => {
    requestAgent.mockReturnValue(null);
    const response = await post(valid);
    expect(response.status).toBe(200);
    expect(closeEntity).toHaveBeenCalledWith(valid);
    const body = await response.json();
    expect(body.closed).toMatchObject({ status: "archived", restore: { tool: "rhen_archive" } });
    expect(body.state).toEqual({ projects: [] });
  });

  it("gives an agent's call a command id so it can be undone", async () => {
    requestAgent.mockReturnValue("claude");
    closeEntity.mockClear();
    await post({ ...valid, reason: "done" });
    const sent = closeEntity.mock.calls[0]![0] as { commandId?: string };
    expect(sent.commandId).toMatch(/^[0-9a-f-]{36}$/);
    requestAgent.mockReturnValue(null);
  });

  it("refuses a body without do, a restore without the version, an unknown type and a child list", async () => {
    closeEntity.mockClear();
    expect((await post({ type: "project", id: "p1", verb: "archive" })).status).toBe(400);
    expect((await post({ ...valid, do: "restore" })).status).toBe(400);
    expect((await post({ ...valid, type: "span" })).status).toBe(400);
    // a child list exists only in a stored proposal; the route never takes one
    await post({ ...valid, children: [{ type: "action", id: "a1", version: 1 }] });
    expect(closeEntity.mock.calls.at(-1)![0]).not.toHaveProperty("children");
    expect(closeEntity).toHaveBeenCalledTimes(1);
  });

  it("answers a refusal with its next call and a conflict with the version", async () => {
    closeEntity.mockRejectedValueOnce(
      new InvalidCommandError("Action is doing.", { nextCall: { tool: "rhen_cancel", arguments: { id: "a1" } } })
    );
    const refused = await post({ ...valid, type: "action", verb: "archive" });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ nextCall: { tool: "rhen_cancel" } });
    closeEntity.mockRejectedValueOnce(new CommandConflictError("changed", { currentVersion: 9 }));
    const conflict = await post({ ...valid, expectedVersion: 2 });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ currentVersion: 9 });
  });
});
