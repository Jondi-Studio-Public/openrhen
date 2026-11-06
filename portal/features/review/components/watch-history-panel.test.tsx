// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/test/render";
import { WatchHistoryPanel } from "./watch-history-panel";

const review = (over: Record<string, unknown> = {}) => ({
  timezone: "Europe/London",
  from: "2026-10-08",
  to: "2026-11-06",
  hasData: true,
  days: [
    { date: "2026-11-05", count: 3 },
    { date: "2026-11-06", count: 0 }
  ],
  hours: Array.from({ length: 24 }, (_, hour) => (hour === 9 ? 3 : 0)),
  total: 3,
  estimate: { lowMin: 0, highMin: 20, midMin: 10, videos: 3, sessions: 1, unknownCount: 1 },
  excluded: { ads: 2, posts: 0, music: 0 },
  imports: [{ id: "imp-1", filename: "watch-history.json", eventCount: 3, importedAt: "2026-11-06T10:00:00.000Z" }],
  ...over
});

afterEach(() => vi.unstubAllGlobals());

describe("WatchHistoryPanel", () => {
  it("explains how to request a Takeout when nothing is imported", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(Response.json(review({ hasData: false, imports: [], total: 0 }))))
    );
    render(<WatchHistoryPanel />);
    expect(await screen.findByText(/takeout\.google\.com/)).toBeTruthy();
    expect(screen.getByText(/format to JSON/)).toBeTruthy();
  });

  it("shows counts and an estimate labelled as one that leans high", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(Response.json(review())))
    );
    render(<WatchHistoryPanel />);
    expect(await screen.findByText(/3 videos watched/)).toBeTruthy();
    expect(screen.getByText(/Estimated time: up to 20m, probably less/)).toBeTruthy();
    expect(screen.getByText(/so it leans high/)).toBeTruthy();
    expect(screen.getByLabelText("Videos watched per day")).toBeTruthy();
    expect(screen.getByLabelText("Videos watched per hour of the day")).toBeTruthy();
    expect(screen.getByText(/Not counted: 2 ads/)).toBeTruthy();
    expect(screen.getByText("5 Nov: 3")).toBeTruthy();
    expect(screen.getByText("09:00: 3")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete import watch-history.json" })).toBeTruthy();
  });

  it("says the read failed instead of showing numbers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("{}", { status: 500 })))
    );
    render(<WatchHistoryPanel />);
    expect(await screen.findByText(/could not be read/)).toBeTruthy();
    expect(screen.queryByText(/videos watched/)).toBeNull();
  });

  it("deletes an import and re-reads", async () => {
    let deleted = false;
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        deleted = true;
        return Promise.resolve(Response.json({ deleted: true }));
      }
      return Promise.resolve(Response.json(deleted ? review({ hasData: false, imports: [], total: 0 }) : review()));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<WatchHistoryPanel />);
    fireEvent.click(await screen.findByText("Delete this import"));
    await waitFor(() => expect(screen.getByText("Import deleted.")).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledWith("/api/imports/watch-history/imp-1", { method: "DELETE" });
  });

  it("posts a chosen JSON file as text and reports what was added", async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) =>
      Promise.resolve(
        init?.method === "POST"
          ? Response.json({
              importId: "i",
              read: 2,
              added: 2,
              alreadyHeld: 0,
              skipped: 0,
              watches: 2,
              ads: 0,
              posts: 0,
              music: 0
            })
          : Response.json(review())
      )
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<WatchHistoryPanel />);
    fireEvent.click(await screen.findByText("Import Takeout"));
    const file = new File(["[]"], "watch-history.json", { type: "application/json" });
    fireEvent.change(await screen.findByLabelText("Takeout file"), { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    await waitFor(() => expect(screen.getByText("2 watches added.")).toBeTruthy());
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(JSON.parse(String(post[1]!.body))).toEqual({ filename: "watch-history.json", encoding: "text", data: "[]" });
  });

  it("sends a zip as base64 when the bytes start with PK, whatever the filename", async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) =>
      Promise.resolve(
        init?.method === "POST"
          ? Response.json({
              importId: "i",
              read: 3,
              added: 3,
              alreadyHeld: 0,
              skipped: 0,
              watches: 0,
              ads: 1,
              posts: 0,
              music: 2
            })
          : Response.json(review())
      )
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<WatchHistoryPanel />);
    fireEvent.click(await screen.findByText("Import Takeout"));
    const zip = new File([new Uint8Array([0x50, 0x4b, 3, 4])], "takeout.data");
    fireEvent.change(await screen.findByLabelText("Takeout file"), { target: { files: [zip] } });
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    await waitFor(() =>
      expect(screen.getByText(/0 watches added, 2 YouTube Music plays kept, not counted, 1 ad kept/)).toBeTruthy()
    );
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(JSON.parse(String(post[1]!.body))).toMatchObject({ encoding: "base64", data: "UEsDBA==" });
  });

  it("shows the server's reason when an import is refused, and adds nothing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) =>
        Promise.resolve(
          init?.method === "POST"
            ? Response.json({ error: "That file is too large." }, { status: 413 })
            : Response.json(review())
        )
      )
    );
    render(<WatchHistoryPanel />);
    fireEvent.click(await screen.findByText("Import Takeout"));
    fireEvent.change(await screen.findByLabelText("Takeout file"), {
      target: { files: [new File(["[]"], "x.json")] }
    });
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    expect(await screen.findByText("That file is too large.")).toBeTruthy();
  });
});
