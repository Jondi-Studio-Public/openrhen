import { describe, expect, it } from "vitest";
import { noOpenSession } from "./missing-session";
import type { TxSql } from "./sql-pool";

const txReturning = (rows: unknown[]) => (async () => rows) as unknown as TxSql;

describe("noOpenSession", () => {
  it("looks the session up for the calling user only, so another user's ended session reads as not found", async () => {
    const calls: unknown[][] = [];
    const tx = (async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push(values);
      return [];
    }) as unknown as TxSql;
    const error = await noOpenSession(tx, "user-a", "s-other");
    expect(calls[0]).toEqual(["s-other", "user-a"]);
    expect(error.message).toContain("no longer exists, or never existed");
  });

  it("says when a session that already ended ended, and points at rhen_status", async () => {
    const error = await noOpenSession(txReturning([{ ended_at: new Date("2026-11-06T02:13:00Z") }]), "u", "s-1");
    expect(error.message).toContain('Session "s-1" is ended (at 2026-11-06T02:13:00.000Z) now');
    expect(error.message).not.toContain("never existed");
    expect(error.nextCall?.tool).toBe("rhen_status");
  });

  it("keeps the not-found wording for an id that matches no session", async () => {
    const error = await noOpenSession(txReturning([]), "u", "s-2");
    expect(error.message).toContain("no longer exists, or never existed");
  });
});
