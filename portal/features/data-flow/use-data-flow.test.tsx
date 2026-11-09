// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@/test/render";
import { useDataFlow } from "./use-data-flow";
import { response, withStaleCalendar } from "./test-fixtures";

const INTERVAL = 60_000;

function Probe({ poll = true }: { poll?: boolean }) {
  const flow = useDataFlow({ intervalMs: INTERVAL, poll });
  return (
    <div>
      <p data-testid="status">{flow.status}</p>
      <p data-testid="entries">{flow.data?.entries.length ?? "none"}</p>
      <p data-testid="down">{flow.healthDown ? "down" : "up"}</p>
      <p data-testid="calendar">
        {flow.data && !flow.data.health.unavailable ? flow.data.health.nodes["calendar-pull"]?.freshness : ""}
      </p>
    </div>
  );
}

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

let fetchMock: ReturnType<typeof vi.fn>;
const ok = (body: unknown) => ({ ok: true, json: async () => body });

beforeEach(() => {
  vi.useFakeTimers();
  setVisibility("visible");
  fetchMock = vi.fn(async () => ok(response()));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}
async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("useDataFlow", () => {
  it("loads once on mount and then again every interval while the page is visible", async () => {
    render(<Probe />);
    await flush();
    expect(screen.getByTestId("status").textContent).toBe("ready");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await tick(INTERVAL);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await tick(INTERVAL);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("stops polling while the page is hidden and reads again, at once, when it comes back", async () => {
    render(<Probe />);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    act(() => setVisibility("hidden"));
    await tick(INTERVAL * 5);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    act(() => setVisibility("visible"));
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await tick(INTERVAL);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not read at once on return when the last read is recent", async () => {
    render(<Probe />);
    await flush();
    act(() => setVisibility("hidden"));
    await tick(10_000);
    act(() => setVisibility("visible"));
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await tick(INTERVAL);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not poll at all when told not to (the header counts)", async () => {
    render(<Probe poll={false} />);
    await flush();
    await tick(INTERVAL * 3);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("shows a source that went stale on the next read", async () => {
    render(<Probe />);
    await flush();
    expect(screen.getByTestId("calendar").textContent).toBe("fresh");
    fetchMock.mockImplementation(async () => ok(withStaleCalendar()));
    await tick(INTERVAL);
    expect(screen.getByTestId("calendar").textContent).toBe("stale");
  });

  it("keeps the last graph, marks health down when a later read fails, and recovers", async () => {
    render(<Probe />);
    await flush();
    fetchMock.mockImplementation(async () => ({ ok: false, status: 503, json: async () => ({}) }));
    await tick(INTERVAL);
    expect(screen.getByTestId("down").textContent).toBe("down");
    expect(screen.getByTestId("entries").textContent).not.toBe("none");
    expect(screen.getByTestId("status").textContent).toBe("ready");
    fetchMock.mockImplementation(async () => ok(response()));
    await tick(INTERVAL);
    expect(screen.getByTestId("down").textContent).toBe("up");
  });

  it("reports an error, with no graph, when the first read fails", async () => {
    fetchMock.mockImplementation(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    render(<Probe />);
    await flush();
    expect(screen.getByTestId("status").textContent).toBe("error");
    expect(screen.getByTestId("entries").textContent).toBe("none");
  });

  it("treats health the server could not read as down", async () => {
    fetchMock.mockImplementation(async () => ok({ ...response(), health: { unavailable: true, reason: "x" } }));
    render(<Probe />);
    await flush();
    expect(screen.getByTestId("down").textContent).toBe("down");
  });
});
