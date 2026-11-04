import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_TIMEZONE } from "@openrhen/contracts";
import { createOwnerTimezone } from "./owner-timezone.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("createOwnerTimezone", () => {
  it("prefers the stored value over APP_TIMEZONE", async () => {
    const tz = createOwnerTimezone(async () => " Europe/London ", { APP_TIMEZONE: "Asia/Tokyo" });
    expect(await tz()).toBe("Europe/London");
  });

  it("falls back to APP_TIMEZONE, then the default, for an empty or null value", async () => {
    expect(await createOwnerTimezone(async () => "", { APP_TIMEZONE: "Asia/Tokyo" })()).toBe("Asia/Tokyo");
    expect(await createOwnerTimezone(async () => null, { APP_TIMEZONE: "  " })()).toBe(DEFAULT_TIMEZONE);
    expect(await createOwnerTimezone(async () => null, {})()).toBe(DEFAULT_TIMEZONE);
  });

  it("holds the value within ttlMs and refreshes after it", async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockResolvedValueOnce("Europe/London").mockResolvedValueOnce("Asia/Tokyo");
    const tz = createOwnerTimezone(read, {}, 60_000);
    expect(await tz()).toBe("Europe/London");
    vi.advanceTimersByTime(59_000);
    expect(await tz()).toBe("Europe/London");
    expect(read).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2_000);
    expect(await tz()).toBe("Asia/Tokyo");
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("keeps the last good value when a read fails, and logs one line", async () => {
    vi.useFakeTimers();
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const read = vi.fn().mockResolvedValueOnce("Europe/London").mockRejectedValueOnce(new Error("db down"));
    const tz = createOwnerTimezone(read, { APP_TIMEZONE: "Asia/Tokyo" }, 60_000);
    expect(await tz()).toBe("Europe/London");
    vi.advanceTimersByTime(61_000);
    expect(await tz()).toBe("Europe/London");
    expect(write).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(write.mock.calls[0]![0]))).toMatchObject({ level: "error", error: "db down" });
  });

  it("uses the env fallback when the first read fails", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const tz = createOwnerTimezone(() => Promise.reject(new Error("db down")), { APP_TIMEZONE: "Asia/Tokyo" });
    expect(await tz()).toBe("Asia/Tokyo");
  });
});
