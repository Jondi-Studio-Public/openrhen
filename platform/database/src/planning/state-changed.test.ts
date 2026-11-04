import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notifyStateChanged, STATE_CHANGED_CHANNEL } from "./state-changed.js";

/** A fake tagged-template `sql`, capturing the strings/values it was called with — enough to assert
 *  on the query shape without a real Postgres connection. */
function fakeSql(behaviour: "resolve" | "reject" = "resolve") {
  const calls: Array<{ strings: TemplateStringsArray; values: unknown[] }> = [];
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ strings, values });
    return behaviour === "resolve" ? Promise.resolve([]) : Promise.reject(new Error("connection lost"));
  };
  return { sql: sql as unknown as import("postgres").Sql, calls };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("notifyStateChanged", () => {
  it("calls pg_notify on the shared channel with the userId, kind and an ISO timestamp", () => {
    const { sql, calls } = fakeSql();
    notifyStateChanged(sql, { userId: "user-1", kind: "planning" });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.values[0]).toBe(STATE_CHANGED_CHANNEL);
    const payload = JSON.parse(calls[0]!.values[1] as string) as { userId: string; kind: string; at: string };
    expect(payload.userId).toBe("user-1");
    expect(payload.kind).toBe("planning");
    expect(() => new Date(payload.at).toISOString()).not.toThrow();
    expect(new Date(payload.at).toISOString()).toBe(payload.at);
  });

  it("is fire-and-forget: it does not return a promise the caller must await", () => {
    const { sql } = fakeSql();
    const result = notifyStateChanged(sql, { userId: "user-1", kind: "state" });
    expect(result).toBeUndefined();
  });

  it("only logs, never throws, when the underlying NOTIFY query fails", async () => {
    const { sql } = fakeSql("reject");
    expect(() => notifyStateChanged(sql, { userId: "user-1", kind: "check_in" })).not.toThrow();
    await flush();
    expect(console.error).toHaveBeenCalledWith("notifyStateChanged: NOTIFY failed", expect.any(Error));
  });
});
