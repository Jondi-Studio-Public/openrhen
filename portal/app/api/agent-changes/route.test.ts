import { beforeEach, describe, expect, it, vi } from "vitest";

/** The list route's framing: the limit defaults to 20 and is clamped, `before` is a cursor or a 400, and the page comes back as `{ changes, nextCursor }`. */
vi.mock("@/server/runtime-env", () => ({ databaseUrl: () => "postgres://test" }));
vi.mock("@/server/persistence/postgres/sql-pool", () => ({ sqlPool: () => ({}) }));
const store = vi.hoisted(() => ({ listAgentChangesPage: vi.fn() }));
vi.mock("@/server/persistence/postgres/agent-changes", async (original) => ({
  ...(await original<typeof import("@/server/persistence/postgres/agent-changes")>()),
  ...store
}));
vi.mock("@/server/persistence/postgres/ensure-user", () => ({ ensureUser: async () => "user-1" }));
vi.mock("@/server/agent-activity", () => ({ noteAgentCall: () => {} }));

const route = await import("./route");

beforeEach(() => {
  store.listAgentChangesPage.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("GET /api/agent-changes", () => {
  it("returns the changes the store lists", async () => {
    const changes = [
      {
        agent: "openclaw",
        id: "e1",
        at: "2026-10-27T01:00:00.000Z",
        label: "Skipped step",
        status: "applied",
        target: { stateKey: "routineSteps", id: "s1" }
      }
    ];
    store.listAgentChangesPage.mockResolvedValue({ changes, nextCursor: "2026-10-27T01:00:00.000000Z|e1" });
    const response = await route.GET(new Request("http://localhost/api/agent-changes"), undefined);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ changes, nextCursor: "2026-10-27T01:00:00.000000Z|e1" });
  });

  it("refuses a caller that names an agent", async () => {
    const response = await route.GET(
      new Request("http://localhost/api/agent-changes", { headers: { "x-openrhen-agent": "openclaw" } }),
      undefined
    );
    expect(response.status).toBe(403);
    expect(store.listAgentChangesPage).not.toHaveBeenCalled();
  });

  it("lists 20 unless asked for a sensible other number", async () => {
    store.listAgentChangesPage.mockResolvedValue({ changes: [], nextCursor: null });
    for (const query of ["", "?limit=50", "?limit=9999", "?limit=0", "?limit=abc"])
      await route.GET(new Request(`http://localhost/api/agent-changes${query}`), undefined);
    expect(store.listAgentChangesPage.mock.calls.map((call) => call[1])).toEqual([
      { limit: 20 },
      { limit: 50 },
      { limit: 20 },
      { limit: 20 },
      { limit: 20 }
    ]);
  });

  it("passes a cursor on as before, and refuses one that is not a cursor", async () => {
    store.listAgentChangesPage.mockResolvedValue({ changes: [], nextCursor: null });
    const cursor = encodeURIComponent("2026-10-27T01:00:00.123456Z|e1");
    expect(
      (await route.GET(new Request(`http://localhost/api/agent-changes?before=${cursor}`), undefined)).status
    ).toBe(200);
    expect(store.listAgentChangesPage.mock.calls[0]![1]).toEqual({
      limit: 20,
      before: { at: "2026-10-27T01:00:00.123456Z", id: "e1" }
    });
    store.listAgentChangesPage.mockClear();
    for (const bad of ["nonsense", "2026-10-27T01:00:00Z", "yesterday|e1", "2026-10-27T01:00:00Z|"])
      expect(
        (
          await route.GET(
            new Request(`http://localhost/api/agent-changes?before=${encodeURIComponent(bad)}`),
            undefined
          )
        ).status
      ).toBe(400);
    expect(store.listAgentChangesPage).not.toHaveBeenCalled();
  });
});
