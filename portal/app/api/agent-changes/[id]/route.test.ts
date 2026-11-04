import { beforeEach, describe, expect, it, vi } from "vitest";

/** The detail route's framing: owner only, a write id in the path, 404 for a stranger's or missing write, 503 without PostgreSQL. */
const env = vi.hoisted(() => ({ url: "postgres://test" as string | undefined }));
vi.mock("@/server/runtime-env", () => ({ databaseUrl: () => env.url }));
vi.mock("@/server/persistence/postgres/sql-pool", () => ({ sqlPool: () => ({}) }));
vi.mock("@/server/persistence/postgres/ensure-user", () => ({ ensureUser: async () => "user-1" }));
const store = vi.hoisted(() => ({ readAgentChangeDetail: vi.fn() }));
vi.mock("@/server/persistence/postgres/agent-change-detail", () => store);
vi.mock("@/server/agent-activity", () => ({ noteAgentCall: () => {} }));

const route = await import("./route");
const ID = "123e4567-e89b-12d3-a456-426614174000";
const call = (id: string, headers: Record<string, string> = {}) =>
  route.GET(new Request(`http://localhost/api/agent-changes/${id}`, { headers }), { params: Promise.resolve({ id }) });

beforeEach(() => {
  env.url = "postgres://test";
  store.readAgentChangeDetail.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("GET /api/agent-changes/[id]", () => {
  it("returns the detail, uncached", async () => {
    const detail = { writeId: ID, rows: [] };
    store.readAgentChangeDetail.mockResolvedValue(detail);
    const response = await call(ID);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(detail);
    expect(store.readAgentChangeDetail).toHaveBeenCalledWith({}, "user-1", ID);
  });

  it("answers 404 when there is no such write", async () => {
    store.readAgentChangeDetail.mockResolvedValue(null);
    expect((await call(ID)).status).toBe(404);
  });

  it("answers 400 to an id that is not a uuid, without reading", async () => {
    expect((await call("not-a-uuid")).status).toBe(400);
    expect(store.readAgentChangeDetail).not.toHaveBeenCalled();
  });

  it("refuses a caller that names an agent", async () => {
    expect((await call(ID, { "x-openrhen-agent": "openclaw" })).status).toBe(403);
    expect(store.readAgentChangeDetail).not.toHaveBeenCalled();
  });

  it("answers 503 without PostgreSQL", async () => {
    env.url = undefined;
    expect((await call(ID)).status).toBe(503);
  });
});
