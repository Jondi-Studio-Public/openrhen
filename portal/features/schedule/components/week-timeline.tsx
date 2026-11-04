"use client";

import { dateTimeFormat, displayLocale } from "@/shared/locale";
import { useEffect, useRef } from "react";
import { dayLengthMinutes, laneLayout, minuteOffset, toPixels } from "@/features/today/day-layout";
import { groupCrampedRuns, type DayPlan, type DayPlanItem } from "@/features/today/day-plan";
import { hourMarks } from "@/features/today/local-datetime";
import { TimelineTrack, laneAnchors, withJourneys } from "@/features/today/components/timeline-track";
import { durationLabel } from "@/features/today/day-summary";
import { Badge } from "@/components/ui/badge";
import { cx } from "@/components/ui/cx";
import styles from "./week-timeline.module.css";
import type { WeekPlan, WeekPlanDay } from "@/features/schedule/week-plan";

/**
 * Seven days beside each other on one set of hours.
 *
 * Nothing here lays a day out: each column is the same `TimelineTrack` the day view draws, measured
 * the same way `DayTimeline` measures it — windows out of the blocks, cramped runs folded, one lane
 * per list. The only thing this canvas does that a day alone cannot is agree on a height: a block
 * pushed past the last hour on Thursday would otherwise make Thursday taller than Wednesday and put
 * every hour rule in the week half an hour out of step with its neighbour. So the tallest column's
 * bottom is the height every column is given, and each is still laid out on its own day's bounds —
 * which is what keeps a clock-change day honest inside a week that mostly is not one.
 *
 * The now-line needs no flag: `buildDayPlan` sets `nowAt` only on the day `now` actually falls on,
 * so the one column that is today draws it and the other six cannot. The same fact names the column
 * to highlight, rather than a second opinion about which day it is arrived at here.
 */

/** Narrower columns than the day view's, so a short block still has a line to write its name on. */
const WEEK_MIN_BLOCK_PX = 18;

export function WeekTimeline({
  week,
  timezone,
  pixelsPerHour,
  free,
  due,
  now,
  onSelect
}: {
  week: WeekPlan;
  timezone: string;
  pixelsPerHour: number;
  /** Each day's free minutes, in the week's order; null where nothing says. */
  free?: Array<number | null>;
  /** What falls due each day, in the week's order, as a chip under the day's heading. */
  due?: Array<Array<{ id: string; label: string }>>;
  /** The clock the week opens at, when today is in it. */
  now?: Date;
  onSelect: (item: DayPlanItem) => void;
}) {
  // Sleep is left off the week: seven nights drawn to scale are most of the canvas and say nothing a
  // week is looked at for. The day view still draws them.
  const awake = { ...week, days: week.days.map((day) => ({ ...day, plan: withoutSleep(day.plan) })) };
  const columns = awake.days.map((day) => measureColumn(day, timezone, pixelsPerHour));
  // The tallest column sets the canvas. `dayLengthMinutes` is per day on purpose: on the day the
  // clocks change one of these seven is twenty-three or twenty-five hours long.
  const height = Math.max(
    ...columns.map((column) =>
      Math.max(toPixels(dayLengthMinutes(column.day.plan.bounds), pixelsPerHour), column.timedLane.cascade.bottom)
    )
  );
  // One gutter for the week, drawn from the first day's hours. Every column is measured from its own
  // midnight, so the marks line up with all seven; the labels are the first day's own.
  const marks = hourMarks(week.days[0]!.plan.bounds, timezone);
  const scroller = useRef<HTMLDivElement>(null);
  const firstDayKey = week.days[0]!.dayKey;
  const today = columns.find((column) => column.today);
  const openAt =
    today && now
      ? Math.max(0, Math.floor(minuteOffset(now, today.day.plan.bounds) / 60) * 60 - 60)
      : firstWakingMinute(awake);

  // Open the week holding today at the hour before now, and any other week at its first waking hour,
  // never at midnight. Once per week shown, so paging scrolls and a re-render never fights the reader.
  const scrolledFor = useRef<string | null>(null);
  useEffect(() => {
    if (!scroller.current || scrolledFor.current === firstDayKey) return;
    scrolledFor.current = firstDayKey;
    scroller.current.scrollTop = toPixels(openAt, pixelsPerHour);
  }, [firstDayKey, openAt, pixelsPerHour]);

  return (
    <div className={`week-timeline ${styles.timeline}`} role="group" aria-label="The week, drawn to scale">
      <div className="week-timeline-scroll" ref={scroller}>
        <div className="week-timeline-grid">
          <div className="week-timeline-corner" aria-hidden="true" />
          {columns.map((column, index) => (
            <div key={`head:${column.day.dayKey}`} className={`week-timeline-head${column.today ? " today" : ""}`}>
              <span className="week-timeline-weekday">{column.weekday}</span>
              <span className="week-timeline-date">{column.date}</span>
              <span className="week-timeline-count">
                {free?.[index] != null
                  ? `${durationLabel(free[index]!)} free`
                  : `${column.count} ${column.count === 1 ? "item" : "items"}`}
              </span>
              {due?.[index]?.map((chip) => (
                <Badge key={chip.id} tone="warn" className={cx(styles.due)} title={chip.label}>
                  {chip.label}
                </Badge>
              ))}
            </div>
          ))}
          <div
            className="day-timeline-gutter week-timeline-gutter"
            aria-hidden="true"
            style={{ height: `${height}px` }}
          >
            {marks.map((mark, index) => (
              <span
                key={mark.at.toISOString()}
                className="day-timeline-hour"
                style={{ top: `${toPixels(mark.minuteOffset, pixelsPerHour)}px` }}
                data-hour={mark.hour}
              >
                {index === 0 ? "" : mark.label}
              </span>
            ))}
          </div>
          {columns.map((column) => (
            <div
              key={column.day.dayKey}
              className={`week-timeline-column${column.today ? " today" : ""}`}
              role="group"
              aria-label={`${column.weekday} ${column.date}, ${column.count} ${column.count === 1 ? "item" : "items"}`}
            >
              <TimelineTrack
                plan={column.day.plan}
                timezone={timezone}
                pixelsPerHour={pixelsPerHour}
                height={height}
                minBlockPx={WEEK_MIN_BLOCK_PX}
                showReserved={false}
                showUntimed={false}
                dense
                selectable={(item) => !isProjectedOccurrence(item)}
                onSelect={onSelect}
                timedLane={column.timedLane}
                reservedLane={column.reservedLane}
                blocks={column.blocks}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Minutes after midnight to open the week at: half an hour before the earliest thing any day holds
 * that is not sleep, on the hour, or 6 am for a week with nothing in it.
 */
export function firstWakingMinute(week: WeekPlan): number {
  let earliest = Number.POSITIVE_INFINITY;
  for (const day of week.days)
    for (const item of day.plan.items) {
      if (item.kind === "sleep" || item.marker || item.window) continue;
      earliest = Math.min(earliest, Math.max(0, minuteOffset(item.startsAt, day.plan.bounds)));
    }
  if (!Number.isFinite(earliest)) return 6 * 60;
  return Math.max(0, Math.floor((earliest - 30) / 60) * 60);
}

/** The day without its sleep blocks or the sleep shading behind them. */
function withoutSleep(plan: DayPlan): DayPlan {
  return {
    ...plan,
    items: plan.items.filter((item) => item.kind !== "sleep"),
    backgrounds: plan.backgrounds.filter((band) => band.kind !== "sleep")
  };
}

/**
 * A commitment this week's arithmetic worked out rather than one the server has stored. It has no
 * row anywhere and so no page to open: the rule it came from is the thing that exists, and the
 * occurrence becomes real when the materialization job reaches that far out.
 */
export function isProjectedOccurrence(item: DayPlanItem): boolean {
  return item.entityId.startsWith("projected:");
}

interface WeekColumn {
  day: WeekPlanDay;
  blocks: DayPlanItem[];
  timedLane: ReturnType<typeof laneLayout>;
  reservedLane: ReturnType<typeof laneLayout>;
  /** How much the day holds, counted before the fold so a folded run still says it was six things. */
  count: number;
  weekday: string;
  date: string;
  today: boolean;
}

/** One column's geometry, worked out exactly as `DayTimeline` works out the day view's. */
function measureColumn(day: WeekPlanDay, timezone: string, pixelsPerHour: number): WeekColumn {
  const timed = day.plan.items.filter((item) => !item.marker && !item.window);
  const blocks = groupCrampedRuns(withJourneys(day.plan, timed).items, pixelsPerHour, WEEK_MIN_BLOCK_PX);
  return {
    day,
    blocks,
    timedLane: laneLayout(blocks, day.plan.bounds, pixelsPerHour, WEEK_MIN_BLOCK_PX, laneAnchors(day.plan, blocks)),
    // The week draws no reservations, so this lane is never read; the track takes one either way.
    reservedLane: laneLayout([], day.plan.bounds, pixelsPerHour, WEEK_MIN_BLOCK_PX),
    count: timed.length,
    ...columnHeading(day, timezone),
    today: day.plan.nowAt !== null
  };
}

/**
 * The column's heading, in two parts because it is drawn on two lines. Formatted from the day's own
 * bounds — local midnight — in the reader's zone, so the weekday named is the one their calendar
 * shows rather than the one UTC would have picked either side of the date line.
 */
export function columnHeading(day: WeekPlanDay, timezone: string): { weekday: string; date: string } {
  const formatter = dateTimeFormat(displayLocale(), {
    timeZone: timezone,
    weekday: "short",
    day: "numeric",
    month: "short"
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(day.plan.bounds.startsAt).map((part) => [part.type, part.value])
  );
  return { weekday: parts.weekday!, date: `${parts.day} ${parts.month}` };
}
