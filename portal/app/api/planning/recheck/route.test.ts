import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/runtime-env", () => ({ databaseUrl: vi.fn(() => "postgres://test") }));
vi.mock("@/server/persistence/postgres/sql-pool", () => ({ sqlPool: () => ({ pool: true }) }));
const mocks = vi.hoisted(() => ({ ensureUser: vi.fn(), enqueueFreshPlanRecheck: vi.fn() }));
vi.mock("@/server/persistence/postgres/ensure-user", () => ({ ensureUser: mocks.ensureUser }));
vi.mock("@/server/persistence/postgres/planning-evidence", () => ({
  enqueueFreshPlanRecheck: mocks.enqueueFreshPlanRecheck
}));
vi.mock("@/server/agent-activity", () => ({ noteAgentCall: () => {} }));

const env = await import("@/server/runtime-env");
const route = await import("./route");

const post = (body: unknown) =>
  route.POST(
    new Request("http://localhost/api/planning/recheck", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body)
    }),
    undefined
  );

beforeEach(() => {
  mocks.ensureUser.mockReset().mockResolvedValue("owner-1");
  mocks.enqueueFreshPlanRecheck.mockReset().mockResolvedValue(undefined);
  vi.mocked(env.databaseUrl).mockReturnValue("postgres://test");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("POST /api/planning/recheck", () => {
  it("queues a recheck for the owner", async () => {
    const response = await post({ userId: "owner-1" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "queued" });
    expect(mocks.enqueueFreshPlanRecheck).toHaveBeenCalledWith({ pool: true }, "owner-1");
  });

  it("refuses a user id that is not the owner, queueing nothing", async () => {
    const response = await post({ userId: "someone-else" });
    expect(response.status).toBe(400);
    expect(mocks.enqueueFreshPlanRecheck).not.toHaveBeenCalled();
  });

  it("refuses a body with no user id", async () => {
    expect((await post("not json")).status).toBe(400);
    expect(mocks.enqueueFreshPlanRecheck).not.toHaveBeenCalled();
  });

  it("answers 502 when queueing fails", async () => {
    mocks.enqueueFreshPlanRecheck.mockRejectedValue(new Error("db down"));
    const response = await post({ userId: "owner-1" });
    expect(response.status).toBe(502);
  });

  it("skips with no database", async () => {
    vi.mocked(env.databaseUrl).mockReturnValue(undefined as never);
    const response = await post({ userId: "owner-1" });
    expect(await response.json()).toEqual({ status: "skipped", reason: "no_database" });
  });
});
