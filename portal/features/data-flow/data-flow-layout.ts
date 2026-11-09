/**
 * The /data page's layout: fixed columns, barycentre sweeps repeated while they help, an adjacent-swap pass and cubic edges, the same way the plan map lays out
 * its cards (`layoutMap` and `edgePath` in `plan-map/map-view-model.ts`). Pure, and the same input gives the same
 * output every run: ties break on the previous position and then the id, and nothing reads the clock or random numbers.
 */

export const NODE_WIDTH = 172;
export const NODE_HEIGHT = 34;
export const COLUMN_GAP = 48;
export const ROW_GAP = 4;
export const PAD = 16;
/** Room above the first row for the column titles. */
export const HEADER_HEIGHT = 30;
/** Room between the main graph and the planned lane. */
export const LANE_GAP = 24;
export const LANE_TITLE_HEIGHT = 26;

export interface LayoutNode {
  id: string;
  /** 0 and up; a negative column is the planned lane, laid out in a grid under the graph with no edges drawn. */
  column: number;
}

export interface LayoutEdge {
  from: string;
  to: string;
}

export interface PlacedNode {
  id: string;
  column: number;
  x: number;
  y: number;
}

export interface FlowLayout {
  width: number;
  height: number;
  columns: number;
  placed: PlacedNode[];
  byId: Map<string, PlacedNode>;
  /** Where the planned lane starts, or null when it is empty. */
  laneTop: number | null;
  crossings: number;
}

export function layoutFlow(
  rawNodes: readonly LayoutNode[],
  edges: readonly LayoutEdge[],
  columnCount: number
): FlowLayout {
  // Degenerate input is made safe rather than trusted: at least one column, and a node past the last one sits in it.
  const columns = Math.max(1, Math.floor(columnCount) || 1);
  const nodes = rawNodes.map((node) => (node.column >= columns ? { ...node, column: columns - 1 } : node));
  const main = nodes
    .filter((node) => node.column >= 0)
    .sort((a, b) => a.column - b.column || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const lane = nodes.filter((node) => node.column < 0).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const ids = new Set(main.map((node) => node.id));
  const drawn = edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to));

  const order: string[][] = Array.from({ length: columns }, () => []);
  for (const node of main) order[node.column]?.push(node.id);
  const columnOf = new Map(main.map((node) => [node.id, node.column] as const));

  const lower = new Map<string, string[]>();
  const upper = new Map<string, string[]>();
  for (const edge of drawn) {
    const a = columnOf.get(edge.from)!;
    const b = columnOf.get(edge.to)!;
    if (a === b) continue;
    const [left, right] = a < b ? [edge.from, edge.to] : [edge.to, edge.from];
    lower.set(right, [...(lower.get(right) ?? []), left]);
    upper.set(left, [...(upper.get(left) ?? []), right]);
  }

  const fractions = () => {
    const at = new Map<string, number>();
    for (const column of order)
      column.forEach((id, index) => at.set(id, column.length > 1 ? index / (column.length - 1) : 0.5));
    return at;
  };

  /** One sweep: re-sort a column by the mean position of its neighbours on the side already fixed. */
  const sweep = (column: number, neighbours: Map<string, string[]>) => {
    const at = fractions();
    const current = order[column]!;
    const previous = new Map(current.map((id, index) => [id, index] as const));
    const key = (id: string) => {
      const near = [...(neighbours.get(id) ?? [])].sort();
      if (near.length === 0) return at.get(id)!;
      return near.reduce((sum, other) => sum + at.get(other)!, 0) / near.length;
    };
    const keys = new Map(current.map((id) => [id, key(id)] as const));
    order[column] = [...current].sort(
      (a, b) => keys.get(a)! - keys.get(b)! || previous.get(a)! - previous.get(b)! || (a < b ? -1 : a > b ? 1 : 0)
    );
  };
  /** Crossings of the current order, on the same straight segments `countCrossings` uses. */
  const score = () => {
    const at = new Map<string, number>();
    order.forEach((column, c) => column.forEach((id, index) => at.set(id, c * 1e6 + index)));
    const probe = new Map<string, PlacedNode>();
    for (const [id, key] of at)
      probe.set(id, { id, column: Math.floor(key / 1e6), x: Math.floor(key / 1e6) * 1000, y: (key % 1e6) * 50 });
    return countCrossings(probe, drawn);
  };

  // Barycentre sweeps down and up, repeated while they help, then adjacent swaps; the best order seen wins. Every step is
  // deterministic, so the same input gives the same layout.
  let best = order.map((column) => [...column]);
  let bestScore = score();
  for (let round = 0; round < 4 && bestScore > 0; round += 1) {
    for (let column = 1; column < columns; column += 1) sweep(column, lower);
    for (let column = columns - 2; column >= 0; column -= 1) sweep(column, upper);
    const now = score();
    if (now < bestScore) {
      bestScore = now;
      best = order.map((column) => [...column]);
    }
  }
  for (let i = 0; i < order.length; i += 1) order[i] = [...best[i]!];
  // The swap pass rescans every edge per swap, so it is skipped for graphs far past the registry's size.
  const swapPasses = drawn.length <= 600 ? 3 : 0;
  for (let pass = 0; pass < swapPasses && bestScore > 0; pass += 1) {
    let improved = false;
    for (const column of order)
      for (let index = 0; index + 1 < column.length; index += 1) {
        [column[index], column[index + 1]] = [column[index + 1]!, column[index]!];
        const now = score();
        if (now < bestScore) {
          bestScore = now;
          improved = true;
        } else [column[index], column[index + 1]] = [column[index + 1]!, column[index]!];
      }
    if (!improved) break;
  }

  const rows = Math.max(1, ...order.map((column) => column.length));
  const step = NODE_WIDTH + COLUMN_GAP;
  const width = PAD * 2 + columns * NODE_WIDTH + (columns - 1) * COLUMN_GAP;
  const mainHeight = HEADER_HEIGHT + PAD + rows * NODE_HEIGHT + (rows - 1) * ROW_GAP;
  const placed: PlacedNode[] = [];
  order.forEach((column, c) =>
    column.forEach((id, index) =>
      placed.push({ id, column: c, x: PAD + c * step, y: HEADER_HEIGHT + PAD + index * (NODE_HEIGHT + ROW_GAP) })
    )
  );

  let height = mainHeight + PAD;
  let laneTop: number | null = null;
  if (lane.length > 0) {
    laneTop = mainHeight + LANE_GAP;
    lane.forEach((node, index) =>
      placed.push({
        id: node.id,
        column: -1,
        x: PAD + (index % columns) * step,
        y: laneTop! + LANE_TITLE_HEIGHT + Math.floor(index / columns) * (NODE_HEIGHT + ROW_GAP)
      })
    );
    height = laneTop + LANE_TITLE_HEIGHT + Math.ceil(lane.length / columns) * (NODE_HEIGHT + ROW_GAP) + PAD;
  }

  const byId = new Map(placed.map((node) => [node.id, node] as const));
  return { width, height, columns, placed, byId, laneTop, crossings: countCrossings(byId, drawn) };
}

/** Where an edge leaves and arrives: the facing sides of the two boxes, at mid height. */
function ends(from: PlacedNode, to: PlacedNode) {
  const fy = from.y + NODE_HEIGHT / 2;
  const ty = to.y + NODE_HEIGHT / 2;
  if (from.x === to.x) return { sx: from.x + NODE_WIDTH, sy: fy, tx: to.x + NODE_WIDTH, ty, same: true };
  const forward = to.x > from.x;
  return {
    sx: forward ? from.x + NODE_WIDTH : from.x,
    sy: fy,
    tx: forward ? to.x : to.x + NODE_WIDTH,
    ty,
    same: false
  };
}

/** A cubic SVG path between two placed nodes. */
export function edgePath(from: PlacedNode, to: PlacedNode): string {
  const { sx, sy, tx, ty, same } = ends(from, to);
  if (same) {
    const bulge = sx + 40;
    return `M ${sx} ${sy} C ${bulge} ${sy}, ${bulge} ${ty}, ${tx} ${ty}`;
  }
  const mid = (sx + tx) / 2;
  return `M ${sx} ${sy} C ${mid} ${sy}, ${mid} ${ty}, ${tx} ${ty}`;
}

type Segment = [number, number, number, number];

const orient = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) =>
  Math.sign((bx - ax) * (cy - ay) - (by - ay) * (cx - ax));

function cross(a: Segment, b: Segment): boolean {
  const o1 = orient(a[0], a[1], a[2], a[3], b[0], b[1]);
  const o2 = orient(a[0], a[1], a[2], a[3], b[2], b[3]);
  const o3 = orient(b[0], b[1], b[2], b[3], a[0], a[1]);
  const o4 = orient(b[0], b[1], b[2], b[3], a[2], a[3]);
  return o1 * o2 < 0 && o3 * o4 < 0;
}

/**
 * Edge crossings, counted on the straight segments between the same two points the curves join. Edges that share an end
 * do not count. This is the number the layout test bounds.
 */
export function countCrossings(byId: ReadonlyMap<string, PlacedNode>, edges: readonly LayoutEdge[]): number {
  const segments: { from: string; to: string; segment: Segment }[] = [];
  for (const edge of edges) {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from || !to) continue;
    const { sx, sy, tx, ty } = ends(from, to);
    segments.push({ from: edge.from, to: edge.to, segment: [sx, sy, tx, ty] });
  }
  let total = 0;
  for (let i = 0; i < segments.length; i += 1)
    for (let j = i + 1; j < segments.length; j += 1) {
      const a = segments[i]!;
      const b = segments[j]!;
      if (a.from === b.from || a.to === b.to || a.from === b.to || a.to === b.from) continue;
      if (cross(a.segment, b.segment)) total += 1;
    }
  return total;
}
