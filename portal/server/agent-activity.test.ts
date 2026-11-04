import { beforeEach, describe, expect, it, vi } from "vitest";

/** The recorder behind agent time: which routes count, one write at a time per agent, and a failure never escapes. */
const recorded = vi.hoisted(() => ({ calls: [] as unknown[], fail: false, running: 0, overlapped: false }));
vi.mock("@/server/runtime-env", () => ({ databaseUrl: () => "postgres://test" }));
vi.mock("@/server/persistence/postgres/sql-pool", () => ({ sqlPool: () => ({}) }));
vi.mock("@/server/agent-session-store", () => ({
  recordAgentCall: async (_sql: unknown, input: unknown) => {
    recorded.running += 1;
    if (recorded.running > 1) recorded.overlapped = true;
    await new Promise((resolve) => setTimeout(resolve, 5));
    recorded.running -= 1;
    if (recorded.fail) throw new Error("table is missing");
    recorded.calls.push(input);
  }
}));

const { countsAsAgentWork, noteAgentCall } = await import("./agent-activity");

beforeEach(() => {
  recorded.calls = [];
  recorded.fail = false;
  recorded.overlapped = false;
});

describe("countsAsAgentWork", () => {
  it("skips probes, the CLI version check and the agent-time route itself", () => {
    for (const route of ["/api/health/database", "/api/cli/version", "/api/cli/bundle", "/api/agent-sessions"])
      expect(countsAsAgentWork(route), route).toBe(false);
    for (const route of ["/api/state", "/api/commands/session", "/api/agent-proposals", "/api/healthy-things"])
      expect(countsAsAgentWork(route), route).toBe(true);
  });
});

describe("noteAgentCall", () => {
  it("records a read and a write with the route template, never a body", async () => {
    noteAgentCall("companion", "/api/state", "GET");
    await noteAgentCall("companion", "/api/commands/session", "POST");
    expect(recorded.calls).toEqual([
      { agent: "companion", route: "/api/state", write: false },
      { agent: "companion", route: "/api/commands/session", write: true }
    ]);
  });

  it("records nothing for an uncounted route", async () => {
    await noteAgentCall("companion", "/api/agent-sessions", "POST");
    expect(recorded.calls).toEqual([]);
  });

  it("runs one agent's calls one at a time, so two quick calls cannot each open a session", async () => {
    // Each call chains on the one before, so the last one settling means all four have.
    const calls = Array.from({ length: 4 }, () => noteAgentCall("companion", "/api/state", "GET"));
    await calls[3];
    expect(recorded.calls).toHaveLength(4);
    expect(recorded.overlapped).toBe(false);
  });

  it("swallows a store failure", async () => {
    recorded.fail = true;
    await expect(noteAgentCall("companion", "/api/state", "GET")).resolves.toBeUndefined();
    recorded.fail = false;
    await noteAgentCall("companion", "/api/state", "GET");
    expect(recorded.calls).toHaveLength(1);
  });
});
