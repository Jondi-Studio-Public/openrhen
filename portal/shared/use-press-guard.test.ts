// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { usePressGuard } from "./use-press-guard";

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("usePressGuard", () => {
  it("marks only the pressed key pending until its command settles", async () => {
    const { result } = renderHook(() => usePressGuard());
    const first = deferred();
    let done!: Promise<void>;
    act(() => {
      done = result.current.press("start", () => first.promise);
    });
    expect(result.current.isPending("start")).toBe(true);
    expect(result.current.isPending("not-now")).toBe(false);
    await act(async () => {
      first.resolve();
      await done;
    });
    expect(result.current.isPending("start")).toBe(false);
  });

  it("ignores a repeat of a key already in flight but lets another key run at once", async () => {
    const { result } = renderHook(() => usePressGuard());
    const run = vi.fn(() => deferred().promise);
    const other = vi.fn(() => Promise.resolve());
    act(() => {
      void result.current.press("start", run);
      void result.current.press("start", run);
      void result.current.press("woke", other);
    });
    await act(async () => undefined);
    expect(run).toHaveBeenCalledTimes(1);
    expect(other).toHaveBeenCalledTimes(1);
  });

  it("releases the key when the command is refused, without rethrowing", async () => {
    const { result } = renderHook(() => usePressGuard());
    await act(async () => {
      await result.current.press("start", () => Promise.reject(new Error("refused")));
    });
    expect(result.current.isPending("start")).toBe(false);
    const again = vi.fn();
    await act(async () => {
      await result.current.press("start", again);
    });
    expect(again).toHaveBeenCalledTimes(1);
  });
});
