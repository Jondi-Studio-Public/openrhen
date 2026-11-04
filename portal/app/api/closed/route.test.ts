import { beforeEach, describe, expect, it, vi } from "vitest";

/** The Closed list route's framing: owner only, tab and type validated, limit clamped, `before` a cursor or a 400. */
vi.mock("@/server/runtime-env", () => ({ databaseUrl: () => "postgres://test" }));
vi.mock("@/server/persistence/postgres/sql-pool", () => ({ sqlPool: () => ({}) }));
const store = vi.hoisted(() => ({ readClosed: vi.fn() }));
vi.mock("@/server/persistence/postgres/readers/closed", async (original) => ({
  ...(await original<typeof import("@/server/persistence/postgres/readers/closed")>()),
  ...store
}));
vi.mock("@/server/persistence/postgres/ensure-user", () => ({ ensureUser: async () => "user-1" }));
vi.mock("@/server/agent-activity", () => ({ noteAgentCall: () => {} }));

const route = await import("./route");
const empty = { rows: [], nextCursor: null, counts: { archived: 0, cancelled: 0 } };

beforeEach(() => {
  store.readClosed.mockReset();
  store.readClosed.mockResolvedValue(empty);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

const get = (query = "") => route.GET(new Request(`http://localhost/api/closed${query}`), undefined);

describe("GET /api/closed", () => {
  it("returns the page the reader gives, uncached", async () => {
    const response = await get("?tab=cancelled");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual(empty);
    expect(store.readClosed.mock.calls[0]![2]).toEqual({ tab: "cancelled", limit: 50 });
  });

  it("defaults to the archived tab and passes a type, a limit and a cursor through", async () => {
    await get();
    await get("?tab=archived&type=project&limit=10&before=2026-11-04T10:00:00.123456Z%7Cproject:p1");
    expect(store.readClosed.mock.calls.map((call) => call[2])).toEqual([
      { tab: "archived", limit: 50 },
      { tab: "archived", type: "project", limit: 10, before: "2026-11-04T10:00:00.123456Z|project:p1" }
    ]);
  });

  it("clamps an odd limit to the default", async () => {
    for (const query of ["?limit=0", "?limit=abc", "?limit=9999"]) await get(query);
    expect(store.readClosed.mock.calls.map((call) => call[2].limit)).toEqual([50, 50, 50]);
  });

  it("refuses an unknown tab, an unknown type and a bad cursor with a 400", async () => {
    for (const query of ["?tab=deleted", "?type=capture", "?before=nonsense"]) {
      const response = await get(query);
      expect(response.status).toBe(400);
      expect(typeof (await response.json()).error).toBe("string");
    }
    expect(store.readClosed).not.toHaveBeenCalled();
  });

  it("refuses a caller that names an agent", async () => {
    const response = await route.GET(
      new Request("http://localhost/api/closed", { headers: { "x-openrhen-agent": "openclaw" } }),
      undefined
    );
    expect(response.status).toBe(403);
    expect(store.readClosed).not.toHaveBeenCalled();
  });
});
