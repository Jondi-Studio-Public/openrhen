import { describe, expect, it } from "vitest";
import type { Card, MapEdge } from "@openrhen/contracts/plan-map-navigator";
import { link, planMap } from "@/features/plan-map/test-fixtures";
import {
  CARD_HEIGHT,
  CARD_WIDTH,
  DEFAULT_CONTROLS,
  buildMapView,
  EDGE_LOOK_LABELS,
  describeCard,
  edgeLook,
  humanise,
  edgePath,
  itemFromSearch,
  controlsFromSearch,
  mapAddress,
  layoutMap,
  busiestAreaHandle,
  mapHref,
  mapStarts
} from "./map-view-model";

const now = new Date("2026-09-04T00:00:00.000Z");

function plan(actionCount = 2) {
  return {
    areas: [{ id: "ar1", name: "Study", status: "active" }],
    outcomes: [{ id: "o1", title: "Pass maths", status: "active" }],
    projects: [
      { id: "p1", title: "Maths exam", status: "active", value: 3, consequence: 2 },
      { id: "p2", title: "Drafting folio", status: "active", value: 1, consequence: 1 }
    ],
    actions: Array.from({ length: actionCount }, (_, i) => ({
      id: `a${i + 1}`,
      title: `Action ${i + 1}`,
      status: "ready",
      projectId: "p1",
      remainingMinutes: 30,
      energy: "low"
    })),
    commitments: [],
    commitmentRecurrenceRules: []
  };
}

const confirmed = link({ status: "confirmed", fromType: "project", fromId: "p1", toType: "subject", toId: "maths" });
const suggested = link({ status: "suggested", fromType: "action", fromId: "a1", toType: "subject", toId: "maths" });
const map = () => planMap({ links: [confirmed, suggested] });

const card = (handle: string): Card => ({
  handle,
  type: handle.split(":")[0] as Card["type"],
  title: handle,
  status: null,
  when: null,
  parent: null,
  steps: 0,
  openBlockers: 0,
  links: 0,
  detail: null
});
const edge = (from: string, to: string): MapEdge => ({ from, to, kind: "parent_child", origin: "derived" });

describe("buildMapView", () => {
  it("reports a problem when the root is not in the plan", () => {
    const view = buildMapView(plan(), map(), "project:gone", DEFAULT_CONTROLS, now);
    expect(view.problem).toMatch(/not in the plan/);
    expect(view.root).toBeNull();
    expect(view.cards).toEqual([]);
  });

  it("has no root and no problem when nothing is chosen", () => {
    const view = buildMapView(plan(), map(), null, DEFAULT_CONTROLS, now);
    expect(view.problem).toBeNull();
    expect(view.root).toBeNull();
  });

  it("drops suggested edges when showSuggested is off", () => {
    const on = buildMapView(plan(), map(), "subject:maths", DEFAULT_CONTROLS, now);
    expect(on.edges.some((e) => e.status === "suggested")).toBe(true);
    const off = buildMapView(plan(), map(), "subject:maths", { ...DEFAULT_CONTROLS, showSuggested: false }, now);
    expect(off.edges.some((e) => e.status === "suggested")).toBe(false);
    expect(off.edges.some((e) => e.status === "confirmed")).toBe(true);
  });

  it("keeps only stored edges when showDerived is off", () => {
    const view = buildMapView(plan(), map(), "project:p1", { ...DEFAULT_CONTROLS, showDerived: false }, now);
    expect(view.edges.length).toBeGreaterThan(0);
    expect(view.edges.every((e) => e.origin === "stored")).toBe(true);
    const all = buildMapView(plan(), map(), "project:p1", DEFAULT_CONTROLS, now);
    expect(all.edges.some((e) => e.origin === "derived")).toBe(true);
  });

  it("leaves archived and cancelled items off a live centre's map", () => {
    const state = plan(3);
    state.actions[0]!.status = "archived";
    state.actions[1]!.status = "cancelled";
    const view = buildMapView(state, map(), "project:p1", DEFAULT_CONTROLS, now);
    const handles = view.cards.map((card) => card.handle);
    expect(handles).not.toContain("action:a1");
    expect(handles).not.toContain("action:a2");
    expect(handles).toContain("action:a3");
    expect(view.edges.some((edge) => [edge.from, edge.to].some((h) => h === "action:a1" || h === "action:a2"))).toBe(
      false
    );
  });

  it("leaves off a card the root only reached through an archived one", () => {
    const state = plan(2);
    state.projects[0]!.status = "archived";
    const view = buildMapView(state, map(), "subject:maths", { ...DEFAULT_CONTROLS, depth: 2 }, now);
    const handles = view.cards.map((card) => card.handle);
    expect(handles).not.toContain("project:p1");
    expect(handles).not.toContain("action:a2");
    expect(handles).toContain("action:a1");
    const joined = new Set(view.edges.flatMap((edge) => [edge.from, edge.to]));
    for (const handle of handles) expect(joined.has(handle)).toBe(true);
  });

  it("reaches further at depth 2", () => {
    const one = buildMapView(plan(), map(), "subject:maths", DEFAULT_CONTROLS, now);
    const two = buildMapView(plan(), map(), "subject:maths", { ...DEFAULT_CONTROLS, depth: 2 }, now);
    const handles = (cards: Card[]) => cards.map((c) => c.handle);
    expect(handles(one.cards)).not.toContain("action:a2");
    expect(handles(two.cards)).toContain("action:a2");
    expect(two.cards.length).toBeGreaterThan(one.cards.length);
  });
});

describe("edgeLook", () => {
  it("names the three looks", () => {
    expect(edgeLook({ origin: "derived" })).toBe("derived");
    expect(edgeLook({ origin: "stored", status: "confirmed" })).toBe("confirmed");
    expect(edgeLook({ origin: "stored", status: "suggested" })).toBe("suggested");
  });
});

describe("layoutMap", () => {
  const neighbours = Array.from({ length: 12 }, (_, i) => card(`action:n${i}`));
  const root = card("project:root");
  const edges = neighbours.map((n) => edge(root.handle, n.handle));

  it("never overlaps two cards", () => {
    const { placed } = layoutMap(root, neighbours, edges);
    expect(placed).toHaveLength(13);
    for (const a of placed)
      for (const b of placed) {
        if (a === b) continue;
        const apart =
          a.x + CARD_WIDTH <= b.x || b.x + CARD_WIDTH <= a.x || a.y + CARD_HEIGHT <= b.y || b.y + CARD_HEIGHT <= a.y;
        expect(apart).toBe(true);
      }
  });

  it("centres the root", () => {
    const { placed, width, height } = layoutMap(root, neighbours, edges);
    const centre = placed.find((p) => p.card.handle === root.handle)!;
    expect(centre.side).toBe("centre");
    // Centred between the outermost columns, with the same margin on both sides of the canvas.
    const left = Math.min(...placed.map((p) => p.x));
    const right = Math.max(...placed.map((p) => p.x + CARD_WIDTH));
    expect(centre.x + CARD_WIDTH / 2).toBeCloseTo((left + right) / 2);
    expect(width - right).toBeCloseTo(left);
    expect(centre.y + CARD_HEIGHT / 2).toBeCloseTo(height / 2);
  });

  it("keeps every card inside width and height", () => {
    const deep = [...neighbours, card("step:s1")];
    const { placed, width, height } = layoutMap(root, deep, [...edges, edge("action:n0", "step:s1")]);
    for (const p of placed) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.x + CARD_WIDTH).toBeLessThanOrEqual(width);
      expect(p.y + CARD_HEIGHT).toBeLessThanOrEqual(height);
    }
  });

  it("keeps no empty column when every neighbour sits on one side", () => {
    const only = card("outcome:only");
    const { placed, width } = layoutMap(root, [only], [edge(root.handle, only.handle)]);
    const left = Math.min(...placed.map((p) => p.x));
    const right = Math.max(...placed.map((p) => p.x + CARD_WIDTH));
    expect(left).toBeGreaterThan(0);
    expect(width - right).toBeCloseTo(left);
    // Two cards and one gap, not three columns with an empty one beside the root.
    expect(right - left).toBeLessThan(CARD_WIDTH * 3);
  });

  it("puts a depth-2 card on the same side as its parent", () => {
    const cards = [card("action:a"), card("action:b"), card("step:s1"), card("step:s2")];
    const { byHandle } = layoutMap(root, cards, [
      edge(root.handle, "action:a"),
      edge(root.handle, "action:b"),
      edge("action:a", "step:s1"),
      edge("action:b", "step:s2")
    ]);
    expect(byHandle.get("step:s1")!.distance).toBe(2);
    expect(byHandle.get("step:s1")!.side).toBe(byHandle.get("action:a")!.side);
    expect(byHandle.get("step:s2")!.side).toBe(byHandle.get("action:b")!.side);
    expect(byHandle.get("action:a")!.side).not.toBe(byHandle.get("action:b")!.side);
  });
});

describe("edgePath", () => {
  it("returns a path that starts with M", () => {
    const { byHandle } = layoutMap(card("project:root"), [card("action:a")], [edge("project:root", "action:a")]);
    expect(edgePath(byHandle.get("project:root")!, byHandle.get("action:a")!)).toMatch(/^M /);
  });

  it("returns a path for two cards in the same column", () => {
    const { byHandle } = layoutMap(
      card("project:root"),
      [card("action:a"), card("action:b")],
      [edge("project:root", "action:a"), edge("project:root", "action:b"), edge("action:a", "action:b")]
    );
    expect(edgePath(byHandle.get("action:a")!, byHandle.get("action:b")!)).toMatch(/^M /);
  });
});

describe("mapStarts", () => {
  it("lists areas, outcomes, projects, then subjects, each alphabetically", () => {
    const view = buildMapView(plan(), map(), null, DEFAULT_CONTROLS, now);
    expect(mapStarts(view).map((s) => `${s.group}:${s.title}`)).toEqual([
      "Areas:Study",
      "Outcomes:Pass maths",
      "Projects:Drafting folio",
      "Projects:Maths exam",
      "Subjects:Maths",
      "Subjects:Meals"
    ]);
  });

  it("leaves archived items out", () => {
    const state = {
      ...plan(),
      areas: [
        { id: "ar1", name: "Study", status: "active" },
        { id: "ar2", name: "Old job", status: "archived" }
      ],
      projects: [{ id: "p9", title: "Shelved", status: "archived", value: 1, consequence: 1 }]
    };
    const view = buildMapView(state, map(), null, DEFAULT_CONTROLS, now);
    const titles = mapStarts(view).map((s) => s.title);
    expect(titles).toContain("Study");
    expect(titles).not.toContain("Old job");
    expect(titles).not.toContain("Shelved");
  });
});

describe("busiestAreaHandle", () => {
  const area = (id: string, sortOrder: number, status = "active") => ({ id, name: id, status, sortOrder });
  const outcome = (id: string, areaId: string) => ({ id, title: id, status: "active", areaId });
  const project = (id: string, outcomeId: string, status = "active") => ({ id, title: id, status, outcomeId });
  const action = (id: string, projectId: string, status = "ready") => ({ id, title: id, status, projectId });
  const state = (overrides: Record<string, unknown[]>) =>
    ({ areas: [], outcomes: [], projects: [], actions: [], ...overrides }) as unknown as Parameters<
      typeof busiestAreaHandle
    >[0];

  it("picks the live area with the most open projects and actions", () => {
    expect(
      busiestAreaHandle(
        state({
          areas: [area("home", 0), area("study", 1)],
          outcomes: [outcome("o-home", "home"), outcome("o-study", "study")],
          projects: [project("p-home", "o-home"), project("p-study", "o-study")],
          actions: [action("a1", "p-study"), action("a2", "p-study"), action("a3", "p-home", "done")]
        })
      )
    ).toBe("area:study");
  });

  it("skips archived areas and closed work, and breaks ties in Plan's order", () => {
    expect(
      busiestAreaHandle(
        state({
          areas: [area("old", 0, "archived"), area("b", 2), area("a", 1)],
          outcomes: [outcome("o-old", "old"), outcome("o-a", "a"), outcome("o-b", "b")],
          projects: [
            project("p-old", "o-old"),
            project("p-a", "o-a"),
            project("p-b", "o-b"),
            project("p-b2", "o-b", "done")
          ],
          actions: [action("x1", "p-old"), action("x2", "p-old"), action("x3", "p-b2")]
        })
      )
    ).toBe("area:a");
  });

  it("has no answer when nothing is open", () => {
    expect(busiestAreaHandle(state({ areas: [area("home", 0)] }))).toBeNull();
  });
});

describe("itemFromSearch and mapHref", () => {
  it("round trips a handle", () => {
    for (const handle of ["project:p1", "subject:maths & more", "action:a/1?"]) {
      expect(itemFromSearch(mapHref(handle).replace("/map", ""))).toBe(handle);
    }
  });

  it("reads no item from a missing or handle-less value", () => {
    expect(itemFromSearch("")).toBeNull();
    expect(itemFromSearch("?item=plain")).toBeNull();
    expect(itemFromSearch("?other=project:p1")).toBeNull();
  });
});

describe("controlsFromSearch and mapAddress", () => {
  it("leaves defaults out of the address and reads them back", () => {
    expect(mapAddress(null, DEFAULT_CONTROLS)).toBe("/map");
    expect(mapAddress("project:p1", DEFAULT_CONTROLS)).toBe("/map?item=project%3Ap1");
    expect(controlsFromSearch("")).toEqual(DEFAULT_CONTROLS);
  });

  it("round trips every control alongside the item", () => {
    const controls = { depth: 3, showSuggested: false, showDerived: false } as const;
    const address = mapAddress("subject:maths & more", controls);
    expect(address).toBe("/map?item=subject%3Amaths+%26+more&depth=3&suggested=0&plan=0");
    const search = address.replace("/map", "");
    expect(controlsFromSearch(search)).toEqual(controls);
    expect(itemFromSearch(search)).toBe("subject:maths & more");
  });

  it("keeps the default for a depth it cannot read", () => {
    expect(controlsFromSearch("?depth=9").depth).toBe(DEFAULT_CONTROLS.depth);
    expect(controlsFromSearch("?depth=two").depth).toBe(DEFAULT_CONTROLS.depth);
  });
});

describe("plain wording", () => {
  it("reads stored words with spaces, not underscores", () => {
    expect(humanise("in_progress")).toBe("in progress");
    expect(humanise("active")).toBe("active");
  });

  it("describes a card's status as plain words", () => {
    expect(describeCard({ ...card("action:a1"), status: "in_progress", when: null }, "UTC")).toBe(
      "action, in progress"
    );
  });

  it("calls a link the plan itself produced 'from the plan'", () => {
    expect(EDGE_LOOK_LABELS.derived).toBe("from the plan");
  });
});
