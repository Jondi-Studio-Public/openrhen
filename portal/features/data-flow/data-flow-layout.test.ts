import { describe, expect, it } from "vitest";
import { buildDataFlowView, dataFlowRegistry, registryTables } from "@openrhen/contracts/data-flow";
import { layoutFor } from "./components/data-flow-graph";
import { buildFlowModel } from "./data-flow-model";
import {
  NODE_HEIGHT,
  NODE_WIDTH,
  countCrossings,
  edgePath,
  layoutFlow,
  type LayoutEdge,
  type LayoutNode
} from "./data-flow-layout";

/** A small seeded generator, so the fixture is the same on every machine. */
function lcg(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/**
 * About 200 nodes in five columns: each node links to one or two nodes near the same relative position in the next
 * column (no column-skipping links; the real registry is covered by its own test below), plus a planned lane.
 */
function fixture(seed = 7) {
  const random = lcg(seed);
  const sizes = [18, 70, 40, 40, 22];
  const nodes: LayoutNode[] = [];
  const columns: string[][] = sizes.map(() => []);
  sizes.forEach((size, column) => {
    for (let index = 0; index < size; index += 1) {
      // Ids in an order unrelated to the structure, so the initial order is a poor one.
      const id = `n${column}-${String(Math.floor(random() * 1e6)).padStart(6, "0")}-${index}`;
      nodes.push({ id, column });
      columns[column]!.push(id);
    }
  });
  for (let index = 0; index < 10; index += 1) nodes.push({ id: `planned-${index}`, column: -1 });
  const edges: LayoutEdge[] = [];
  const seen = new Set<string>();
  const add = (from: string, to: string) => {
    if (seen.has(`${from}>${to}`)) return;
    seen.add(`${from}>${to}`);
    edges.push({ from, to });
  };
  // Every node has a hidden position along the column; it links to nodes near the same position in the next one.
  const position = new Map<string, number>();
  for (const column of columns)
    column.forEach((id, index) => position.set(id, (index + random() * 0.8) / column.length));
  for (let column = 0; column < sizes.length - 1; column += 1) {
    const next = columns[column + 1]!;
    for (const id of columns[column]!) {
      const count = 1 + Math.floor(random() * 2);
      for (let k = 0; k < count; k += 1) {
        const wanted = Math.min(0.999, Math.max(0, position.get(id)! + (random() - 0.5) * 0.06));
        add(id, next[Math.floor(wanted * next.length)]!);
      }
    }
  }
  return { nodes, edges };
}

describe("layoutFlow", () => {
  it("gives the same output for the same input, in any input order", () => {
    const { nodes, edges } = fixture();
    const first = layoutFlow(nodes, edges, 5);
    const second = layoutFlow([...nodes].reverse(), [...edges].reverse(), 5);
    expect(second.placed).toEqual(first.placed);
    expect(second.crossings).toBe(first.crossings);
    expect(layoutFlow(nodes, edges, 5)).toEqual(first);
  });

  it("puts each node in its own column's x and never overlaps two nodes", () => {
    const { nodes, edges } = fixture();
    const layout = layoutFlow(nodes, edges, 5);
    const boxes = layout.placed;
    const keys = new Set(boxes.map((box) => `${box.x},${box.y}`));
    expect(keys.size).toBe(boxes.length);
    for (const box of boxes) {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + NODE_WIDTH).toBeLessThanOrEqual(layout.width);
      expect(box.y + NODE_HEIGHT).toBeLessThanOrEqual(layout.height);
    }
  });

  // This pins the width constant, not the rendered fit: between 720 px and about 1,100 px plus the sidebar the map scrolls
  // inside its own frame (the page does not). The browser check asserts the real fit at 1440.
  it("fits all five columns in a 1440 px window beside the app sidebar", () => {
    // The sidebar and page gutters take about 300 px of 1440; the map must fit what is left with no scroll.
    const layout = layoutFlow([{ id: "a", column: 4 }], [], 5);
    expect(layout.width).toBeLessThanOrEqual(1440 - 300);
    const last = layout.byId.get("a")!;
    expect(last.x + NODE_WIDTH).toBeLessThanOrEqual(layout.width);
  });

  it("lays planned nodes in a lane under the graph, with no edges", () => {
    const { nodes, edges } = fixture();
    const layout = layoutFlow(nodes, edges, 5);
    expect(layout.laneTop).not.toBeNull();
    const planned = layout.placed.filter((box) => box.column === -1);
    expect(planned).toHaveLength(10);
    for (const box of planned) expect(box.y).toBeGreaterThan(layout.laneTop!);
    for (const box of layout.placed.filter((b) => b.column >= 0)) expect(box.y).toBeLessThan(layout.laneTop!);
  });

  it("keeps a graph of about 200 nodes within the crossing bound", () => {
    const { nodes, edges } = fixture();
    expect(nodes.filter((n) => n.column >= 0)).toHaveLength(190);
    const layout = layoutFlow(nodes, edges, 5);
    expect(layout.crossings).toBeLessThanOrEqual(BOUND);
  });

  it("beats the plain id order by a wide margin", () => {
    const { nodes, edges } = fixture();
    const layout = layoutFlow(nodes, edges, 5);
    const initial = layoutFlow(nodes, [], 5);
    const plain = countCrossings(initial.byId, edges);
    expect(layout.crossings).toBeLessThan(plain / 4);
  });

  it("handles no nodes and nodes without edges", () => {
    expect(layoutFlow([], [], 5).placed).toEqual([]);
    const single = layoutFlow([{ id: "a", column: 2 }], [], 5);
    expect(single.placed).toHaveLength(1);
    expect(single.crossings).toBe(0);
  });

  it("copes with cycles, backward edges, self loops, a column past the end and no columns", () => {
    const nodes = [
      { id: "a", column: 0 },
      { id: "b", column: 1 },
      { id: "c", column: 9 }
    ];
    const edges = [
      { from: "a", to: "b" },
      { from: "b", to: "a" },
      { from: "c", to: "a" },
      { from: "b", to: "b" }
    ];
    const layout = layoutFlow(nodes, edges, 2);
    for (const box of layout.placed) {
      expect(Number.isFinite(box.x) && Number.isFinite(box.y)).toBe(true);
      expect(box.x + NODE_WIDTH).toBeLessThanOrEqual(layout.width);
    }
    expect(layout.byId.get("c")?.column).toBe(1);
    const none = layoutFlow(nodes, edges, 0);
    expect(none.width).toBeGreaterThan(0);
    expect(none.placed.every((box) => Number.isFinite(box.x))).toBe(true);
  });

  it("ignores an edge to a node that is not there", () => {
    const layout = layoutFlow([{ id: "a", column: 0 }], [{ from: "a", to: "ghost" }], 5);
    expect(layout.crossings).toBe(0);
  });
});

describe("the real core registry", () => {
  it("lays out within the recorded crossing bound", () => {
    const registry = dataFlowRegistry();
    const view = buildDataFlowView(registryTables(registry), registry);
    const model = buildFlowModel(
      { ...view, generatedAt: new Date(0).toISOString(), health: { unavailable: true, reason: "x", next: "y" } },
      { now: new Date(0) }
    );
    const layout = layoutFor(model.nodes, model.edges);
    expect(model.nodes.length).toBeGreaterThan(120);
    // Measured at REAL_BOUND_MEASURED on the first green run, with 10% slack; a worse layout fails. A registry addition can
    // move it: re-measure and update the number, do not widen the slack. Health is unavailable here, so nothing is folded.
    expect(layout.crossings).toBeLessThanOrEqual(Math.ceil(REAL_BOUND_MEASURED * 1.1));
  });
});

describe("edgePath", () => {
  it("joins the facing sides of two nodes with a cubic", () => {
    const layout = layoutFlow(
      [
        { id: "a", column: 0 },
        { id: "b", column: 1 }
      ],
      [{ from: "a", to: "b" }],
      5
    );
    const path = edgePath(layout.byId.get("a")!, layout.byId.get("b")!);
    expect(path).toMatch(/^M \d+ \d+ C /);
    expect(path).toContain(`M ${layout.byId.get("a")!.x + NODE_WIDTH} `);
  });
});

describe("countCrossings", () => {
  it("counts a crossing pair and not a parallel one", () => {
    const layout = layoutFlow(
      [
        { id: "a", column: 0 },
        { id: "b", column: 0 },
        { id: "c", column: 1 },
        { id: "d", column: 1 }
      ],
      [],
      5
    );
    const crossed = countCrossings(layout.byId, [
      { from: "a", to: "d" },
      { from: "b", to: "c" }
    ]);
    const parallel = countCrossings(layout.byId, [
      { from: "a", to: "c" },
      { from: "b", to: "d" }
    ]);
    expect([crossed, parallel]).toEqual([1, 0]);
  });
});

/** Measured 106 for this seed with the repeated sweeps and swap pass (362 with two sweeps), plus 10% slack; the unsorted order has about 3,900. */
const BOUND = 117;

/** Crossings of the real core registry, health unavailable so nothing is folded (153 nodes, 195 edges); 583 before the repeated sweeps and swap pass. */
const REAL_BOUND_MEASURED = 374;
