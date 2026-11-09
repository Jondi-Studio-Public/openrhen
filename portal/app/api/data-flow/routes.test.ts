import { beforeEach, describe, expect, it, vi } from "vitest";

/** The data-flow route without a database answers 503 with the exact next call. */
const env = vi.hoisted(() => ({ url: undefined as string | undefined }));
vi.mock("@/server/runtime-env", () => ({ databaseUrl: () => env.url }));
vi.mock("@/server/persistence/postgres/sql-pool", () => ({ sqlPool: () => ({}) }));
vi.mock("@/server/data-flow/data-flow-response", () => ({ readDataFlow: async () => ({ entries: [] }) }));

const route = await import("./route");

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("GET /api/data-flow", () => {
  it("says to set DATABASE_URL and call the route again when there is no database", async () => {
    env.url = undefined;
    const response = await route.GET(new Request("http://localhost/api/data-flow"), undefined);
    expect(response.status).toBe(503);
    const { error } = (await response.json()) as { error: string };
    expect(error).toContain("DATABASE_URL");
    expect(error).toContain("GET /api/data-flow");
  });
});
