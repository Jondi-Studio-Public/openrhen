import { describe, expect, it, vi } from "vitest";
import { dbWaitMs, waitForDatabase } from "./wait-for-database.js";

const URL_WITH_PASSWORD = "postgres://app:s3cretpw@postgres:5432/openrhen";

function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

describe("waitForDatabase", () => {
  it("resolves at once on a healthy database", async () => {
    const connect = vi.fn(async () => undefined);
    await waitForDatabase(URL_WITH_PASSWORD, { timeoutMs: 90_000, intervalMs: 2_000, connect, ...clock() });
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("succeeds after N failures and logs without the URL", async () => {
    let failures = 6;
    const connect = vi.fn(async () => {
      if (failures-- > 0) throw new Error("connection refused");
    });
    const waits: number[] = [];
    await waitForDatabase(URL_WITH_PASSWORD, {
      timeoutMs: 90_000,
      intervalMs: 2_000,
      connect,
      onWaiting: (ms) => waits.push(ms),
      ...clock()
    });
    expect(connect).toHaveBeenCalledTimes(7);
    expect(waits).toEqual([10_000]);
  });

  it("times out with a message that never carries the URL or password", async () => {
    const connect = async () => {
      throw new Error(`connect failed for ${URL_WITH_PASSWORD} password s3cretpw`);
    };
    const error = await waitForDatabase(URL_WITH_PASSWORD, {
      timeoutMs: 6_000,
      intervalMs: 2_000,
      connect,
      secrets: [URL_WITH_PASSWORD, "s3cretpw"],
      ...clock()
    }).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toMatch(/did not accept connections within 6 s/);
    expect(message).not.toContain("s3cretpw");
    expect(message).not.toContain(URL_WITH_PASSWORD);
  });
});

describe("dbWaitMs", () => {
  it("defaults to 90 seconds and accepts a positive integer", () => {
    expect(dbWaitMs(undefined)).toBe(90_000);
    expect(dbWaitMs(" ")).toBe(90_000);
    expect(dbWaitMs("5")).toBe(5_000);
  });

  it("rejects anything else", () => {
    for (const bad of ["0", "-1", "1.5", "abc", "10s"])
      expect(() => dbWaitMs(bad), bad).toThrow(/MIGRATE_DB_WAIT_SECONDS/);
  });
});
