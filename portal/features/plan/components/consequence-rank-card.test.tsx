// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConsequenceGroupView } from "@openrhen/contracts";
import { createSeedState } from "@/state/portal-state";
import { act, fireEvent, render, screen, waitFor } from "@/test/render";
import { ConsequenceRankCard } from "./consequence-rank-card";

const seed = createSeedState(new Date("2026-10-27T10:00:00.000Z"));
vi.mock("@/state/portal-provider", () => ({ usePortal: () => ({ state: seed }) }));

function makeGroup(id: string, titles = ["Alpha", "Bravo", "Charlie", "Delta"]): ConsequenceGroupView {
  return {
    groupId: id,
    pool: "project",
    wording: "most_regret_not_doing",
    question: "A year from now, which of these would you most regret never having done?",
    items: titles.map((title, index) => ({ n: index + 1, id: `${id}-${index}`, title, stars: 3 })),
    reissued: false,
    answerCall: { tool: "rhen_save", arguments: {} },
    instructions: ""
  };
}

type Call = { url: string; body: Record<string, unknown> | null };
let calls: Call[];
let nextGroups: (ConsequenceGroupView | null)[];
let postResult: { status: number; body: unknown };
let nextResult: { status: number; body?: unknown } | null;

beforeEach(() => {
  calls = [];
  nextGroups = [makeGroup("g1"), makeGroup("g2"), makeGroup("g3"), makeGroup("g4"), makeGroup("g5")];
  postResult = { status: 200, body: { result: {} } };
  nextResult = null;
  window.localStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null });
      if (url.startsWith("/api/consequence/next")) {
        if (nextResult) return Response.json(nextResult.body ?? {}, { status: nextResult.status });
        return Response.json({ group: nextGroups.shift() ?? null });
      }
      return Response.json(postResult.body, { status: postResult.status });
    })
  );
});
afterEach(() => vi.unstubAllGlobals());

const posts = () => calls.filter((call) => call.body !== null);
async function start() {
  render(<ConsequenceRankCard />);
  fireEvent.click(screen.getByRole("button", { name: "Start" }));
  await screen.findByText(/most regret never having done/);
}
const titles = () =>
  screen.getAllByRole("listitem").map((item) => item.querySelector("span[class*=title]")?.textContent);

describe("ConsequenceRankCard", () => {
  it("stays closed and reads nothing until it is started, and says answers are optional", () => {
    render(<ConsequenceRankCard />);
    expect(screen.getByRole("heading", { name: "Rank these four" })).toBeTruthy();
    expect(screen.getByText(/Every answer is optional/)).toBeTruthy();
    expect(calls).toEqual([]);
  });

  it("shows the server's question and each item with its stars", async () => {
    await start();
    expect(titles()).toEqual(["Alpha", "Bravo", "Charlie", "Delta"]);
    expect(screen.getAllByRole("img", { name: "3 of 5 stars" })).toHaveLength(4);
  });

  it("titles the card for the size of the group it holds", async () => {
    nextGroups = [makeGroup("g1", ["Alpha", "Bravo", "Charlie"])];
    await start();
    expect(screen.getByRole("heading", { name: "Rank these three" })).toBeTruthy();
  });

  it("reorders with the move buttons and sends the order best first", async () => {
    await start();
    fireEvent.click(screen.getByRole("button", { name: "Move Delta up" }));
    fireEvent.click(screen.getByRole("button", { name: "Move Delta up" }));
    fireEvent.click(screen.getByRole("button", { name: "Move Alpha down" }));
    expect(titles()).toEqual(["Delta", "Alpha", "Bravo", "Charlie"]);
    expect(screen.getByRole("button", { name: "Move Delta up" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Move Charlie down" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Submit order" }));
    await screen.findByText(/Saved. Your plan is recalculating/);
    expect(posts()[0]).toMatchObject({
      url: "/api/commands/consequence",
      body: { groupId: "g1", rankedIds: ["g1-3", "g1-0", "g1-1", "g1-2"], wording: "most_regret_not_doing" }
    });
    // The next group loads after the confirmation.
    await screen.findByText("Alpha");
    expect(calls.filter((call) => call.url === "/api/consequence/next")).toHaveLength(2);
  });

  it("drags a row past its neighbours with the pointer", async () => {
    await start();
    const items = screen.getAllByRole("listitem");
    items.forEach((item, index) => {
      item.getBoundingClientRect = () => ({ top: index * 100, height: 100 }) as DOMRect;
    });
    const grip = items[0]!.querySelector("span[class*=grip]")!;
    fireEvent.pointerDown(grip, { pointerId: 1 });
    fireEvent.pointerMove(grip, { pointerId: 1, clientY: 330 });
    expect(titles()).toEqual(["Bravo", "Charlie", "Alpha", "Delta"]);
    fireEvent.pointerUp(grip, { pointerId: 1 });
    fireEvent.pointerMove(grip, { pointerId: 1, clientY: 0 });
    expect(titles()).toEqual(["Bravo", "Charlie", "Alpha", "Delta"]);
  });

  it("sends a tie, and a skip as a tie that says so without counting it", async () => {
    await start();
    fireEvent.click(screen.getByRole("button", { name: /These are equal/ }));
    await screen.findByText(/Saved as equal/);
    expect(posts()[0]?.body).toMatchObject({ groupId: "g1", tie: true });
    expect(posts()[0]?.body?.rankedIds).toBeUndefined();
    await screen.findByText("Alpha");
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    await screen.findByText(/Skipped/);
    expect(posts()[1]?.body).toMatchObject({ groupId: "g2", tie: true, evidence: "skipped" });
    await waitFor(() => expect(screen.getByText(/1 group today, 1 group this week/)).toBeTruthy());
  });

  it("still works when localStorage throws on read and on write", async () => {
    const boom = () => {
      throw new Error("storage blocked");
    };
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(boom);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(boom);
    try {
      await start();
      fireEvent.click(screen.getByRole("button", { name: /These are equal/ }));
      await screen.findByText(/Saved as equal/);
      expect(posts()[0]?.body).toMatchObject({ groupId: "g1", tie: true });
      await screen.findByText("Alpha");
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("shows the server's message when an answer is refused, and keeps the group", async () => {
    await start();
    postResult = {
      status: 409,
      body: { error: "That group is not the one waiting. Nothing was changed. Next: rhen_inbox" }
    };
    fireEvent.click(screen.getByRole("button", { name: "Submit order" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Nothing was changed. Next: rhen_inbox");
    expect(titles()).toEqual(["Alpha", "Bravo", "Charlie", "Delta"]);
    fireEvent.click(screen.getByRole("button", { name: "Load the waiting group" }));
    await waitFor(() => expect(calls.filter((call) => call.url === "/api/consequence/next")).toHaveLength(2));
  });

  it("explains an empty queue and what to do", async () => {
    nextGroups = [null];
    render(<ConsequenceRankCard />);
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(await screen.findByText("Nothing to rank right now")).toBeTruthy();
    expect(screen.getByText(/Add more projects or actions/)).toBeTruthy();
  });

  it("shows the server's message when the group cannot be loaded", async () => {
    nextResult = {
      status: 503,
      body: { error: "Ranking requires PostgreSQL, and the portal has no database right now." }
    };
    render(<ConsequenceRankCard />);
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Ranking requires PostgreSQL");
    nextResult = null;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText("Alpha");
  });

  it("offers a few more after three groups instead of loading a fourth", async () => {
    await start();
    for (let round = 1; round <= 3; round++) {
      fireEvent.click(screen.getByRole("button", { name: /These are equal/ }));
      if (round < 3) await screen.findByText(`Alpha`);
    }
    expect(await screen.findByText(/That is 3 for today, which is plenty/)).toBeTruthy();
    expect(calls.filter((call) => call.url === "/api/consequence/next")).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "A few more" }));
    await screen.findByText("Alpha");
    expect(calls.filter((call) => call.url === "/api/consequence/next")).toHaveLength(4);
    // Once asked for, it keeps going rather than pausing at four.
    fireEvent.click(screen.getByRole("button", { name: /These are equal/ }));
    await waitFor(() => expect(calls.filter((call) => call.url === "/api/consequence/next")).toHaveLength(5));
  });

  it("opens straight on the prompt when today's three are already done", async () => {
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: seed.settings.timezone }).format(new Date());
    window.localStorage.setItem("openrhen:consequence-rank-answers", JSON.stringify([day, day, day]));
    render(<ConsequenceRankCard />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Start" })));
    expect(screen.getByRole("button", { name: "A few more" })).toBeTruthy();
    expect(calls).toEqual([]);
  });
});
