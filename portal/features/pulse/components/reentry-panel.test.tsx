// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSeedState } from "@/state/portal-state";
import { freezeClock } from "@/shared/clock";
import { fireEvent, render, screen, waitFor } from "@/test/render";
import { ReentryPanel } from "./reentry-panel";
import { ReentryUndoBanner } from "./reentry-undo-banner";

const now = new Date("2026-10-28T02:00:00.000Z");
freezeClock(now);
const acceptServerState = vi.fn();

vi.mock("@/state/portal-provider", async () => {
  const actual = await vi.importActual<object>("@/state/portal-provider");
  return { ...actual, usePortal: () => ({ state: createSeedState(now), acceptServerState }) };
});

const choices = {
  places: [
    { id: "home", name: "Home" },
    { id: "uni", name: "Campus" }
  ],
  contexts: [{ id: "laptop", name: "Laptop", kind: "tool" }]
};
const item = (id: string, title: string, over: Record<string, unknown> = {}) => ({
  id,
  kind: "self_set_deadline",
  title,
  plannedAt: "2026-10-27T01:00:00.000Z",
  localDate: null,
  projectId: "p1",
  projectTitle: "Thesis",
  version: 1,
  ...over
});
function review(tier: string, entries: unknown[], over: Record<string, unknown> = {}) {
  return {
    lapsed: true,
    pulse: {},
    review: {
      tier,
      lastConfirmedAt: "2026-10-27T00:00:00.000Z",
      gapMinutes: 1560,
      reviewable: entries.length,
      lapsing: 0,
      days: [],
      projects: [],
      entries,
      ...over
    },
    choices
  };
}

function stub(read: unknown, post?: { ok: boolean; status?: number; body: unknown }) {
  const fetchMock = vi.fn(async (url: string, _init?: { body?: string }) => {
    if (url.startsWith("/api/pulse/reentry")) return { ok: true, json: async () => read };
    return { ok: post?.ok ?? true, status: post?.status ?? 200, json: async () => post?.body ?? {} };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const submit = () => screen.getByRole("button", { name: "Back on plan" }) as HTMLButtonElement;
async function answerFacts() {
  fireEvent.click(await screen.findByRole("button", { name: "Home" }));
  fireEvent.click(screen.getByRole("button", { name: "Medium" }));
  fireEvent.click(screen.getByRole("button", { name: "None of these" }));
}

beforeEach(() => {
  vi.unstubAllGlobals();
  acceptServerState.mockReset();
});

describe("ReentryPanel", () => {
  it("asks only for the three facts at the shortest gap, and enables Submit when they are answered", async () => {
    stub(review("none", [], { gapMinutes: 90 }));
    render(<ReentryPanel onDone={() => {}} />);
    await screen.findByText(/Welcome back/);
    expect(submit().disabled).toBe(true);
    expect(screen.getByText(/Still needed: where you are, your energy, what's available/)).toBeTruthy();
    await answerFacts();
    expect(submit().disabled).toBe(false);
  });

  it("lists today's items one by one with four answers each, none chosen, and holds Submit until all are answered", async () => {
    stub(review("today", [item("deadline:a", "Draft chapter"), item("deadline:b", "Email supervisor")]));
    render(<ReentryPanel onDone={() => {}} />);
    await answerFacts();
    expect(screen.getByText("Draft chapter")).toBeTruthy();
    const group = screen.getByRole("group", { name: "What happened to Draft chapter" });
    expect(group.querySelectorAll('button[aria-pressed="true"]')).toHaveLength(0);
    expect(group.querySelectorAll("button")).toHaveLength(4);
    expect(group.textContent).toContain("Still open");
    expect(submit().disabled).toBe(true);
    expect(screen.getByText(/2 items to review/)).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Done" })[0]!);
    expect(submit().disabled).toBe(true);
    fireEvent.click(screen.getAllByRole("button", { name: "Still open" })[1]!);
    expect(submit().disabled).toBe(false);
  });

  it("takes one tap per day at the days tier, with exceptions behind a disclosure", async () => {
    const a = item("deadline:a", "Draft chapter", { localDate: "2026-10-26" });
    stub(review("days", [a], { days: [{ day: "2026-10-26", entryIds: [a.id] }] }));
    render(<ReentryPanel onDone={() => {}} />);
    await answerFacts();
    expect(screen.queryByText("Draft chapter")).toBeNull();
    expect(submit().disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Nothing recorded" }));
    expect(submit().disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Exceptions" }));
    expect(screen.getByText("Draft chapter")).toBeTruthy();
  });

  it("keeps or drops per project, or starts fresh, at the projects tier", async () => {
    const a = item("deadline:a", "Draft chapter");
    stub(review("projects", [a], { projects: [{ projectId: "p1", title: "Thesis", entryIds: [a.id] }] }));
    render(<ReentryPanel onDone={() => {}} />);
    await answerFacts();
    expect(submit().disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Drop all" }));
    expect(submit().disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Drop all" }));
    expect(submit().disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Start fresh" }));
    expect(submit().disabled).toBe(false);
  });

  it("posts the answers, hands the returned state to the provider and reports what to undo", async () => {
    const fetchMock = stub(review("today", [item("deadline:a", "Draft chapter")]), {
      ok: true,
      body: { state: { marker: "fresh" }, revertible: "cmd-9", result: { unrecorded: 0, lapsed: 2 } }
    });
    const onDone = vi.fn();
    render(<ReentryPanel onDone={onDone} />);
    await answerFacts();
    fireEvent.click(screen.getByRole("button", { name: "Clear date" }));
    fireEvent.click(submit());
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(acceptServerState).toHaveBeenCalledWith({ marker: "fresh" });
    expect(onDone.mock.calls[0]![0]).toMatchObject({ revertible: "cmd-9", lapsed: 2 });
    const post = fetchMock.mock.calls.find(([url]) => url === "/api/commands/reenter")!;
    const body = JSON.parse(post[1]!.body!) as Record<string, unknown>;
    expect(body).toMatchObject({ locationId: "home", energy: "medium", contexts: [] });
    expect(body.settlement).toEqual({ items: [{ entryId: "deadline:a", verdict: "skipped", version: 1 }] });
  });

  it("shows the server's 422 with each missing line, in place", async () => {
    stub(review("none", []), {
      ok: false,
      status: 422,
      body: { code: "reentryIncomplete", error: "Re-entry is incomplete; nothing was written.", missing: ["energy"] }
    });
    render(<ReentryPanel onDone={() => {}} />);
    await answerFacts();
    fireEvent.click(submit());
    expect(await screen.findByText(/Re-entry is incomplete/)).toBeTruthy();
    expect(screen.getByText("energy")).toBeTruthy();
  });

  it("says so when the review cannot be read, and offers a retry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({}) }))
    );
    render(<ReentryPanel onDone={() => {}} />);
    expect(await screen.findByText("The catch-up could not be read.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});

describe("ReentryUndoBanner", () => {
  it("undoes through the revert route and hands over the restored state", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: { body?: string }) => ({
      ok: true,
      json: async () => ({ state: { marker: "lapsed again" } })
    }));
    vi.stubGlobal("fetch", fetchMock);
    const onClose = vi.fn();
    render(
      <ReentryUndoBanner done={{ state: null, revertible: "cmd-9", unrecorded: 3, lapsed: 0 }} onClose={onClose} />
    );
    expect(document.activeElement?.querySelector('[role="status"]')).toBeTruthy();
    expect(screen.getByText(/3 answers were recorded as unrecorded, not done/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/commands/revert");
    expect(JSON.parse(init!.body!)).toMatchObject({ target: "cmd-9", direction: "undo" });
    expect(acceptServerState).toHaveBeenCalledWith({ marker: "lapsed again" });
  });

  it("keeps the banner and says why when the undo is refused", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({ error: "A row changed since." }) }))
    );
    const onClose = vi.fn();
    render(<ReentryUndoBanner done={{ state: null, revertible: "c", unrecorded: 0, lapsed: 0 }} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(await screen.findByText(/A row changed since/)).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });
});
