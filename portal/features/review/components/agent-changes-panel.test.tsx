// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@/test/render";
import { freezeClock } from "@/shared/clock";
import { AGENT_CHANGES_LOOKED_KEY, readAgentChangesLookedAt } from "../agent-changes-seen";
import type { AgentChangeDetail } from "../agent-change-view";
import { AgentChangesPanel, type AgentChange } from "./agent-changes-panel";

freezeClock(new Date("2026-10-27T06:00:00.000Z"));

const TZ = "Australia/Brisbane";

const change = (extra: Partial<AgentChange> = {}): AgentChange => ({
  agent: "openclaw",
  id: "e1",
  at: "2026-10-27T05:00:00.000Z",
  label: "Skipped step: Pack bag",
  status: "applied",
  ...extra
});

const detail = (extra: Partial<AgentChangeDetail> = {}): AgentChangeDetail => ({
  writeId: "w1",
  actor: "openclaw",
  commandType: "save_entity",
  at: "2026-10-27T05:00:00.000Z",
  state: "applied",
  rows: [
    {
      entityType: "commitment",
      entityId: "c1",
      title: "Spin class",
      operation: "update",
      fields: [
        { field: "starts_at", before: "2026-10-27T08:00:00.000Z", after: "2026-10-27T08:30:00.000Z", afterKnown: true },
        { field: "importance", before: 4, after: 5, afterKnown: true }
      ],
      basis: "stated",
      statedEvidence: "Move spin to half six"
    }
  ],
  plan: {
    available: true,
    dayKey: "2026-10-27",
    moved: [
      {
        title: "Gym",
        fromStartsAt: "2026-10-27T09:00:00.000Z",
        toStartsAt: "2026-10-27T09:30:00.000Z",
        deltaMinutes: 30
      }
    ],
    added: [],
    dropped: [],
    sleepShiftMinutes: 0
  },
  ...extra
});

beforeEach(() => window.localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

const isList = (input: string | URL | Request) => String(input).startsWith("/api/agent-changes?");

/**
 * A fetch that answers the list from `lists` in turn (the last repeats), every POST from `post`, and a
 * detail read from `details` by write id (404 when absent).
 */
function stubFetch(
  lists: (AgentChange[] | { changes: AgentChange[]; nextCursor: string | null })[],
  post: () => Response = () => Response.json({ ok: true }),
  details: Record<string, AgentChangeDetail> = {}
) {
  let listed = 0;
  const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "POST") return Promise.resolve(post());
    if (isList(input)) {
      const page = lists[Math.min(listed, lists.length - 1)]!;
      listed += 1;
      return Promise.resolve(Response.json(Array.isArray(page) ? { changes: page } : page));
    }
    const id = decodeURIComponent(String(input).split("/").pop() ?? "");
    const found = details[id];
    return Promise.resolve(found ? Response.json(found) : Response.json({ error: "No such write." }, { status: 404 }));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const posts = (fetchMock: ReturnType<typeof stubFetch>) =>
  fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");
const listCalls = (fetchMock: ReturnType<typeof stubFetch>) =>
  fetchMock.mock.calls.filter(([input, init]) => init?.method !== "POST" && isList(input));

/** Opens the sheet for the row titled `title` and returns it. */
async function openChange(title: string | RegExp) {
  fireEvent.click(await screen.findByRole("button", { name: title }));
  return screen.getByRole("dialog");
}

describe("AgentChangesPanel", () => {
  it("asks for the latest 20 and shows each change's label without ids, agent and age, and a status when not applied", async () => {
    const fetchMock = stubFetch([
      [
        change({ label: 'update commitment "Spin class" (a6c70f15-f1cb-4d57-ba41-af6d5664f003)' }),
        change({ id: "e2", label: "Resumed session", status: "undone", at: "2026-10-27T03:00:00.000Z" })
      ]
    ]);
    render(<AgentChangesPanel timezone={TZ} />);
    expect(await screen.findByText('Update commitment "Spin class"')).toBeTruthy();
    expect(screen.getByText("openclaw · 1 h ago")).toBeTruthy();
    expect(screen.getByText("openclaw · 3 h ago")).toBeTruthy();
    expect(screen.getByText("Undone")).toBeTruthy();
    expect(String(fetchMock.mock.calls[0]![0])).toBe("/api/agent-changes?limit=20");
    expect(screen.getByRole("heading", { name: "Agent changes" })).toBeTruthy();
  });

  it("says so in one line when there are none", async () => {
    stubFetch([[]]);
    render(<AgentChangesPanel timezone={TZ} />);
    expect(await screen.findByText("No agent changes yet.")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("opens a sheet with each field from → to, the basis, the quoted words and the plan effect", async () => {
    // `writeId` stands in for the list shape the write ledger's undo PR (3b) adds; today's list route does not
    // return it, so this test proves the sheet, not that the real route links a row to its write.
    const fetchMock = stubFetch([[change({ writeId: "w1" })]], undefined, { w1: detail() });
    render(<AgentChangesPanel timezone={TZ} />);
    const sheet = await openChange(/Skipped step: Pack bag/);
    expect(await within(sheet).findByText("Changed the commitment")).toBeTruthy();
    expect(within(sheet).getByText("“Spin class”")).toBeTruthy();
    expect(within(sheet).getByText("You said so")).toBeTruthy();
    expect(within(sheet).getByText("Move spin to half six")).toBeTruthy();
    expect(within(sheet).getByText("Importance")).toBeTruthy();
    expect(within(sheet).getByText("4")).toBeTruthy();
    expect(within(sheet).getByText("5")).toBeTruthy();
    expect(within(sheet).getByText("Starts")).toBeTruthy();
    expect(within(sheet).getByText("Tue, 27 Oct at 6:00 pm")).toBeTruthy();
    expect(within(sheet).getByText("Tue, 27 Oct at 6:30 pm")).toBeTruthy();
    expect(within(sheet).getByText("The plan moved 1 block that day.")).toBeTruthy();
    expect(within(sheet).getByText("Gym: 7:00 pm → 7:30 pm")).toBeTruthy();
    expect(fetchMock.mock.calls.some(([input]) => String(input) === "/api/agent-changes/w1")).toBe(true);
  });

  it("explains a server-checked entry from its command id before the list carries a write id", async () => {
    const fetchMock = stubFetch([[change({ target: { stateKey: "revert", id: "cmd-1" } })]], undefined, {
      "cmd-1": detail({ writeId: "cmd-1" })
    });
    render(<AgentChangesPanel timezone={TZ} />);
    const sheet = await openChange(/Skipped step/);
    expect(await within(sheet).findByText("Changed the commitment")).toBeTruthy();
    expect(fetchMock.mock.calls.some(([input]) => String(input) === "/api/agent-changes/cmd-1")).toBe(true);
  });

  it("says plainly when an old change kept no details, and still offers Undo", async () => {
    const fetchMock = stubFetch([[change({ writeId: null })]]);
    render(<AgentChangesPanel timezone={TZ} />);
    const sheet = await openChange(/Skipped step/);
    expect(within(sheet).getByText(/aren't linked to it/)).toBeTruthy();
    expect(within(sheet).getByRole("button", { name: "Undo" })).toBeTruthy();
    expect(fetchMock.mock.calls.filter(([input]) => String(input).startsWith("/api/agent-changes/"))).toHaveLength(0);
  });

  it("says the plan effect cannot be shown when the old plan is gone", async () => {
    stubFetch([[change({ writeId: "w1" })]], undefined, {
      w1: detail({
        plan: {
          available: false,
          reason: "pruned",
          dayKey: null,
          moved: [],
          added: [],
          dropped: [],
          sleepShiftMinutes: 0
        }
      })
    });
    render(<AgentChangesPanel timezone={TZ} />);
    const sheet = await openChange(/Skipped step/);
    expect(await within(sheet).findByText(/no longer kept, so its effect can't be shown/)).toBeTruthy();
  });

  it("offers Undo on an applied change, Redo on an undone one, and nothing on a superseded one", async () => {
    stubFetch([
      [
        change({ id: "a", label: "Applied one" }),
        change({ id: "b", label: "Undone one", status: "undone" }),
        change({ id: "c", label: "Superseded one", status: "superseded" })
      ]
    ]);
    render(<AgentChangesPanel timezone={TZ} />);
    expect(within(await openChange(/Applied one/)).getByRole("button", { name: "Undo" })).toBeTruthy();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /close/i }));
    expect(within(await openChange(/Undone one/)).getByRole("button", { name: "Redo" })).toBeTruthy();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /close/i }));
    const superseded = await openChange(/Superseded one/);
    expect(within(superseded).queryByRole("button", { name: /^(Undo|Redo)$/ })).toBeNull();
    expect(within(superseded).getByText(/can no longer be undone here/)).toBeTruthy();
  });

  it("posts the undo, shows a pending state, then refreshes the list", async () => {
    let finish!: (response: Response) => void;
    let listed = 0;
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") return new Promise<Response>((resolve) => (finish = resolve));
      if (!isList(input)) return Promise.resolve(Response.json({}, { status: 404 }));
      listed += 1;
      return Promise.resolve(Response.json({ changes: [change({ status: listed > 1 ? "undone" : "applied" })] }));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AgentChangesPanel timezone={TZ} />);
    const sheet = await openChange(/Skipped step/);
    fireEvent.click(within(sheet).getByRole("button", { name: "Undo" }));
    const pending = await within(sheet).findByRole("button", { name: "Undoing…" });
    expect(pending.getAttribute("aria-disabled")).toBe("true");
    // Still focusable, so focus stays in the sheet and Escape keeps working while the undo runs.
    expect((pending as HTMLButtonElement).disabled).toBe(false);
    const [url, init] = fetchMock.mock.calls.find(([, options]) => options?.method === "POST")!;
    expect(String(url)).toBe("/api/agent-changes/e1/undo");
    expect(JSON.parse(String(init?.body))).toEqual({ redo: false });
    finish(Response.json({ ok: true }));
    expect(await within(sheet).findByRole("button", { name: "Redo" })).toBeTruthy();
    expect(within(sheet).getByText("openclaw · 1 h ago · Undone")).toBeTruthy();
  });

  it("posts redo: true for an undone change", async () => {
    const fetchMock = stubFetch([[change({ status: "undone" })], [change()]]);
    render(<AgentChangesPanel timezone={TZ} />);
    const sheet = await openChange(/Skipped step/);
    fireEvent.click(within(sheet).getByRole("button", { name: "Redo" }));
    expect(await within(sheet).findByRole("button", { name: "Undo" })).toBeTruthy();
    expect(JSON.parse(String(posts(fetchMock)[0]![1]?.body))).toEqual({ redo: true });
  });

  it("shows the portal's error text in the sheet and leaves the list as it was", async () => {
    const fetchMock = stubFetch([[change()]], () =>
      Response.json({ error: 'Not undone: "Skipped step" changed since it was written.' }, { status: 409 })
    );
    render(<AgentChangesPanel timezone={TZ} />);
    const sheet = await openChange(/Skipped step/);
    fireEvent.click(within(sheet).getByRole("button", { name: "Undo" }));
    expect((await within(sheet).findByRole("alert")).textContent).toBe(
      'Not undone: "Skipped step" changed since it was written.'
    );
    expect(within(sheet).getByRole("button", { name: "Undo" })).toBeTruthy();
    expect(listCalls(fetchMock)).toHaveLength(1);
  });

  it("offers 'Undo anyway' after a 409 and retries with force: true", async () => {
    let attempt = 0;
    const fetchMock = stubFetch([[change()], [change({ status: "undone" })]], () => {
      attempt += 1;
      return attempt === 1
        ? Response.json({ error: "Recorded without a version." }, { status: 409 })
        : Response.json({ ok: true });
    });
    render(<AgentChangesPanel timezone={TZ} />);
    const sheet = await openChange(/Skipped step/);
    fireEvent.click(within(sheet).getByRole("button", { name: "Undo" }));
    expect((await within(sheet).findByRole("alert")).textContent).toBe("Recorded without a version.");
    fireEvent.click(within(sheet).getByRole("button", { name: "Undo anyway" }));
    expect(await within(sheet).findByRole("button", { name: "Redo" })).toBeTruthy();
    expect(within(sheet).queryByRole("button", { name: "Undo anyway" })).toBeNull();
    expect(posts(fetchMock).map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
      { redo: false },
      { redo: false, force: true }
    ]);
  });

  it("offers 'Redo anyway' after a 409 on a redo", async () => {
    stubFetch([[change({ status: "undone" })]], () => Response.json({ error: "Nope." }, { status: 409 }));
    render(<AgentChangesPanel timezone={TZ} />);
    const sheet = await openChange(/Skipped step/);
    fireEvent.click(within(sheet).getByRole("button", { name: "Redo" }));
    await within(sheet).findByRole("alert");
    expect(within(sheet).getByRole("button", { name: "Redo anyway" })).toBeTruthy();
  });

  it("offers no force button when the failure is not a conflict", async () => {
    stubFetch([[change()]], () => Response.json({ error: "Not available." }, { status: 503 }));
    render(<AgentChangesPanel timezone={TZ} />);
    const sheet = await openChange(/Skipped step/);
    fireEvent.click(within(sheet).getByRole("button", { name: "Undo" }));
    await within(sheet).findByRole("alert");
    expect(within(sheet).queryByRole("button", { name: "Undo anyway" })).toBeNull();
  });

  it("says so when the list cannot be reloaded after a successful undo", async () => {
    let listed = 0;
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") return Promise.resolve(Response.json({ ok: true }));
      if (!isList(input)) return Promise.resolve(Response.json({}, { status: 404 }));
      listed += 1;
      return Promise.resolve(
        listed === 1 ? Response.json({ changes: [change()] }) : new Response("{}", { status: 503 })
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AgentChangesPanel timezone={TZ} />);
    const sheet = await openChange(/Skipped step/);
    fireEvent.click(within(sheet).getByRole("button", { name: "Undo" }));
    expect((await within(sheet).findByRole("alert")).textContent).toBe("Agent changes could not be reloaded.");
  });

  it("shows the portal's warning when the undo landed but was not recorded", async () => {
    stubFetch([[change()], [change({ status: "undone" })]], () =>
      Response.json({ ok: true, warning: "This change was applied but could not be recorded, so it cannot be undone." })
    );
    render(<AgentChangesPanel timezone={TZ} />);
    const sheet = await openChange(/Skipped step/);
    fireEvent.click(within(sheet).getByRole("button", { name: "Undo" }));
    expect((await within(sheet).findByRole("alert")).textContent).toBe(
      "This change was applied but could not be recorded, so it cannot be undone."
    );
    expect(within(sheet).getByRole("button", { name: "Redo" })).toBeTruthy();
  });

  it("says the portal could not be reached when the request itself fails", async () => {
    const fetchMock = stubFetch([[change()]]);
    fetchMock.mockImplementation((input, init) =>
      init?.method === "POST"
        ? Promise.reject(new TypeError("offline"))
        : isList(input)
          ? Promise.resolve(Response.json({ changes: [change()] }))
          : Promise.resolve(Response.json({}, { status: 404 }))
    );
    render(<AgentChangesPanel timezone={TZ} />);
    const sheet = await openChange(/Skipped step/);
    fireEvent.click(within(sheet).getByRole("button", { name: "Undo" }));
    expect((await within(sheet).findByRole("alert")).textContent).toBe("The portal could not be reached.");
  });

  it("shows nothing while loading and a short line when the list cannot be read", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response("{}", { status: 503 })));
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<AgentChangesPanel timezone={TZ} />);
    expect(container.textContent).toBe("");
    expect(await screen.findByText("Agent changes could not be loaded.")).toBeTruthy();
  });

  it("pages back with the cursor the list gave, and stops when there is none", async () => {
    const fetchMock = stubFetch([
      { changes: [change()], nextCursor: "2026-10-27T05:00:00.000Z|e1" },
      { changes: [change({ id: "e0", label: "Older one", at: "2026-10-26T05:00:00.000Z" })], nextCursor: null }
    ]);
    render(<AgentChangesPanel timezone={TZ} />);
    fireEvent.click(await screen.findByRole("button", { name: "Show older" }));
    expect(await screen.findByText("Older one")).toBeTruthy();
    expect(screen.getByText("Skipped step: Pack bag")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Show older" })).toBeNull();
    expect(String(listCalls(fetchMock)[1]![0])).toBe(
      `/api/agent-changes?limit=20&before=${encodeURIComponent("2026-10-27T05:00:00.000Z|e1")}`
    );
  });

  it("marks changes after the last look as new, then records this look", async () => {
    window.localStorage.setItem(AGENT_CHANGES_LOOKED_KEY, "2026-10-27T04:00:00.000Z");
    stubFetch([[change(), change({ id: "e2", label: "Earlier one", at: "2026-10-27T03:00:00.000Z" })]]);
    render(<AgentChangesPanel timezone={TZ} />);
    expect(await screen.findByText("1 new since you looked")).toBeTruthy();
    expect(screen.getAllByText("New")).toHaveLength(1);
    expect(Date.parse(readAgentChangesLookedAt() ?? "")).toBeGreaterThan(Date.parse("2026-10-27T04:00:00.000Z"));
  });
});
