/**
 * The arithmetic behind the day timeline: minutes to pixels, clipping to the day, packing
 * overlapping blocks side by side, and keeping inflated short blocks from covering each other.
 * Pure and unit-tested so the component can be a thin renderer.
 */

export interface TimeSpan {
  startsAt: Date;
  endsAt: Date;
}

export interface DayWindow {
  startsAt: Date;
  endsAt: Date;
}

/** Real minutes from the start of the day to `at`; negative before the day, beyond its length after. */
export function minuteOffset(at: Date, bounds: DayWindow): number {
  return (at.getTime() - bounds.startsAt.getTime()) / 60_000;
}

export function dayLengthMinutes(bounds: DayWindow): number {
  return minuteOffset(bounds.endsAt, bounds);
}

export function toPixels(minutes: number, pixelsPerHour: number): number {
  return (minutes / 60) * pixelsPerHour;
}

/**
 * The part of a span that falls inside the day, half-open, and which ends were cut. A span that
 * touches the day only at a boundary — ending exactly at midnight, say — is not on the day at all.
 */
export function clip(
  span: TimeSpan,
  bounds: DayWindow
): { startsAt: Date; endsAt: Date; clippedStart: boolean; clippedEnd: boolean } | null {
  if (span.startsAt >= bounds.endsAt || span.endsAt <= bounds.startsAt) return null;
  const clippedStart = span.startsAt < bounds.startsAt;
  const clippedEnd = span.endsAt > bounds.endsAt;
  return {
    startsAt: clippedStart ? bounds.startsAt : span.startsAt,
    endsAt: clippedEnd ? bounds.endsAt : span.endsAt,
    clippedStart,
    clippedEnd
  };
}

export interface BlockGeometry {
  top: number;
  height: number;
}

/**
 * Where a span sits on the day's canvas. A short span still gets `minimumHeight` so a five-minute
 * step remains a legible, tappable block; the height, not the top, absorbs the difference.
 */
export function blockGeometry(
  span: TimeSpan,
  bounds: DayWindow,
  pixelsPerHour: number,
  minimumHeight = 0
): BlockGeometry {
  const top = toPixels(minuteOffset(span.startsAt, bounds), pixelsPerHour);
  const bottom = toPixels(minuteOffset(span.endsAt, bounds), pixelsPerHour);
  return { top, height: Math.max(minimumHeight, bottom - top) };
}

export interface ColumnPlacement {
  /** Zero-based column within the overlap cluster. */
  column: number;
  /** How many columns the cluster needs; the block's width is `1 / columns`. */
  columns: number;
}

/** What a block falls back to when the packing has nothing to say about it: the whole width. */
export const NO_COLUMN: ColumnPlacement = { column: 0, columns: 1 };

/**
 * Sweep-line packing. Blocks are taken in start order; each goes in the lowest column whose last
 * block has already ended (half-open, so a block starting exactly when another ends shares its
 * column). Blocks that transitively overlap form one cluster and share a column count, so two
 * simultaneous events split the width in half while a lone event keeps all of it.
 */
export function assignColumns<T extends { id: string } & TimeSpan>(items: T[]): Map<string, ColumnPlacement> {
  const placements = new Map<string, ColumnPlacement>();
  const ordered = [...items].sort(
    (a, b) => a.startsAt.getTime() - b.startsAt.getTime() || b.endsAt.getTime() - a.endsAt.getTime()
  );
  let cluster: T[] = [];
  let columnEnds: number[] = [];
  let clusterEnd = -Infinity;
  const closeCluster = () => {
    const columns = Math.max(1, columnEnds.length);
    for (const member of cluster) placements.get(member.id)!.columns = columns;
    cluster = [];
    columnEnds = [];
    clusterEnd = -Infinity;
  };
  for (const item of ordered) {
    const start = item.startsAt.getTime();
    const end = Math.max(item.endsAt.getTime(), start);
    if (cluster.length && start >= clusterEnd) closeCluster();
    let column = columnEnds.findIndex((columnEnd) => columnEnd <= start);
    if (column === -1) {
      column = columnEnds.length;
      columnEnds.push(end);
    } else {
      columnEnds[column] = end;
    }
    placements.set(item.id, { column, columns: 1 });
    cluster.push(item);
    clusterEnd = Math.max(clusterEnd, end);
  }
  if (cluster.length) closeCluster();
  return placements;
}

export interface CascadeBlock extends BlockGeometry, ColumnPlacement {
  id: string;
  /**
   * Happens at a time the reader relies on (a commitment, a fixed routine, sleep, a recorded
   * session), so only another pinned block may push it. Unpinned blocks are the engine's projection
   * and give way around it instead.
   */
  pinned?: boolean;
  /** For a pinned block, the top of what it claims above itself: the start of its journey bar. */
  claimsFrom?: number;
}

export interface CascadedGeometry extends BlockGeometry {
  /** Pixels below its true time the block had to move; 0 when it sits where the clock puts it. */
  pushedBy: number;
}

export interface CascadeResult {
  placements: Map<string, CascadedGeometry>;
  /** The lowest adjusted bottom. The canvas must reach it or a pushed block is drawn off the day. */
  bottom: number;
  /** Blocks drawn narrower than their time columns, to share a pinned block's width with what meets it. */
  columns: Map<string, ColumnPlacement>;
}

/**
 * Push-down in pixel space, run after the minimum-height inflation.
 *
 * `assignColumns` resolves overlap in *time*; a minimum height creates overlap in *pixels* that no
 * amount of column packing sees — six back-to-back five-minute steps are 30 real minutes but 108
 * drawn pixels, so each one covers the next. Here a block that would start inside the inflated
 * bottom of an earlier one starts at that bottom instead, and the displacement cascades through the
 * rest of the run. Order and height are preserved: the run stays legible and stays in sequence, and
 * only its lower blocks read late.
 *
 * Pinned blocks are the exception: what the reader has to be somewhere for stays on its clock time.
 * They are placed first and pushed only by each other. The projected blocks then cascade among
 * themselves and flow past them: one that runs into a pinned block (or its journey bar) gives up as
 * much as a quarter of its height to end where that starts, and one that still does not fit is drawn
 * beside it, the pinned block taking the left half of its width and the projected run the right half,
 * the way a calendar draws two things at once. Without this a few inflated five-minute tasks before a
 * class drew the class, and everything fixed after it, an hour late.
 *
 * Collision is judged by the drawn rectangle, not by the column index, because a full-width block
 * outside a cluster shares pixels with every column of the cluster above it. Blocks are taken in
 * top order, so each one only ever has to clear those already placed.
 */
export function cascadeBlocks(blocks: CascadeBlock[]): CascadeResult {
  const ordered = blocks
    .map((block, index) => ({ block, index }))
    .sort((a, b) => a.block.top - b.block.top || a.index - b.index)
    .map(({ block }) => block);
  const placements = new Map<string, CascadedGeometry>();
  const columns = new Map<string, ColumnPlacement>();
  const span = (placement: ColumnPlacement) => {
    const count = Math.max(1, placement.columns);
    return { left: placement.column / count, right: (placement.column + 1) / count };
  };
  // Half-open horizontally: neighbouring columns touch at an edge and are not in each other's way.
  const shareColumns = (a: { left: number; right: number }, b: { left: number; right: number }) =>
    a.left < b.right && a.right > b.left;
  /** Where a block may start below those already placed in its columns. */
  const clear = (placed: Array<{ left: number; right: number; bottom: number }>, at: ColumnPlacement, top: number) =>
    placed.reduce(
      (lowest, earlier) => (shareColumns(earlier, span(at)) ? Math.max(lowest, earlier.bottom) : lowest),
      top
    );
  let bottom = 0;
  const place = (block: CascadeBlock, top: number, height: number) => {
    placements.set(block.id, { top, height, pushedBy: top - block.top });
    bottom = Math.max(bottom, top + height);
  };

  const pinned: Array<{ block: CascadeBlock; left: number; right: number; top: number; bottom: number }> = [];
  for (const block of ordered.filter((candidate) => candidate.pinned)) {
    const top = clear(pinned, block, block.top);
    place(block, top, block.height);
    pinned.push({ block, ...span(block), top: Math.min(top, block.claimsFrom ?? top), bottom: top + block.height });
  }

  const flowing: Array<{ left: number; right: number; bottom: number }> = [];
  // Per pinned block, the projected blocks drawn in its right half, which cascade among themselves.
  const beside = new Map<string, Array<{ left: number; right: number; bottom: number }>>();
  for (const block of ordered.filter((candidate) => !candidate.pinned)) {
    const floor = Math.min(block.height, Math.ceil(block.height * 0.75));
    const top = clear(flowing, block, block.top);
    let height = block.height;
    const meets = pinned.find(
      (obstacle) => shareColumns(obstacle, span(block)) && obstacle.top < top + height && obstacle.bottom > top
    );
    if (meets && meets.top - top >= floor) height = meets.top - top;
    else if (meets) {
      const count = Math.max(1, meets.block.columns);
      const left = { column: meets.block.column * 2, columns: count * 2 };
      const right = { column: meets.block.column * 2 + 1, columns: count * 2 };
      columns.set(meets.block.id, left);
      columns.set(block.id, right);
      const slot = beside.get(meets.block.id) ?? [];
      beside.set(meets.block.id, slot);
      const sideTop = clear(slot, right, top);
      // A run drawn beside one pinned block can reach the next (bedtime, then sleep): that one gives up
      // its right half too.
      for (const obstacle of pinned)
        if (
          obstacle !== meets &&
          shareColumns(obstacle, span(block)) &&
          obstacle.top < sideTop + height &&
          obstacle.bottom > sideTop
        )
          columns.set(obstacle.block.id, {
            column: obstacle.block.column * 2,
            columns: Math.max(1, obstacle.block.columns) * 2
          });
      place(block, sideTop, height);
      slot.push({ ...span(right), bottom: sideTop + height });
      flowing.push({ ...span(block), bottom: sideTop + height });
      continue;
    }
    place(block, top, height);
    flowing.push({ ...span(block), bottom: top + height });
  }
  return { placements, bottom, columns };
}

/**
 * The smallest block drawn, so a five-minute step is still readable and tappable. Sized to hold one
 * whole line of the title plus the block's padding: below that the block is a coloured sliver with a
 * clipped word in it, which is worse than no word at all.
 */
export const MIN_BLOCK_PX = 26;

export interface Lane {
  columns: Map<string, ColumnPlacement>;
  cascade: CascadeResult;
}

/** What a lane's commitments ask of the layout; see `laneLayout`. */
export interface LaneAnchors {
  reachFrom?: ReadonlyMap<string, Date>;
  pinned?: ReadonlySet<string>;
}

/**
 * One stacking list's geometry: time-based columns first, then the pixel push-down that keeps a run
 * of inflated short blocks from covering itself. Lists that overlay each other are laid out one at a
 * time by design — a reservation is drawn beside the day, not squeezed into its sequence — and a
 * canvas with narrower days than the day timeline's can ask for a smaller `minBlockPx`.
 *
 * `anchors.reachFrom` names blocks that claim time above their own start: a commitment drawing its
 * journey as a bar from the leave-by time (`timeline-track.tsx`). The columns are shared out over that
 * longer span, so whatever happens during the journey takes a lane beside the bar instead of sitting
 * on it, while the block itself is still drawn from its own start. `anchors.pinned` names the blocks
 * the cascade may not push for a projected one (`cascadeBlocks`).
 */
export function laneLayout<T extends { id: string } & TimeSpan>(
  items: T[],
  bounds: DayWindow,
  pixelsPerHour: number,
  minBlockPx = MIN_BLOCK_PX,
  { reachFrom = new Map(), pinned = new Set() }: LaneAnchors = {}
): Lane {
  const columns = assignColumns(
    items.map((item) => {
      const reach = reachFrom.get(item.id);
      return reach && reach < item.startsAt ? { id: item.id, startsAt: reach, endsAt: item.endsAt } : item;
    })
  );
  const cascade = cascadeBlocks(
    items.map((item) => {
      const reach = reachFrom.get(item.id);
      return {
        id: item.id,
        ...blockGeometry(item, bounds, pixelsPerHour, minBlockPx),
        ...(columns.get(item.id) ?? NO_COLUMN),
        pinned: pinned.has(item.id),
        ...(reach ? { claimsFrom: toPixels(minuteOffset(reach, bounds), pixelsPerHour) } : {})
      };
    })
  );
  return { columns: new Map([...columns, ...cascade.columns]), cascade };
}

/**
 * The start of the first stretch of at least `minimumMinutes` after `from` that no block occupies,
 * or null when the rest of the day is spoken for. Where the untimed "next up" chips sit: in a gap,
 * so they never cover something that does have a time.
 */
export function firstGapAfter(blocks: TimeSpan[], from: Date, bounds: DayWindow, minimumMinutes: number): Date | null {
  const occupied = blocks
    .filter((block) => block.endsAt > from && block.startsAt < bounds.endsAt)
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  let cursor = Math.max(from.getTime(), bounds.startsAt.getTime());
  for (const block of occupied) {
    if (block.startsAt.getTime() - cursor >= minimumMinutes * 60_000) return new Date(cursor);
    cursor = Math.max(cursor, block.endsAt.getTime());
  }
  return bounds.endsAt.getTime() - cursor >= minimumMinutes * 60_000 ? new Date(cursor) : null;
}

export interface AllocationLike extends TimeSpan {
  actionId: string;
  projectId: string;
  minutes: number;
}

export interface MergedAllocation extends TimeSpan {
  id: string;
  actionId: string;
  projectId: string;
  minutes: number;
}

/**
 * Engine allocation blocks are one per fifteen-minute slot. Runs of the same action in touching
 * slots merge into one wall-clock interval, which is how a two-hour reservation reads as one shape
 * rather than eight slivers. Slots that merely sit near each other stay separate.
 */
export function mergeAdjacentBlocks(allocations: AllocationLike[]): MergedAllocation[] {
  const ordered = [...allocations].sort(
    (a, b) => a.startsAt.getTime() - b.startsAt.getTime() || a.actionId.localeCompare(b.actionId)
  );
  const merged: MergedAllocation[] = [];
  const open = new Map<string, MergedAllocation>();
  for (const block of ordered) {
    const current = open.get(block.actionId);
    if (current && current.endsAt.getTime() === block.startsAt.getTime()) {
      current.endsAt = block.endsAt;
      current.minutes += block.minutes;
      continue;
    }
    const next: MergedAllocation = {
      id: `${block.actionId}:${block.startsAt.toISOString()}`,
      actionId: block.actionId,
      projectId: block.projectId,
      startsAt: block.startsAt,
      endsAt: block.endsAt,
      minutes: block.minutes
    };
    merged.push(next);
    open.set(block.actionId, next);
  }
  return merged.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime() || a.actionId.localeCompare(b.actionId));
}

export interface SessionBlockLike extends TimeSpan {
  /** What the block advances; null for anything the plan does not attribute to a target. */
  targetId: string | null;
}

export interface MergedSessions<T extends SessionBlockLike> extends TimeSpan {
  /** The first block of the run — what the drawn block is titled and reasoned by. */
  first: T;
  /** Every block the run stands for, in start order. */
  blocks: T[];
}

/**
 * The sibling of `mergeAdjacentBlocks` for the engine's projected day. The maximum session length
 * splits a long action into consecutive sessions — 90, 90, 40 — which is faithful to the session
 * policy and unreadable as three blocks in a row. Touching blocks for the same target become one
 * drawn shape that says how many sessions it holds; blocks separated by anything at all, and blocks
 * with no target, stay apart.
 */
export function mergeAdjacentSessions<T extends SessionBlockLike>(blocks: T[]): Array<MergedSessions<T>> {
  const ordered = [...blocks].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  const merged: Array<MergedSessions<T>> = [];
  for (const block of ordered) {
    const current = merged.at(-1);
    if (
      current &&
      block.targetId !== null &&
      current.first.targetId === block.targetId &&
      current.endsAt.getTime() === block.startsAt.getTime()
    ) {
      current.endsAt = block.endsAt;
      current.blocks.push(block);
      continue;
    }
    merged.push({ first: block, blocks: [block], startsAt: block.startsAt, endsAt: block.endsAt });
  }
  return merged;
}
