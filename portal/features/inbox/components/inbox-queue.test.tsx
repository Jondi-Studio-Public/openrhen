// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { act, fireEvent, render, screen, within } from "@/test/render";
import { emptyRoomCounts, type InboxFilter, type RoomCounts } from "@/features/inbox/rooms";
import type { QueueEntry } from "@/features/inbox/queue";
import { mailSource } from "@/state/extensions";

const replace = vi.fn();
const yes = vi.fn();
const no = vi.fn();
const beginReview = vi.fn();
const openBatch = vi.fn();
const reload = vi.fn();
const bulkConfirm = vi.fn();
let inbox: Record<string, unknown>;

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace, push: vi.fn() }) }));
vi.mock("@/features/inbox/inbox-provider", () => ({ useInbox: () => inbox }));
vi.mock("@/shared/clock", () => ({ useNow: () => new Date("2026-10-28T02:00:00.000Z") }));
vi.mock("./queue-detail", () => ({
  QueueDetail: function MockDetail({ entry }: { entry: QueueEntry }) {
    const [label, setLabel] = useState("Yes");
    const [off, setOff] = useState(false);
    const [quiet, setQuiet] = useState(false);
    return (
      <div data-testid="detail">
        <h2>{entry.title}</h2>
        <button
          data-inbox-action="yes"
          disabled={off}
          aria-describedby="why-yes"
          data-inbox-weight={quiet ? "quiet" : undefined}
          onClick={() => yes(entry.key)}
        >
          {label}
        </button>
        <button data-inbox-action="no" onClick={() => no(entry.key)}>
          No
        </button>
        <button onClick={() => setLabel("Add to plan")}>Relabel</button>
        <button onClick={() => setQuiet(true)}>Go quiet</button>
        <button onClick={() => setOff(true)}>Disable yes</button>
        <input aria-label="Reply" />
      </div>
    );
  }
}));
vi.mock("./add-sheet", () => ({ AddSheet: () => <button>Add or import</button> }));
vi.mock("./replaced-list", () => ({ ReplacedList: () => <div data-testid="replaced" /> }));
vi.mock("@/components/recently-handled", () => ({
  RecentlyHandled: ({ rows }: { rows: readonly unknown[] }) => <div data-testid="handled" data-rows={rows.length} />
}));
vi.mock("@/features/imports/components/import-history-list", () => ({
  ImportHistoryList: () => <div data-testid="import-history" />
}));
vi.mock("@/features/imports/components/import-status-banners", () => ({ ImportStatusBanners: () => null }));
vi.mock("../use-recently-handled", () => ({
  useRecentlyHandled: () => ({ emails: [], captured: [], kept: [] }),
  useRecentlyReplaced: () => []
}));
vi.mock("@/features/agent-proposals/agent-proposals-store", () => ({
  handledAgentRows: () => [],
  useAgentProposals: () => []
}));

const { InboxQueue, inboxAnswer } = await import("./inbox-queue");

let serial = 0;
const entry = (title: string, room: QueueEntry["room"], overrides: Record<string, unknown> = {}): QueueEntry =>
  ({
    kind: "link",
    link: { id: `l${++serial}` },
    key: `link:${title}`,
    room,
    title,
    meta: `Meta of ${title}`,
    tag: { label: `Tag ${title}`, tone: "neutral" },
    waiting: true,
    ...overrides
  }) as unknown as QueueEntry;

const first = entry("First thing", "emails");
const second = entry("Second thing", "captured");
const third = entry("Third thing", "map");
const read = entry("Read note", "people", { waiting: false });
const filed = entry("Filed away", "kept", { waiting: false });
const queue = [first, second, third, read, filed];

function setInbox(overrides: Record<string, unknown> = {}, counts: Partial<RoomCounts> = {}) {
  inbox = {
    desk: true,
    queue,
    counts: { ...emptyRoomCounts, emails: 1, captured: 1, map: 1, kept: 1, ...counts },
    emailCount: { waiting: 0 },
    imports: { batch: null, history: [], busy: false, queueStatus: {}, queueError: "", queueLoaded: true },
    decisions: { leaving: new Map(), hidden: new Set<string>() },
    proposals: { reviewingId: null, beginReview, replacedError: "", restore: vi.fn() },
    planMap: { status: "ready", error: "", actionError: "", map: null, handled: [], busy: false, reload, bulkConfirm },
    openBatch,
    ...overrides
  };
}

const show = (filter: InboxFilter = "all") => render(<InboxQueue filter={filter} />);
const list = () => screen.getByRole("region", { name: "Waiting" });
const detail = () => screen.getByTestId("detail");
const key = (value: string, target: Node = document.body, init: KeyboardEventInit = {}) =>
  fireEvent.keyDown(target, { key: value, ...init });

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  for (const spy of [replace, yes, no, beginReview, openBatch, reload, bulkConfirm]) spy.mockReset();
  setInbox();
});

describe("inboxAnswer", () => {
  it.each([
    [3, "3 things to decide. Nothing changes your plan until you say so."],
    [1, "1 thing to decide. Nothing changes your plan until you say so."],
    [0, "Nothing to decide. Nothing changes your plan until you say so."]
  ])("says %i waiting as a sentence", (waiting, sentence) => {
    expect(inboxAnswer(waiting)).toBe(sentence);
  });

  it("adds how long the oldest has waited", () => {
    expect(inboxAnswer(47, "oldest: 6 weeks")).toBe(
      "47 things to decide, oldest: 6 weeks. Nothing changes your plan until you say so."
    );
  });
});

describe("InboxQueue head", () => {
  it("answers with the badge total, leaving kept items out", () => {
    setInbox({}, { emails: 2, people: 1, captured: 0, calendar: 0, map: 0, kept: 9 });
    show();
    expect(screen.getByRole("heading", { name: "Inbox" })).toBeTruthy();
    expect(screen.getByText("3 things to decide. Nothing changes your plan until you say so.")).toBeTruthy();
  });

  it("says one thing, and says nothing to decide", () => {
    setInbox({}, { emails: 1, captured: 0, map: 0, kept: 0 });
    const { unmount } = show();
    expect(screen.getByText(/^1 thing to decide\./)).toBeTruthy();
    unmount();
    setInbox({ queue: [] }, { emails: 0, captured: 0, map: 0, kept: 0 });
    show();
    expect(screen.getByText(/^Nothing to decide\. Nothing changes/)).toBeTruthy();
  });

  it("offers Add or import", () => {
    show();
    expect(screen.getByRole("button", { name: "Add or import" })).toBeTruthy();
  });
});

describe("InboxQueue chips", () => {
  it("lists All and the six rooms with their counts, Kept for later without one", () => {
    setInbox({}, { emails: 2, people: 1, captured: 3, calendar: 4, map: 5, kept: 7 });
    show();
    const chips = within(screen.getByRole("group", { name: "Show" }));
    // The Emails room is the mail feature's: it is there exactly when a mail source is registered (see the mail twin).
    const names = chips.getAllByRole("button").map((button) => button.textContent);
    expect(names.some((name) => name?.startsWith("Emails"))).toBe(mailSource() !== undefined);
    expect(names.filter((name) => !name?.startsWith("Emails"))).toEqual([
      "All 15",
      "From people1",
      "Captured3",
      "Calendar4",
      "Links5",
      "Kept for later"
    ]);
  });

  it("presses the active filter's chip and no other", () => {
    show("map");
    const pressed = within(screen.getByRole("group", { name: "Show" }))
      .getAllByRole("button")
      .filter((button) => button.getAttribute("aria-pressed") === "true")
      .map((button) => button.textContent);
    expect(pressed).toEqual(["Links1"]);
  });

  it("presses All on the unfiltered queue", () => {
    show("all");
    expect(screen.getByRole("button", { name: /^All/ }).getAttribute("aria-pressed")).toBe("true");
  });

  it.each([
    [/^From people/, "/inbox/people"],
    [/^Captured/, "/inbox/captured"],
    [/^Calendar/, "/inbox/calendar"],
    [/^Links/, "/inbox/map"],
    [/^Kept for later/, "/inbox/kept"]
  ])("replaces the address with %s's room", (name, href) => {
    show("all");
    fireEvent.click(screen.getByRole("button", { name }));
    expect(replace).toHaveBeenCalledWith(href, { scroll: false });
  });

  it("goes back to /inbox from All", () => {
    show("emails");
    fireEvent.click(screen.getByRole("button", { name: /^All/ }));
    expect(replace).toHaveBeenCalledWith("/inbox", { scroll: false });
  });
});

describe("InboxQueue on a desk", () => {
  it("lists the waiting entries, not the filed ones, with the first one's detail", () => {
    show("all");
    const rows = within(list()).getAllByRole("button");
    expect(rows.map((row) => row.textContent)).toEqual([
      "First thingMeta of First thingTag First thing",
      "Second thingMeta of Second thingTag Second thing",
      "Third thingMeta of Third thingTag Third thing"
    ]);
    expect(within(detail()).getByRole("heading").textContent).toBe("First thing");
    expect(rows[0]!.getAttribute("aria-current")).toBe("true");
    expect(rows[1]!.hasAttribute("aria-current")).toBe(false);
  });

  it("lists everything in a room, waiting or not", () => {
    show("people");
    expect(within(list()).getByRole("button", { name: /Read note/ })).toBeTruthy();
    expect(within(detail()).getByRole("heading").textContent).toBe("Read note");
  });

  it("moves the detail to a clicked row and marks it current", () => {
    show("all");
    fireEvent.click(within(list()).getByRole("button", { name: /Third thing/ }));
    expect(within(detail()).getByRole("heading").textContent).toBe("Third thing");
    expect(
      within(list())
        .getByRole("button", { name: /Third thing/ })
        .getAttribute("aria-current")
    ).toBe("true");
    expect(
      within(list())
        .getByRole("button", { name: /First thing/ })
        .hasAttribute("aria-current")
    ).toBe(false);
  });

  it("moves with J and K, and stops at either end", () => {
    show("all");
    const heading = () => within(detail()).getByRole("heading").textContent;
    key("k");
    expect(heading()).toBe("First thing");
    key("j");
    expect(heading()).toBe("Second thing");
    key("J");
    expect(heading()).toBe("Third thing");
    key("j");
    expect(heading()).toBe("Third thing");
    key("k");
    expect(heading()).toBe("Second thing");
  });

  it("clicks the detail's yes button on Y and its no button on N", () => {
    show("all");
    key("j");
    key("y");
    expect(yes).toHaveBeenCalledWith("link:Second thing");
    key("n");
    expect(no).toHaveBeenCalledWith("link:Second thing");
  });

  it("does not take a quiet-weighted (risky) yes on Y: it focuses the button so Enter or a click must confirm", () => {
    show("all");
    fireEvent.click(within(detail()).getByRole("button", { name: "Go quiet" }));
    key("y");
    expect(yes).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(detail().querySelector('[data-inbox-action="yes"]'));
    key("n");
    expect(no).toHaveBeenCalledWith("link:First thing");
  });

  it("ignores the keys while typing in an input, and with a modifier held", () => {
    show("all");
    const input = screen.getByLabelText("Reply");
    key("j", input);
    key("y", input);
    key("n", input);
    expect(yes).not.toHaveBeenCalled();
    expect(no).not.toHaveBeenCalled();
    expect(within(detail()).getByRole("heading").textContent).toBe("First thing");
    fireEvent.keyDown(document.body, { key: "y", ctrlKey: true });
    fireEvent.keyDown(document.body, { key: "j", metaKey: true });
    expect(yes).not.toHaveBeenCalled();
    expect(within(detail()).getByRole("heading").textContent).toBe("First thing");
  });

  it("does nothing on Y when the detail has no yes button", () => {
    show("all");
    detail().querySelector('[data-inbox-action="yes"]')!.remove();
    key("y");
    expect(yes).not.toHaveBeenCalled();
  });

  it("shows the key hint under the list", () => {
    show("all");
    expect(screen.getByText("Use J and K to move, Y to take the main action, N to ignore.")).toBeTruthy();
  });

  it("moves to the entry that took its place when the chosen one leaves", () => {
    const { rerender } = show("all");
    key("j");
    expect(within(detail()).getByRole("heading").textContent).toBe("Second thing");
    setInbox({ queue: [first, third, read, filed] });
    rerender(<InboxQueue filter="all" />);
    expect(within(detail()).getByRole("heading").textContent).toBe("Third thing");
  });

  it("opens a capture for review and a calendar's batch when they are chosen", () => {
    const item = { id: "c1" };
    const capture = entry("A capture", "captured", { kind: "capture", key: "capture:c1", item });
    const calendar = entry("Google Calendar: 2 events to review", "calendar", {
      kind: "calendar",
      key: "calendar:google_calendar",
      batchId: "b1"
    });
    setInbox({ queue: [capture, calendar] });
    show("all");
    expect(beginReview).toHaveBeenCalledWith(item);
    fireEvent.click(within(list()).getByRole("button", { name: /Google Calendar/ }));
    expect(openBatch).toHaveBeenCalledWith("b1");
  });
});

describe("InboxQueue empty states", () => {
  it.each([
    ["all", "Nothing to decide"],
    ["emails", "No email changes"],
    ["people", "Nothing from people"],
    ["captured", "Nothing captured"],
    ["calendar", "No calendar events to review"],
    ["map", "No links or findings"],
    ["kept", "Nothing kept for later"]
  ] as const)("says so under the %s chip", (filter, title) => {
    setInbox({ queue: [] });
    show(filter);
    expect(within(list()).getByText(title)).toBeTruthy();
    expect(screen.queryByTestId("detail")).toBeNull();
  });

  it("says a room is empty when only other rooms have entries", () => {
    show("calendar");
    expect(within(list()).getByText("No calendar events to review")).toBeTruthy();
  });
});

describe("InboxQueue on a phone", () => {
  beforeEach(() => setInbox({ desk: false }));
  afterEach(() => vi.unstubAllGlobals());

  it("shows one card with its place in the queue, and no list or chips", () => {
    show("all");
    expect(screen.getByText("1 of 3")).toBeTruthy();
    expect(within(detail()).getByRole("heading").textContent).toBe("First thing");
    expect(screen.queryByRole("region", { name: "Waiting" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Show" })).toBeNull();
    expect(screen.queryByText(/Use J and K/)).toBeNull();
  });

  it("steps with Next and Previous, disabled at the ends", () => {
    show("all");
    const next = () => screen.getByRole("button", { name: "Next" }) as HTMLButtonElement;
    const previous = () => screen.getByRole("button", { name: "Previous" }) as HTMLButtonElement;
    expect(previous().disabled).toBe(true);
    fireEvent.click(next());
    expect(screen.getByText("2 of 3")).toBeTruthy();
    expect(within(detail()).getByRole("heading").textContent).toBe("Second thing");
    fireEvent.click(next());
    expect(screen.getByText("3 of 3")).toBeTruthy();
    expect(next().disabled).toBe(true);
    fireEvent.click(previous());
    expect(screen.getByText("2 of 3")).toBeTruthy();
  });

  it("shows the list and chips behind a List button, and returns to one at a time", () => {
    show("all");
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    expect(within(list()).getAllByRole("button")).toHaveLength(3);
    expect(screen.getByRole("group", { name: "Show" })).toBeTruthy();
    expect(screen.queryByTestId("detail")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "One at a time" }));
    expect(screen.getByText("1 of 3")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Waiting" })).toBeNull();
  });

  it("opens the card for a row picked from the list", () => {
    show("all");
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    fireEvent.click(within(list()).getByRole("button", { name: /Third thing/ }));
    expect(screen.getByText("3 of 3")).toBeTruthy();
    expect(within(detail()).getByRole("heading").textContent).toBe("Third thing");
    expect(screen.queryByRole("region", { name: "Waiting" })).toBeNull();
  });

  it("answers J, K, Y and N the same way", () => {
    show("all");
    key("j");
    expect(screen.getByText("2 of 3")).toBeTruthy();
    key("y");
    expect(yes).toHaveBeenCalledWith("link:Second thing");
    key("k");
    expect(screen.getByText("1 of 3")).toBeTruthy();
  });

  it("shows the empty state with the chips, and no List button, when nothing waits", () => {
    setInbox({ desk: false, queue: [] });
    show("emails");
    expect(within(list()).getByText("No email changes")).toBeTruthy();
    expect(screen.getByRole("group", { name: "Show" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "List" })).toBeNull();
  });
});

describe("InboxQueue notices", () => {
  it("says how many email threads wait for the desktop model under All and Emails only", () => {
    setInbox({ emailCount: { waiting: 2 } });
    const { unmount } = show("emails");
    expect(screen.getByText(/2 email threads are waiting for the desktop model/)).toBeTruthy();
    unmount();
    const again = show("captured");
    expect(screen.queryByText(/waiting for the desktop model/)).toBeNull();
    again.unmount();
    setInbox({ emailCount: { waiting: 1 } });
    show("all");
    expect(screen.getByText(/1 email thread is waiting for the desktop model/)).toBeTruthy();
  });

  it("reports a plan map that could not load, with Try again, under All and Links", () => {
    setInbox({
      planMap: {
        status: "error",
        error: "Server unavailable",
        actionError: "",
        map: null,
        handled: [],
        busy: false,
        reload,
        bulkConfirm
      }
    });
    const { unmount } = show("map");
    expect(screen.getByRole("alert").textContent).toContain("Server unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(reload).toHaveBeenCalledTimes(1);
    unmount();
    show("captured");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("reports a failed decision", () => {
    setInbox({
      planMap: {
        status: "ready",
        error: "",
        actionError: "That link no longer exists.",
        map: null,
        handled: [],
        busy: false,
        reload,
        bulkConfirm
      }
    });
    show("all");
    expect(screen.getByRole("alert").textContent).toBe("That link no longer exists.");
  });

  it("offers a bulk confirm under Links for a proposer's several suggested links", () => {
    const suggested = (id: string) => ({ id, status: "suggested", proposer: "rule:keywords", kind: "about" });
    setInbox({
      planMap: {
        status: "ready",
        error: "",
        actionError: "",
        map: { links: [suggested("a"), suggested("b")], findings: [] },
        handled: [],
        busy: false,
        reload,
        bulkConfirm
      }
    });
    const { unmount } = show("map");
    fireEvent.click(screen.getByRole("button", { name: 'Confirm all 2 "about" from rule:keywords' }));
    expect(bulkConfirm).toHaveBeenCalledWith("rule:keywords", "about");
    unmount();
    show("captured");
    expect(screen.queryByRole("button", { name: /Confirm all/ })).toBeNull();
  });
});

describe("InboxQueue backlog sweep", () => {
  const aged = (id: string, room: QueueEntry["room"]) =>
    ({
      kind: "capture",
      item: { id, sourceType: "manual_capture" },
      key: `capture:${id}`,
      room,
      title: `Capture ${id}`,
      meta: "",
      tag: { label: "To sort", tone: "neutral" },
      waiting: true,
      arrivedAt: "2026-09-10T00:00:00.000Z"
    }) as unknown as QueueEntry;

  it("ignores everything older than two weeks in one call, on All, Emails and Captured only", () => {
    const ignore = vi.fn();
    setInbox({ queue: [aged("a", "captured"), aged("b", "captured"), first], ignore });
    const { unmount } = show("captured");
    expect(screen.getByText(/to decide, oldest: 6 weeks\./)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Ignore everything older than 2 weeks (2)" }));
    expect(ignore).toHaveBeenCalledWith(["a", "b"]);
    unmount();
    show("map");
    expect(screen.queryByRole("button", { name: /Ignore everything older/ })).toBeNull();
  });

  it("runs one sweep at a time, however fast it is pressed", async () => {
    let finish!: () => void;
    const ignore = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    setInbox({ queue: [aged("a", "captured"), aged("b", "captured")], ignore });
    show("captured");
    const button = screen.getByRole("button", { name: "Ignore everything older than 2 weeks (2)" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(ignore).toHaveBeenCalledTimes(1);
    expect((button as HTMLButtonElement).disabled).toBe(true);
    await act(async () => finish());
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("InboxQueue handled foot", () => {
  it("shows Calendar's import history there and leaves From people without a history", () => {
    const { unmount } = show("calendar");
    expect(screen.getByTestId("import-history")).toBeTruthy();
    expect(screen.queryByTestId("handled")).toBeNull();
    unmount();
    show("people");
    expect(screen.queryByTestId("import-history")).toBeNull();
    expect(screen.queryByTestId("handled")).toBeNull();
  });

  it("shows recently handled rows and the replaced list under Emails", () => {
    show("emails");
    expect(screen.getByTestId("handled")).toBeTruthy();
    expect(screen.getByTestId("replaced")).toBeTruthy();
  });

  it("does not show the replaced list under Captured", () => {
    show("captured");
    expect(screen.queryByTestId("replaced")).toBeNull();
    expect(screen.getByTestId("handled")).toBeTruthy();
  });
});

const heading = () => within(detail()).getByRole("heading").textContent;

describe("InboxQueue selection stays put", () => {
  it("keeps the detail on screen when an entry arrives above it", () => {
    const { rerender } = show("all");
    key("j");
    expect(heading()).toBe("Second thing");
    const arrival = entry("Arrival", "emails");
    setInbox({ queue: [arrival, first, second, third] });
    rerender(<InboxQueue filter="all" />);
    expect(heading()).toBe("Second thing");
    expect(within(list()).getAllByRole("button")[0]!.textContent).toContain("Arrival");
    expect(
      within(list())
        .getByRole("button", { name: /Second thing/ })
        .getAttribute("aria-current")
    ).toBe("true");
  });

  it("leads with an entry that arrives above the first while nothing has been touched", () => {
    const { rerender } = show("all");
    setInbox({ queue: [entry("Arrival", "emails"), first, second, third] });
    rerender(<InboxQueue filter="all" />);
    expect(heading()).toBe("Arrival");
  });

  const arriveAbove = (rerender: (ui: React.ReactElement) => void) => {
    setInbox({ queue: [entry("Arrival", "emails"), first, second, third] });
    rerender(<InboxQueue filter="all" />);
  };

  it("holds the first entry once the person presses a pointer in the detail", () => {
    const { rerender } = show("all");
    fireEvent.pointerDown(screen.getByRole("heading", { name: "First thing" }));
    arriveAbove(rerender);
    expect(heading()).toBe("First thing");
    expect(within(list()).getAllByRole("button")[0]!.textContent).toContain("Arrival");
  });

  it("holds the first entry once focus moves into the detail", () => {
    const { rerender } = show("all");
    act(() => screen.getByLabelText("Reply").focus());
    arriveAbove(rerender);
    expect(heading()).toBe("First thing");
  });

  it("holds the first entry once Y or N is pressed", () => {
    const { rerender } = show("all");
    key("n");
    arriveAbove(rerender);
    expect(heading()).toBe("First thing");
  });

  it("holds the first entry once the person moves with J or K", () => {
    const { rerender } = show("all");
    key("k");
    arriveAbove(rerender);
    expect(heading()).toBe("First thing");
  });

  it("holds the first entry once a row in the list is clicked", () => {
    const { rerender } = show("all");
    fireEvent.click(within(list()).getByRole("button", { name: /First thing/ }));
    arriveAbove(rerender);
    expect(heading()).toBe("First thing");
  });

  it("does not hold on a key that means nothing to the queue", () => {
    const { rerender } = show("all");
    key("x");
    arriveAbove(rerender);
    expect(heading()).toBe("Arrival");
  });

  it("holds the entry that took a decided one's place, against a later arrival above it", () => {
    const { rerender } = show("all");
    fireEvent.click(within(list()).getByRole("button", { name: /Second thing/ }));
    setInbox({ queue: [first, third] });
    rerender(<InboxQueue filter="all" />);
    expect(heading()).toBe("Third thing");
    setInbox({ queue: [entry("Arrival", "emails"), first, third] });
    rerender(<InboxQueue filter="all" />);
    expect(heading()).toBe("Third thing");
  });

  it("goes back to leading with the first entry after a chip is chosen", () => {
    const { rerender } = show("all");
    fireEvent.pointerDown(screen.getByRole("heading", { name: "First thing" }));
    fireEvent.click(screen.getByRole("button", { name: /^Captured/ }));
    setInbox({ queue: [entry("Arrival", "captured"), first, second, third] });
    rerender(<InboxQueue filter="captured" />);
    expect(heading()).toBe("Arrival");
  });

  it("falls back to the entry now at its position when the chosen one is decided and leaves", () => {
    const { rerender } = show("all");
    fireEvent.click(within(list()).getByRole("button", { name: /Second thing/ }));
    setInbox({ queue: [first, third] });
    rerender(<InboxQueue filter="all" />);
    expect(heading()).toBe("Third thing");
    // And it stays on that one, rather than snapping back when the list changes again.
    setInbox({ queue: [entry("Arrival", "emails"), first, third] });
    rerender(<InboxQueue filter="all" />);
    expect(heading()).toBe("Third thing");
  });

  it("falls back to the last entry when the chosen one was the last", () => {
    const { rerender } = show("all");
    fireEvent.click(within(list()).getByRole("button", { name: /Third thing/ }));
    setInbox({ queue: [first, second] });
    rerender(<InboxQueue filter="all" />);
    expect(heading()).toBe("Second thing");
  });
});

describe("InboxQueue ?item= in the address", () => {
  it("chooses a listed entry named by ?item=", () => {
    window.history.replaceState(null, "", "/inbox/captured?item=link%3AThird%20thing");
    show("all");
    expect(heading()).toBe("Third thing");
    expect(
      within(list())
        .getByRole("button", { name: /Third thing/ })
        .getAttribute("aria-current")
    ).toBe("true");
  });

  it("waits for an entry that has not been listed yet, then shows it when it arrives", () => {
    window.history.replaceState(null, "", "/inbox/captured?item=capture%3Alater");
    const { rerender } = show("all");
    expect(heading()).toBe("First thing");
    const later = entry("Later capture", "captured", { key: "capture:later", kind: "link" });
    setInbox({ queue: [first, later] });
    rerender(<InboxQueue filter="all" />);
    expect(heading()).toBe("Later capture");
  });

  it("opens on the first entry when there is no ?item=", () => {
    show("all");
    expect(heading()).toBe("First thing");
  });
});

describe("InboxQueue held keys", () => {
  it("ignores a repeated key press, for yes and for J", () => {
    show("all");
    key("y", document.body, { repeat: true });
    key("n", document.body, { repeat: true });
    key("j", document.body, { repeat: true });
    expect(yes).not.toHaveBeenCalled();
    expect(no).not.toHaveBeenCalled();
    expect(heading()).toBe("First thing");
    key("y");
    expect(yes).toHaveBeenCalledTimes(1);
  });
});

describe("InboxQueue while a decision runs", () => {
  const linkId = (value: QueueEntry) => (value as unknown as { link: { id: string } }).link.id;

  it.each([
    ["leaving", () => ({ leaving: new Map([[linkId(first), "confirm"]]), hidden: new Set<string>() })],
    ["hidden", () => ({ leaving: new Map(), hidden: new Set([linkId(first)]) })]
  ])("stands the detail down when its record is %s, and Y and N do nothing", (_name, decisions) => {
    setInbox({ decisions: decisions() });
    show("all");
    const card = screen.getByRole("region", { name: "Selected" });
    expect(card.getAttribute("aria-busy")).toBe("true");
    expect(card.hasAttribute("inert")).toBe(true);
    key("y");
    key("n");
    expect(yes).not.toHaveBeenCalled();
    expect(no).not.toHaveBeenCalled();
  });

  it("leaves the detail live when the record being decided is another entry", () => {
    setInbox({ decisions: { leaving: new Map([[linkId(second), "confirm"]]), hidden: new Set<string>() } });
    show("all");
    const card = screen.getByRole("region", { name: "Selected" });
    expect(card.hasAttribute("aria-busy")).toBe(false);
    expect(card.hasAttribute("inert")).toBe(false);
    key("y");
    expect(yes).toHaveBeenCalledTimes(1);
  });

  it("still moves with J and K while a decision runs", () => {
    setInbox({ decisions: { leaving: new Map([[linkId(first), "confirm"]]), hidden: new Set<string>() } });
    show("all");
    key("j");
    expect(heading()).toBe("Second thing");
    expect(screen.getByRole("region", { name: "Selected" }).hasAttribute("inert")).toBe(false);
  });

  it("names an email's, a capture's and a finding's records by their own ids", () => {
    const email = entry("An email", "emails", { kind: "email", key: "email:s1", items: [{ id: "e1" }, { id: "e2" }] });
    const capture = entry("A capture", "captured", { kind: "capture", key: "capture:c1", item: { id: "c1" } });
    const found = entry("A finding", "map", { kind: "finding", key: "finding:f1", finding: { id: "f1" } });
    for (const [target, id] of [
      [email, "e2"],
      [capture, "c1"],
      [found, "f1"]
    ] as const) {
      setInbox({ queue: [target], decisions: { leaving: new Map(), hidden: new Set([id]) } });
      const { unmount } = show("all");
      expect(screen.getByRole("region", { name: "Selected" }).hasAttribute("inert")).toBe(true);
      unmount();
    }
  });
});

describe("InboxQueue held imports", () => {
  const imports = (extra: Record<string, unknown>) => ({
    batch: null,
    history: [],
    busy: false,
    queueStatus: {},
    queueError: "",
    queueLoaded: true,
    ...extra
  });

  it("shows a queue error as an alert under Calendar and All, and not under Emails", () => {
    setInbox({ imports: imports({ queueError: "Could not read the held imports." }) });
    const calendar = show("calendar");
    expect(screen.getByRole("alert").textContent).toBe("Could not read the held imports.");
    calendar.unmount();
    const all = show("all");
    expect(screen.getByRole("alert").textContent).toBe("Could not read the held imports.");
    all.unmount();
    show("emails");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says held imports are loading under Calendar until they have loaded", () => {
    setInbox({ imports: imports({ queueLoaded: false }) });
    const loading = show("calendar");
    expect(screen.getByText("Loading held imports…")).toBeTruthy();
    loading.unmount();
    const other = show("all");
    expect(screen.queryByText("Loading held imports…")).toBeNull();
    other.unmount();
    setInbox({ imports: imports({ queueLoaded: true }) });
    show("calendar");
    expect(screen.queryByText("Loading held imports…")).toBeNull();
  });

  it("shows the error instead of the loading line", () => {
    setInbox({ imports: imports({ queueLoaded: false, queueError: "Offline" }) });
    show("calendar");
    expect(screen.queryByText("Loading held imports…")).toBeNull();
    expect(screen.getByRole("alert").textContent).toBe("Offline");
  });
});

describe("InboxQueue docked actions on a phone", () => {
  const dock = () => document.querySelector("[data-docked-actions]") as HTMLElement | null;

  beforeEach(() => setInbox({ desk: false }));

  it("docks the detail's no and yes buttons, mirroring their labels, after the detail card", () => {
    show("all");
    const bar = dock()!;
    expect(bar).toBeTruthy();
    expect(
      within(bar)
        .getAllByRole("button")
        .map((b) => b.textContent)
    ).toEqual(["No", "Yes"]);
    expect(
      screen.getByRole("region", { name: "Selected" }).compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it("docks a yes the card marks quiet at secondary weight, and an ordinary one as primary", () => {
    show("all");
    const yesButton = () => within(dock()!).getByRole("button", { name: "Yes" });
    expect(yesButton().className).toMatch(/primary/);
    fireEvent.click(screen.getByText("Go quiet"));
    return waitFor(() => expect(yesButton().className).toMatch(/secondary/));
  });

  it("is a group named Decide", () => {
    show("all");
    expect(screen.getByRole("group", { name: "Decide" })).toBe(dock());
  });

  it("copies each original's aria-describedby to its docked button, and none where the original has none", () => {
    show("all");
    expect(within(dock()!).getByRole("button", { name: "Yes" }).getAttribute("aria-describedby")).toBe("why-yes");
    expect(within(dock()!).getByRole("button", { name: "No" }).hasAttribute("aria-describedby")).toBe(false);
  });

  it("clicks the original button when a docked one is clicked", () => {
    // Frames run at once here, so the one-press-per-frame guard (tested below) does not apply.
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => callback(0));
    show("all");
    fireEvent.click(within(dock()!).getByRole("button", { name: "Yes" }));
    expect(yes).toHaveBeenCalledWith("link:First thing");
    fireEvent.click(within(dock()!).getByRole("button", { name: "No" }));
    expect(no).toHaveBeenCalledWith("link:First thing");
  });

  describe("press guard", () => {
    let frames: FrameRequestCallback[];
    beforeEach(() => {
      frames = [];
      vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
    });
    afterEach(() => vi.unstubAllGlobals());
    const nextFrame = () => act(() => frames.splice(0).forEach((callback) => callback(0)));

    it("presses the original once for two clicks in the same tick", () => {
      show("all");
      const docked = within(dock()!).getByRole("button", { name: "Yes" });
      fireEvent.click(docked);
      fireEvent.click(docked);
      expect(yes).toHaveBeenCalledTimes(1);
    });

    it("allows another press once the next frame has run", () => {
      show("all");
      const docked = within(dock()!).getByRole("button", { name: "Yes" });
      fireEvent.click(docked);
      nextFrame();
      fireEvent.click(docked);
      expect(yes).toHaveBeenCalledTimes(2);
    });

    it("guards yes and no together, so a yes then a no in one tick presses only the first", () => {
      show("all");
      fireEvent.click(within(dock()!).getByRole("button", { name: "Yes" }));
      fireEvent.click(within(dock()!).getByRole("button", { name: "No" }));
      expect(yes).toHaveBeenCalledTimes(1);
      expect(no).not.toHaveBeenCalled();
      nextFrame();
      fireEvent.click(within(dock()!).getByRole("button", { name: "No" }));
      expect(no).toHaveBeenCalledTimes(1);
    });
  });

  it("follows a label change in the detail", async () => {
    show("all");
    fireEvent.click(screen.getByRole("button", { name: "Relabel" }));
    await waitFor(() => expect(within(dock()!).getByRole("button", { name: "Add to plan" })).toBeTruthy());
    expect(within(dock()!).queryByRole("button", { name: "Yes" })).toBeNull();
  });

  it("follows the detail's disabled state, and does not press a disabled original", async () => {
    show("all");
    fireEvent.click(screen.getByRole("button", { name: "Disable yes" }));
    await waitFor(() =>
      expect((within(dock()!).getByRole("button", { name: "Yes" }) as HTMLButtonElement).disabled).toBe(true)
    );
    expect((within(dock()!).getByRole("button", { name: "No" }) as HTMLButtonElement).disabled).toBe(false);
    expect(yes).not.toHaveBeenCalled();
  });

  it("is disabled while the selected entry is being decided", () => {
    const linkId = (first as unknown as { link: { id: string } }).link.id;
    setInbox({ desk: false, decisions: { leaving: new Map([[linkId, "confirm"]]), hidden: new Set<string>() } });
    show("all");
    for (const button of within(dock()!).getAllByRole("button"))
      expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows the new entry's buttons after moving on", () => {
    show("all");
    fireEvent.click(screen.getByRole("button", { name: "Relabel" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(within(dock()!).getByRole("button", { name: "Yes" })).toBeTruthy();
    fireEvent.click(within(dock()!).getByRole("button", { name: "Yes" }));
    expect(yes).toHaveBeenCalledWith("link:Second thing");
  });

  it("is not rendered on the list view or when nothing waits", () => {
    const { unmount } = show("all");
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    expect(dock()).toBeNull();
    unmount();
    setInbox({ desk: false, queue: [] });
    show("all");
    expect(dock()).toBeNull();
  });

  it("is not rendered on a desk", () => {
    setInbox({ desk: true });
    show("all");
    expect(dock()).toBeNull();
  });
});
