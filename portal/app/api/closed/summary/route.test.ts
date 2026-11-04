import { beforeEach, describe, expect, it, vi } from "vitest";

/** The badge route: owner only, `no-store`, and the reader's answer as it is. */
vi.mock("@/server/runtime-env", () => ({ databaseUrl: () => "postgres://test" }));
vi.mock("@/server/persistence/postgres/sql-pool", () => ({ sqlPool: () => ({}) }));
const store = vi.hoisted(() => ({ readClosedSummary: vi.fn() }));
vi.mock("@/server/persistence/postgres/readers/closed", async (original) => ({
  ...(await original<typeof import("@/server/persistence/postgres/readers/closed")>()),
  ...store
}));
vi.mock("@/server/persistence/postgres/ensure-user", () => ({ ensureUser: async () => "user-1" }));
vi.mock("@/server/agent-activity", () => ({ noteAgentCall: () => {} }));

const route = await import("./route");

beforeEach(() => {
  store.readClosedSummary.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("GET /api/closed/summary", () => {
  it("answers with the count and the latest time, read at the current time", async () => {
    store.readClosedSummary.mockResolvedValue({ agentLast24h: 2, latestAt: "2026-11-04T10:00:00.000Z" });
    const before = Date.now();
    const response = await route.GET(new Request("http://localhost/api/closed/summary"), undefined);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({ agentLast24h: 2, latestAt: "2026-11-04T10:00:00.000Z" });
    const now = store.readClosedSummary.mock.calls[0]![2] as Date;
    expect(now.getTime()).toBeGreaterThanOrEqual(before);
  });

  it("refuses a caller that names an agent", async () => {
    const response = await route.GET(
      new Request("http://localhost/api/closed/summary", { headers: { "x-openrhen-agent": "openclaw" } }),
      undefined
    );
    expect(response.status).toBe(403);
    expect(store.readClosedSummary).not.toHaveBeenCalled();
  });
});
