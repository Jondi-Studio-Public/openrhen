// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@/test/render";
import { link, planMap } from "@/features/plan-map/test-fixtures";
import { PlanMapPage, centreHref } from "./plan-map-page";

const portalState: Record<string, unknown> = {
  settings: { timezone: "Australia/Brisbane" },
  areas: [],
  outcomes: [],
  projects: [{ id: "p1", title: "Maths exam", status: "active", value: 3, consequence: 2 }],
  deliverables: [
    { id: "d1", title: "Folio sheet", status: "active", projectId: "p1", steps: [], criteria: [], blockers: [] }
  ],
  actions: [
    {
      id: "a1",
      title: "Practice paper",
      status: "ready",
      projectId: "p1",
      remainingMinutes: 30,
      energy: "low"
    }
  ],
  commitments: [],
  commitmentRecurrenceRules: []
};

vi.mock("@/state/portal-provider", () => ({ usePortal: () => ({ state: portalState }) }));
const clock = vi.hoisted(() => ({ now: new Date("2026-09-04T00:00:00.000Z") }));
vi.mock("@/shared/clock", () => ({ useNow: () => clock.now }));

const fetchMock = vi.fn();
const ok = (body: unknown) => ({ ok: true, json: () => Promise.resolve(body) });
const withLinks = () =>
  planMap({
    links: [
      link({ status: "confirmed", fromType: "project", fromId: "p1", toType: "subject", toId: "maths" }),
      link({ status: "suggested", fromType: "project", fromId: "p1", toType: "subject", toId: "meals" })
    ]
  });

beforeEach(() => {
  clock.now = new Date("2026-09-04T00:00:00.000Z");
  portalState.areas = [];
  portalState.outcomes = [];
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  window.history.replaceState(null, "", "/map");
});
afterEach(() => vi.unstubAllGlobals());

const linkList = () => screen.findByRole("list", { name: "Links on this map" });

describe("PlanMapPage", () => {
  it("shows the start list when no item is chosen", async () => {
    fetchMock.mockResolvedValue(ok(withLinks()));
    render(<PlanMapPage />);
    expect(await screen.findByText("Start from an area, outcome, project or subject")).toBeTruthy();
    for (const name of ["Maths", "Meals", "Maths exam"]) expect(screen.getByRole("link", { name })).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("opens on the busiest live area, marks it among grouped chips, and leaves archived items out", async () => {
    portalState.areas = [
      { id: "quiet", name: "Quiet", status: "active", sortOrder: 0 },
      { id: "study", name: "Study", status: "active", sortOrder: 1 },
      { id: "old", name: "Old job", status: "archived", sortOrder: 2 }
    ];
    portalState.outcomes = [{ id: "o1", title: "Pass maths", status: "active", areaId: "study" }];
    portalState.projects = [
      { id: "p1", title: "Maths exam", status: "active", outcomeId: "o1", value: 3, consequence: 2 }
    ];
    fetchMock.mockResolvedValue(ok(withLinks()));
    render(<PlanMapPage />);
    expect(await screen.findByRole("img", { name: /^Map of Study/ })).toBeTruthy();
    expect(window.location.search).toBe("");
    expect(screen.getByText("Or start somewhere else")).toBeTruthy();
    const areas = screen.getByRole("list", { name: "Areas" });
    expect(
      within(areas)
        .getAllByRole("link")
        .map((link) => link.textContent)
    ).toEqual(["Quiet", "Study"]);
    expect(within(areas).getByRole("link", { name: "Study" }).getAttribute("aria-current")).toBe("true");
    expect(screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)).toEqual([
      "Areas",
      "Outcomes",
      "Projects",
      "Subjects"
    ]);
    expect(screen.queryByRole("link", { name: "Old job" })).toBeNull();
    portalState.projects = [{ id: "p1", title: "Maths exam", status: "active", value: 3, consequence: 2 }];
  });

  it("draws confirmed, suggested and derived links for ?item=project:p1", async () => {
    window.history.replaceState(null, "", "/map?item=project:p1");
    fetchMock.mockResolvedValue(ok(withLinks()));
    const { container } = render(<PlanMapPage />);
    expect(await screen.findByRole("img")).toBeTruthy();
    const list = await linkList();
    const rows = (look: string) => list.querySelectorAll(`li[data-look="${look}"]`);
    await vi.waitFor(() => expect(rows("confirmed")).toHaveLength(1));
    expect(rows("suggested")).toHaveLength(1);
    expect(rows("derived")).toHaveLength(2);
    expect(within(rows("confirmed")[0] as HTMLElement).getByText("confirmed")).toBeTruthy();
    expect(within(rows("suggested")[0] as HTMLElement).getByText("suggested")).toBeTruthy();
    expect(within(rows("derived")[0] as HTMLElement).getByText("from the plan")).toBeTruthy();
    expect(container.querySelector('path[data-look="suggested"]')).not.toBeNull();
    expect(container.querySelector('path[data-look="confirmed"]')).not.toBeNull();
    expect(container.querySelector('path[data-look="derived"]')).not.toBeNull();
  });

  it("removes the suggested row when Show suggested links is switched off", async () => {
    window.history.replaceState(null, "", "/map?item=project:p1");
    fetchMock.mockResolvedValue(ok(withLinks()));
    const { container } = render(<PlanMapPage />);
    const list = await linkList();
    await vi.waitFor(() => expect(list.querySelectorAll('li[data-look="suggested"]')).toHaveLength(1));
    fireEvent.click(screen.getByRole("switch", { name: "Show suggested links" }));
    expect(container.querySelectorAll('li[data-look="suggested"]')).toHaveLength(0);
    expect(container.querySelector('path[data-look="suggested"]')).toBeNull();
    expect(container.querySelectorAll('li[data-look="confirmed"]')).toHaveLength(1);
  });

  it("recentres from a start link without reloading the page", async () => {
    fetchMock.mockResolvedValue(ok(withLinks()));
    const push = vi.spyOn(window.history, "pushState");
    render(<PlanMapPage />);
    fireEvent.click(await screen.findByRole("link", { name: "Maths exam" }));
    expect(push).toHaveBeenCalledTimes(1);
    expect(window.location.search).toBe("?item=project%3Ap1");
    expect(await screen.findByRole("img")).toBeTruthy();
    expect(screen.queryByText("Start from an area, outcome, project or subject")).toBeNull();
    push.mockRestore();
  });

  it("keeps the controls in the address, keeps them on a recentre, and opens a map drawn as addressed", async () => {
    fetchMock.mockResolvedValue(ok(withLinks()));
    window.history.replaceState(null, "", "/map?item=project:p1");
    const push = vi.spyOn(window.history, "pushState");
    const { unmount } = render(<PlanMapPage />);
    await screen.findByRole("img");
    fireEvent.click(
      within(screen.getByRole("radiogroup", { name: "How far out" })).getByRole("radio", { name: "2 links" })
    );
    fireEvent.click(screen.getByRole("switch", { name: "Links from the plan" }));
    // A control replaces the entry rather than adding one, so Back still means the last centre.
    expect(push).not.toHaveBeenCalled();
    expect(window.location.search).toBe("?item=project%3Ap1&depth=2&plan=0");
    push.mockRestore();
    unmount();

    window.history.replaceState(null, "", "/map?item=project:p1&depth=3&suggested=0");
    render(<PlanMapPage />);
    await screen.findByRole("img");
    const depth = within(screen.getByRole("radiogroup", { name: "How far out" }));
    expect(depth.getByRole("radio", { name: "3 links" }).getAttribute("aria-checked")).toBe("true");
    expect(depth.getByRole("radio", { name: "1 link" }).getAttribute("aria-checked")).toBe("false");
    expect(screen.getByRole("switch", { name: "Show suggested links" }).getAttribute("aria-checked")).toBe("false");
    expect(screen.getByRole("switch", { name: "Links from the plan" }).getAttribute("aria-checked")).toBe("true");
  });

  it("never draws the map below its own units, so a phone scrolls it rather than shrinking the text", async () => {
    fetchMock.mockResolvedValue(ok(withLinks()));
    window.history.replaceState(null, "", "/map?item=project:p1");
    render(<PlanMapPage />);
    const map = await screen.findByRole("img");
    const width = map.getAttribute("viewBox")!.split(" ")[2];
    expect(map.style.minWidth).toBe(`${width}px`);
  });

  it("says when stored links failed to load, offers a retry, and still draws derived links", async () => {
    window.history.replaceState(null, "", "/map?item=project:p1");
    fetchMock.mockRejectedValueOnce(new Error("Network down"));
    const { container } = render(<PlanMapPage />);
    expect(await screen.findByText(/Network down/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(await screen.findByRole("img")).toBeTruthy();
    expect(container.querySelectorAll('li[data-look="derived"]').length).toBeGreaterThan(0);
    expect(container.querySelectorAll('li[data-look="confirmed"]')).toHaveLength(0);

    fetchMock.mockResolvedValue(ok(withLinks()));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await vi.waitFor(() => expect(container.querySelectorAll('li[data-look="confirmed"]')).toHaveLength(1));
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("centres a wide map once, and leaves the reader's scroll alone when the clock ticks", async () => {
    // jsdom lays nothing out, so give every element a canvas wider than its box and a real scrollLeft.
    const scroll = new WeakMap<Element, number>();
    const restore = [
      ["scrollWidth", { get: () => 900 }],
      ["clientWidth", { get: () => 390 }],
      [
        "scrollLeft",
        {
          get(this: Element) {
            return scroll.get(this) ?? 0;
          },
          set(this: Element, value: number) {
            scroll.set(this, value);
          }
        }
      ]
    ].map(([name, descriptor]) => {
      const original = Object.getOwnPropertyDescriptor(Element.prototype, name as string);
      Object.defineProperty(Element.prototype, name as string, { configurable: true, ...(descriptor as object) });
      return () => Object.defineProperty(Element.prototype, name as string, original!);
    });
    try {
      window.history.replaceState(null, "", "/map?item=project:p1");
      fetchMock.mockResolvedValue(ok(withLinks()));
      const { container, rerender } = render(<PlanMapPage />);
      await linkList();
      const canvas = container.querySelector("[data-map-canvas]")!;
      await vi.waitFor(() => expect(scroll.has(canvas)).toBe(true));
      canvas.scrollLeft = 123;
      clock.now = new Date("2026-09-04T00:01:00.000Z");
      rerender(<PlanMapPage />);
      expect(canvas.scrollLeft).toBe(123);
    } finally {
      for (const undo of restore) undo();
    }
  });

  it("is read-only: no confirm, reject or remove control anywhere", async () => {
    window.history.replaceState(null, "", "/map?item=project:p1");
    fetchMock.mockResolvedValue(ok(withLinks()));
    render(<PlanMapPage />);
    await linkList();
    await vi.waitFor(() => expect(document.querySelectorAll('li[data-look="suggested"]')).toHaveLength(1));
    expect(screen.queryByRole("button", { name: /confirm|reject|remove|dismiss/i })).toBeNull();
    expect(screen.queryByText(/^(Confirm|Reject|Remove)$/)).toBeNull();
    expect(fetchMock.mock.calls.every(([, init]) => !init || !init.method || init.method === "GET")).toBe(true);
  });
});

describe("centreHref", () => {
  const state = {
    areas: [{ id: "study" }],
    outcomes: [{ id: "o1", areaId: "study" }],
    projects: [{ id: "p1", outcomeId: "o1", area: "" }]
  } as unknown as Parameters<typeof centreHref>[1];

  it("opens an area, outcome or project where Plan shows it, and a deliverable in its workspace", () => {
    expect(centreHref("area:study", state)).toBe("/plan/study");
    expect(centreHref("outcome:o1", state)).toBe("/plan/study#outcome-o1");
    expect(centreHref("project:p1", state)).toBe("/plan/study#project-p1");
    expect(centreHref("deliverable:d1", state)).toBe("/deliverables?deliverable=d1");
  });

  it("offers nothing for an item with no page of its own, or one that is gone", () => {
    expect(centreHref("subject:maths", state)).toBeNull();
    expect(centreHref("area:gone", state)).toBeNull();
    expect(centreHref("nonsense", state)).toBeNull();
  });
});
