import { beforeEach, describe, expect, it, vi } from "vitest";

/** The source-settings route's framing: bad input is a 400 that says what to send, and the retention note reaches the owner. */
vi.mock("@/server/runtime-env", () => ({ databaseUrl: () => "postgres://test" }));
vi.mock("@/server/persistence/postgres/sql-pool", () => ({ sqlPool: () => ({}) }));
const store = vi.hoisted(() => {
  class ActivityInputError extends Error {
    constructor(
      message: string,
      readonly status: 400 | 404 = 400
    ) {
      super(message);
    }
  }
  return { ActivityInputError, setActivitySourceSettings: vi.fn(), purgeActivitySource: vi.fn() };
});
vi.mock("@/server/persistence/postgres/activity-store", () => store);

const settings = await import("./[source]/route");
const purge = await import("./[source]/events/route");

const put = (body: unknown) =>
  settings.PUT(
    new Request("http://localhost/api/activity-sources/spotify", { method: "PUT", body: JSON.stringify(body) }),
    { params: Promise.resolve({ source: "spotify" }) } as never
  );

beforeEach(() => {
  store.setActivitySourceSettings.mockReset();
  store.purgeActivitySource.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("PUT /api/activity-sources/[source]", () => {
  it("returns the store's answer, including the retention note", async () => {
    store.setActivitySourceSettings.mockResolvedValue({
      source: "spotify",
      contentEnabled: false,
      retentionDays: 90,
      retentionRuns: true,
      note: "Retention is saved. Expired events are deleted automatically."
    });
    const response = await put({ retentionDays: 90 });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      retentionRuns: true,
      note: expect.stringContaining("deleted automatically")
    });
    expect(store.setActivitySourceSettings.mock.calls[0]![2]).toEqual({ retentionDays: 90 });
  });

  it("answers a body it cannot read, or an unknown source, with a 400 or 404 that says what to send", async () => {
    expect((await put({ retentionDays: 0 })).status).toBe(400);
    expect((await put({ surprise: true })).status).toBe(400);
    store.setActivitySourceSettings.mockRejectedValue(new store.ActivityInputError('Source "x" is not known.', 404));
    expect((await put({ contentEnabled: true })).status).toBe(404);
  });
});

describe("DELETE /api/activity-sources/[source]/events", () => {
  it("purges the source and says how many went", async () => {
    store.purgeActivitySource.mockResolvedValue({ removed: 12 });
    const response = await purge.DELETE(new Request("http://localhost/x", { method: "DELETE" }), {
      params: Promise.resolve({ source: "spotify" })
    });
    expect(await response.json()).toEqual({ removed: 12 });
  });
});
