import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttentionItem } from "@openrhen/contracts";
import { FACTS_FAILURE_MEMO_MS, FACTS_READ_TIMEOUT_MS, guardedFactsRead, resetFactsGuard } from "./facts-guard";

const T0 = new Date("2026-11-08T12:00:00.000Z");
const later = (seconds: number) => new Date(T0.getTime() + seconds * 1000);
const none: AttentionItem[] = [];

beforeEach(() => {
  resetFactsGuard();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("guardedFactsRead", () => {
  it("shares one read between concurrent callers of the same user and kind", async () => {
    let release!: () => void;
    const run = vi.fn(() => new Promise<AttentionItem[]>((resolve) => (release = () => resolve(none))));
    const first = guardedFactsRead("u", T0, true, run);
    const second = guardedFactsRead("u", T0, true, run);
    expect(run).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, second]);
    await guardedFactsRead(
      "u",
      T0,
      true,
      vi.fn(async () => none)
    );
    const other = vi.fn(async () => none);
    await guardedFactsRead("u", T0, false, other);
    expect(other).toHaveBeenCalledTimes(1);
  });

  it("remembers a failure for 45 s, answering it without another read, then reads again", async () => {
    expect(FACTS_FAILURE_MEMO_MS).toBe(45_000);
    const bad = vi.fn(async (): Promise<AttentionItem[]> => {
      throw new Error("down");
    });
    await expect(guardedFactsRead("u", T0, false, bad)).rejects.toThrow("down");
    const again = vi.fn(async () => none);
    await expect(guardedFactsRead("u", later(10), true, again)).rejects.toThrow(/failed a moment ago/);
    expect(again).not.toHaveBeenCalled();
    await expect(guardedFactsRead("u", later(46), true, again)).resolves.toEqual([]);
    expect(again).toHaveBeenCalledTimes(1);
  });

  it("keeps one abandoned slow read in flight instead of starting another, and counts the timeout as a failure", async () => {
    vi.useFakeTimers();
    let settle!: () => void;
    const slow = vi.fn(() => new Promise<AttentionItem[]>((resolve) => (settle = () => resolve(none))));
    const pending = guardedFactsRead("u", T0, false, slow);
    const caught = pending.catch((error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(FACTS_READ_TIMEOUT_MS + 1);
    expect(await caught).toMatch(/timed out/);
    const more = vi.fn(async () => none);
    await expect(guardedFactsRead("u", later(11), false, more)).rejects.toThrow(/failed a moment ago/);
    expect(more).not.toHaveBeenCalled();
    settle();
    await vi.advanceTimersByTimeAsync(1);
    await expect(guardedFactsRead("u", later(60), false, more)).resolves.toEqual([]);
  });

  it("does not remember a success", async () => {
    const ok = vi.fn(async () => none);
    await guardedFactsRead("u", T0, true, ok);
    await guardedFactsRead("u", T0, true, ok);
    expect(ok).toHaveBeenCalledTimes(2);
  });
});
