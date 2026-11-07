import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSeedState, type PortalState } from "@/state/portal-state";

/** The handheld's `shown` rows: a 200 with a changed ETag logs one, a 304 logs none, and a failing log never breaks the poll. */
const holder = vi.hoisted(() => ({ current: null as PortalState | null }));
vi.mock("@/server/persistence/state-store", () => ({ getStateStore: () => ({ get: async () => holder.current }) }));
vi.mock("@/server/runtime-env", () => ({ databaseUrl: () => "postgres://test" }));
vi.mock("@/server/persistence/postgres/sql-pool", () => ({ sqlPool: () => ({}) }));
vi.mock("@/server/persistence/postgres/ensure-user", () => ({ ensureUser: async () => "user-1" }));
vi.mock("@/server/persistence/postgres/readers/check-in-read", () => ({ readCurrentCheckIn: async () => null }));
const writer = vi.hoisted(() => ({ logOfferShown: vi.fn() }));
vi.mock("@/server/persistence/postgres/offer-log-writer", () => writer);

const { GET } = await import("./route");
const { clearCachedDeviceState } = await import("@/server/device/device-state-cache");

const NOW = new Date("2026-09-02T10:00:00.000Z");
const get = (headers?: HeadersInit) =>
  GET(new Request("http://portal.test/api/device/now", headers ? { headers } : {}), {});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  holder.current = createSeedState(NOW) as unknown as PortalState;
  clearCachedDeviceState();
  writer.logOfferShown.mockReset().mockResolvedValue(true);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.useRealTimers());

describe("GET /api/device/now offer log", () => {
  it("logs one handheld shown row for a 200", async () => {
    const response = await get();
    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(writer.logOfferShown).toHaveBeenCalledTimes(1));
    const [, userId, input] = writer.logOfferShown.mock.calls[0]!;
    expect(userId).toBe("user-1");
    expect(input).toMatchObject({ surface: "handheld" });
    expect(typeof input.resolutionKind).toBe("string");
  });

  it("logs nothing for a 304", async () => {
    const etag = (await get()).headers.get("etag")!;
    await vi.waitFor(() => expect(writer.logOfferShown).toHaveBeenCalledTimes(1));
    writer.logOfferShown.mockClear();
    const response = await get({ "if-none-match": etag });
    expect(response.status).toBe(304);
    await vi.advanceTimersByTimeAsync(10);
    expect(writer.logOfferShown).not.toHaveBeenCalled();
  });

  it("still answers 200 with the snapshot when the log write fails", async () => {
    writer.logOfferShown.mockRejectedValue(new Error("database is down"));
    const response = await get();
    expect(response.status).toBe(200);
    expect(await response.json()).toHaveProperty("stateVersion");
    await vi.waitFor(() => expect(writer.logOfferShown).toHaveBeenCalled());
  });
});
