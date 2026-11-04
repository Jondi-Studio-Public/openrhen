"use client";

import type { CSSProperties } from "react";
import {
  assignColumns,
  blockGeometry,
  dayLengthMinutes,
  laneLayout,
  toPixels,
  MIN_BLOCK_PX
} from "@/features/today/day-layout";
import {
  groupCrampedRuns,
  type DayPlan,
  type DayPlanItem,
  type DayPlanLocation,
  type DayPlanUntimed,
  type DayPlanWait
} from "@/features/today/day-plan";
import { hourMarks } from "@/features/today/local-datetime";
import { wakingRange } from "@/features/today/day-summary";
import styles from "./day-timeline.module.css";
import { formatZonedTime } from "@/shared/date-format";
import { TimelineTrack, UntimedChip, laneAnchors, locationColour, withJourneys, untimedAnchor } from "./timeline-track";

export { blockClass, formatDeadline, locationColour } from "./timeline-track";

/** How much of the hour before the waking day shows above a cropped canvas: room for its first label. */
const CROP_LEAD_PX = 10;

/** Below this a stay is a coloured sliver only; a word inside it would be unreadable anyway. */
const LOCATION_LABEL_PX = 34;
/**
 * The day drawn to scale. Every block has a start and an end: a stated fact, or — tagged
 * "projected" and drawn lighter — a block of the engine's forward-simulated day, which will move as
 * the day does. The strip of "next up" chips is the one thing on the canvas that is deliberately not
 * proportional, and it appears only for a plan with no projected day: the engine has ranked those
 * items but not placed them. An eligibility window is neither: it is drawn as a band behind the day
 * with one label chip, because it says when something *may* happen and would otherwise take a column
 * away from the things that are actually happening then. Backgrounds show sleep, the engine's capacity shading
 * from the calculation time forward, and the part of the day already gone; the now-line is drawn
 * only on today, from the provider's clock so a replay stays frozen.
 *
 * The measuring is done here and the drawing in `TimelineTrack`: the hour gutter and the location
 * strip are this one day's own furniture, and the track between them is the part a grid of days
 * reuses a day at a time.
 */
export function DayTimeline({
  plan,
  timezone,
  pixelsPerHour,
  showReserved,
  onSelect,
  onSelectWait,
  onSelectUntimed,
  cropToWaking = false
}: {
  plan: DayPlan;
  timezone: string;
  pixelsPerHour: number;
  showReserved: boolean;
  /**
   * Draw only the waking day — wake to bed, widened to whatever else the day holds — instead of the
   * whole midnight-to-midnight canvas. The canvas underneath is the same; the night is cropped off.
   */
  cropToWaking?: boolean;
  onSelect: (item: DayPlanItem) => void;
  onSelectWait?: ((wait: DayPlanWait) => void) | undefined;
  onSelectUntimed?: ((chip: DayPlanUntimed) => void) | undefined;
}) {
  const { bounds } = plan;
  const marks = hourMarks(bounds, timezone);
  const time = (value: Date) => formatZonedTime(value, timezone);
  const px = (minutes: number) => toPixels(minutes, pixelsPerHour);
  // Windows come out of the blocks first: an eligibility window is hours wide and holds nothing, so
  // leaving it among the blocks made it take a column of its own and squeeze the events that do have
  // somewhere to be into slivers beside it. The track draws it as a band behind them instead, and the
  // columns here are shared out among concrete events alone.
  //
  // Folding then comes before the geometry: a folded run is one block, so it usually needs no cascade
  // at all. Reservations are left unfolded — they are already merged per action upstream, and a run of
  // them stands for different work rather than one stretch of it.
  const { items: timed } = withJourneys(
    plan,
    plan.items.filter((item) => !item.marker && !item.window)
  );
  const blocks = groupCrampedRuns(timed, pixelsPerHour, MIN_BLOCK_PX);
  const timedLane = laneLayout(blocks, bounds, pixelsPerHour, MIN_BLOCK_PX, laneAnchors(plan, blocks));
  const reservedLane = laneLayout(plan.reserved, bounds, pixelsPerHour);
  // A late run of short blocks can be pushed past the last hour. Grow the canvas rather than clip it:
  // the extra pixels are empty day, and a block drawn outside the canvas is a block nobody can reach.
  const height = Math.max(
    toPixels(dayLengthMinutes(bounds), pixelsPerHour),
    timedLane.cascade.bottom,
    showReserved ? reservedLane.cascade.bottom : 0
  );
  const anchor = untimedAnchor(plan, blocks);
  // Latest-safe reservations are drawn only on request, and then they widen the crop like anything else.
  const range = cropToWaking ? wakingRange(plan, anchor ? [anchor] : [], showReserved ? plan.reserved : []) : null;
  // A little of the hour before shows above the crop, so the first hour's label is not cut in half.
  const cropTop = range ? Math.max(0, px(range.start) - CROP_LEAD_PX) : 0;
  // A crowded run can push blocks below the hour they name; the crop still reaches the last of them.
  // The night's own block is left out of that, or it would pull the whole night back in.
  const lowest = (items: DayPlanItem[], lane: typeof timedLane) =>
    items
      .filter((item) => item.kind !== "sleep")
      .reduce((bottom, item) => {
        const placed = lane.cascade.placements.get(item.id);
        return placed ? Math.max(bottom, placed.top + placed.height) : bottom;
      }, 0);
  const pushedBottom = Math.max(lowest(blocks, timedLane), showReserved ? lowest(plan.reserved, reservedLane) : 0);
  // The same lead below, so the last hour's label is not cut in half either.
  const cropBottom = range ? Math.min(height, Math.max(px(range.end), pushedBottom) + CROP_LEAD_PX) : height;

  return (
    <div
      className="day-timeline"
      style={{ "--dt-hour-px": `${pixelsPerHour}px`, "--dt-height": `${height}px` } as CSSProperties}
    >
      <div className={styles.crop} style={{ height: `${cropBottom - cropTop}px` }}>
        <div className="day-timeline-canvas" style={{ height: `${height}px`, marginTop: `${-cropTop}px` }}>
          <div className="day-timeline-gutter" aria-hidden="true">
            {marks.map((mark, index) => (
              <span
                key={`${mark.at.toISOString()}`}
                className="day-timeline-hour"
                style={{ top: `${px(mark.minuteOffset)}px` }}
                data-hour={mark.hour}
              >
                {index === 0 || px(mark.minuteOffset) < cropTop + CROP_LEAD_PX / 2 ? "" : mark.label}
              </span>
            ))}
          </div>
          {plan.locations.length > 0 && (
            <ol className="day-timeline-locations" aria-label="Where the projected day puts you">
              {plan.locations.map((stay) => (
                <LocationSegment key={stay.id} stay={stay} plan={plan} pixelsPerHour={pixelsPerHour} time={time} />
              ))}
            </ol>
          )}
          {plan.waits.length > 0 && (
            <ol className="day-timeline-waits" aria-label="Waits">
              {plan.waits.map((wait) => (
                <WaitSegment
                  key={wait.id}
                  wait={wait}
                  waits={plan.waits}
                  plan={plan}
                  pixelsPerHour={pixelsPerHour}
                  time={time}
                  onSelect={onSelectWait}
                />
              ))}
            </ol>
          )}
          <TimelineTrack
            plan={plan}
            timezone={timezone}
            pixelsPerHour={pixelsPerHour}
            height={height}
            showReserved={showReserved}
            onSelect={onSelect}
            onSelectUntimed={onSelectUntimed}
            timedLane={timedLane}
            reservedLane={reservedLane}
            blocks={blocks}
            visibleFrom={cropTop}
          />
        </div>
      </div>
      {plan.nowAt && (
        <p className="day-timeline-sr" aria-live="polite">
          Now {time(plan.nowAt)}
        </p>
      )}
      {plan.untimed.length > 0 && !anchor && (
        <div
          className="day-timeline-untimed day-timeline-untimed-foot"
          role="group"
          aria-label="Next up, not yet timed"
        >
          <span className="day-timeline-untimed-label">Next up · not timed</span>
          {plan.untimed.map((chip) => (
            <UntimedChip key={chip.id} chip={chip} onSelect={onSelectUntimed} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * One stay in the location strip: a coloured segment beside the hour gutter, hatched while in
 * transit because you are nowhere in particular then and nothing is eligible. The name is on the
 * title only: written down the strip it ran into the hour labels, and each block already carries its
 * place as a left edge in the same colour.
 */
function LocationSegment({
  stay,
  plan,
  pixelsPerHour,
  time
}: {
  stay: DayPlanLocation;
  plan: DayPlan;
  pixelsPerHour: number;
  time: (value: Date) => string;
}) {
  const geometry = blockGeometry(stay, plan.bounds, pixelsPerHour);
  const transit = stay.locationId === null;
  return (
    <li
      className={`day-timeline-location${transit ? " transit" : ""}`}
      style={{
        top: `${geometry.top}px`,
        height: `${geometry.height}px`,
        ...(transit ? {} : { background: locationColour(stay.locationId!) })
      }}
      title={`${stay.label} · ${time(stay.startsAt)}–${time(stay.endsAt)}`}
    ></li>
  );
}

/**
 * One segment of the waits strip: free time after a
 * step's hands-on work, never a block and never full-width. A running wait (a completed step) is
 * solid; a projected one (a pending step) is lighter. Overlapping waits share the strip, packed into
 * columns the same way a window's overlaps are (`assignColumns`).
 */
function WaitSegment({
  wait,
  waits,
  plan,
  pixelsPerHour,
  time,
  onSelect
}: {
  wait: DayPlanWait;
  waits: DayPlanWait[];
  plan: DayPlan;
  pixelsPerHour: number;
  time: (value: Date) => string;
  onSelect?: ((wait: DayPlanWait) => void) | undefined;
}) {
  const geometry = blockGeometry(wait, plan.bounds, pixelsPerHour);
  const columns = assignColumns(waits).get(wait.id) ?? { column: 0, columns: 1 };
  const label = `${wait.title.split(" · ")[0]} · ready ${time(wait.endsAt)}`;
  return (
    <li
      className={`day-timeline-wait${wait.running ? " running" : " projected"}${wait.stale ? " stale" : ""}`}
      style={{
        top: `${geometry.top}px`,
        height: `${geometry.height}px`,
        left: `${(columns.column / columns.columns) * 100}%`,
        width: `${(1 / columns.columns) * 100}%`
      }}
      title={`${wait.title} · ${wait.anchorTitle}`}
      onClick={onSelect ? () => onSelect(wait) : undefined}
    >
      {geometry.height >= LOCATION_LABEL_PX && <span>{label}</span>}
    </li>
  );
}
