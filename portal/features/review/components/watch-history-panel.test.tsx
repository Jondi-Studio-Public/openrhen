// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/test/render";
import { WatchHistoryPanel } from "./watch-history-panel";

const review = (over: Record<string, unknown> = {}) => ({
  timezone: "Europe/London",
  from: "2026-10-08",
  to: "2026-11-06",
  hasData: true,
  watchesHeld: 3,
  lengths: { keyState: "unset", known: 0, missing: 3, unavailable: 0, quotaPaused: false },
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

const lengthsResult = (over: Record<string, unknown> = {}) => ({
  fetched: 3,
  remaining: 0,
  stopped: null,
  message: "Looked up 3 videos; every watched video now has its length.",
  ...over
});

describe("WatchHistoryPanel", () => {
  it("keeps one polite status region in the page from the first render, empty until there is something to say", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {}))
    );
    render(<WatchHistoryPanel />);
    const status = document.querySelector("[data-watch-status]")!;
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.textContent).toBe("");
  });

  it("says how many watches are held when none fall in the window", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          Response.json(
            review({
              total: 0,
              watchesHeld: 12,
              estimate: { lowMin: 0, highMin: 0, midMin: 0, videos: 0, sessions: 0, unknownCount: 0 },
              days: Array.from({ length: 30 }, (_, i) => ({
                date: `2026-10-${String(i + 1).padStart(2, "0")}`,
                count: 0
              }))
            })
          )
        )
      )
    );
    render(<WatchHistoryPanel />);
    expect(await screen.findByText("12 watches held, none in the last 30 days.")).toBeTruthy();
    expect(screen.queryByText(/No videos watched in this period/)).toBeNull();
  });

  it("asks for a YouTube key, linking to the page, when none is saved", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(Response.json(review())))
    );
    render(<WatchHistoryPanel />);
    expect(
      await screen.findByText(
        "Add a YouTube API key in Settings > Passwords and keys to estimate time from video lengths."
      )
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Passwords and keys" }).getAttribute("href")).toBe(
      "/settings/passwords-and-keys"
    );
    expect(screen.queryByRole("button", { name: "Fetch video lengths" })).toBeNull();
  });

  it("fetches lengths on the button, repeating while videos remain, and then re-reads", async () => {
    const lengths = { keyState: "set", known: 0, missing: 3, unavailable: 0, quotaPaused: false };
    const answers = [
      lengthsResult({ fetched: 2, remaining: 1, message: "Looked up 2 videos; 1 still to do." }),
      lengthsResult({ fetched: 1 })
    ];
    const fetchMock = vi.fn((url: string, init?: RequestInit) =>
      Promise.resolve(
        init?.method === "POST" && url === "/api/review/watch-history/lengths"
          ? Response.json(answers.shift())
          : Response.json(review({ lengths }))
      )
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<WatchHistoryPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Fetch video lengths" }));
    await waitFor(() => expect(screen.getByText(/every watched video now has its length/)).toBeTruthy());
    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) => url === "/api/review/watch-history/lengths" && init?.method === "POST"
      )
    ).toHaveLength(2);
  });

  it("stops on the server's reason and says it, without looping", async () => {
    const lengths = { keyState: "set", known: 0, missing: 3, unavailable: 0, quotaPaused: false };
    const fetchMock = vi.fn((url: string, init?: RequestInit) =>
      Promise.resolve(
        init?.method === "POST"
          ? Response.json(
              lengthsResult({
                fetched: 0,
                remaining: 3,
                stopped: "quota",
                message:
                  "YouTube's daily quota is used up. Lengths resume on the next run, after midnight Pacific time."
              })
            )
          : Response.json(review({ lengths }))
      )
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<WatchHistoryPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Fetch video lengths" }));
    await waitFor(() => expect(screen.getByText(/daily quota is used up/)).toBeTruthy());
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("starts the length lookup by itself after an import when a key is saved", async () => {
    const lengths = { keyState: "set", known: 0, missing: 3, unavailable: 0, quotaPaused: false };
    const fetchMock = vi.fn((url: string) =>
      Promise.resolve(
        url === "/api/imports/watch-history"
          ? Response.json({
              importId: "i",
              read: 3,
              added: 3,
              alreadyHeld: 0,
              skipped: 0,
              watches: 3,
              ads: 0,
              posts: 0,
              music: 0
            })
          : url === "/api/review/watch-history/lengths"
            ? Response.json(lengthsResult())
            : Response.json(review({ lengths }))
      )
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<WatchHistoryPanel />);
    fireEvent.click(await screen.findByText("Import Takeout"));
    fireEvent.change(await screen.findByLabelText("Takeout file"), { target: { files: [new File(["[]"], "w.json")] } });
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => url === "/api/review/watch-history/lengths")).toBe(true)
    );
  });

  it("does not look up lengths after an import when no key is saved", async () => {
    const fetchMock = vi.fn((url: string) =>
      Promise.resolve(
        url === "/api/imports/watch-history"
          ? Response.json({
              importId: "i",
              read: 3,
              added: 3,
              alreadyHeld: 0,
              skipped: 0,
              watches: 3,
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
    fireEvent.change(await screen.findByLabelText("Takeout file"), { target: { files: [new File(["[]"], "w.json")] } });
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    await screen.findByText("3 watches added.");
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/review/watch-history/lengths")).toBe(false);
  });

  it("disables the delete button while its request is pending, so it cannot be sent twice", async () => {
    let release: (value: Response) => void = () => {};
    const fetchMock = vi.fn((_url: string, init?: RequestInit) =>
      init?.method === "DELETE"
        ? new Promise<Response>((resolve) => {
            release = resolve;
          })
        : Promise.resolve(Response.json(review()))
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<WatchHistoryPanel />);
    const button = await screen.findByRole("button", { name: "Delete import watch-history.json" });
    fireEvent.click(button);
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(true));
    fireEvent.click(button);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(1);
    release(Response.json({ deleted: true, removed: 3 }));
    await waitFor(() => expect(screen.getByText("Import deleted: 3 entries removed.")).toBeTruthy());
  });

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
        return Promise.resolve(Response.json({ deleted: true, removed: 3 }));
      }
      return Promise.resolve(Response.json(deleted ? review({ hasData: false, imports: [], total: 0 }) : review()));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<WatchHistoryPanel />);
    fireEvent.click(await screen.findByText("Delete this import"));
    await waitFor(() => expect(screen.getByText("Import deleted: 3 entries removed.")).toBeTruthy());
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

  it("refuses a file over the limit before reading it, saying the limit", async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) => Promise.resolve(Response.json(review())));
    vi.stubGlobal("fetch", fetchMock);
    render(<WatchHistoryPanel />);
    fireEvent.click(await screen.findByText("Import Takeout"));
    const big = new File(["[]"], "big.json");
    Object.defineProperty(big, "size", { value: 60 * 1024 * 1024 });
    fireEvent.change(await screen.findByLabelText("Takeout file"), { target: { files: [big] } });
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    expect(await screen.findByText(/That file is 60 MB; the limit is 50 MB/)).toBeTruthy();
    expect(fetchMock.mock.calls.every(([, init]) => init?.method !== "POST")).toBe(true);
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
