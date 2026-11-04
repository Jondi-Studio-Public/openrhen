import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSeedState, type PortalState } from "@/state/portal-state";

/**
 * Every persistence boundary replaced wholesale, the same pattern `device/now/route.test.ts` uses:
 * this route is a thin read (`ensureUser` + `readTravelLookupsRemaining`) with nothing of its own
 * worth exercising against a real database — `travel-spend.integration.test.ts` (task 005's file,
 * outside this task's scope) already covers the budget arithmetic itself.
 */
const holder = vi.hoisted(() => ({ current: null as PortalState | null }));
vi.mock("@/server/persistence/state-store", () => ({ getStateStore: () => ({ get: async () => holder.current }) }));
vi.mock("@/server/runtime-env", () => ({ databaseUrl: () => "postgres://test" }));
vi.mock("@/server/persistence/postgres/sql-pool", () => ({ sqlPool: () => ({}) }));
vi.mock("@/server/persistence/postgres/ensure-user", () => ({ ensureUser: async () => "user-1" }));

const remaining = vi.hoisted(() => ({
  value: { spent: 3, remaining: 97, limit: 100 } as { spent: number; remaining: number; limit: number } | null,
  throws: false
}));
vi.mock("@/server/travel/travel-spend", () => ({
  readTravelLookupsRemaining: async () => {
    if (remaining.throws) throw new Error("connection refused");
    return remaining.value;
  }
}));

const { GET } = await import("./route");

const NOW = new Date("2026-09-26T10:00:00.000Z");

beforeEach(() => {
  holder.current = {
    ...createSeedState(NOW),
    settings: { ...createSeedState(NOW).settings, timezone: "Australia/Sydney" }
  };
  remaining.value = { spent: 3, remaining: 97, limit: 100 };
  remaining.throws = false;
});

afterEach(() => vi.restoreAllMocks());

describe("GET /api/travel/budget", () => {
  it("reports the day's spend and what remains", async () => {
    const response = await GET(new Request("http://portal.test/api/travel/budget"), {});
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ spent: 3, remaining: 97, limit: 100 });
  });

  it("refuses when portal state is unavailable", async () => {
    holder.current = null;
    const response = await GET(new Request("http://portal.test/api/travel/budget"), {});
    expect(response.status).toBe(503);
  });

  it("reports a read failure without leaking its detail", async () => {
    remaining.throws = true;
    const response = await GET(new Request("http://portal.test/api/travel/budget"), {});
    expect(response.status).toBe(502);
    expect((await response.json()).error).toBeTruthy();
  });
});
