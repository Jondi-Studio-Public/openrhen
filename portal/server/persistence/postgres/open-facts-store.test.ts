import { describe, expect, it, vi } from "vitest";

vi.mock("./ensure-user", () => ({ ensureUser: async () => "user-1" }));

import { OpenFactsTimeoutError, readOpenFacts } from "./open-facts-store";

describe("readOpenFacts timeout", () => {
  it("turns a Postgres statement timeout (57014) into an error that says how to narrow the read", async () => {
    const sql = {
      begin: async () => {
        throw Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
      }
    } as never;
    const error = await readOpenFacts(sql, { now: new Date("2026-11-08T12:00:00Z") }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpenFactsTimeoutError);
    expect((error as Error).message).toContain("horizonDays");
    expect((error as Error).message).toContain("retry");
  });

  it("lets any other database error through unchanged", async () => {
    const boom = new Error("connection reset");
    const sql = {
      begin: async () => {
        throw boom;
      }
    } as never;
    await expect(readOpenFacts(sql, {})).rejects.toBe(boom);
  });

  it("refuses an out-of-range option with the allowed range", async () => {
    await expect(readOpenFacts({} as never, { horizonDays: 0 })).rejects.toThrow(/horizonDays/);
    await expect(readOpenFacts({} as never, { limit: 1000 })).rejects.toThrow(/limit/);
    await expect(readOpenFacts({} as never, { maxRows: 0 })).rejects.toThrow(/maxRows/);
    await expect(readOpenFacts({} as never, { maxRows: 20001 })).rejects.toThrow(/maxRows/);
  });
});
