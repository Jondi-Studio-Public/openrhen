import { beforeEach, describe, expect, it, vi } from "vitest";

/** The ingest route's framing: the agent is the token's name, bad input is a 400 naming where, and the store is told nothing else. */
vi.mock("@/server/runtime-env", () => ({ databaseUrl: () => "postgres://test" }));
vi.mock("@/server/persistence/postgres/sql-pool", () => ({ sqlPool: () => ({}) }));
const store = vi.hoisted(() => ({ ingestAgentSessions: vi.fn(), readAgentTime: vi.fn() }));
vi.mock("@/server/agent-session-store", () => store);
vi.mock("@/server/agent-activity", () => ({ noteAgentCall: () => {} }));

const route = await import("./route");

const session = (extra: Record<string, unknown> = {}) => ({
  id: "oc-1",
  startedAt: new Date(Date.now() - 3_600_000).toISOString(),
  endedAt: new Date(Date.now() - 60_000).toISOString(),
  ...extra
});
const post = (body: unknown, agent?: string) =>
  route.POST(
    new Request("http://localhost/api/agent-sessions", {
      method: "POST",
      headers: { "content-type": "application/json", ...(agent ? { "x-openrhen-agent": agent } : {}) },
      body: JSON.stringify(body)
    }),
    undefined
  );

beforeEach(() => {
  store.ingestAgentSessions.mockReset();
  store.readAgentTime.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("POST /api/agent-sessions", () => {
  it("stores the batch under the agent's own name and returns the per-id results", async () => {
    store.ingestAgentSessions.mockResolvedValue({ schemaVersion: 1, results: [{ id: "oc-1", status: "created" }] });
    const response = await post({ schemaVersion: 1, sessions: [session()] }, "openclaw");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ schemaVersion: 1, results: [{ id: "oc-1", status: "created" }] });
    const [, agent, sessions] = store.ingestAgentSessions.mock.calls[0]!;
    expect(agent).toBe("openclaw");
    expect(sessions).toHaveLength(1);
  });

  it("refuses a caller that is not an agent", async () => {
    expect((await post({ schemaVersion: 1, sessions: [session()] })).status).toBe(403);
    expect(store.ingestAgentSessions).not.toHaveBeenCalled();
  });

  it("answers 400 with the path of what failed, and names the version when that is wrong", async () => {
    const bad = await post(
      { schemaVersion: 1, sessions: [session(), session({ id: "b", endedAt: "2020-01-01T00:00:00Z" })] },
      "openclaw"
    );
    expect(bad.status).toBe(400);
    expect((await bad.json()).issues[0].path).toBe("sessions.1.endedAt");
    const version = await post({ schemaVersion: 2, sessions: [session()] }, "openclaw");
    expect(version.status).toBe(400);
    expect((await version.json()).error).toBe("schemaVersion must be 1.");
    expect(store.ingestAgentSessions).not.toHaveBeenCalled();
  });

  it("refuses a session that ends well after now", async () => {
    const response = await post(
      { schemaVersion: 1, sessions: [session({ endedAt: new Date(Date.now() + 3_600_000).toISOString() })] },
      "openclaw"
    );
    expect(response.status).toBe(400);
    expect(store.ingestAgentSessions).not.toHaveBeenCalled();
  });

  it("answers 400 to a body that is not JSON", async () => {
    const response = await route.POST(
      new Request("http://localhost/api/agent-sessions", {
        method: "POST",
        headers: { "x-openrhen-agent": "openclaw" },
        body: "nope"
      }),
      undefined
    );
    expect(response.status).toBe(400);
  });
});

describe("GET /api/agent-sessions", () => {
  it("reads seven days unless asked for a sensible other number", async () => {
    store.readAgentTime.mockResolvedValue({ totalMinutes: 0 });
    await route.GET(new Request("http://localhost/api/agent-sessions"), undefined);
    await route.GET(new Request("http://localhost/api/agent-sessions?days=30"), undefined);
    await route.GET(new Request("http://localhost/api/agent-sessions?days=9999"), undefined);
    expect(store.readAgentTime.mock.calls.map((call) => call[1])).toEqual([7, 30, 7]);
  });
});
