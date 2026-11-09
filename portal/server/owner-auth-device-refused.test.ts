import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

/** With no hook given, a refused device poll goes to the device poll log, which is what leaves the `device:handheld` row. */
const polls = vi.hoisted(() => ({ recordDevicePoll: vi.fn(async () => undefined) }));
vi.mock("./device/device-poll-log", () => polls);

const { ownerGate } = await import("./owner-auth");

const gate = (headers: Record<string, string>) =>
  ownerGate({
    request: new Request("http://portal.test/api/device/now", { headers }),
    route: "/api/device/now",
    agent: undefined,
    mode: "require",
    deps: { lookup: async () => null, touch: async () => false }
  });

afterEach(() => {
  vi.unstubAllEnvs();
  polls.recordDevicePoll.mockClear();
});

describe("ownerGate default device-refused hook", () => {
  it("records a failed poll with the reason for a wrong token and for none", async () => {
    vi.stubEnv("DEVICE_TOKEN_HASH", createHash("sha256").update("right").digest("hex"));
    await gate({ "x-openrhen-device": "wrong" });
    await vi.waitFor(() => expect(polls.recordDevicePoll).toHaveBeenCalledTimes(1));
    await gate({});
    await vi.waitFor(() => expect(polls.recordDevicePoll).toHaveBeenCalledTimes(2));
    expect(polls.recordDevicePoll.mock.calls).toEqual([
      [{ status: "failed", reason: "device-invalid" }],
      [{ status: "failed", reason: "device-anonymous" }]
    ]);
  });

  it("records nothing for an accepted token", async () => {
    vi.stubEnv("DEVICE_TOKEN_HASH", createHash("sha256").update("right").digest("hex"));
    expect(await gate({ "x-openrhen-device": "right" })).toEqual({ device: true });
    expect(polls.recordDevicePoll).not.toHaveBeenCalled();
  });
});
