import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSeedState, type PortalState } from "@/state/portal-state";

/** The handheld's poll rows: an accepted poll is recorded with how it was let in, from the owner outcome `withRoute` carries. */
const holder = vi.hoisted(() => ({ current: null as PortalState | null }));
vi.mock("@/server/persistence/state-store", () => ({ getStateStore: () => ({ get: async () => holder.current }) }));
vi.mock("@/server/runtime-env", () => ({ databaseUrl: () => "postgres://test" }));
vi.mock("@/server/persistence/postgres/sql-pool", () => ({ sqlPool: () => ({}) }));
vi.mock("@/server/persistence/postgres/ensure-user", () => ({ ensureUser: async () => "user-1" }));
vi.mock("@/server/persistence/postgres/readers/check-in-read", () => ({ readCurrentCheckIn: async () => null }));
vi.mock("@/server/persistence/postgres/offer-log-writer", () => ({ logOfferShown: async () => true }));
const polls = vi.hoisted(() => ({ recordDevicePoll: vi.fn(async () => undefined) }));
vi.mock("@/server/device/device-poll-log", () => polls);
vi.mock("@/server/agent-activity", () => ({ noteAgentCall: () => {} }));

const { GET } = await import("./route");
const { clearCachedDeviceState } = await import("@/server/device/device-state-cache");

const NOW = new Date("2026-09-02T10:00:00.000Z");
const TOKEN = "device-secret-1";
const get = (headers?: HeadersInit) =>
  GET(new Request("http://portal.test/api/device/now", headers ? { headers } : {}), {});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  holder.current = createSeedState(NOW) as unknown as PortalState;
  clearCachedDeviceState();
  polls.recordDevicePoll.mockClear();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("GET /api/device/now poll rows", () => {
  it("records a poll let in by the device token as auth device", async () => {
    vi.stubEnv("OPENRHEN_OWNER_AUTH", "require");
    vi.stubEnv("DEVICE_TOKEN_HASH", createHash("sha256").update(TOKEN).digest("hex"));
    expect((await get({ "x-openrhen-device": TOKEN })).status).toBe(200);
    expect(polls.recordDevicePoll).toHaveBeenCalledExactlyOnceWith({ status: "synced", auth: "device" });
  });

  it("records a poll with the right token as device even when owner auth is off", async () => {
    vi.stubEnv("DEVICE_TOKEN_HASH", createHash("sha256").update(TOKEN).digest("hex"));
    await get({ "x-openrhen-device": TOKEN });
    expect(polls.recordDevicePoll).toHaveBeenCalledExactlyOnceWith({ status: "synced", auth: "device" });
  });

  it("records a poll with no credential as anonymous when owner auth is off", async () => {
    expect((await get()).status).toBe(200);
    expect(polls.recordDevicePoll).toHaveBeenCalledExactlyOnceWith({ status: "synced", auth: "anonymous" });
  });

  it("records a 304 too: a battery device mostly gets those", async () => {
    const first = await get();
    const etag = first.headers.get("etag")!;
    polls.recordDevicePoll.mockClear();
    expect((await get({ "if-none-match": etag })).status).toBe(304);
    expect(polls.recordDevicePoll).toHaveBeenCalledOnce();
  });

  it("answers the device even when recording fails", async () => {
    polls.recordDevicePoll.mockRejectedValueOnce(new Error("down"));
    expect((await get()).status).toBe(200);
  });
});
