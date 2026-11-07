// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@/test/render";
import { SHOWN_SETTLE_MS, useOfferShown } from "@/shared/use-offer-shown";

type Args = Parameters<typeof useOfferShown>[0];

const candidate = (id: string) => ({ action: { id, title: `Action ${id}` } });
const recommended = (id: string) => ({ kind: "recommended", candidate: candidate(id) }) as unknown as Args["activity"];

function Probe(props: Args) {
  useOfferShown(props);
  return null;
}

let visibility: "visible" | "hidden" = "visible";
const fetchMock = vi.fn();

beforeEach(() => {
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  fetchMock.mockReset().mockResolvedValue(new Response("{}"));
  vi.stubGlobal("fetch", fetchMock);
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Lets the settle delay pass, inside `act` so effects flush. */
const settle = (ms = SHOWN_SETTLE_MS) => act(() => void vi.advanceTimersByTime(ms));

const bodies = () => fetchMock.mock.calls.map((call) => JSON.parse((call[1] as RequestInit).body as string));

describe("useOfferShown", () => {
  it("sends once for a key, again only when it changes, and never for a recalculation of the same key", () => {
    const { rerender } = render(<Probe enabled activity={recommended("a")} primary={candidate("a") as never} />);
    expect(fetchMock).not.toHaveBeenCalled();
    settle(SHOWN_SETTLE_MS - 1);
    expect(fetchMock).not.toHaveBeenCalled();
    settle(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/offer-log/shown");
    expect(bodies()[0]).toMatchObject({ surface: "portal", resolutionKind: "recommended", targetId: "a" });
    rerender(<Probe enabled activity={recommended("a")} primary={candidate("a") as never} />);
    settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    rerender(<Probe enabled activity={recommended("b")} primary={candidate("b") as never} />);
    settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not send a resolution that is replaced before it has settled", () => {
    const { rerender } = render(<Probe enabled activity={recommended("a")} primary={null} />);
    settle(SHOWN_SETTLE_MS - 500);
    rerender(<Probe enabled activity={recommended("b")} primary={null} />);
    settle(SHOWN_SETTLE_MS - 1);
    expect(fetchMock).not.toHaveBeenCalled();
    settle(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(bodies()[0]).toMatchObject({ targetId: "b" });
  });

  it("sends nothing while hidden or disabled, then sends when the tab becomes visible with a new key", () => {
    visibility = "hidden";
    const { rerender } = render(<Probe enabled activity={recommended("a")} primary={null} />);
    expect(fetchMock).not.toHaveBeenCalled();
    settle();
    expect(fetchMock).not.toHaveBeenCalled();
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    document.dispatchEvent(new Event("visibilitychange"));
    settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    rerender(<Probe enabled={false} activity={recommended("c")} primary={null} />);
    settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("swallows a failing request", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    render(<Probe enabled activity={recommended("a")} primary={null} />);
    expect(() => settle()).not.toThrow();
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
