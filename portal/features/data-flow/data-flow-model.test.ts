import { describe, expect, it } from "vitest";
import {
  DEFAULT_FILTERS,
  reachSteps,
  ageText,
  applyFilters,
  buildFlowModel,
  countsLine,
  listRows,
  triggerText,
  type FlowModel
} from "./data-flow-model";
import { buildDataFlowView, dataFlowRegistry, registryTables } from "@openrhen/contracts/data-flow";
import { NOW, response, withStaleCalendar } from "./test-fixtures";

const model = (data = response(), expanded?: Set<string>): FlowModel =>
  buildFlowModel(data, { now: NOW, ...(expanded ? { expanded } : {}) });

describe("ageText", () => {
  it.each([
    [null, "never"],
    ["2026-11-09T11:59:40.000Z", "just now"],
    ["2026-11-09T11:30:00.000Z", "30 min ago"],
    ["2026-11-09T10:00:00.000Z", "2 h ago"],
    ["2026-11-05T12:00:00.000Z", "4 d ago"]
  ])("%s reads %s", (iso, text) => {
    expect(ageText(iso, NOW)).toBe(text);
  });
});

describe("buildFlowModel", () => {
  it("puts nodes in five columns and planned entries in their own lane", () => {
    const m = model();
    expect(m.byId.get("calendar-pull")?.column).toBe(1);
    expect(m.byId.get("ingest")?.column).toBe(1);
    expect(m.byId.get("engine-input")?.column).toBe(3);
    expect(m.byId.get("backup-run")?.column).toBe(3);
    expect(m.byId.get("surface:engine")?.column).toBe(4);
    expect(m.byId.get("ext:calendar-account")?.column).toBe(0);
    expect(m.byId.get("planned-holidays")?.column).toBe(-1);
    expect(m.byId.get("planned-holidays")?.planned).toBe(true);
  });

  it("collapses file imports into one node and tables with the same neighbours into one store", () => {
    const m = model();
    expect(m.nodes.filter((node) => node.id === "files")).toHaveLength(1);
    const stores = m.nodes.filter((node) => node.kind === "store");
    expect(stores.find((node) => node.tables?.includes("example_items"))?.tables).toEqual([
      "example_items",
      "example_imports"
    ]);
    expect(stores.find((node) => node.tables?.includes("commitments"))?.tables).toEqual(["commitments"]);
  });

  it("opens the activity store into one row per source", () => {
    const closed = model();
    expect(closed.byId.get("store:activity")?.expandable).toBe(true);
    expect(closed.byId.has("store:activity/physiology")).toBe(false);
    const open = model(response(), new Set(["store:activity"]));
    expect(open.byId.has("store:activity")).toBe(false);
    expect(open.byId.get("store:activity/physiology")?.label).toBe("Physiology");
    expect(open.byId.get("store:activity/*")?.label).toBe("All sources");
  });

  it("colours entries by freshness and says it in words with an age", () => {
    const m = model();
    expect(m.byId.get("calendar-pull")).toMatchObject({ tone: "green", detail: "Fresh · 1 h ago" });
    const stale = model(withStaleCalendar()).byId.get("calendar-pull")!;
    expect(stale).toMatchObject({ tone: "red", attention: "problem" });
    expect(stale.detail).toBe("Stale · 4 d ago");
  });

  it("marks a fresh source nothing reads as unused (amber), not a problem", () => {
    const node = model().byId.get("music-export")!;
    expect(node).toMatchObject({ tone: "amber", attention: "unused", marker: "gives nothing yet" });
  });

  it("shows a feed that was never set up as grey, and one that never reported as hollow", () => {
    const data = response();
    if (data.health.unavailable) throw new Error("fixture");
    data.health.nodes["watch-export"] = {
      ...data.health.nodes["watch-export"]!,
      freshness: "never",
      lastSuccessAt: null
    };
    const m = model(data);
    expect(m.byId.get("watch-export")).toMatchObject({ tone: "hollow", attention: "problem" });
    expect(m.byId.get("phone-shortcuts")).toMatchObject({ tone: "grey", marker: "nothing sends" });
  });

  it("shows probe_unresolved and failing as red", () => {
    const data = response();
    if (data.health.unavailable) throw new Error("fixture");
    data.health.nodes["calendar-pull"] = { ...data.health.nodes["calendar-pull"]!, freshness: "probe_unresolved" };
    data.health.nodes["watch-export"] = { ...data.health.nodes["watch-export"]!, freshness: "failing" };
    const m = model(data);
    expect(m.byId.get("calendar-pull")?.tone).toBe("red");
    expect(m.byId.get("calendar-pull")?.detail).toMatch(/^Check unresolved/);
    expect(m.byId.get("watch-export")?.tone).toBe("red");
  });

  it("gives the device a last-seen line and the worst tone of its feeds", () => {
    const device = model().byId.get("device:phone")!;
    expect(device.detail).toBe("last seen 2 h ago (phone location)");
    expect(device.tone).toBe("green");
    expect(model().edges).toContainEqual(expect.objectContaining({ from: "device:phone", to: "phone-ping" }));
  });

  it("draws solid edges where the path reaches the engine and dotted ones where it is blind", () => {
    const m = model();
    const edge = (from: string, to: string) => m.edges.find((item) => item.from === from && item.to === to);
    expect(m.byId.get("calendar-pull")?.reachesEngine).toBe(true);
    expect(m.byId.get("music-export")?.reachesEngine).toBe(false);
    expect(
      edge(
        "calendar-pull",
        m.byId.get("engine-input") ? [...m.byId.values()].find((n) => n.tables?.includes("commitments"))!.id : ""
      )?.engine
    ).toBe(true);
    expect(edge("engine-input", "surface:engine")?.engine).toBe(true);
    expect(edge("watch-panel", "surface:page/review")?.engine).toBe(false);
  });

  it("greys backup and REST as pass-through", () => {
    expect(model().byId.get("surface:backup")?.passThrough).toBe(true);
    expect(model().byId.get("backup-run")?.passThrough).toBe(true);
  });

  it("with health unavailable keeps the graph, greys every node and says so", () => {
    const m = model({ ...response(), health: { unavailable: true, reason: "boom", next: "Run doctor." } });
    expect(m.healthAvailable).toBe(false);
    expect(m.byId.get("calendar-pull")).toMatchObject({ tone: "grey", detail: "Health unavailable" });
    expect(m.nodes.length).toBe(model().nodes.length);
    expect(countsLine(m)).toBe("Health unavailable");
  });

  it("is a pure function of its input", () => {
    expect(JSON.stringify(model())).toBe(JSON.stringify(model()));
  });
});

/** The fixture plus idle file imports (never set up, never any rows) in one category, and one in another. */
function withIdle(count: number) {
  const data = response();
  if (data.health.unavailable) throw new Error("fixture");
  const base = data.entries.find((entry) => entry.id === "watch-export")!;
  for (let index = 0; index < count; index += 1) {
    const id = `idle-${index}`;
    data.entries = [
      ...data.entries,
      {
        ...base,
        id,
        name: `Idle ${index}`,
        from: [`local:idle-${index}`],
        to: [`pg:idle_${index}`],
        reach: "gives nothing yet"
      }
    ];
    data.health.nodes[id] = {
      entryId: id,
      probe: "test",
      configured: false,
      freshness: "never",
      lastSuccessAt: null,
      lastAttemptAt: null,
      lastError: null,
      threshold: null
    };
    data.edges = [
      ...data.edges,
      { from: `local:idle-${index}`, to: id, kind: "reads" },
      { from: id, to: `pg:idle_${index}`, kind: "writes" }
    ];
  }
  return data;
}

describe("folding idle collectors", () => {
  it("folds idle collectors into one node per category, with edges merged into it", () => {
    const m = model(withIdle(5));
    const fold = m.byId.get("fold:files")!;
    expect(fold).toMatchObject({ label: "5 more not set up", column: 1, tone: "grey", detail: "files" });
    expect(fold.folded).toHaveLength(5);
    expect(fold.foldedNames).toContain("Idle 3");
    expect(m.byId.has("idle-0")).toBe(false);
    expect(m.edges.filter((edge) => edge.from === "fold:files" || edge.to === "fold:files").length).toBeGreaterThan(0);
    expect(m.edges.every((edge) => m.byId.has(edge.from) && m.byId.has(edge.to))).toBe(true);
  });

  it("merges the stores the folded collectors alone write into one", () => {
    const folded = model(withIdle(5)).nodes.filter((node) => node.kind === "store").length;
    const open = model(withIdle(5), new Set(["fold:files"])).nodes.filter((node) => node.kind === "store").length;
    expect(open - folded).toBe(4);
  });

  it("shows them one by one once the fold is opened, or when told not to fold", () => {
    expect(model(withIdle(5), new Set(["fold:files"])).byId.has("idle-0")).toBe(true);
    expect(model(withIdle(5), new Set(["fold:files"])).byId.has("fold:files")).toBe(false);
    expect(buildFlowModel(withIdle(5), { now: NOW, unfold: true }).byId.has("idle-4")).toBe(true);
  });

  it("does not fold a lone idle collector, a source with rows, a problem, or anything when health is unavailable", () => {
    expect(model(withIdle(1)).byId.has("idle-0")).toBe(true);
    expect(model(withIdle(5)).byId.has("watch-export")).toBe(true);
    const failing = withIdle(5);
    if (failing.health.unavailable) throw new Error("fixture");
    failing.health.nodes["idle-0"] = { ...failing.health.nodes["idle-0"]!, configured: true, freshness: "failing" };
    expect(model(failing).byId.has("idle-0")).toBe(true);
    expect(model(failing).byId.get("fold:files")?.folded).toHaveLength(4);
    const down = { ...withIdle(5), health: { unavailable: true as const, reason: "x", next: "n" } };
    expect(model(down).byId.has("idle-0")).toBe(true);
  });

  it("never folds readers, planned entries or sources that nothing sends", () => {
    const m = model(withIdle(5));
    expect(m.byId.has("phone-shortcuts")).toBe(true);
    expect(m.byId.has("planned-holidays")).toBe(true);
    expect(m.byId.has("today-view")).toBe(true);
  });

  it("keeps every entry in the list rows", () => {
    const m = buildFlowModel(withIdle(5), { now: NOW, unfold: true });
    const { nodes, edges } = applyFilters(m, DEFAULT_FILTERS);
    expect(listRows(m, nodes, edges).filter((row) => row.id.startsWith("idle-"))).toHaveLength(5);
  });
});

describe("machinery tables", () => {
  const withMachinery = () => {
    const data = response();
    data.datasets = [
      { ref: "pg:jobs", infrastructure: "queue" },
      { ref: "pg:writes", infrastructure: "ledger" }
    ];
    data.entries = data.entries.map((entry) =>
      entry.id === "today-view" ? { ...entry, from: [...entry.from, "pg:jobs", "pg:writes"] } : entry
    );
    data.edges = [
      ...data.edges,
      { from: "pg:jobs", to: "today-view", kind: "reads" },
      { from: "pg:writes", to: "today-view", kind: "reads" }
    ];
    return data;
  };

  it("draws the infrastructure tables as one store until it is opened", () => {
    const store = model(withMachinery()).byId.get("store:machinery")!;
    expect(store).toMatchObject({ label: "Machinery tables", detail: "2 tables", expandable: true });
    expect(store.tables).toEqual(["jobs", "writes"]);
    expect(model(withMachinery(), new Set(["store:machinery"])).byId.has("store:machinery")).toBe(false);
  });
});

describe("countsLine", () => {
  it("counts late, silent, collected-unused and accepted-nothing-sends", () => {
    expect(countsLine(model())).toBe("1 collected, unused · 1 accepted, nothing sends");
    expect(countsLine(model(withStaleCalendar()))).toBe("1 late · 1 collected, unused · 1 accepted, nothing sends");
  });

  it("says so when nothing is wrong", () => {
    const data = response();
    data.unused.entries = [];
    expect(countsLine(model(data))).toBe("Everything collected is arriving");
  });

  it("counts a device silent when every feed that reports is late or worse", () => {
    const data = withStaleCalendar();
    if (data.health.unavailable) throw new Error("fixture");
    data.health.nodes["phone-ping"] = { ...data.health.nodes["phone-ping"]!, freshness: "stale" };
    expect(countsLine(model(data))).toContain("1 device silent");
  });
});

describe("applyFilters", () => {
  it("shows everything by default, including planned", () => {
    const m = model();
    expect(applyFilters(m, DEFAULT_FILTERS).nodes).toHaveLength(m.nodes.length);
  });

  it("hides planned entries on request", () => {
    const m = model();
    const ids = applyFilters(m, { ...DEFAULT_FILTERS, showPlanned: false }).nodes.map((n) => n.id);
    expect(ids).not.toContain("planned-holidays");
  });

  it("keeps only entries in a category, with the nodes that join them and no orphans", () => {
    const m = model();
    const { nodes, edges } = applyFilters(m, { ...DEFAULT_FILTERS, category: "calendar" });
    const ids = new Set(nodes.map((n) => n.id));
    expect(ids.has("calendar-pull")).toBe(true);
    expect(ids.has("ext:calendar-account")).toBe(true);
    expect(ids.has("watch-export")).toBe(false);
    expect(ids.has("files")).toBe(false);
    for (const edge of edges) {
      expect(ids.has(edge.from)).toBe(true);
      expect(ids.has(edge.to)).toBe(true);
    }
  });

  it("keeps entries that reach the engine", () => {
    const ids = applyFilters(model(), { ...DEFAULT_FILTERS, reachesEngine: true }).nodes.map((n) => n.id);
    expect(ids).toContain("calendar-pull");
    expect(ids).toContain("engine-input");
    expect(ids).not.toContain("music-export");
    expect(ids).not.toContain("planned-holidays");
  });

  it("problems only keeps the stale source and what it feeds", () => {
    const ids = applyFilters(model(withStaleCalendar()), { ...DEFAULT_FILTERS, problemsOnly: true }).nodes.map(
      (n) => n.id
    );
    expect(ids).toContain("calendar-pull");
    expect(ids).not.toContain("watch-export");
    expect(ids).not.toContain("music-export");
  });

  it("filters core from private by owner", () => {
    const data = response();
    data.entries = data.entries.map((e) => (e.id === "watch-export" ? { ...e, owner: "extra" } : e));
    const m = model(data);
    expect(m.owners).toEqual(["core", "extra"]);
    const priv = applyFilters(m, { ...DEFAULT_FILTERS, owner: "private" })
      .nodes.filter((n) => n.entry)
      .map((n) => n.id);
    expect(priv).toEqual(["watch-export"]);
  });
});

describe("listRows", () => {
  it("puts problems first and gives each row a from, via, to, reaches strip", () => {
    const m = model(withStaleCalendar());
    const { nodes, edges } = applyFilters(m, DEFAULT_FILTERS);
    const rows = listRows(m, nodes, edges);
    expect(rows[0]?.id).toBe("calendar-pull");
    expect(rows.at(-1)?.planned).toBe(true);
    const music = rows.find((row) => row.id === "music-export")!;
    expect(music.chips.map((chip) => chip.kind)).toEqual(["from", "via", "to", "reaches"]);
    expect(music.chips[0]?.text).toBe("Files you import");
    expect(music.chips[1]?.text).toBe("Activity ingest");
    expect(music.chips.at(-1)?.text).toBe("gives nothing yet");
  });
});

describe("triggerText", () => {
  it("reads each trigger", () => {
    expect(triggerText({ kind: "loop", loop: "x" })).toBe("runs in the x loop");
    expect(triggerText({ kind: "on-request", by: "owner" })).toBe("runs when you ask");
    expect(triggerText({ kind: "none" })).toBe("nothing starts it");
  });
});

describe("what the data gives", () => {
  const labels = (m: FlowModel) => m.nodes.filter((n) => n.kind === "surface");

  it("takes a surface's detail from the gives lines of the readers pointing at it", () => {
    const m = model();
    expect(m.byId.get("surface:page/review")).toMatchObject({ label: "Review", detail: "watch time by day and hour" });
    expect(m.byId.get("surface:engine")).toMatchObject({ label: "Planning engine", detail: "the plan" });
  });

  it("joins the gives of several readers and falls back to a plain kind label, never the id", () => {
    const data = response();
    data.entries = [
      ...data.entries,
      {
        ...data.entries.find((e) => e.id === "today-view")!,
        id: "today-two",
        name: "Today two",
        gives: "tasks by hour",
        to: ["surface:page/today"]
      },
      {
        ...data.entries.find((e) => e.id === "today-view")!,
        id: "vendor-out",
        name: "Outbound thing",
        gives: undefined as never,
        to: ["surface:external/some_vendor_service"]
      }
    ];
    data.edges = [
      ...data.edges,
      { from: "today-two", to: "surface:page/today", kind: "writes" },
      { from: "vendor-out", to: "surface:external/some_vendor_service", kind: "writes" }
    ];
    const m = model(data);
    expect(m.byId.get("surface:page/today")?.detail).toBe("plan and schedule; tasks by hour");
    const external = m.byId.get("surface:external/some_vendor_service")!;
    expect(external.label).toBe("Outbound publish");
    expect(external.detail).toBe("Outbound thing");
    for (const node of labels(m)) expect(node.label).not.toMatch(/[/_]/);
  });

  it("lists, for an entry, the surfaces it reaches with what each gives", () => {
    const m = model();
    const steps = reachSteps(m, "calendar-pull");
    expect(steps).toContainEqual({ label: "Planning engine", gives: "the plan" });
    expect(steps).toContainEqual({ label: "Today", gives: "plan and schedule" });
    expect(reachSteps(m, "music-export")).toEqual([]);
  });

  it("never shows an id in any surface label of the real core registry", () => {
    const registry = dataFlowRegistry();
    const view = buildDataFlowView(registryTables(registry), registry);
    const m = buildFlowModel(
      { ...view, generatedAt: NOW.toISOString(), health: { unavailable: true, reason: "x", next: "y" } },
      { now: NOW }
    );
    const surfaces = labels(m);
    expect(surfaces.length).toBeGreaterThan(8);
    for (const node of surfaces) {
      expect(node.label).not.toMatch(/[/_]/);
      expect(node.detail).not.toMatch(/_/);
    }
  });
});

describe("filters for what is collected but unused", () => {
  it("keeps the unused sources, including ones folded into a group, and unfolds them", () => {
    const data = response();
    const m = buildFlowModel(data, { now: NOW, unfold: true });
    const ids = applyFilters(m, { ...DEFAULT_FILTERS, unusedOnly: true })
      .nodes.filter((n) => n.entry)
      .map((n) => n.id);
    expect(ids.sort()).toEqual(["music-export", "phone-shortcuts"]);
  });
});
