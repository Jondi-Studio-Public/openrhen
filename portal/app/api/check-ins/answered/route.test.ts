import { beforeEach, describe, expect, it, vi } from "vitest";

const reader = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("@/server/runtime-env", () => ({ databaseUrl: () => "postgres://test" }));
vi.mock("@/server/persistence/postgres/sql-pool", () => ({ sqlPool: () => ({}) }));
vi.mock("@/server/persistence/postgres/ensure-user", () => ({ ensureUser: async () => "user-1" }));
vi.mock("@/server/persistence/postgres/readers/check-in-read", () => ({ readAnsweredCheckIns: reader.read }));

const { GET } = await import("./route");
const get = (query = "") => GET(new Request(`http://portal.test/api/check-ins/answered${query}`), undefined);

beforeEach(() => {
  reader.read.mockReset().mockResolvedValue([{ id: "c1", status: "deviated", tags: [] }]);
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("GET /api/check-ins/answered", () => {
  it("lists with the defaults when no query is given", async () => {
    const response = await get();
    expect(reader.read).toHaveBeenCalledWith({}, "user-1", {});
    expect((await response.json()).checkIns).toEqual([{ id: "c1", status: "deviated", tags: [] }]);
  });

  it("passes since, before and limit through as typed values", async () => {
    await get("?since=2026-11-01T00:00:00Z&before=2026-11-09T00:00:00Z&limit=5");
    expect(reader.read).toHaveBeenCalledWith({}, "user-1", {
      since: new Date("2026-11-01T00:00:00Z"),
      before: new Date("2026-11-09T00:00:00Z"),
      limit: 5
    });
  });

  it.each(["?since=yesterday", "?before=nope", "?limit=0", "?limit=abc", "?limit=1.5"])(
    "refuses %s with 400",
    async (query) => {
      const response = await get(query);
      expect(response.status).toBe(400);
      expect(reader.read).not.toHaveBeenCalled();
    }
  );
});
