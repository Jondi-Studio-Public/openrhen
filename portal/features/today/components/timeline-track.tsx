"use client";

import { dateTimeFormat, displayLocale } from "@/shared/locale";
import type { CSSProperties } from "react";
import {
  assignColumns,
  blockGeometry,
  firstGapAfter,
  minuteOffset,
  toPixels,
  MIN_BLOCK_PX,
  NO_COLUMN,
  type DayWindow,
  type Lane,
  type LaneAnchors
} from "@/features/today/day-layout";
import type { DayPlan, DayPlanItem, DayPlanUntimed } from "@/features/today/day-plan";
import { hourMarks } from "@/features/today/local-datetime";
import { formatZonedTime } from "@/shared/date-format";

/**
 * Below this a block shows its title only. The second line either fits whole or is not drawn — half a
 * line of subtitle sliced by the block's edge reads as damage rather than as detail, and the detail
 * sheet has all of it anyway.
 */
const BLOCK_META_PX = 40;
/**
 * Room for three lines: a journey's "Leave" line, the title and the meta. Below it the Leave time goes
 * on the title's own line instead, so a short commitment never has its title sliced by its subtitle.
 */
const BLOCK_THREE_LINES_PX = 58;
/** A dense (week) block's title line, matching its caption line-height. */
const DENSE_TITLE_LINE_PX = 16;
/** A window band's floor, so its label always has a band to sit in. */
const MIN_WINDOW_PX = 20;
/** How far each further overlapping window's label drops, so two labels never sit on each other. */
const WINDOW_LABEL_STEP_PX = 18;
/** A window label's drawn height, its 16px line and two border pixels, plus a pixel either side. */
const WINDOW_LABEL_PX = 20;
/** How much clear time the "next up" strip needs before it settles into a gap. */
const UNTIMED_GAP_MINUTES = 40;

/**
 * Colours for the location strip. Deliberately a small fixed set hashed by id rather than a stored
 * per-place colour: places come and go, and a band beside the gutter only has to say "somewhere
 * else now" — the label says which somewhere. Fixed order and a fixed hash keep a place the same
 * colour between renders and between days.
 */
const LOCATION_COLOURS = ["#8fb3a0", "#a8b6cf", "#cbb083", "#b79bb8", "#8fb6bd", "#c2a596"] as const;

export function locationColour(locationId: string): string {
  // FNV-1a rather than a plain polynomial: ids here routinely share a long prefix ("ctx-home",
  // "ctx-campus"), and a weaker mix hands the two places a reader most often compares one colour.
  let hash = 2_166_136_261;
  for (const character of locationId) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return LOCATION_COLOURS[(hash >>> 0) % LOCATION_COLOURS.length]!;
}

/**
 * One column of drawn day: backgrounds and hour rules, the eligibility windows behind them, the
 * reservation lane, the timed blocks with their halos and meta, point markers, the "next up" strip
 * and the now-line. Everything here is measured against one day's bounds and nothing else — the
 * lanes and the canvas height are worked out by whoever owns the surrounding canvas and handed in,
 * so several days side by side can share one height and still each be laid out on its own hours.
 *
 * `dense` is for a track too narrow to spare a second line of text, and `showUntimed` for a surface
 * that shows the untimed chips somewhere of its own. `selectable` is for a canvas holding blocks that
 * open nothing — a block that cannot be followed anywhere is drawn as text rather than as a control,
 * because a button that does nothing when pressed is a worse answer than one that was never offered.
 */
export function TimelineTrack({
  plan,
  timezone,
  pixelsPerHour,
  height,
  minBlockPx = MIN_BLOCK_PX,
  showReserved,
  showUntimed = true,
  dense = false,
  selectable = () => true,
  onSelect,
  onSelectUntimed,
  timedLane,
  reservedLane,
  blocks,
  visibleFrom = 0
}: {
  plan: DayPlan;
  timezone: string;
  pixelsPerHour: number;
  height: number;
  minBlockPx?: number;
  showReserved: boolean;
  showUntimed?: boolean;
  dense?: boolean;
  /** Whether a tap on this block goes anywhere; everything is selectable unless a surface says not. */
  selectable?: (item: DayPlanItem) => boolean;
  onSelect: (item: DayPlanItem) => void;
  onSelectUntimed?: ((chip: DayPlanUntimed) => void) | undefined;
  timedLane: Lane;
  reservedLane: Lane;
  blocks: DayPlanItem[];
  /**
   * Where the canvas starts being seen, in pixels, when the owner crops the top of it off. A block
   * that starts above that line writes its title just below it rather than in the cropped-off part.
   */
  visibleFrom?: number;
}) {
  const { bounds } = plan;
  const marks = hourMarks(bounds, timezone);
  const time = (value: Date) => formatZonedTime(value, timezone);
  const px = (minutes: number) => toPixels(minutes, pixelsPerHour);
  const windows = plan.items.filter((item) => !item.marker && item.window);
  const journeys = journeysByBlock(plan, blocks);
  const attached = new Set([...journeys.values()].map((journey) => journey.leaveBy.id));
  const markers = plan.items.filter((item) => item.marker && !attached.has(item.id));
  // Columns among the windows too, but only to stagger their labels: the bands themselves are full
  // width and translucent, so two overlapping windows read as two tints rather than as two columns.
  const windowColumns = assignColumns(windows);
  /**
   * How far above its block a journey's bar reaches: the journey's own length on the clock. A block a
   * crowded run pushed down takes its bar with it, rather than stretching the bar from the leave time
   * across every block drawn in between; the "Leave" line on the block still names the real time.
   */
  const journeyReachPx = (journey: Journey, item: DayPlanItem) =>
    Math.max(
      0,
      blockGeometry(item, bounds, pixelsPerHour).top - blockGeometry(journey.leaveBy, bounds, pixelsPerHour).top
    );
  const labelTops = windowLabelTops(
    windows,
    bounds,
    pixelsPerHour,
    blocks.map((item) => {
      const geometry =
        timedLane.cascade.placements.get(item.id) ?? blockGeometry(item, bounds, pixelsPerHour, minBlockPx);
      const journey = journeys.get(item.id);
      const top = journey ? geometry.top - journeyReachPx(journey, item) : geometry.top;
      return { top, bottom: geometry.top + geometry.height };
    })
  );
  const anchor = showUntimed ? untimedAnchor(plan, blocks) : null;

  /**
   * Where the block is drawn. The top is the cascaded one, which for a block in a crowded run is
   * below the time it names. Nothing on the block says so: its label and its times are the true
   * ones, and the day's hour rules stay where they are, so the reader has both readings available.
   */
  const spanStyle = (item: DayPlanItem, lane: Lane): CSSProperties => {
    const placement = lane.columns.get(item.id) ?? NO_COLUMN;
    const geometry = lane.cascade.placements.get(item.id) ?? blockGeometry(item, bounds, pixelsPerHour, minBlockPx);
    return {
      top: `${geometry.top}px`,
      height: `${geometry.height}px`,
      left: `${(placement.column / placement.columns) * 100}%`,
      width: `${100 / placement.columns}%`
    };
  };
  const journeyText = (journey: Journey) =>
    [
      `leave ${time(journey.leaveBy.startsAt)}`,
      ...journey.legs.map((leg) => `${leg.title}${leg.subtitle ? ` (${leg.subtitle})` : ""}`),
      ...(journey.legs.length === 0 && journey.leaveBy.subtitle ? [journey.leaveBy.subtitle] : [])
    ].join(", ");
  const label = (item: DayPlanItem) => {
    if (item.marker) return `${item.title}, ${time(item.startsAt)}`;
    const journey = journeys.get(item.id);
    return `${item.title}, ${time(item.startsAt)} to ${time(item.endsAt)}${item.clippedStart ? ", started the day before" : ""}${item.clippedEnd ? ", continues after midnight" : ""}${journey ? `, ${journeyText(journey)}` : ""}`;
  };

  return (
    <div className="day-timeline-track" style={{ height: `${height}px` }}>
      <div className="day-timeline-backgrounds" aria-hidden="true">
        {plan.backgrounds.map((band) => (
          <div
            key={band.id}
            className={`day-timeline-band day-timeline-band-${band.kind}`}
            style={{
              top: `${px(minuteOffset(band.startsAt, bounds))}px`,
              height: `${px(minuteOffset(band.endsAt, bounds) - minuteOffset(band.startsAt, bounds))}px`
            }}
          />
        ))}
        {marks.map((mark) => (
          <div
            key={mark.at.toISOString()}
            className="day-timeline-rule"
            style={{ top: `${px(mark.minuteOffset)}px` }}
          />
        ))}
        {plan.lines.map((line) => {
          const top = px(minuteOffset(line.at, bounds));
          // A "Nothing fits" note is a word on an empty stretch; drawn over a block it is text on text.
          // The line and its title stay, only the label gives way.
          const covered =
            line.kind === "gap" &&
            blocks.some((item) => {
              const placed = timedLane.cascade.placements.get(item.id);
              return placed !== undefined && top + 16 > placed.top && top < placed.top + placed.height;
            });
          return (
            <div
              key={line.id}
              className={`day-timeline-line day-timeline-line-${line.kind}`}
              title={`${line.label} · ${time(line.at)}`}
              style={{ top: `${top}px` }}
            >
              {!covered && (
                <span>
                  {line.label} · {time(line.at)}
                </span>
              )}
            </div>
          );
        })}
      </div>
      {windows.length > 0 && (
        <ol className="day-timeline-windows" aria-label="Windows something may happen in">
          {windows.map((item) => (
            <WindowBand
              key={item.id}
              item={item}
              bounds={bounds}
              pixelsPerHour={pixelsPerHour}
              column={(windowColumns.get(item.id) ?? NO_COLUMN).column}
              labelTop={labelTops.get(item.id) ?? null}
              hideCrowdedLabel={dense}
              label={label(item)}
              onSelect={onSelect}
            />
          ))}
        </ol>
      )}
      {showReserved && plan.reserved.length > 0 && (
        <ol className="day-timeline-reserved" aria-label="Latest-safe reservations">
          {plan.reserved.map((item) => (
            <li key={item.id} style={spanStyle(item, reservedLane)}>
              <button
                type="button"
                className={`day-timeline-block day-timeline-reserved-block${item.kind === "soft" ? " soft" : ""}${item.stale ? " stale" : ""}`}
                aria-label={`${item.kind === "soft" ? "Cadence room" : "Reserved"}: ${label(item)}`}
                title={`${item.kind === "soft" ? "Cadence room" : "Reserved"}: ${label(item)}`}
                onClick={() => onSelect(item)}
              >
                <span className="day-timeline-block-title">{item.title}</span>
                {!dense && (
                  <span className="day-timeline-block-meta">
                    {item.kind === "soft"
                      ? item.subtitle
                      : item.deadlineAt
                        ? `reserved by ${formatDeadline(item.deadlineAt, timezone)}`
                        : "reserved"}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ol>
      )}
      <ol className="day-timeline-items" aria-label="Timed items">
        {blocks.map((item) => {
          const style = spanStyle(item, timedLane);
          const geometry =
            timedLane.cascade.placements.get(item.id) ?? blockGeometry(item, bounds, pixelsPerHour, minBlockPx);
          const itemTop = geometry.top;
          const journey = journeys.get(item.id);
          const place = stayColourFor(plan, item);
          // Only the part below `visibleFrom` is seen, so the lines it has room for are counted from there.
          const hidden = Math.max(0, visibleFrom - itemTop);
          const seen = geometry.height - hidden;
          // A dense block's title wraps onto as many 16px lines as the block shows, then ends in an
          // ellipsis, rather than cutting a long name to its first few letters on one line.
          const titleLines = dense ? Math.max(1, Math.floor((seen - 2) / DENSE_TITLE_LINE_PX)) : undefined;
          const blockStyle = {
            ...(hidden > 0 && seen > 0 ? { paddingTop: `${hidden + 2}px` } : {}),
            ...(titleLines ? { "--dt-title-lines": titleLines } : {})
          } as CSSProperties;
          const showsMeta = !dense && seen >= BLOCK_META_PX && Boolean(item.subtitle || item.steps);
          const leaveLine = journey !== undefined && seen >= (showsMeta ? BLOCK_THREE_LINES_PX : BLOCK_META_PX);
          const content = (
            <>
              {journey && leaveLine && (
                <span className="day-timeline-leave">Leave {time(journey.leaveBy.startsAt)}</span>
              )}
              <span className="day-timeline-block-title">
                {/* A dense column has no room to spare before the title; the label still says when to leave. */}
                {journey && !leaveLine && !dense && (
                  <span className="day-timeline-leave">Leave {time(journey.leaveBy.startsAt)} · </span>
                )}
                {item.source === "engine" && (
                  <span className="day-timeline-tag">{item.projected ? "projected" : "planned"}</span>
                )}
                {item.title}
              </span>
              {showsMeta && (
                <span className="day-timeline-block-meta">
                  {item.subtitle}
                  {item.steps && item.steps.length > 0 && (
                    <>
                      {item.subtitle ? " · " : ""}
                      {item.steps.map((step) => `${step.title} ${time(step.startsAt)}`).join(" · ")}
                    </>
                  )}
                  {/* The block is drawn at its own start, which functions as when to leave even though
                      nothing said so — spell it out rather than leave the reader to infer it from where
                      the block happens to sit. */}
                  {item.kind === "travel" && <> · Leave by {time(item.startsAt)}</>}
                </span>
              )}
            </>
          );
          return (
            <li
              key={item.id}
              style={place ? ({ ...style, "--dt-place": place } as CSSProperties) : style}
              className={`day-timeline-item day-timeline-item-${item.kind}${journey ? " has-journey" : ""}${place ? " has-place" : ""}`}
            >
              {journey && (
                // The journey's own track, ending at the top the block is drawn at and as long as the
                // journey (`journeyReachPx`). The block's own label says all of it; the bar's title is
                // for a pointer hovering it.
                <span
                  className={`day-timeline-journey${journey.leaveBy.stale ? " stale" : ""}`}
                  aria-hidden="true"
                  data-testid="day-timeline-journey"
                  title={journeyText(journey)}
                  style={{
                    top: `${-journeyReachPx(journey, item)}px`,
                    height: `${journeyReachPx(journey, item)}px`
                  }}
                />
              )}
              {item.halos?.map((halo, index) => {
                // Halos are positioned relative to their block, which sits at the cascaded
                // `itemTop`. A halo keeps its own true-time height, so on a pushed block it
                // reaches further above than the fifteen minutes it stands for: the setup time
                // is a fact about the clock, not about where the block ended up.
                const geometry = blockGeometry(halo, bounds, pixelsPerHour);
                return (
                  <span
                    key={index}
                    className="day-timeline-halo"
                    aria-hidden="true"
                    style={{ top: `${geometry.top - itemTop}px`, height: `${geometry.height}px` }}
                  />
                );
              })}
              {selectable(item) ? (
                <button
                  type="button"
                  className={blockClass(item)}
                  style={blockStyle}
                  aria-label={label(item)}
                  title={label(item)}
                  onClick={() => onSelect(item)}
                >
                  {content}
                </button>
              ) : (
                <span className={blockClass(item)} style={blockStyle} title={label(item)}>
                  {content}
                </span>
              )}
            </li>
          );
        })}
      </ol>
      {markers.map((item) => (
        <button
          key={item.id}
          type="button"
          className={`day-timeline-marker day-timeline-marker-${item.kind}${item.urgency ? ` ${item.urgency}` : ""}${item.stale ? " stale" : ""}`}
          style={{ top: `${px(minuteOffset(item.startsAt, bounds))}px` }}
          aria-label={label(item)}
          title={label(item)}
          onClick={() => onSelect(item)}
        >
          <span>
            {/* A leave-by or start-by title already names its own time ("Leave by 1:43 pm for …"). */}
            {item.kind === "leave_by" || item.kind === "start_by"
              ? item.title
              : `${item.title} · ${time(item.startsAt)}`}
          </span>
        </button>
      ))}
      {plan.untimed.length > 0 && anchor && (
        <div
          className="day-timeline-untimed"
          style={{ top: `${px(minuteOffset(anchor, bounds))}px` }}
          role="group"
          aria-label="Next up, not yet timed"
        >
          <span className="day-timeline-untimed-label">Next up · not timed</span>
          {plan.untimed.map((chip) => (
            <UntimedChip key={chip.id} chip={chip} onSelect={onSelectUntimed} />
          ))}
        </div>
      )}
      {plan.nowAt && (
        <div
          className="day-timeline-now"
          aria-hidden="true"
          style={{ top: `${px(minuteOffset(plan.nowAt, bounds))}px` }}
          data-testid="day-timeline-now"
        >
          <span>{time(plan.nowAt)}</span>
        </div>
      )}
    </div>
  );
}

/** A commitment's journey: its leave-by marker, and the engine's own legs that run inside it. */
export interface Journey {
  leaveBy: DayPlanItem;
  legs: DayPlanItem[];
}

/**
 * The journey each drawn commitment carries, keyed by block id. A leave-by used to be a full-width
 * chip at its own minute, and the leg the engine projected for the same trip a block beside the
 * commitment: the chip sat on whatever else was on then and, on a week column, ran into the next day.
 * On its destination it is now one bar from the leave time down to the block, the block's first line
 * says "Leave 1:43 pm", and the legs inside that stretch are the bar rather than blocks of their own.
 * A marker whose commitment is not drawn as its own block here (folded into a run, or on the other
 * side of midnight) stays a marker, and its legs stay blocks.
 */
export function journeysByBlock(plan: DayPlan, blocks: DayPlanItem[]): Map<string, Journey> {
  const leaveBys = new Map(
    plan.items.filter((item) => item.marker && item.kind === "leave_by").map((item) => [item.entityId, item])
  );
  const legs = plan.items.filter((item) => item.kind === "travel" && !item.marker && !item.window);
  const journeys = new Map<string, Journey>();
  for (const block of blocks) {
    if (block.kind !== "commitment" || block.grouped) continue;
    const leaveBy = leaveBys.get(block.entityId);
    if (!leaveBy || leaveBy.startsAt >= block.startsAt) continue;
    journeys.set(block.id, {
      leaveBy,
      legs: legs.filter((leg) => leg.startsAt < block.startsAt && leg.endsAt > leaveBy.startsAt)
    });
  }
  return journeys;
}

/**
 * The timed items a canvas lays out once journeys have taken their legs, and the journeys themselves.
 * Both the day and the week measure through this, so the lanes and the drawing agree on what is a
 * block.
 */
export function withJourneys(
  plan: DayPlan,
  timed: DayPlanItem[]
): { items: DayPlanItem[]; journeys: Map<string, Journey> } {
  const journeys = journeysByBlock(plan, timed);
  const absorbed = new Set([...journeys.values()].flatMap((journey) => journey.legs.map((leg) => leg.id)));
  return { items: timed.filter((item) => !absorbed.has(item.id)), journeys };
}

/** When each journey-carrying block's lane has to start: its leave time, for `laneLayout`. */
export function journeyReach(journeys: Map<string, Journey>): Map<string, Date> {
  return new Map([...journeys].map(([blockId, journey]) => [blockId, journey.leaveBy.startsAt]));
}

/**
 * What the timed lane's layout has to keep: each journey's lane starting at its leave time, and every
 * block with a time of its own (a commitment, a fixed routine, sleep, a recorded session) on that
 * time, so the engine's projected blocks give way around it rather than push it late.
 */
export function laneAnchors(plan: DayPlan, blocks: DayPlanItem[]): LaneAnchors {
  return {
    reachFrom: journeyReach(journeysByBlock(plan, blocks)),
    pinned: new Set(
      blocks.filter((block) => block.source === "fixed" || block.source === "recorded").map((block) => block.id)
    )
  };
}

/**
 * The stay a block happens in, for the phone's coloured left edge that stands in for the location
 * strip. Read at the block's midpoint, so a block that starts on the stroke of a move is coloured by
 * where it is spent; none in transit or outside every stay.
 */
export function stayColourFor(plan: DayPlan, item: DayPlanItem): string | null {
  const middle = (item.startsAt.getTime() + item.endsAt.getTime()) / 2;
  const stay = plan.locations.find(
    (candidate) => candidate.startsAt.getTime() <= middle && middle < candidate.endsAt.getTime()
  );
  return stay?.locationId ? locationColour(stay.locationId) : null;
}

/**
 * Where the "next up" chips settle: the first gap after now wide enough to hold them, so they never
 * cover something that does have a time. Null when the rest of the day is spoken for, which leaves
 * the caller to put the chips somewhere off the canvas. Only stated blocks are in the way — a
 * projected block is the engine's guess, and the chips are the same guess left unplaced.
 */
export function untimedAnchor(plan: DayPlan, blocks: DayPlanItem[]): Date | null {
  if (!plan.untimed.length || !plan.nowAt) return null;
  return firstGapAfter(
    blocks.filter((item) => item.source !== "engine"),
    plan.nowAt,
    plan.bounds,
    UNTIMED_GAP_MINUTES
  );
}

/**
 * Where each window's label chip sits, in canvas pixels: the first stretch inside its band that no
 * drawn block (nor a journey bar, nor an earlier window's chip) covers. The chip is drawn under the
 * blocks, so at the band's top it used to sit beneath the day's events and show a few letters in the
 * gaps between their lanes. Null when the band has no clear stretch at all; the caller then keeps the
 * chip at the band's top (the day view, where the chip is the window's only target) or leaves it out
 * (a week column, where the band's tint still says the window is there and the day view opens it).
 */
export function windowLabelTops(
  windows: DayPlanItem[],
  bounds: DayWindow,
  pixelsPerHour: number,
  occupied: Array<{ top: number; bottom: number }>
): Map<string, number | null> {
  const taken = [...occupied];
  const tops = new Map<string, number | null>();
  const ordered = [...windows].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  for (const window of ordered) {
    const band = blockGeometry(window, bounds, pixelsPerHour, MIN_WINDOW_PX);
    const bandBottom = band.top + band.height;
    let top = band.top + 2;
    // Each clash moves the chip to the bottom of what it hit; the list is short, so a rescan is cheap.
    for (let moved = true; moved && top + WINDOW_LABEL_PX <= bandBottom;) {
      moved = false;
      for (const rect of taken) {
        if (rect.top < top + WINDOW_LABEL_PX && rect.bottom > top) {
          top = rect.bottom + 1;
          moved = true;
        }
      }
    }
    const fits = top + WINDOW_LABEL_PX <= bandBottom;
    tops.set(window.id, fits ? top : null);
    if (fits) taken.push({ top, bottom: top + WINDOW_LABEL_PX });
  }
  return tops;
}

/**
 * One eligibility window: a translucent band across the day with a single label chip at its top.
 *
 * The band takes no column and no clicks — the day's real events are drawn over it at full width —
 * and the chip is the whole of the target, so the window opens the same detail sheet a block would
 * without turning three hours of empty canvas into one enormous button. Where two windows overlap
 * their chips step down one after another; the bands themselves simply tint the same stretch twice,
 * which is what two overlapping windows are.
 */
function WindowBand({
  item,
  bounds,
  pixelsPerHour,
  column,
  labelTop,
  hideCrowdedLabel,
  label,
  onSelect
}: {
  item: DayPlanItem;
  bounds: DayWindow;
  pixelsPerHour: number;
  column: number;
  /** Where `windowLabelTops` put the chip on the canvas; null when the band has no clear stretch. */
  labelTop: number | null;
  hideCrowdedLabel: boolean;
  label: string;
  onSelect: (item: DayPlanItem) => void;
}) {
  const geometry = blockGeometry(item, bounds, pixelsPerHour, MIN_WINDOW_PX);
  if (labelTop === null && hideCrowdedLabel)
    return (
      <li
        className="day-timeline-window"
        style={{ top: `${geometry.top}px`, height: `${geometry.height}px` }}
        title={label}
      />
    );
  return (
    <li className="day-timeline-window" style={{ top: `${geometry.top}px`, height: `${geometry.height}px` }}>
      <button
        type="button"
        className="day-timeline-window-label"
        style={{ top: `${labelTop === null ? 2 + column * WINDOW_LABEL_STEP_PX : labelTop - geometry.top}px` }}
        aria-label={label}
        title={label}
        onClick={() => onSelect(item)}
      >
        {item.title}
        {item.subtitle ? ` · ${item.subtitle}` : ""}
      </button>
    </li>
  );
}

export function UntimedChip({
  chip,
  onSelect
}: {
  chip: DayPlanUntimed;
  onSelect?: ((chip: DayPlanUntimed) => void) | undefined;
}) {
  const text = `${chip.title} · ${chip.minutes} min`;
  if (!onSelect) return <span className="day-timeline-chip">{text}</span>;
  return (
    <button type="button" className="day-timeline-chip" onClick={() => onSelect(chip)} title={chip.reason}>
      {text}
    </button>
  );
}

export function blockClass(item: DayPlanItem): string {
  const classes = ["day-timeline-block", `day-timeline-block-${item.source}`, `day-timeline-block-kind-${item.kind}`];
  if (item.grouped) classes.push("grouped");
  if (item.tentative) classes.push("tentative");
  if (item.presence === "anchor") classes.push("presence-anchor");
  if (item.projected) classes.push("projected");
  if (item.displaced) classes.push("displaced");
  if (item.stale) classes.push("stale");
  if (item.clippedStart) classes.push("clipped-start");
  if (item.clippedEnd) classes.push("clipped-end");
  return classes.join(" ");
}

export function formatDeadline(at: Date, timezone: string): string {
  return dateTimeFormat(displayLocale(), {
    timeZone: timezone,
    weekday: "short",
    day: "numeric",
    month: "short"
  }).format(at);
}
