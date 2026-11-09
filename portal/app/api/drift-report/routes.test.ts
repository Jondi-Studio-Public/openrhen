import { beforeEach, describe, expect, it, vi } from "vitest";

/** The drift report route: 503 without a database, 400 on a bad window, and the reader gets a bounded window. */
const env = vi.hoisted(() => ({ url: undefined as string | undefined }));
const reads = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }));
vi.mock("@/server/runtime-env", () => ({ databaseUrl: () => env.url }));
vi.mock("@/server/persistence/postgres/sql-pool", () => ({ sqlPool: () => ({}) }));
vi.mock("@/server/persistence/postgres/ensure-user", () => ({ ensureUser: async () => "user-1" }));
vi.mock("@/server/drift/drift-report", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/drift/drift-report")>()),
  readDriftReport: async (_sql: unknown, _user: string, options: Record<string, unknown>) => {
    reads.calls.push(options);
    return { episodes: [] };
  }
}));

const route = await import("./route");
const call = (query = "") => route.GET(new Request(`http://localhost/api/drift-report${query}`), undefined);

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  env.url = "postgres://example";
  reads.calls.length = 0;
});

describe("GET /api/drift-report", () => {
  it("says to set DATABASE_URL and call the route again when there is no database", async () => {
    env.url = undefined;
    const response = await call();
    expect(response.status).toBe(503);
    const { error } = (await response.json()) as { error: string };
    expect(error).toContain("DATABASE_URL");
    expect(error).toContain("GET /api/drift-report");
  });

  it("reads the last 30 days by default", async () => {
    expect((await call()).status).toBe(200);
    const { from, to } = reads.calls[0] as { from: Date; to: Date };
    expect(Math.round((to.getTime() - from.getTime()) / 86_400_000)).toBe(30);
  });

  it("caps days at 90", async () => {
    await call("?days=5000");
    const { from, to } = reads.calls[0] as { from: Date; to: Date };
    expect(Math.round((to.getTime() - from.getTime()) / 86_400_000)).toBe(90);
  });

  it("passes an explicit window and the legacy cut through", async () => {
    await call("?from=2026-01-01T00:00:00Z&to=2026-01-10T00:00:00Z&legacyBefore=2025-12-01T00:00:00Z");
    expect(reads.calls[0]).toMatchObject({
      from: new Date("2026-01-01T00:00:00Z"),
      to: new Date("2026-01-10T00:00:00Z"),
      legacyBefore: new Date("2025-12-01T00:00:00Z")
    });
  });

  it("refuses an unreadable time, an empty window and one longer than 90 days, and reads nothing", async () => {
    for (const query of [
      "?from=yesterday",
      "?legacyBefore=soon",
      "?from=2026-01-10T00:00:00Z&to=2026-01-01T00:00:00Z",
      "?from=2025-01-01T00:00:00Z&to=2026-01-01T00:00:00Z"
    ]) {
      const response = await call(query);
      expect(response.status, query).toBe(400);
      expect(((await response.json()) as { error: string }).error).toContain("GET /api/drift-report");
    }
    expect(reads.calls).toEqual([]);
  });
});
