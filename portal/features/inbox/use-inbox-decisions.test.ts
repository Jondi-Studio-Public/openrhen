// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import "@/test/render";
import {
  EXIT_MS,
  TOAST_MS,
  useInboxDecisions,
  useToastClock,
  type DecisionToast,
  type Exit,
  type ToastAction
} from "./use-inbox-decisions";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (document as { startViewTransition?: unknown }).startViewTransition;
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

function setup() {
  const hook = renderHook(() => useInboxDecisions());
  /** Starts a decision and returns its outcome, with a rejection captured rather than thrown. */
  function decide(
    ids: string[],
    exit: Exit,
    write: () => Promise<boolean | void | readonly string[]>,
    action?: ToastAction,
    verb?: string,
    noun?: string,
    subject?: string
  ) {
    let outcome!: Promise<{ value?: boolean; error?: unknown }>;
    act(() => {
      outcome = hook.result.current.decide(ids, exit, write, action, verb, noun, subject).then(
        (value) => ({ value }),
        (error: unknown) => ({ error })
      );
    });
    return outcome;
  }
  const exitDone = () => act(() => vi.advanceTimersByTimeAsync(EXIT_MS));
  return { ...hook, decide, exitDone };
}

describe("useInboxDecisions", () => {
  it("lets the card leave, hides it while the write runs, then releases it and sets the toast", async () => {
    const { result, decide, exitDone } = setup();
    const write = deferred<void>();
    const writeFn = vi.fn(() => write.promise);
    const outcome = decide(["a"], "confirm", writeFn);

    expect(result.current.leaving.get("a")).toBe("confirm");
    expect(result.current.hidden.has("a")).toBe(false);
    expect(writeFn).not.toHaveBeenCalled();

    await exitDone();
    expect(result.current.hidden.has("a")).toBe(true);
    expect(writeFn).toHaveBeenCalledTimes(1);
    expect(result.current.toast).toBeNull();

    await act(async () => write.resolve());
    expect(await outcome).toEqual({ value: true });
    expect(result.current.leaving.size).toBe(0);
    expect(result.current.hidden.size).toBe(0);
    expect(result.current.toast).toMatchObject({ exit: "confirm", ids: ["a"], action: { kind: "view" } });
  });

  it("releases the card and shows no toast when the write returns false", async () => {
    const { result, decide, exitDone } = setup();
    const outcome = decide(["a"], "ignore", async () => false);
    await exitDone();
    expect(await outcome).toEqual({ value: false });
    expect(result.current.leaving.size).toBe(0);
    expect(result.current.hidden.size).toBe(0);
    expect(result.current.toast).toBeNull();
  });

  it("releases the card and passes the rejection on when the write throws", async () => {
    const { result, decide, exitDone } = setup();
    const failure = new Error("Offline");
    const outcome = decide(["a", "b"], "ignore", async () => {
      throw failure;
    });
    await exitDone();
    expect(await outcome).toEqual({ error: failure });
    expect(result.current.leaving.size).toBe(0);
    expect(result.current.hidden.size).toBe(0);
    expect(result.current.toast).toBeNull();
  });

  it("does nothing for an empty list of ids", async () => {
    const { result, decide } = setup();
    const write = vi.fn(async () => {});
    expect(await decide([], "ignore", write)).toEqual({ value: false });
    expect(write).not.toHaveBeenCalled();
    expect(result.current.toast).toBeNull();
  });

  it("counts only the ids a write says landed, and says how many were tried", async () => {
    const { result, decide, exitDone } = setup();
    const run = decide(["a", "b", "c"], "ignore", async () => ["a", "c"], { kind: "view" });
    await exitDone();
    await run;
    expect(result.current.toast).toMatchObject({ ids: ["a", "c"], attempted: 3 });
  });

  it("shows no toast when a write lands none of its ids", async () => {
    const { result, decide, exitDone } = setup();
    const run = decide(["a", "b"], "ignore", async () => [], { kind: "view" });
    await exitDone();
    expect(await run).toEqual({ value: false });
    expect(result.current.toast).toBeNull();
  });

  it("merges ignores made while the toast is up into one toast whose Undo runs both", async () => {
    const { result, decide, exitDone } = setup();
    const order: string[] = [];
    const first = { kind: "undo", run: vi.fn(async () => void order.push("first")) } as const;
    const second = { kind: "undo", run: vi.fn(async () => void order.push("second")) } as const;

    const one = decide(["a"], "ignore", async () => {}, first);
    await exitDone();
    await one;
    const keyAfterFirst = result.current.toast!.key;

    const two = decide(["b"], "ignore", async () => {}, second);
    await exitDone();
    await two;

    const toast = result.current.toast!;
    expect(toast.ids).toEqual(["a", "b"]);
    expect(toast.key).toBeGreaterThan(keyAfterFirst);
    expect(toast.action.kind).toBe("undo");
    if (toast.action.kind !== "undo") return;
    await toast.action.run();
    expect(order).toEqual(["first", "second"]);
  });

  it("starts a new toast when the second decision goes the other way or is not an undo", async () => {
    const { result, decide, exitDone } = setup();
    const undo = { kind: "undo", run: async () => {} } as const;

    const ignored = decide(["a"], "ignore", async () => {}, undo);
    await exitDone();
    await ignored;
    const confirmed = decide(["b"], "confirm", async () => {});
    await exitDone();
    await confirmed;
    expect(result.current.toast).toMatchObject({ exit: "confirm", ids: ["b"], action: { kind: "view" } });

    const ignoredAgain = decide(["c"], "confirm", async () => {}, undo);
    await exitDone();
    await ignoredAgain;
    expect(result.current.toast).toMatchObject({ ids: ["c"], action: { kind: "undo" } });
  });

  it("carries a subject to the toast and never merges a decision that names one", async () => {
    const { result, decide, exitDone } = setup();
    const first = decide(["a"], "confirm", async () => {}, undefined, undefined, undefined, "Added: A");
    await exitDone();
    await first;
    expect(result.current.toast).toMatchObject({ ids: ["a"], subject: "Added: A" });
    const second = decide(["b"], "confirm", async () => {}, undefined, undefined, undefined, "Added: B");
    await exitDone();
    await second;
    expect(result.current.toast).toMatchObject({ ids: ["b"], subject: "Added: B" });
  });

  it("carries the verb and noun to the toast, and merges only decisions that share both", async () => {
    const { result, decide, exitDone } = setup();
    const undo = { kind: "undo", run: async () => {} } as const;

    const first = decide(["a"], "confirm", async () => {}, undo, "Confirmed", "link");
    await exitDone();
    await first;
    expect(result.current.toast).toMatchObject({ ids: ["a"], verb: "Confirmed", noun: "link" });

    const second = decide(["b"], "confirm", async () => {}, undo, "Confirmed", "link");
    await exitDone();
    await second;
    expect(result.current.toast).toMatchObject({ ids: ["a", "b"], verb: "Confirmed", noun: "link" });

    const finding = decide(["c"], "confirm", async () => {}, undo, "Confirmed", "finding");
    await exitDone();
    await finding;
    expect(result.current.toast).toMatchObject({ ids: ["c"], noun: "finding" });
  });

  it("dismiss clears the toast", async () => {
    const { result, decide, exitDone } = setup();
    const outcome = decide(["a"], "confirm", async () => {});
    await exitDone();
    await outcome;
    expect(result.current.toast).not.toBeNull();
    act(() => result.current.dismiss());
    expect(result.current.toast).toBeNull();
  });

  it("skips the exit wait for someone who prefers reduced motion", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true }))
    );
    const { result, decide } = setup();
    const write = vi.fn(async () => {});
    const outcome = decide(["a"], "ignore", write);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(write).toHaveBeenCalledTimes(1);
    expect(await outcome).toEqual({ value: true });
    expect(result.current.toast).toMatchObject({ ids: ["a"] });
  });

  it("hides the card inside a view transition where the browser has them", async () => {
    const startViewTransition = vi.fn((update: () => void) => {
      update();
      return { finished: Promise.resolve() };
    });
    (document as unknown as { startViewTransition: unknown }).startViewTransition = startViewTransition;
    const { decide, exitDone } = setup();
    const write = vi.fn(async () => {});
    const outcome = decide(["a"], "ignore", write);
    await exitDone();
    expect(startViewTransition).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledTimes(1);
    await outcome;
    expect(document.documentElement.classList.contains("inbox-reflow")).toBe(false);
  });

  it("does not use a view transition when motion is reduced", async () => {
    const startViewTransition = vi.fn();
    (document as unknown as { startViewTransition: unknown }).startViewTransition = startViewTransition;
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true }))
    );
    const { decide } = setup();
    const outcome = decide(["a"], "ignore", async () => {});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await outcome;
    expect(startViewTransition).not.toHaveBeenCalled();
  });
});

describe("useToastClock", () => {
  const toast: DecisionToast = { key: 1, exit: "ignore", ids: ["a"], action: { kind: "view" } };

  it("dismisses the toast after six seconds", () => {
    const dismiss = vi.fn();
    renderHook(() => useToastClock(toast, dismiss));
    act(() => void vi.advanceTimersByTime(TOAST_MS - 1));
    expect(dismiss).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(1));
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it("holds while the pointer or focus is on it, and starts the six seconds again on letting go", () => {
    const dismiss = vi.fn();
    const { result } = renderHook(() => useToastClock(toast, dismiss));
    act(() => void vi.advanceTimersByTime(TOAST_MS - 1000));
    act(() => result.current.hold());
    act(() => void vi.advanceTimersByTime(TOAST_MS * 3));
    expect(dismiss).not.toHaveBeenCalled();
    act(() => result.current.letGo());
    act(() => void vi.advanceTimersByTime(TOAST_MS - 1));
    expect(dismiss).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(1));
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it("restarts the clock for a newer toast and runs none without one", () => {
    const dismiss = vi.fn();
    const { rerender } = renderHook(({ current }) => useToastClock(current, dismiss), {
      initialProps: { current: toast as DecisionToast | null }
    });
    act(() => void vi.advanceTimersByTime(TOAST_MS - 1));
    rerender({ current: { ...toast, key: 2 } });
    act(() => void vi.advanceTimersByTime(TOAST_MS - 1));
    expect(dismiss).not.toHaveBeenCalled();
    rerender({ current: null });
    act(() => void vi.advanceTimersByTime(TOAST_MS * 2));
    expect(dismiss).not.toHaveBeenCalled();
  });
});
