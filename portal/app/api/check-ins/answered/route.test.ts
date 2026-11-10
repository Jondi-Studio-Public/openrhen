import { beforeEach, describe, expect, it, vi } from "vitest";

const reader = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("@/server/runtime-env", () => ({ databaseUrl: () => "postgres://test" }));
vi.mock("@/server/persistence/postgres/sql-pool", () => ({ sqlPool: () => ({}) }));
vi.mock("@/server/persistence/postgres/ensure-user", () => ({ ensureUser: async () => "user-1" }));
vi.mock("@/server/persistence/postgres/readers/check-in-read", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/persistence/postgres/readers/check-in-read")>()),
  readAnsweredCheckIns: reader.read
}));

const { GET } = await import("./route");
const cursor = Buffer.from("2026-11-10T01:02:03.123456Z|126b15ba-ff40-4a7f-8f3e-b824506a1fcc").toString("base64url");
const get = (query = "") => GET(new Request(`http://portal.test/api/check-ins/answered${query}`), undefined);

beforeEach(() => {
  reader.read.mockReset().mockResolvedValue({ checkIns: [{ id: "c1", status: "deviated", tags: [] }], next: null });
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("GET /api/check-ins/answered", () => {
  it("lists with the defaults when no query is given", async () => {
    const response = await get();
    expect(reader.read).toHaveBeenCalledWith({}, "user-1", {});
    expect(await response.json()).toEqual({ checkIns: [{ id: "c1", status: "deviated", tags: [] }], next: null });
  });

  it("passes since, before and limit through as typed values", async () => {
    await get("?since=2026-11-01T00:00:00Z&before=2026-11-09T00:00:00Z&limit=5");
    expect(reader.read).toHaveBeenCalledWith({}, "user-1", {
      since: new Date("2026-11-01T00:00:00Z"),
      before: new Date("2026-11-09T00:00:00Z"),
      limit: 5
    });
  });

  it("passes the filters and the decoded cursor through", async () => {
    await get(`?limit=5&untagged=1&with-words=true&cursor=${cursor}`);
    expect(reader.read).toHaveBeenCalledWith({}, "user-1", {
      limit: 5,
      untagged: true,
      withWords: true,
      cursor: { answeredAt: "2026-11-10T01:02:03.123456Z", id: "126b15ba-ff40-4a7f-8f3e-b824506a1fcc" }
    });
  });

  it("treats 0, false and an empty flag as not set", async () => {
    await get("?untagged=0&with-words=false");
    expect(reader.read).toHaveBeenCalledWith({}, "user-1", {});
  });

  it.each([
    [`?cursor=${cursor}&before=2026-11-09T00:00:00Z`, /Send cursor or before, not both/],
    ["?cursor=garbage!", /cursor must be the next value from the previous result.*Omit cursor/],
    [`?cursor=${Buffer.from("x|y").toString("base64url")}`, /Omit cursor to start/],
    ["?untagged=yes", /Send untagged=1, or omit untagged/],
    ["?with-words=2", /Send with-words=1, or omit with-words/]
  ])("refuses %s with the fix named", async (query, message) => {
    const response = await get(query);
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(message);
    expect(reader.read).not.toHaveBeenCalled();
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
