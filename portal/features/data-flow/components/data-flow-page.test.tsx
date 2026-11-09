// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@/test/render";
import { freezeClock } from "@/shared/clock";
import { NOW, response, withStaleCalendar } from "../test-fixtures";
import { DataFlowPage } from "./data-flow-page";
import { DataFlowCountsLink } from "./data-flow-counts";

freezeClock(NOW);

const ok = (body: unknown) => ({ ok: true, json: async () => body });
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn(async () => ok(response()));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("DataFlowPage", () => {
  it("draws the graph with every column and the counts line", async () => {
    render(<DataFlowPage />);
    expect(await screen.findByRole("heading", { name: "Data" })).toBeTruthy();
    const graph = await screen.findByRole("group", { name: /Data flow map/ });
    for (const title of ["Outside", "Collectors", "Stores", "Readers", "What it gives"])
      expect(within(graph).getByText(title)).toBeTruthy();
    expect(within(graph).getByRole("button", { name: /Calendar pull, Fresh/ })).toBeTruthy();
    expect(screen.getByText(/1 collected, unused/)).toBeTruthy();
  });

  it("opens the panel for a node and closes it", async () => {
    render(<DataFlowPage />);
    const graph = await screen.findByRole("group", { name: /Data flow map/ });
    fireEvent.click(within(graph).getByRole("button", { name: /Calendar pull/ }));
    expect(await screen.findByRole("dialog", { name: "Calendar pull" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close Calendar pull" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Calendar pull" })).toBeNull());
  });

  it("shows a stale source as stale in the text of its node", async () => {
    fetchMock.mockImplementation(async () => ok(withStaleCalendar()));
    render(<DataFlowPage />);
    const graph = await screen.findByRole("group", { name: /Data flow map/ });
    expect(within(graph).getByRole("button", { name: /Calendar pull, Stale/ })).toBeTruthy();
    expect(screen.getByText(/1 late/)).toBeTruthy();
  });

  it("filters: planned entries can be hidden and problems shown alone", async () => {
    fetchMock.mockImplementation(async () => ok(withStaleCalendar()));
    render(<DataFlowPage />);
    const graph = await screen.findByRole("group", { name: /Data flow map/ });
    expect(within(graph).getByRole("button", { name: /Public holidays/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show planned" }));
    expect(within(graph).queryByRole("button", { name: /Public holidays/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Problems only" }));
    expect(within(graph).getByRole("button", { name: /Calendar pull/ })).toBeTruthy();
    expect(within(graph).queryByRole("button", { name: /Watch history/ })).toBeNull();
  });

  it("folds idle collectors on the map, opens the fold, and still lists every one", async () => {
    const data = response();
    if (data.health.unavailable) throw new Error("fixture");
    const base = data.entries.find((entry) => entry.id === "watch-export")!;
    for (const id of ["idle-a", "idle-b", "idle-c"]) {
      data.entries = [...data.entries, { ...base, id, name: `Quiet ${id}`, from: [], to: [] }];
      data.health.nodes[id] = {
        entryId: id,
        probe: "t",
        configured: false,
        freshness: "never",
        lastSuccessAt: null,
        lastAttemptAt: null,
        lastError: null,
        threshold: null
      };
    }
    fetchMock.mockImplementation(async () => ok(data));
    render(<DataFlowPage />);
    const graph = await screen.findByRole("group", { name: /Data flow map/ });
    expect(within(graph).queryByRole("button", { name: /Quiet idle-a/ })).toBeNull();
    expect(screen.getByRole("list", { name: "Data sources, problems first" }).textContent).toContain("Quiet idle-a");
    fireEvent.click(within(graph).getByRole("button", { name: /3 more not set up/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Show these on the map" }));
    await waitFor(() => expect(within(graph).getByRole("button", { name: /Quiet idle-a/ })).toBeTruthy());
  });

  it("only ever reads: every request is a GET with no body", async () => {
    render(<DataFlowPage />);
    const graph = await screen.findByRole("group", { name: /Data flow map/ });
    fireEvent.click(within(graph).getByRole("button", { name: /Calendar pull/ }));
    await screen.findByRole("dialog", { name: "Calendar pull" });
    for (const call of fetchMock.mock.calls) {
      expect(call[0]).toBe("/api/data-flow");
      const init = (call[1] ?? {}) as { method?: string; body?: unknown };
      expect(init.method ?? "GET").toBe("GET");
      expect(init.body).toBeUndefined();
    }
  });

  it("folds everything opened back with one control", async () => {
    render(<DataFlowPage />);
    const graph = await screen.findByRole("group", { name: /Data flow map/ });
    expect(screen.queryByRole("button", { name: "Fold all" })).toBeNull();
    fireEvent.click(within(graph).getByRole("button", { name: /Activity store/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Open into sources" }));
    await waitFor(() => expect(within(graph).getByRole("button", { name: /Physiology/ })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Fold all" }));
    await waitFor(() => expect(within(graph).queryByRole("button", { name: /Physiology/ })).toBeNull());
    expect(screen.queryByRole("button", { name: "Fold all" })).toBeNull();
  });

  it("shows the collected-but-unused sources when the count is pressed", async () => {
    render(<DataFlowPage />);
    const graph = await screen.findByRole("group", { name: /Data flow map/ });
    fireEvent.click(screen.getByRole("button", { name: "Show collected, unused only" }));
    expect(within(graph).getByRole("button", { name: /Music export/ })).toBeTruthy();
    expect(within(graph).queryByRole("button", { name: /Calendar pull/ })).toBeNull();
  });

  it("moves between map nodes with the arrow keys and has a single tab stop", async () => {
    render(<DataFlowPage />);
    const graph = await screen.findByRole("group", { name: /Data flow map/ });
    const stops = within(graph)
      .getAllByRole("button")
      .filter((b) => b.getAttribute("tabindex") === "0");
    expect(stops).toHaveLength(1);
    stops[0]!.focus();
    fireEvent.keyDown(stops[0]!, { key: "ArrowDown" });
    const now = within(graph)
      .getAllByRole("button")
      .filter((b) => b.getAttribute("tabindex") === "0");
    expect(now).toHaveLength(1);
    expect(now[0]).not.toBe(stops[0]);
  });

  it("drops a filter whose chip has gone, so the page is never stuck empty", async () => {
    const data = response();
    data.entries = data.entries.map((e) => (e.id === "watch-export" ? { ...e, owner: "extra" } : e));
    fetchMock.mockImplementation(async () => ok(data));
    vi.useFakeTimers();
    try {
      render(<DataFlowPage />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      fireEvent.click(screen.getByRole("button", { name: "Private" }));
      const graph = screen.getByRole("group", { name: /Data flow map/ });
      expect(within(graph).queryByRole("button", { name: /Calendar pull/ })).toBeNull();
      // The next read has no private entries, so the Core and Private chips go; the filter has to go with them.
      fetchMock.mockImplementation(async () => ok(response()));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(screen.queryByRole("button", { name: "Private" })).toBeNull();
      expect(
        within(screen.getByRole("group", { name: /Data flow map/ })).getByRole("button", { name: /Calendar pull/ })
      ).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("says Nothing matches on the map as well as in the list", async () => {
    render(<DataFlowPage />);
    await screen.findByRole("group", { name: /Data flow map/ });
    fireEvent.click(screen.getByRole("button", { name: "Problems only" }));
    expect(screen.queryByRole("group", { name: /Data flow map/ })).toBeNull();
    expect(screen.getAllByText(/Nothing matches/).length).toBe(2);
  });

  it("marks map nodes as opening a dialog, not as toggles", async () => {
    render(<DataFlowPage />);
    const graph = await screen.findByRole("group", { name: /Data flow map/ });
    const node = within(graph).getByRole("button", { name: /Calendar pull/ });
    expect(node.getAttribute("aria-haspopup")).toBe("dialog");
    expect(node.hasAttribute("aria-pressed")).toBe(false);
    expect(graph.getAttribute("aria-describedby")).toBeTruthy();
  });

  it("opens the activity store into its sources", async () => {
    render(<DataFlowPage />);
    const graph = await screen.findByRole("group", { name: /Data flow map/ });
    fireEvent.click(within(graph).getByRole("button", { name: /Activity store/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Open into sources" }));
    await waitFor(() => expect(within(graph).getByRole("button", { name: /Physiology/ })).toBeTruthy());
  });

  it("says Health unavailable over the static graph when the endpoint goes down, and recovers", async () => {
    vi.useFakeTimers();
    try {
      render(<DataFlowPage />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.queryByText(/Health unavailable/)).toBeNull();
      fetchMock.mockImplementation(async () => ({ ok: false, status: 503, json: async () => ({}) }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      const banner = screen.getByRole("status", { name: "" });
      expect(banner.textContent).toMatch(/Health unavailable/);
      const graph = screen.getByRole("group", { name: /Data flow map/ });
      expect(within(graph).getByRole("button", { name: /Calendar pull/ })).toBeTruthy();
      // Old colours and ages are not shown as if they were live while health is down.
      expect(within(graph).getByRole("button", { name: /Calendar pull, Health unavailable/ })).toBeTruthy();
      expect(within(graph).queryByRole("button", { name: /, Fresh/ })).toBeNull();
      expect(screen.queryByRole("button", { name: "Show collected, unused only" })).toBeNull();
      fetchMock.mockImplementation(async () => ok(response()));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(screen.queryByText(/Health unavailable/)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("offers a retry when the first read fails", async () => {
    fetchMock.mockImplementation(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    render(<DataFlowPage />);
    expect(await screen.findByText(/could not be read/)).toBeTruthy();
    fetchMock.mockImplementation(async () => ok(response()));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("group", { name: /Data flow map/ })).toBeTruthy();
  });

  it("renders the list view alongside the graph for a phone", async () => {
    render(<DataFlowPage />);
    await screen.findByRole("group", { name: /Data flow map/ });
    expect(screen.getByRole("list", { name: "Data sources, problems first" })).toBeTruthy();
  });
});

describe("DataFlowCountsLink", () => {
  it("links the counts line to the Data page", async () => {
    fetchMock.mockImplementation(async () => ok(withStaleCalendar()));
    render(<DataFlowCountsLink />);
    const link = await screen.findByRole("link", { name: /^Data map: 1 late/ });
    expect(link.getAttribute("href")).toBe("/data");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("shows nothing when the map cannot be read", async () => {
    fetchMock.mockImplementation(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    render(<DataFlowCountsLink />);
    await act(async () => {});
    expect(screen.queryByRole("link")).toBeNull();
  });
});
