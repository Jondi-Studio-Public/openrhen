import { describe, expect, it } from "vitest";
import { type StatusRow, isOpenStatus, resolveFactStatus } from "./fact-status.js";

const row = (
  status: StatusRow["status"],
  validFrom: string,
  actor: StatusRow["actor"],
  key: string = status
): StatusRow => ({
  status,
  validFrom,
  actor,
  key
});
const NOW = new Date("2026-11-08T12:00:00Z");

describe("resolveFactStatus", () => {
  it("is proposed when nothing has been said", () => {
    expect(resolveFactStatus([], { now: NOW })).toEqual({ status: "proposed", row: null, expired: false });
  });

  it("lets the latest valid_from win, whatever the input order", () => {
    const rows = [
      row("done", "2026-11-08T03:00:00Z", "extractor"),
      row("confirmed", "2026-11-08T01:00:00Z", "person"),
      row("cancelled", "2026-11-08T02:00:00Z", "mark")
    ];
    expect(resolveFactStatus(rows, { now: NOW }).status).toBe("done");
    expect(resolveFactStatus([...rows].reverse(), { now: NOW }).status).toBe("done");
  });

  it("breaks a tie on valid_from by actor rank: person over Mark over extractor", () => {
    const at = "2026-11-08T01:00:00Z";
    const rows = [row("done", at, "extractor"), row("cancelled", at, "mark"), row("confirmed", at, "person")];
    expect(resolveFactStatus(rows, { now: NOW }).status).toBe("confirmed");
    expect(resolveFactStatus(rows.slice(0, 2), { now: NOW }).status).toBe("cancelled");
  });

  it("compares instants, not strings, across offsets", () => {
    const rows = [
      row("done", "2026-11-08T10:00:00+11:00", "person"),
      row("cancelled", "2026-11-07T22:00:00Z", "person")
    ];
    // 10:00+11:00 is 23:00Z on the 7th, later than 22:00Z.
    expect(resolveFactStatus(rows, { now: NOW }).status).toBe("done");
  });

  it("breaks a full tie by key so the answer never depends on input order", () => {
    const a = row("done", "2026-11-08T01:00:00Z", "person", "b-key");
    const b = row("cancelled", "2026-11-08T01:00:00Z", "person", "a-key");
    expect(resolveFactStatus([a, b], { now: NOW }).row?.key).toBe("b-key");
    expect(resolveFactStatus([b, a], { now: NOW }).row?.key).toBe("b-key");
  });

  it("computes expired at read for an open fact whose time has passed", () => {
    const rows = [row("confirmed", "2026-11-01T00:00:00Z", "person")];
    expect(resolveFactStatus(rows, { now: NOW, expiresAt: "2026-11-08T11:00:00Z" })).toMatchObject({
      status: "expired",
      expired: true
    });
    expect(resolveFactStatus(rows, { now: NOW, expiresAt: "2026-11-09T00:00:00Z" }).status).toBe("confirmed");
  });

  it("never expires a closed fact", () => {
    for (const status of ["cancelled", "done", "superseded", "source_gone"] as const) {
      const rows = [row(status, "2026-11-01T00:00:00Z", "person")];
      expect(resolveFactStatus(rows, { now: NOW, expiresAt: "2026-11-02T00:00:00Z" }).status).toBe(status);
    }
  });

  it("lets a rescheduled row carry its own new expiry", () => {
    const rows = [{ ...row("rescheduled", "2026-11-05T00:00:00Z", "person"), expiresAt: "2026-11-20T00:00:00Z" }];
    expect(resolveFactStatus(rows, { now: NOW, expiresAt: "2026-11-02T00:00:00Z" }).status).toBe("rescheduled");
  });

  it("treats an unreadable valid_from as the earliest time rather than throwing", () => {
    const rows = [row("done", "garbage", "person"), row("confirmed", "2026-11-01T00:00:00Z", "extractor")];
    expect(resolveFactStatus(rows, { now: NOW }).status).toBe("confirmed");
  });
});

describe("isOpenStatus", () => {
  it("is open for proposed, confirmed and rescheduled only", () => {
    expect(["proposed", "confirmed", "rescheduled"].every((s) => isOpenStatus(s as never))).toBe(true);
    expect(["cancelled", "done", "superseded", "source_gone", "expired"].some((s) => isOpenStatus(s as never))).toBe(
      false
    );
  });
});
