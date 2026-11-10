import { beforeEach, describe, expect, it, vi } from "vitest";
import { CLIENT_VIEW_TYPES } from "@openrhen/contracts";

const store = vi.hoisted(() => ({ mark: vi.fn(), db: "postgres://test" as string | undefined }));
vi.mock("@/server/runtime-env", () => ({ databaseUrl: () => store.db }));
vi.mock("@/server/persistence/postgres/sql-pool", () => ({ sqlPool: () => ({}) }));
vi.mock("@/server/persistence/postgres/ensure-user", () => ({ ensureUser: async () => "user-1" }));
vi.mock("@/server/persistence/postgres/readers/check-in-read", () => ({ markCheckInShown: store.mark }));

const { POST } = await import("./route");

const ID = "6f0c2c1e-3f5b-4f3a-9b0e-2a6d5f0d9a11";
const post = (id: string) =>
  POST(new Request(`http://portal.test/api/check-ins/${id}/shown`, { method: "POST" }), {
    params: Promise.resolve({ id })
  });

beforeEach(() => {
  store.db = "postgres://test";
  store.mark.mockReset().mockResolvedValue({
    id: ID,
    status: "pending",
    promptedAt: "2026-11-10T09:00:00.000Z",
    stamped: true
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("POST /api/check-ins/{id}/shown", () => {
  it("stamps the owner's check-in and answers the published CheckInShown shape", async () => {
    const response = await post(ID);
    expect(response.status).toBe(200);
    expect(store.mark).toHaveBeenCalledWith({}, "user-1", ID);
    const body = await response.json();
    expect(body).toEqual({ id: ID, status: "pending", promptedAt: "2026-11-10T09:00:00.000Z", stamped: true });
    expect(CLIENT_VIEW_TYPES.CheckInShown.safeParse(body).success).toBe(true);
  });

  it("passes a repeat through as stamped: false with the first time", async () => {
    store.mark.mockResolvedValue({ id: ID, status: "pending", promptedAt: "2026-11-10T09:00:00.000Z", stamped: false });
    expect((await (await post(ID)).json()).stamped).toBe(false);
  });

  it("answers 404 for an id that is not this owner's check-in, and for one that is not an id at all", async () => {
    store.mark.mockResolvedValue(null);
    expect((await post(ID)).status).toBe(404);
    store.mark.mockClear();
    expect((await post("not-an-id")).status).toBe(404);
    expect(store.mark).not.toHaveBeenCalled();
  });

  it("answers 503 without a database", async () => {
    store.db = undefined;
    expect((await post(ID)).status).toBe(503);
  });
});
