import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DoctorItem, DoctorReport } from "@openrhen/contracts";
import type { PoolSql } from "@/server/persistence/postgres/sql-pool";
import { readAttentionCounts, resetAttentionCountsMemo } from "./counts";
import { readAttention } from "./read-attention";
import type { AttentionReaders } from "./readers";

/** The counts the status block reads: the doctor half is kept for 30 s, `decided` and `viewer` never are. */
const SENTINEL = "SENTINEL-counts-55";
const sql = {} as PoolSql;
const T0 = new Date("2026-11-04T12:00:00.000Z");
const later = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

const blocking = (check: DoctorItem["check"]): DoctorItem => ({
  id: `${check}:x`,
  check,
  tier: "blocking",
  area: "integrations",
  title: SENTINEL,
  why: SENTINEL,
  handles: [],
  fix: { who: "person", question: SENTINEL }
});
const report = (items: DoctorItem[]): DoctorReport => ({
  generatedAt: T0.toISOString(),
  healthy: false,
  counts: { blocking: items.length, degrading: 0, tidy: 0 },
  byArea: {},
  items,
  notChecked: []
});

const checkInEntry = {
  id: "check-in:7c1d6f2e-0000-4000-8000-000000000001",
  kind: "check_in",
  plannedAt: "2026-11-04T09:00:00.000Z"
};
const settled = { due: false, lapsed: false, pulse: null, since: null, unsettled: 0 };
const dueNow = { ...settled, due: true, since: new Date("2026-11-02T00:00:00.000Z"), unsettled: 3 };

function readers(over: Partial<AttentionReaders> = {}) {
  return {
    userId: vi.fn(async () => "user-1"),
    doctor: vi.fn(async () => report([blocking("sync_failing"), blocking("stale_location")])),
    decided: vi.fn(async (_user: string, agent: string) => (agent === "scribe" ? 3 : 1)),
    entries: vi.fn(async () => []),
    due: vi.fn(async () => settled),
    pulse: vi.fn(),
    refusal: vi.fn(),
    proposals: vi.fn(),
    ...over
  } satisfies AttentionReaders;
}

beforeEach(() => {
  resetAttentionCountsMemo();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("readAttentionCounts", () => {
  it("counts blocking items the doctor alone reports (owned checks left out), and reads neither the pulse nor the proposals", async () => {
    const r = readers();
    const counts = await readAttentionCounts(sql, { agent: "scribe", scopes: undefined, now: T0 }, r);
    expect(counts).toEqual({
      viewer: "agent",
      healthBlocking: 1,
      sourcesFailed: 0,
      decided: 3,
      checkInOpen: 0,
      catchUpDue: 0
    });
    for (const unread of [r.pulse, r.proposals]) expect(unread).not.toHaveBeenCalled();
  });

  it("memoises the doctor half for 30 s per user, but decided and viewer are computed on every call", async () => {
    const r = readers();
    const scribe = { agent: "scribe", scopes: undefined, now: T0 };
    const other = { agent: "companion", scopes: undefined, now: later(10) };
    const planOnly = { agent: "reader", scopes: ["read:plan"], now: later(20) };
    const owner = { agent: null, scopes: undefined, now: later(25) };

    const first = await readAttentionCounts(sql, scribe, r);
    const second = await readAttentionCounts(sql, other, r);
    const third = await readAttentionCounts(sql, planOnly, r);
    const fourth = await readAttentionCounts(sql, owner, r);

    expect(r.doctor).toHaveBeenCalledTimes(1);
    expect(first.decided).toBe(3);
    expect(second.decided).toBe(1);
    expect(second.decided).not.toBe(first.decided);
    expect(third).toEqual({
      viewer: "agent",
      healthBlocking: 1,
      sourcesFailed: 0,
      decided: 0,
      checkInOpen: 0,
      catchUpDue: 0
    });
    expect(r.decided).toHaveBeenCalledTimes(2);
    expect(fourth).toEqual({
      viewer: "owner",
      healthBlocking: 1,
      sourcesFailed: 0,
      decided: 0,
      checkInOpen: 0,
      catchUpDue: 0
    });
    expect([first, second].map((c) => c.viewer)).toEqual(["agent", "agent"]);
  });

  it("reads the doctor again once 30 s have passed, and for another user", async () => {
    const r = readers();
    await readAttentionCounts(sql, { agent: "scribe", scopes: undefined, now: T0 }, r);
    await readAttentionCounts(sql, { agent: "scribe", scopes: undefined, now: later(29) }, r);
    expect(r.doctor).toHaveBeenCalledTimes(1);
    await readAttentionCounts(sql, { agent: "scribe", scopes: undefined, now: later(30) }, r);
    expect(r.doctor).toHaveBeenCalledTimes(2);
    // Another user id has its own entry.
    const second = readers({ userId: async () => "user-2" });
    await readAttentionCounts(sql, { agent: "scribe", scopes: undefined, now: later(31) }, second);
    expect(second.doctor).toHaveBeenCalledTimes(1);
    await readAttentionCounts(sql, { agent: "scribe", scopes: undefined, now: later(32) }, second);
    expect(second.doctor).toHaveBeenCalledTimes(1);
  });

  it("never keeps a failed doctor read: it counts as a failed source and the next call retries it", async () => {
    const doctor = vi
      .fn<AttentionReaders["doctor"]>()
      .mockRejectedValueOnce(new Error(`${SENTINEL} detail`))
      .mockResolvedValue(report([blocking("sync_failing")]));
    const r = readers({ doctor });
    const failed = await readAttentionCounts(sql, { agent: "scribe", scopes: undefined, now: T0 }, r);
    expect(failed).toEqual({
      viewer: "agent",
      healthBlocking: 0,
      sourcesFailed: 1,
      decided: 3,
      checkInOpen: 0,
      catchUpDue: 0
    });
    const retried = await readAttentionCounts(sql, { agent: "scribe", scopes: undefined, now: later(5) }, r);
    expect(retried).toEqual({
      viewer: "agent",
      healthBlocking: 1,
      sourcesFailed: 0,
      decided: 3,
      checkInOpen: 0,
      catchUpDue: 0
    });
    expect(doctor).toHaveBeenCalledTimes(2);
    expect(vi.mocked(console.error).mock.calls.join("\n")).not.toContain(SENTINEL);
  });

  it("a failed decided read counts as a failed source and leaves the doctor half intact", async () => {
    const r = readers({ decided: vi.fn(() => Promise.reject(new Error(SENTINEL))) });
    const counts = await readAttentionCounts(sql, { agent: "scribe", scopes: undefined, now: T0 }, r);
    expect(counts).toEqual({
      viewer: "agent",
      healthBlocking: 1,
      sourcesFailed: 1,
      decided: 0,
      checkInOpen: 0,
      catchUpDue: 0
    });
    expect(vi.mocked(console.error).mock.calls.join("\n")).not.toContain(SENTINEL);
  });
});

describe("readAttentionCounts agrees with the feed", () => {
  const request = { agent: "scribe", scopes: undefined, now: T0 };
  const feedNow = async (r: ReturnType<typeof readers>) => {
    const result = await readAttention(sql, request, {
      ...r,
      pulse: vi.fn(async () => null),
      proposals: vi.fn(async () => ({
        outcomes: {
          outcomes: [],
          staleCount: 0,
          queryNow: T0.toISOString(),
          since: T0.toISOString(),
          sinceClamped: undefined
        },
        windowStart: T0.toISOString(),
        waiting: null
      }))
    } as never);
    if (!("answer" in result)) throw new Error("lapsed");
    return result.answer.items.filter((item) => item.urgency === "now").length;
  };
  const countsNow = async (r: ReturnType<typeof readers>) => {
    const c = await readAttentionCounts(sql, request, r);
    return c.healthBlocking + c.sourcesFailed + c.checkInOpen + c.catchUpDue;
  };

  it("counts an open check-in and a due catch-up, exactly as many urgency-now items as the feed lists", async () => {
    for (const over of [
      {},
      { entries: vi.fn(async () => [checkInEntry as never]) },
      { due: vi.fn(async () => dueNow) },
      { entries: vi.fn(async () => [checkInEntry as never]), due: vi.fn(async () => dueNow) }
    ]) {
      resetAttentionCountsMemo();
      const r = readers(over);
      expect(await countsNow(r)).toBe(await feedNow(readers(over)));
    }
    resetAttentionCountsMemo();
    const both = await readAttentionCounts(
      sql,
      request,
      readers({ entries: vi.fn(async () => [checkInEntry as never]), due: vi.fn(async () => dueNow) })
    );
    expect(both).toMatchObject({ healthBlocking: 1, checkInOpen: 1, catchUpDue: 1 });
  });

  it("counts a ledger that cannot be read as the feed does: one unavailable item per failed source", async () => {
    const over = { entries: vi.fn(() => Promise.reject(new Error(SENTINEL))) };
    resetAttentionCountsMemo();
    expect(await countsNow(readers(over))).toBe(await feedNow(readers(over)));
  });
});
