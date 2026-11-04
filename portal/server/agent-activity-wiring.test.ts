import { beforeEach, describe, expect, it, vi } from "vitest";

/** `withRoute` counts a request that names an agent toward agent time, and no other. */
const identity = vi.hoisted(() => ({ current: undefined as undefined | { actor: string } }));
vi.mock("@/server/agent-tokens", () => ({
  identifyRequest: async () => identity.current ?? { actor: undefined }
}));
const note = vi.hoisted(() => vi.fn());
vi.mock("@/server/agent-activity", () => ({ noteAgentCall: note }));

const { withRoute } = await import("./logging");

const route = withRoute("/api/state", async () => Response.json({ ok: true }));
const get = () => route(new Request("http://portal.test/api/state"), undefined);

beforeEach(() => {
  note.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("withRoute and agent time", () => {
  it("notes a request from a named agent with its route template and method", async () => {
    identity.current = { actor: "companion" };
    expect((await get()).status).toBe(200);
    expect(note).toHaveBeenCalledWith("companion", "/api/state", "GET");
  });

  it("notes nothing for a person", async () => {
    identity.current = undefined;
    await get();
    expect(note).not.toHaveBeenCalled();
  });
});
