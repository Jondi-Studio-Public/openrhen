import { beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({ url: "postgres://example" as string | undefined }));
const labels = vi.hoisted(() => ({ readWorkLabels: vi.fn() }));
vi.mock("@/server/runtime-env", () => ({ databaseUrl: () => env.url }));
vi.mock("@/server/persistence/postgres/sql-pool", () => ({ sqlPool: () => ({}) }));
vi.mock("@/server/drift/work-labels", () => labels);

const route = await import("./route");
const call = () => route.GET(new Request("http://localhost/api/work-labels"), undefined);

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  env.url = "postgres://example";
  labels.readWorkLabels.mockReset();
});

describe("GET /api/work-labels", () => {
  it("answers the labels as the reader resolved them", async () => {
    const answer = {
      modelConfigured: true,
      labels: [{ areaId: "a1", value: "work", origin: "inferred", at: "2026-11-09T10:00:00.000Z" }]
    };
    labels.readWorkLabels.mockResolvedValue(answer);
    const response = await call();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(answer);
  });

  it("says to set DATABASE_URL and call again when there is no database", async () => {
    env.url = undefined;
    const response = await call();
    expect(response.status).toBe(503);
    const { error } = (await response.json()) as { error: string };
    expect(error).toContain("DATABASE_URL");
    expect(error).toContain("GET /api/work-labels");
    expect(labels.readWorkLabels).not.toHaveBeenCalled();
  });
});
