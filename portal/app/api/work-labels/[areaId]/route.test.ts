import { beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({ url: "postgres://example" as string | undefined }));
const labels = vi.hoisted(() => ({ setWorkLabel: vi.fn() }));
vi.mock("@/server/runtime-env", () => ({ databaseUrl: () => env.url }));
vi.mock("@/server/persistence/postgres/sql-pool", () => ({ sqlPool: () => ({}) }));
vi.mock("@/server/drift/work-labels", () => labels);

const route = await import("./route");
const put = (body: unknown, areaId = "area-1") =>
  route.PUT(
    new Request(`http://localhost/api/work-labels/${areaId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body)
    }),
    { params: Promise.resolve({ areaId }) }
  );

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  env.url = "postgres://example";
  labels.setWorkLabel.mockReset();
});

describe("PUT /api/work-labels/[areaId]", () => {
  it("passes the area, label and request id to the writer and answers the label as it now reads", async () => {
    const label = { areaId: "area-1", value: "work", origin: "corrected", at: "2026-11-09T10:00:00.000Z" };
    labels.setWorkLabel.mockResolvedValue({ ok: true, label });
    const response = await put({ label: "work", requestId: "req-12345678" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(label);
    expect(labels.setWorkLabel).toHaveBeenCalledWith(expect.anything(), {
      areaId: "area-1",
      label: "work",
      requestId: "req-12345678"
    });
  });

  it("answers the writer's refusal with its status and its sentence", async () => {
    labels.setWorkLabel.mockResolvedValue({ ok: false, status: 404, error: "That area is not here." });
    const response = await put({ label: "work", requestId: "req-12345678" });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "That area is not here." });
  });

  it("hands a body that is not JSON to the writer as missing fields, which it refuses", async () => {
    labels.setWorkLabel.mockResolvedValue({ ok: false, status: 400, error: "label must be one of: work" });
    const response = await put("not json");
    expect(response.status).toBe(400);
    expect(labels.setWorkLabel).toHaveBeenCalledWith(expect.anything(), {
      areaId: "area-1",
      label: undefined,
      requestId: undefined
    });
  });

  it("says to set DATABASE_URL when there is no database, writing nothing", async () => {
    env.url = undefined;
    const response = await put({ label: "work", requestId: "req-12345678" });
    expect(response.status).toBe(503);
    expect(labels.setWorkLabel).not.toHaveBeenCalled();
  });
});
