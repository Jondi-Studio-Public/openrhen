// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSeedState } from "@/state/portal-state";
import { freezeClock } from "@/shared/clock";
import { fireEvent, render, screen } from "@/test/render";
import { CatchUpPage } from "./catch-up-page";

const now = new Date("2026-10-18T12:00:00.000Z");
freezeClock(now);
const acceptServerState = vi.fn();

vi.mock("@/state/portal-provider", async () => {
  const actual = await vi.importActual<object>("@/state/portal-provider");
  return { ...actual, usePortal: () => ({ state: createSeedState(now), acceptServerState }) };
});

const entry = {
  id: "occurrence:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  kind: "occurrence",
  title: "Stretch",
  plannedAt: "2026-10-16T10:00:00.000Z",
  question: null,
  verdicts: ["done", "skipped", "dropped", "pending"],
  atRequired: [],
  localDate: "2026-10-16",
  projectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  version: null
};

function ledger(overrides: Record<string, unknown> = {}) {
  return {
    now: now.toISOString(),
    since: "2026-10-13T02:00:00.000Z",
    due: true,
    unsettled: 1,
    staleDates: 0,
    nextOffset: null,
    entries: [entry],
    remaining: 0,
    ...overrides
  };
}

function stubFetch(read: unknown, settle?: unknown) {
  const fetchMock = vi.fn(async (url: string, _init?: { body?: string }) => {
    if (url.startsWith("/api/catch-up")) return { ok: true, json: async () => read };
    return { ok: true, json: async () => settle ?? {} };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  window.localStorage.clear();
  acceptServerState.mockReset();
});

describe("CatchUpPage", () => {
  it("settles chosen entries in one command and refreshes the plan", async () => {
    const fetchMock = stubFetch(ledger(), {
      result: { results: [{ entryId: entry.id, outcome: "applied" }], closed: true, remaining: 0 },
      state: { marker: "fresh" }
    });
    render(<CatchUpPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Skipped" }));
    fireEvent.click(screen.getByRole("button", { name: "Settle and close" }));
    await vi.waitFor(() => expect(acceptServerState).toHaveBeenCalledWith({ marker: "fresh" }));
    const post = fetchMock.mock.calls.find(([url]) => url === "/api/commands/catch-up-settle")!;
    const body = JSON.parse(post[1]!.body!);
    expect(body.verdicts).toEqual([{ entryId: entry.id, verdict: "skipped" }]);
    expect(body.closeWindow).toBe(true);
  });

  it("keeps a choice across a reload", async () => {
    stubFetch(ledger());
    const first = render(<CatchUpPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Done" }));
    first.unmount();
    render(<CatchUpPage />);
    const done = await screen.findByRole("button", { name: "Done" });
    expect(done.getAttribute("aria-pressed")).toBe("true");
  });

  it("lists what did not apply and keeps it", async () => {
    stubFetch(ledger(), {
      result: {
        results: [{ entryId: entry.id, outcome: "conflict", message: "Changed elsewhere." }],
        closed: false,
        remaining: 1
      },
      state: null
    });
    render(<CatchUpPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Done" }));
    fireEvent.click(screen.getByRole("button", { name: "Settle and close" }));
    expect(await screen.findByText(/Changed elsewhere/)).toBeTruthy();
  });

  it("counts Keep open apart from choices that change something", async () => {
    stubFetch(ledger());
    render(<CatchUpPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Keep open" }));
    expect(screen.getByText(/0 left to choose · 0 to settle · 1 kept open/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Settle chosen" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("limits the day button to actions, leaving project dates alone", async () => {
    const lapsed = {
      id: "deadline:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      kind: "self_set_deadline",
      title: "Sort the garage",
      plannedAt: "2026-10-16T10:00:00.000Z",
      question: null,
      verdicts: ["done", "skipped", "dropped", "pending"],
      atRequired: [],
      localDate: null,
      projectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      version: 2
    };
    stubFetch(ledger({ entries: [entry, lapsed], unsettled: 2 }));
    render(<CatchUpPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Skip this day's actions" }));
    const pressed = screen.getAllByRole("button", { pressed: true }).map((button) => button.textContent);
    expect(pressed).toEqual(["Skipped"]);
  });

  it("does not offer to close while entries are off the loaded page", async () => {
    stubFetch(ledger({ unsettled: 3 }));
    render(<CatchUpPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Done" }));
    expect(screen.getByRole("button", { name: "Settle chosen" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Settle and close" })).toBeNull();
  });

  it("sends an open session's end time and minutes left", async () => {
    const session = {
      id: "session:cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      kind: "open_session",
      title: "Write report",
      plannedAt: "2026-10-18T10:00:00.000Z",
      question: "Did Write report finish?",
      verdicts: ["done", "ended", "skipped", "pending"],
      atRequired: ["done", "ended"],
      asksRemainingMinutes: true,
      localDate: null,
      projectId: null,
      version: 3
    };
    const fetchMock = stubFetch(ledger({ entries: [session], unsettled: 1 }), {
      result: { results: [{ entryId: session.id, outcome: "applied" }], closed: false, remaining: 0 },
      state: null
    });
    render(<CatchUpPage />);
    expect(await screen.findByRole("heading", { name: "Right now" })).toBeTruthy();
    expect(screen.getByText("Did Write report finish?")).toBeTruthy();
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual(
      expect.arrayContaining(["Done", "Stopped at", "Didn't start", "Still going"])
    );
    fireEvent.click(screen.getByRole("button", { name: "Stopped at" }));
    const when = screen.getByLabelText("Stopped at", { selector: "input" }) as HTMLInputElement;
    expect(when.type).toBe("datetime-local");
    fireEvent.change(when, { target: { value: "2026-10-18T20:30" } });
    fireEvent.change(screen.getByLabelText(/Minutes left/), { target: { value: "25" } });
    fireEvent.click(screen.getByRole("button", { name: "Settle and close" }));
    await vi.waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => url === "/api/commands/catch-up-settle")).toBe(true)
    );
    const post = fetchMock.mock.calls.find(([url]) => url === "/api/commands/catch-up-settle")!;
    const [verdict] = JSON.parse(post[1]!.body!).verdicts;
    expect(verdict).toMatchObject({ entryId: session.id, verdict: "ended", remainingMinutes: 25, version: 3 });
    expect(new Date(verdict.at).getUTCHours() * 60 + new Date(verdict.at).getUTCMinutes()).toBeGreaterThan(0);
    expect(Number.isNaN(new Date(verdict.at).getTime())).toBe(false);
  });

  it("offers a check-in only its own verdicts, with no time needed", async () => {
    const checkIn = {
      id: "check-in:dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      kind: "check_in",
      title: "Thesis",
      plannedAt: "2026-10-18T08:00:00.000Z",
      question: "Were you on Thesis 4 hours ago?",
      verdicts: ["done", "skipped", "pending"],
      atRequired: [],
      localDate: null,
      projectId: null,
      version: 1
    };
    const fetchMock = stubFetch(ledger({ entries: [checkIn] }), {
      result: { results: [{ entryId: checkIn.id, outcome: "applied" }], closed: false, remaining: 0 },
      state: null
    });
    render(<CatchUpPage />);
    expect(await screen.findByText("Were you on Thesis 4 hours ago?")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Dropped" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "On track" }));
    expect(document.querySelector('input[type="datetime-local"]')).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Settle and close" }));
    await vi.waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => url === "/api/commands/catch-up-settle")).toBe(true)
    );
    const post = fetchMock.mock.calls.find(([url]) => url === "/api/commands/catch-up-settle")!;
    expect(JSON.parse(post[1]!.body!).verdicts).toEqual([{ entryId: checkIn.id, verdict: "done", version: 1 }]);
  });

  it("skips everything older than N days in one bulk verdict", async () => {
    const fetchMock = stubFetch(ledger(), {
      result: { results: [], closed: false, remaining: 0 },
      state: null
    });
    render(<CatchUpPage />);
    const days = (await screen.findByLabelText(/Skip everything older than/)) as HTMLInputElement;
    expect(days.value).toBe("7");
    fireEvent.change(days, { target: { value: "14" } });
    fireEvent.click(screen.getByRole("button", { name: "Skip older ones" }));
    await vi.waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => url === "/api/commands/catch-up-settle")).toBe(true)
    );
    const post = fetchMock.mock.calls.find(([url]) => url === "/api/commands/catch-up-settle")!;
    expect(JSON.parse(post[1]!.body!).verdicts).toEqual([{ bulk: "skip_older_than", days: 14 }]);
  });
});
