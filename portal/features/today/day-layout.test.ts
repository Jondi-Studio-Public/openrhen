import { describe, expect, it } from "vitest";
import {
  assignColumns,
  blockGeometry,
  cascadeBlocks,
  clip,
  dayLengthMinutes,
  firstGapAfter,
  laneLayout,
  MIN_BLOCK_PX,
  mergeAdjacentBlocks,
  minuteOffset,
  toPixels
} from "./day-layout";

const at = (value: string) => new Date(value);
const bounds = { startsAt: at("2026-08-18T14:00:00.000Z"), endsAt: at("2026-08-19T14:00:00.000Z") };
const span = (id: string, start: string, end: string) => ({ id, startsAt: at(start), endsAt: at(end) });

describe("Day layout arithmetic", () => {
  it("measures offsets in real minutes from the start of the day", () => {
    expect(minuteOffset(at("2026-08-18T14:00:00.000Z"), bounds)).toBe(0);
    expect(minuteOffset(at("2026-08-18T23:15:00.000Z"), bounds)).toBe(555);
    expect(minuteOffset(at("2026-08-18T13:30:00.000Z"), bounds)).toBe(-30);
    expect(dayLengthMinutes(bounds)).toBe(1440);
    expect(toPixels(90, 48)).toBe(72);
  });

  it("clips a span to the day and says which ends were cut", () => {
    expect(clip(span("a", "2026-08-18T20:00:00.000Z", "2026-08-18T21:00:00.000Z"), bounds)).toMatchObject({
      startsAt: at("2026-08-18T20:00:00.000Z"),
      endsAt: at("2026-08-18T21:00:00.000Z"),
      clippedStart: false,
      clippedEnd: false
    });
    // Sleep that starts the evening before and ends this morning keeps only the morning part.
    expect(clip(span("s", "2026-08-18T12:30:00.000Z", "2026-08-18T21:00:00.000Z"), bounds)).toMatchObject({
      startsAt: bounds.startsAt,
      clippedStart: true,
      clippedEnd: false
    });
    // Tonight's sleep runs past local midnight and is cut at the end of the day.
    expect(clip(span("t", "2026-08-19T12:30:00.000Z", "2026-08-19T21:00:00.000Z"), bounds)).toMatchObject({
      endsAt: bounds.endsAt,
      clippedStart: false,
      clippedEnd: true
    });
  });

  it("treats a span that only touches the day at a boundary as not on the day", () => {
    expect(clip(span("x", "2026-08-18T12:00:00.000Z", "2026-08-18T14:00:00.000Z"), bounds)).toBeNull();
    expect(clip(span("y", "2026-08-19T14:00:00.000Z", "2026-08-19T15:00:00.000Z"), bounds)).toBeNull();
    expect(clip(span("z", "2026-08-20T00:00:00.000Z", "2026-08-20T01:00:00.000Z"), bounds)).toBeNull();
  });

  it("gives a block a top and height in pixels with a minimum height for short spans", () => {
    const step = span("step", "2026-08-18T23:00:00.000Z", "2026-08-18T23:05:00.000Z");
    expect(blockGeometry(step, bounds, 60)).toEqual({ top: 540, height: 5 });
    expect(blockGeometry(step, bounds, 60, 14)).toEqual({ top: 540, height: 14 });
    const hour = span("hour", "2026-08-18T23:00:00.000Z", "2026-08-19T00:00:00.000Z");
    expect(blockGeometry(hour, bounds, 48)).toEqual({ top: 432, height: 48 });
  });
});

describe("Overlap column assignment", () => {
  it("keeps non-overlapping and merely touching blocks in a single full-width column", () => {
    const placements = assignColumns([
      span("a", "2026-08-18T20:00:00.000Z", "2026-08-18T21:00:00.000Z"),
      span("b", "2026-08-18T21:00:00.000Z", "2026-08-18T22:00:00.000Z"),
      span("c", "2026-08-19T01:00:00.000Z", "2026-08-19T02:00:00.000Z")
    ]);
    expect(placements.get("a")).toEqual({ column: 0, columns: 1 });
    expect(placements.get("b")).toEqual({ column: 0, columns: 1 });
    expect(placements.get("c")).toEqual({ column: 0, columns: 1 });
  });

  it("splits a three-way overlap into three columns and leaves a later lone block whole", () => {
    const placements = assignColumns([
      span("a", "2026-08-18T20:00:00.000Z", "2026-08-18T22:00:00.000Z"),
      span("b", "2026-08-18T20:30:00.000Z", "2026-08-18T21:30:00.000Z"),
      span("c", "2026-08-18T21:00:00.000Z", "2026-08-18T21:15:00.000Z"),
      span("d", "2026-08-19T01:00:00.000Z", "2026-08-19T02:00:00.000Z")
    ]);
    expect(placements.get("a")).toEqual({ column: 0, columns: 3 });
    expect(placements.get("b")).toEqual({ column: 1, columns: 3 });
    expect(placements.get("c")).toEqual({ column: 2, columns: 3 });
    expect(placements.get("d")).toEqual({ column: 0, columns: 1 });
  });

  it("reuses a freed column within a cluster and links chained overlaps into one cluster", () => {
    // a overlaps b, b overlaps c, but a and c do not touch: still one cluster of two columns.
    const placements = assignColumns([
      span("a", "2026-08-18T20:00:00.000Z", "2026-08-18T21:00:00.000Z"),
      span("b", "2026-08-18T20:30:00.000Z", "2026-08-18T21:30:00.000Z"),
      span("c", "2026-08-18T21:00:00.000Z", "2026-08-18T22:00:00.000Z")
    ]);
    expect(placements.get("a")).toEqual({ column: 0, columns: 2 });
    expect(placements.get("b")).toEqual({ column: 1, columns: 2 });
    expect(placements.get("c")).toEqual({ column: 0, columns: 2 });
  });

  it("is independent of input order", () => {
    const items = [
      span("late", "2026-08-18T21:00:00.000Z", "2026-08-18T22:00:00.000Z"),
      span("early", "2026-08-18T20:00:00.000Z", "2026-08-18T21:30:00.000Z")
    ];
    expect(assignColumns(items).get("early")).toEqual({ column: 0, columns: 2 });
    expect(assignColumns([...items].reverse()).get("early")).toEqual({ column: 0, columns: 2 });
  });
});

describe("Pixel cascade after minimum-height inflation", () => {
  const block = (id: string, top: number, height: number, column = 0, columns = 1) => ({
    id,
    top,
    height,
    column,
    columns
  });
  const tops = (result: ReturnType<typeof cascadeBlocks>, ids: string[]) =>
    ids.map((id) => result.placements.get(id)!.top);

  it("leaves blocks that already clear each other exactly where the clock puts them", () => {
    const result = cascadeBlocks([block("a", 600, 60), block("b", 660, 30), block("c", 780, 18)]);
    expect(tops(result, ["a", "b", "c"])).toEqual([600, 660, 780]);
    expect([...result.placements.values()].every((placement) => placement.pushedBy === 0)).toBe(true);
    expect(result.bottom).toBe(798);
  });

  it("cascades a run of inflated five-minute blocks so none covers the next", () => {
    // Five minutes is 5 px at 60 px/hour but each block is drawn 18 px tall.
    const run = [600, 605, 610, 615, 620].map((top, index) => block(`s${index}`, top, 18));
    const result = cascadeBlocks(run);
    const ids = run.map((item) => item.id);
    expect(tops(result, ids)).toEqual([600, 618, 636, 654, 672]);
    expect(result.placements.get("s4")!.pushedBy).toBe(52);
    expect(result.placements.get("s4")!.height).toBe(18);
    // Every drawn block clears the one before it, and the order of the run is unchanged.
    const drawn = ids.map((id) => result.placements.get(id)!);
    for (const [index, placement] of drawn.entries()) {
      if (index === 0) continue;
      expect(placement.top).toBeGreaterThanOrEqual(drawn[index - 1]!.top + drawn[index - 1]!.height);
    }
  });

  it("pushes only where the drawn rectangles meet, so parallel columns stay independent", () => {
    const result = cascadeBlocks([
      block("long", 600, 60, 0, 2),
      block("short", 600, 18, 1, 2),
      block("after-short", 605, 18, 1, 2),
      // Outside the cluster and full width, so it has to clear both columns above it.
      block("whole", 660, 18, 0, 1)
    ]);
    expect(tops(result, ["long", "short", "after-short", "whole"])).toEqual([600, 600, 618, 660]);
    expect(result.placements.get("long")!.pushedBy).toBe(0);
    expect(result.placements.get("whole")!.pushedBy).toBe(0);
    // The same run one column over, with nothing full-width below it, only pushes within its column.
    const parallel = cascadeBlocks([block("l", 600, 120, 0, 2), block("a", 600, 18, 1, 2), block("b", 605, 18, 1, 2)]);
    expect(tops(parallel, ["l", "a", "b"])).toEqual([600, 600, 618]);
    expect(parallel.bottom).toBe(720);
  });

  it("reports the lowest adjusted bottom so the canvas can be grown to hold a late run", () => {
    // Four ten-minute blocks in the last half-hour of a 1440 px day.
    const late = [1410, 1415, 1420, 1425].map((top, index) => block(`l${index}`, top, 18));
    const result = cascadeBlocks(late);
    expect(result.placements.get("l3")!.top).toBe(1464);
    expect(result.bottom).toBe(1482);
    expect(Math.max(1440, result.bottom)).toBe(1482);
    expect(cascadeBlocks([]).bottom).toBe(0);
    expect(cascadeBlocks([]).placements.size).toBe(0);
  });

  it("keeps a pinned block on its clock time and draws the projected run that cannot fit beside it", () => {
    // Four five-minute projected tasks before a 10:40 class, drawn 18 px each: the third would run
    // into the class with only 4 px before it, so it and the one after it share the class's width.
    const run = [600, 605, 610, 615].map((top, index) => block(`s${index}`, top, 18));
    const result = cascadeBlocks([...run, { ...block("class", 640, 60), pinned: true }]);
    expect(tops(result, ["s0", "s1", "class", "s2", "s3"])).toEqual([600, 618, 640, 636, 654]);
    expect(result.placements.get("class")!.pushedBy).toBe(0);
    expect(result.columns.get("class")).toEqual({ column: 0, columns: 2 });
    expect(result.columns.get("s2")).toEqual({ column: 1, columns: 2 });
    expect(result.columns.get("s3")).toEqual({ column: 1, columns: 2 });
    // The two that cleared the class keep the whole width.
    expect(result.columns.has("s0") || result.columns.has("s1")).toBe(false);
    expect(result.bottom).toBe(700);
  });

  it("lets a projected block give up a quarter of its height to end where a pinned block starts", () => {
    const result = cascadeBlocks([block("task", 600, 26), { ...block("routine", 622, 50), pinned: true }]);
    expect(result.placements.get("task")).toEqual({ top: 600, height: 22, pushedBy: 0 });
    expect(result.placements.get("routine")).toEqual({ top: 622, height: 50, pushedBy: 0 });
    expect(result.columns.size).toBe(0);
    // Short of three quarters, it goes beside instead of shrinking past legibility.
    const tight = cascadeBlocks([block("task", 600, 26), { ...block("routine", 618, 50), pinned: true }]);
    expect(tight.placements.get("task")).toEqual({ top: 600, height: 26, pushedBy: 0 });
    expect(tight.columns.get("task")).toEqual({ column: 1, columns: 2 });
    expect(tight.columns.get("routine")).toEqual({ column: 0, columns: 2 });
  });

  it("pushes a pinned block only for another pinned one", () => {
    const result = cascadeBlocks([
      { ...block("first", 600, 26), pinned: true },
      { ...block("second", 610, 60), pinned: true },
      block("task", 605, 18)
    ]);
    expect(tops(result, ["first", "second", "task"])).toEqual([600, 626, 605]);
    expect(result.columns.get("task")).toEqual({ column: 1, columns: 2 });
    expect(result.columns.get("first")).toEqual({ column: 0, columns: 2 });
    expect(result.columns.has("second")).toBe(false);
  });

  it("halves each pinned block a run drawn beside another one reaches", () => {
    // Bedtime at 640 and sleep straight after it; the run beside bedtime runs on past sleep's start.
    const result = cascadeBlocks([
      block("a", 630, 26),
      block("b", 635, 26),
      { ...block("bedtime", 640, 30), pinned: true },
      { ...block("sleep", 670, 90), pinned: true }
    ]);
    expect(tops(result, ["a", "b", "bedtime", "sleep"])).toEqual([630, 656, 640, 670]);
    expect(result.columns.get("bedtime")).toEqual({ column: 0, columns: 2 });
    expect(result.columns.get("sleep")).toEqual({ column: 0, columns: 2 });
    expect(result.columns.get("b")).toEqual({ column: 1, columns: 2 });
  });

  it("keeps a projected block off a pinned block's journey bar as well as the block", () => {
    const result = cascadeBlocks([
      block("task", 610, 26),
      { ...block("class", 660, 60), pinned: true, claimsFrom: 630 }
    ]);
    expect(result.placements.get("task")).toEqual({ top: 610, height: 20, pushedBy: 0 });
    // A projected block in another column is not in the bar's way.
    const beside = cascadeBlocks([
      block("task", 640, 26, 1, 2),
      { ...block("class", 660, 60, 0, 2), pinned: true, claimsFrom: 630 }
    ]);
    expect(beside.placements.get("task")).toEqual({ top: 640, height: 26, pushedBy: 0 });
    expect(beside.columns.size).toBe(0);
  });

  it("is independent of input order and never moves a block up", () => {
    const items = [block("late", 620, 18), block("early", 600, 18), block("middle", 610, 18)];
    const forward = cascadeBlocks(items);
    const reversed = cascadeBlocks([...items].reverse());
    expect(tops(forward, ["early", "middle", "late"])).toEqual([600, 618, 636]);
    expect(tops(reversed, ["early", "middle", "late"])).toEqual([600, 618, 636]);
    expect([...forward.placements.values()].every((placement) => placement.pushedBy >= 0)).toBe(true);
  });
});

describe("Lane layout", () => {
  const run = [0, 5, 10].map((minute, index) =>
    span(
      `s${index}`,
      `2026-08-18T23:${String(minute).padStart(2, "0")}:00.000Z`,
      `2026-08-18T23:${String(minute + 5).padStart(2, "0")}:00.000Z`
    )
  );

  it("packs overlaps into columns and leaves clear blocks where the clock puts them", () => {
    const lane = laneLayout(
      [
        span("a", "2026-08-18T20:00:00.000Z", "2026-08-18T21:00:00.000Z"),
        span("b", "2026-08-18T20:30:00.000Z", "2026-08-18T21:30:00.000Z"),
        span("c", "2026-08-19T01:00:00.000Z", "2026-08-19T02:00:00.000Z")
      ],
      bounds,
      60
    );
    expect(lane.columns.get("a")).toEqual({ column: 0, columns: 2 });
    expect(lane.columns.get("b")).toEqual({ column: 1, columns: 2 });
    expect(lane.columns.get("c")).toEqual({ column: 0, columns: 1 });
    // Side-by-side columns are not in each other's way, so nothing is pushed down.
    expect(lane.cascade.placements.get("b")).toEqual({ top: 390, height: 60, pushedBy: 0 });
    expect(lane.cascade.placements.get("c")).toEqual({ top: 660, height: 60, pushedBy: 0 });
    expect(lane.cascade.bottom).toBe(720);
  });

  it("shares the columns out over a block's journey when it reaches above its own start", () => {
    // A 9:00 commitment left for at 8:15, and a 8:30 projected session inside the journey: apart in
    // their own times, so without the reach they would each take the whole width and the session would
    // sit on the journey bar.
    const items = [
      span("commitment", "2026-08-18T23:00:00.000Z", "2026-08-19T00:00:00.000Z"),
      span("session", "2026-08-18T22:30:00.000Z", "2026-08-18T22:55:00.000Z")
    ];
    expect(laneLayout(items, bounds, 60).columns.get("session")).toEqual({ column: 0, columns: 1 });
    const lane = laneLayout(items, bounds, 60, MIN_BLOCK_PX, {
      reachFrom: new Map([["commitment", at("2026-08-18T22:15:00.000Z")]])
    });
    expect(lane.columns.get("commitment")).toEqual({ column: 0, columns: 2 });
    expect(lane.columns.get("session")).toEqual({ column: 1, columns: 2 });
    // The block is still drawn from its own start, not from the leave time.
    expect(lane.cascade.placements.get("commitment")!.top).toBe(540);
  });

  it("holds the pinned blocks it is given on their own time", () => {
    // Two five-minute projected steps from 23:00 and a commitment at 23:10. Unpinned, the cascade draws
    // the commitment at 592 instead of 550; pinned, it stays at 550 and shares its width with the steps,
    // which have 10 px before it and need 26.
    const commitment = span("commitment", "2026-08-18T23:10:00.000Z", "2026-08-19T00:00:00.000Z");
    const free = laneLayout([...run.slice(0, 2), commitment], bounds, 60);
    expect(free.cascade.placements.get("commitment")!.top).toBe(592);
    const lane = laneLayout([...run.slice(0, 2), commitment], bounds, 60, MIN_BLOCK_PX, {
      pinned: new Set(["commitment"])
    });
    expect(["commitment", "s0", "s1"].map((id) => lane.cascade.placements.get(id)!.top)).toEqual([550, 540, 566]);
    expect(lane.columns.get("commitment")).toEqual({ column: 0, columns: 2 });
    expect(lane.columns.get("s0")).toEqual({ column: 1, columns: 2 });
    expect(lane.columns.get("s1")).toEqual({ column: 1, columns: 2 });
  });

  it("inflates short blocks to the default minimum and cascades the pixel overlap that creates", () => {
    // Three five-minute steps back to back: 5 px apart at 60 px/hour, each drawn 26 px tall.
    const lane = laneLayout(run, bounds, 60);
    expect(run.map((item) => lane.cascade.placements.get(item.id)!.top)).toEqual([540, 566, 592]);
    expect(run.every((item) => lane.cascade.placements.get(item.id)!.height === 26)).toBe(true);
    // Nothing overlaps in time, so the packing still hands every block the whole width.
    expect(run.every((item) => lane.columns.get(item.id)!.columns === 1)).toBe(true);
    expect(lane.cascade.bottom).toBe(618);
  });

  it("takes a smaller minimum for a denser canvas, which leaves the same run nothing to cascade", () => {
    const lane = laneLayout(run, bounds, 60, 4);
    expect(run.map((item) => lane.cascade.placements.get(item.id)!.top)).toEqual([540, 545, 550]);
    expect(run.every((item) => lane.cascade.placements.get(item.id)!.pushedBy === 0)).toBe(true);
    // A minimum of zero draws each block at its true five pixels.
    expect(laneLayout(run, bounds, 60, 0).cascade.placements.get("s0")!.height).toBe(5);
  });

  it("has an empty lane for an empty list", () => {
    const lane = laneLayout([], bounds, 60);
    expect(lane.columns.size).toBe(0);
    expect(lane.cascade.placements.size).toBe(0);
    expect(lane.cascade.bottom).toBe(0);
  });
});

describe("First gap after a time", () => {
  const blocks = [
    span("a", "2026-08-19T00:00:00.000Z", "2026-08-19T01:00:00.000Z"),
    span("b", "2026-08-19T01:10:00.000Z", "2026-08-19T02:00:00.000Z"),
    span("c", "2026-08-19T02:00:00.000Z", "2026-08-19T13:50:00.000Z")
  ];

  it("returns the first free stretch long enough, skipping a gap that is too short", () => {
    // 01:00–01:10 is only ten minutes; the tail after 13:50 is exactly ten minutes.
    expect(firstGapAfter(blocks, at("2026-08-19T00:30:00.000Z"), bounds, 20)).toBeNull();
    expect(firstGapAfter(blocks, at("2026-08-19T00:30:00.000Z"), bounds, 10)?.toISOString()).toBe(
      "2026-08-19T01:00:00.000Z"
    );
    expect(firstGapAfter(blocks, at("2026-08-19T13:00:00.000Z"), bounds, 10)?.toISOString()).toBe(
      "2026-08-19T13:50:00.000Z"
    );
  });

  it("starts at the asked-for time when nothing occupies it, and never before the day", () => {
    expect(firstGapAfter([], at("2026-08-19T03:00:00.000Z"), bounds, 20)?.toISOString()).toBe(
      "2026-08-19T03:00:00.000Z"
    );
    expect(firstGapAfter([], at("2026-08-18T10:00:00.000Z"), bounds, 20)).toEqual(bounds.startsAt);
    expect(firstGapAfter(blocks.slice(0, 1), at("2026-08-18T23:00:00.000Z"), bounds, 90)?.toISOString()).toBe(
      "2026-08-19T01:00:00.000Z"
    );
  });
});

describe("Merging engine allocation blocks", () => {
  const block = (actionId: string, start: string, end: string, minutes = 15) => ({
    actionId,
    projectId: "p",
    slotId: start,
    startsAt: at(start),
    endsAt: at(end),
    minutes
  });

  it("merges touching same-action slots into one interval and sums their minutes", () => {
    const merged = mergeAdjacentBlocks([
      block("a", "2026-08-19T03:00:00.000Z", "2026-08-19T03:15:00.000Z"),
      block("a", "2026-08-19T03:15:00.000Z", "2026-08-19T03:30:00.000Z"),
      block("a", "2026-08-19T03:30:00.000Z", "2026-08-19T03:45:00.000Z", 10)
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      actionId: "a",
      startsAt: at("2026-08-19T03:00:00.000Z"),
      endsAt: at("2026-08-19T03:45:00.000Z"),
      minutes: 40
    });
  });

  it("keeps a gap, a different action, and interleaved actions apart", () => {
    const merged = mergeAdjacentBlocks([
      block("b", "2026-08-19T03:15:00.000Z", "2026-08-19T03:30:00.000Z"),
      block("a", "2026-08-19T03:00:00.000Z", "2026-08-19T03:15:00.000Z"),
      block("a", "2026-08-19T03:30:00.000Z", "2026-08-19T03:45:00.000Z"),
      block("a", "2026-08-19T05:00:00.000Z", "2026-08-19T05:15:00.000Z")
    ]);
    expect(merged.map((item) => [item.actionId, item.startsAt.toISOString(), item.minutes])).toEqual([
      ["a", "2026-08-19T03:00:00.000Z", 15],
      ["b", "2026-08-19T03:15:00.000Z", 15],
      ["a", "2026-08-19T03:30:00.000Z", 15],
      ["a", "2026-08-19T05:00:00.000Z", 15]
    ]);
    expect(new Set(merged.map((item) => item.id)).size).toBe(4);
  });

  it("returns nothing for no allocations", () => {
    expect(mergeAdjacentBlocks([])).toEqual([]);
  });
});
