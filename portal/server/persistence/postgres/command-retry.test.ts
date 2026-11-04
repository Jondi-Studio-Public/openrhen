import { describe, expect, it, vi } from "vitest";
import { COMMAND_RETRY_ATTEMPTS, isRetryableTransactionError, withCommandRetry } from "./command-retry";

const pgError = (code: string, message = "boom") => Object.assign(new Error(message), { code });
const noSleep = async () => {};

describe("withCommandRetry", () => {
  it("retries once after a deadlock and returns the second attempt's result", async () => {
    const run = vi.fn().mockRejectedValueOnce(pgError("40P01", "deadlock detected")).mockResolvedValueOnce("ok");
    await expect(withCommandRetry(run, { sleep: noSleep })).resolves.toBe("ok");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("retries a serialization failure too", async () => {
    const run = vi.fn().mockRejectedValueOnce(pgError("40001")).mockResolvedValueOnce("ok");
    await expect(withCommandRetry(run, { sleep: noSleep })).resolves.toBe("ok");
  });

  it("gives up after the maximum attempts and rethrows the last error", async () => {
    const error = pgError("40P01", "deadlock detected");
    const run = vi.fn().mockRejectedValue(error);
    await expect(withCommandRetry(run, { sleep: noSleep })).rejects.toBe(error);
    expect(run).toHaveBeenCalledTimes(COMMAND_RETRY_ATTEMPTS);
    expect(COMMAND_RETRY_ATTEMPTS).toBe(3);
  });

  it("does not retry other errors", async () => {
    for (const error of [pgError("23505"), pgError("55P03"), new Error("plain")]) {
      const run = vi.fn().mockRejectedValue(error);
      await expect(withCommandRetry(run, { sleep: noSleep })).rejects.toBe(error);
      expect(run).toHaveBeenCalledTimes(1);
    }
  });

  it("pauses between attempts, not after the last", async () => {
    const sleep = vi.fn(async () => {});
    await expect(withCommandRetry(() => Promise.reject(pgError("40P01")), { sleep })).rejects.toBeDefined();
    expect(sleep).toHaveBeenCalledTimes(COMMAND_RETRY_ATTEMPTS - 1);
  });

  it("recognises only deadlock and serialization SQLSTATEs", () => {
    expect(isRetryableTransactionError(pgError("40P01"))).toBe(true);
    expect(isRetryableTransactionError(pgError("40001"))).toBe(true);
    expect(isRetryableTransactionError(pgError("23505"))).toBe(false);
    expect(isRetryableTransactionError(null)).toBe(false);
  });
});
