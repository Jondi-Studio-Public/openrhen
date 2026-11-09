import { beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({ url: "postgres://example" as string | undefined }));
const reasons = vi.hoisted(() => ({ deleteReason: vi.fn() }));
vi.mock("@/server/runtime-env", () => ({ databaseUrl: () => env.url }));
vi.mock("@/server/persistence/postgres/sql-pool", () => ({ sqlPool: () => ({}) }));
vi.mock("@/server/drift/drift-reasons", () => reasons);

const route = await import("./route");
const checkInId = "11111111-1111-4111-8111-111111111111";
const del = (id = checkInId) =>
  route.DELETE(new Request(`http://localhost/api/drift-reasons/${id}`, { method: "DELETE" }), {
    params: Promise.resolve({ checkInId: id })
  });

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  env.url = "postgres://example";
  reasons.deleteReason.mockReset();
});

describe("DELETE /api/drift-reasons/[checkInId]", () => {
  it("answers how many rows went", async () => {
    reasons.deleteReason.mockResolvedValue({ ok: true, removed: 3 });
    const response = await del();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ removed: 3 });
    expect(reasons.deleteReason).toHaveBeenCalledWith(expect.anything(), checkInId);
  });

  it("answers the writer's refusal with its status and sentence", async () => {
    reasons.deleteReason.mockResolvedValue({ ok: false, status: 400, error: "Not a check-in id." });
    const response = await del("nope");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Not a check-in id." });
  });

  it("says to set DATABASE_URL when there is no database", async () => {
    env.url = undefined;
    expect((await del()).status).toBe(503);
    expect(reasons.deleteReason).not.toHaveBeenCalled();
  });
});
