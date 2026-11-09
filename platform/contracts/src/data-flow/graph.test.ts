import { describe, expect, it } from "vitest";
import { buildFlowGraph, datasetsOverlap } from "./graph.js";
import { parseDatasetRef, type FlowEntry } from "./types.js";

const none = { kind: "none", reason: "fixture" } as const;

function entry(partial: Partial<FlowEntry> & Pick<FlowEntry, "id" | "role">): FlowEntry {
  return {
    name: partial.id,
    category: "files",
    method: "push",
    trigger: { kind: "none" },
    code: {},
    from: [],
    to: [],
    health: none,
    ...partial
  };
}

const ingest = entry({
  id: "ingest",
  role: "pipe",
  to: ["pg:activity_events", "pg:activity_imports"]
});
const source = (id: string, extra: Partial<FlowEntry> = {}) =>
  entry({ id, role: "source", activitySource: id, via: ["ingest"], ...extra });

function graph(entries: FlowEntry[], tables = ["activity_events", "activity_imports", "notes"]) {
  return buildFlowGraph(tables, { entries, datasets: [], composedBuild: false });
}

describe("dataset names", () => {
  it("parses partitions and refuses malformed names", () => {
    expect(parseDatasetRef("pg:activity_events[source=a,kind=b]")).toEqual({
      scheme: "pg",
      name: "activity_events",
      filters: { source: "a", kind: "b" }
    });
    expect(parseDatasetRef("surface:page/review")?.name).toBe("page/review");
    expect(parseDatasetRef("pg:x[source]")).toBeNull();
    expect(parseDatasetRef("nope:x")).toBeNull();
  });

  it("overlaps a whole table with any partition, and a partition only with its own source", () => {
    const p = (ref: string) => parseDatasetRef(ref)!;
    expect(datasetsOverlap(p("pg:t"), p("pg:t[source=a]"))).toBe(true);
    expect(datasetsOverlap(p("pg:t[source=*]"), p("pg:t[source=a]"))).toBe(true);
    expect(datasetsOverlap(p("pg:t[source=a]"), p("pg:t[source=b]"))).toBe(false);
    expect(datasetsOverlap(p("pg:t[source=a,kind=k]"), p("pg:t[source=a]"))).toBe(true);
    expect(datasetsOverlap(p("pg:t[source=a,kind=k]"), p("pg:t[source=a,kind=j]"))).toBe(false);
    expect(datasetsOverlap(p("pg:t"), p("pg:u"))).toBe(false);
  });
});

describe("effective writes", () => {
  it("gives a source behind a pipe the partition of its activity source", () => {
    const g = graph([ingest, source("timeline")]);
    expect(g.writes("timeline")).toContain("pg:activity_events[source=timeline]");
  });
});

describe("reach", () => {
  const panel = entry({
    id: "panel",
    role: "reader",
    from: ["pg:activity_events[source=timeline]"],
    to: ["surface:page/review"],
    gives: "time by hour"
  });

  it("walks from a source's partition through a reader to a surface and reports what it gives", () => {
    const g = graph([ingest, source("timeline"), source("other"), panel]);
    expect(g.reach("timeline")).toEqual([
      { surface: "surface:page/review", readers: ["panel"], gives: ["time by hour"] }
    ]);
    expect(g.reach("other")).toEqual([]);
    expect(g.reachLabel("timeline")).toBe("Review: time by hour");
    expect(g.reachLabel("other")).toBe("collected, gives nothing yet");
  });

  it("does not walk through pass-through readers or count pass-through surfaces", () => {
    const rest = entry({
      id: "rest",
      role: "reader",
      passThrough: true,
      from: ["pg:activity_events"],
      to: ["surface:page/x"]
    });
    const backup = entry({ id: "backup", role: "sink", from: ["pg:activity_events"], to: ["surface:backup"] });
    const g = graph([ingest, source("timeline"), rest, backup]);
    expect(g.reach("timeline")).toEqual([]);
  });

  it("follows a reader that writes a table another reader reads, and in-process feeds", () => {
    const derive = entry({
      id: "derive",
      role: "reader",
      from: ["pg:activity_events[source=*]"],
      to: ["pg:notes"],
      value: { note: "every source on purpose" }
    });
    const page = entry({
      id: "notes-page",
      role: "reader",
      from: ["pg:notes"],
      to: ["surface:page/notes"],
      gives: "notes"
    });
    const g = graph([ingest, source("timeline"), derive, page]);
    expect(g.reach("timeline").map((r) => [r.surface, r.readers])).toEqual([
      ["surface:page/notes", ["derive", "notes-page"]]
    ]);
    const fed = entry({ id: "fed", role: "reader", to: ["surface:tool/rhen_x"], gives: "x" });
    const feeder = entry({
      id: "feeder",
      role: "reader",
      from: ["pg:activity_events[source=timeline]"],
      feeds: ["fed"]
    });
    expect(
      graph([ingest, source("timeline"), feeder, fed])
        .reach("timeline")
        .map((r) => r.surface)
    ).toEqual(["surface:tool/rhen_x"]);
  });

  it("ignores planned entries", () => {
    const planned = entry({ ...panel, id: "planned-panel", planned: { landsAs: { route: "GET /api/x" } } });
    expect(graph([ingest, source("timeline"), planned]).reach("timeline")).toEqual([]);
  });
});

describe("unused", () => {
  it("lists sources that reach nothing, those nothing sends, unused kinds and unused tables", () => {
    const reader = entry({
      id: "reader",
      role: "reader",
      from: ["pg:activity_events[source=a,kind=x]"],
      to: ["surface:page/p"],
      gives: "g"
    });
    const g = buildFlowGraph(
      ["activity_events", "activity_imports", "notes", "dead_table"],
      {
        entries: [
          ingest,
          source("a"),
          source("b"),
          source("c", { noProducer: true }),
          reader,
          entry({ id: "writer", role: "source", to: ["pg:notes"] }),
          entry({ id: "dead-writer", role: "source", to: ["pg:dead_table"] })
        ],
        datasets: [{ ref: "pg:dead_table", dead: "nothing reads it" }],
        composedBuild: false
      },
      { kindsOf: (s) => (s === "a" ? ["x", "y"] : ["z"]) }
    );
    const unused = g.unused();
    expect(unused.entries.map((e) => [e.id, e.bucket])).toEqual([
      ["b", "unused"],
      ["c", "nothing-sends"],
      ["dead-writer", "unused"],
      ["writer", "unused"]
    ]);
    expect(unused.kinds).toEqual([{ source: "a", kinds: ["y"] }]);
    expect(unused.datasets).toEqual(["pg:activity_imports", "pg:notes"]);
    expect(unused.dead).toEqual(["pg:dead_table"]);
  });
});

describe("devices and engine use", () => {
  it("rolls entries up by device", () => {
    const g = graph([
      entry({ id: "a", role: "source", device: "phone" }),
      entry({ id: "b", role: "source", device: "phone" }),
      entry({ id: "c", role: "source", device: "pc" })
    ]);
    expect(g.devices()).toEqual([
      { id: "pc", ref: "ext:device/pc", entries: ["c"] },
      { id: "phone", ref: "ext:device/phone", entries: ["a", "b"] }
    ]);
  });

  it("separates what the engine reads, what it misses and what is blind by design", () => {
    const engine = entry({ id: "engine", role: "reader", from: ["pg:actions"], to: ["surface:engine"] });
    const g = buildFlowGraph(
      ["actions", "users", "activity_events"],
      {
        entries: [
          engine,
          entry({ id: "reads", role: "source", to: ["pg:actions"] }),
          entry({ id: "misses", role: "source", to: ["pg:users"] }),
          entry({ id: "blind", role: "source", to: ["pg:activity_events"] })
        ],
        datasets: [],
        composedBuild: false
      },
      { planInput: ["actions", "users"], blind: ["activity_events"] }
    );
    expect(g.engineUse("reads")).toEqual({ reads: true, blindInFact: [], blindByDesign: false });
    expect(g.engineUse("misses")).toEqual({ reads: false, blindInFact: ["users"], blindByDesign: false });
    expect(g.engineUse("blind")).toEqual({ reads: false, blindInFact: [], blindByDesign: true });
  });
});
