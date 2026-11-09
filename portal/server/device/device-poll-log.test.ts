import { beforeEach, describe, expect, it, vi } from "vitest";

const runLog = vi.hoisted(() => ({ recordRunThrottled: vi.fn(async () => undefined) }));
vi.mock("@/server/persistence/postgres/run-log", () => runLog);

const { recordDevicePoll } = await import("./device-poll-log");

beforeEach(() => {
  runLog.recordRunThrottled.mockClear();
  vi.unstubAllEnvs();
  vi.stubEnv("DEVICE_TOKEN_HASH", "");
});

describe("recordDevicePoll", () => {
  it("records an accepted poll as a synced device:handheld row, throttled by the run log", async () => {
    vi.stubEnv("DEVICE_TOKEN_HASH", "a".repeat(64));
    await recordDevicePoll({ status: "synced", auth: "device" });
    expect(runLog.recordRunThrottled).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "device:handheld",
        trigger: "scheduled",
        status: "synced",
        summary: { auth: "device" }
      })
    );
  });

  it("records a refused poll as failed, with the reason", async () => {
    await recordDevicePoll({ status: "failed", reason: "device-invalid" });
    expect(runLog.recordRunThrottled).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", summary: { reason: "device-invalid" } })
    );
  });

  it("counts an anonymous poll as seen only while no device token is configured", async () => {
    await recordDevicePoll({ status: "synced", auth: "anonymous" });
    expect(runLog.recordRunThrottled).toHaveBeenCalledTimes(1);
    runLog.recordRunThrottled.mockClear();
    vi.stubEnv("DEVICE_TOKEN_HASH", "a".repeat(64));
    await recordDevicePoll({ status: "synced", auth: "anonymous" });
    expect(runLog.recordRunThrottled).not.toHaveBeenCalled();
  });

  it("never throws", async () => {
    runLog.recordRunThrottled.mockRejectedValueOnce(new Error("down"));
    await expect(recordDevicePoll({ status: "failed", reason: "device-anonymous" })).resolves.toBeUndefined();
  });
});
