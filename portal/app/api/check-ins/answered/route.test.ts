import { beforeEach, describe, expect, it, vi } from "vitest";

/** The route's framing: query validation answers 400 with the fix, and the reader gets the parsed query. */
const reader = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("@/server/runtime-env", () => ({ databaseUrl: () => "postgres://test" }));
vi.mock("@/server/persistence/postgres/sql-pool", () => ({ sqlPool: () => ({}) }));
vi.mock("@/server/persistence/postgres/ensure-user", () => ({ ensureUser: async () => "user-1" }));
vi.mock("@/server/persistence/postgres/readers/check-in-read", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/persistence/postgres/readers/check-in-read")>()),
  readAnsweredCheckIns: reader.read
}));

const { GET } = await import("./route");

const get = (query = "") => GET(new Request(`http://portal.test/api/check-ins/answered${query}`), undefined);
const cursor = Buffer.from("2026-11-10T01:02:03.123456Z|126b15ba-ff40-4a7f-8f3e-b824506a1fcc").toString("base64url");

beforeEach(() => {
  reader.read.mockReset().mockResolvedValue({ checkIns: [], next: null });
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("GET /api/check-ins/answered", () => {
  it("defaults to 50 rows from the start, with no filter", async () => {
    const response = await get();
    expect(reader.read).toHaveBeenCalledWith({}, "user-1", { limit: 50, untagged: false, withWords: false });
    expect(await response.json()).toEqual({ checkIns: [], next: null });
  });

  it("passes the filters and the decoded cursor through", async () => {
    await get(`?limit=200&untagged=1&with-words=true&after=${cursor}`);
    expect(reader.read).toHaveBeenCalledWith({}, "user-1", {
      limit: 200,
      untagged: true,
      withWords: true,
      after: { answeredAt: "2026-11-10T01:02:03.123456Z", id: "126b15ba-ff40-4a7f-8f3e-b824506a1fcc" }
    });
  });

  it.each([
    ["?limit=0", /limit must be a whole number from 1 to 200.*Send limit=50/],
    ["?limit=201", /from 1 to 200/],
    ["?limit=abc", /got "abc"/],
    ["?limit=", /from 1 to 200/],
    ["?after=garbage!", /after must be the next value from the previous result/],
    [`?after=${Buffer.from("x|y").toString("base64url")}`, /Omit after to start/],
    ["?untagged=yes", /Send untagged=1, or omit untagged/],
    ["?with-words=2", /Send with-words=1/],
    ["?since=today", /Unknown parameter "since".*after, limit, untagged, with-words/]
  ])("refuses %s with the fix named", async (query, message) => {
    const response = await get(query);
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(message);
    expect(reader.read).not.toHaveBeenCalled();
  });
});
