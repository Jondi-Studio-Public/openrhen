import { beforeEach, describe, expect, it, vi } from "vitest";

/** The route's framing: only `?peek=1` asks the reader not to stamp `prompted_at`; the owner's surfaces never do. */
const reader = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("@/server/runtime-env", () => ({ databaseUrl: () => "postgres://test" }));
vi.mock("@/server/persistence/postgres/sql-pool", () => ({ sqlPool: () => ({}) }));
vi.mock("@/server/persistence/postgres/ensure-user", () => ({ ensureUser: async () => "user-1" }));
vi.mock("@/server/persistence/postgres/readers/check-in-read", () => ({ readCurrentCheckIn: reader.read }));
vi.mock("@/server/persistence/postgres/photo-checkin-store", () => ({ photoPromptDue: async () => false }));

const { GET } = await import("./route");

const get = (query = "") => GET(new Request(`http://portal.test/api/check-ins/current${query}`), undefined);

beforeEach(() => {
  reader.read.mockReset().mockResolvedValue({ id: "c1", status: "pending" });
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("GET /api/check-ins/current", () => {
  it("stamps by default, as the portal's own poll needs", async () => {
    await get();
    expect(reader.read).toHaveBeenCalledWith({}, "user-1", { stamp: true });
  });

  it("does not stamp on ?peek=1, and still answers the check-in", async () => {
    const response = await get("?peek=1");
    expect(reader.read).toHaveBeenCalledWith({}, "user-1", { stamp: false });
    expect((await response.json()).checkIn).toMatchObject({ id: "c1" });
  });

  it("stamps for any other peek value", async () => {
    await get("?peek=0");
    expect(reader.read).toHaveBeenCalledWith({}, "user-1", { stamp: true });
  });
});
