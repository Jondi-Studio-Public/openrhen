import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMaxWaitDebounce } from "./debounce";

describe("createMaxWaitDebounce", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("collapses a short burst into one call after the quiet period", () => {
    const run = vi.fn();
    const debounce = createMaxWaitDebounce(run, { quietMs: 250, maxWaitMs: 5_000 });
    for (let i = 0; i < 5; i++) {
      debounce.trigger();
      vi.advanceTimersByTime(100);
    }
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(250);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("still fires during a steady stream that never goes quiet", () => {
    const run = vi.fn();
    const debounce = createMaxWaitDebounce(run, { quietMs: 250, maxWaitMs: 5_000 });
    // One trigger every 100 ms for 20 s: a plain debounce would never run.
    for (let elapsed = 0; elapsed < 20_000; elapsed += 100) {
      debounce.trigger();
      vi.advanceTimersByTime(100);
    }
    expect(run.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(run.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it("starts a fresh burst after a call", () => {
    const run = vi.fn();
    const debounce = createMaxWaitDebounce(run, { quietMs: 250, maxWaitMs: 5_000 });
    debounce.trigger();
    vi.advanceTimersByTime(300);
    debounce.trigger();
    vi.advanceTimersByTime(300);
    expect(run).toHaveBeenCalledTimes(2);
  });
});
