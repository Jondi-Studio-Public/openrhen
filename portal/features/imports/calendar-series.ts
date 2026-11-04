import { commitmentRepeatFallsOn, normalizeRepeatWeekdays, type CommitmentRepeat } from "@openrhen/contracts";

/** Structural subset of a shared-calendar event (@openrhen/contracts) — duplicated rather than
 * imported because this module is browser-safe and the full contract import isn't needed here. */
export interface CalendarSeriesEvent {
  externalEventId: string;
  title: string;
  startsAt: string;
  endsAt: string;
  location: string | null;
  recurring: boolean;
  seriesId: string | null;
}

export interface CalendarSeriesGroup<TEvent extends CalendarSeriesEvent = CalendarSeriesEvent> {
  seriesId: string;
  title: string;
  location: string | null;
  startDate: string;
  /** The spacing of a uniform days series; null for a weekday-set series, whose rule is `repeat`. */
  intervalDays: number | null;
  /** The rule the series imports as: every N days, or every N weeks on a weekday set. */
  repeat: CommitmentRepeat;
  localStartTime: string;
  localEndTime: string;
  events: TEvent[];
}

const DAY = 86_400_000;

/**
 * A shared calendar may expand a recurring event into one instance per occurrence rather than returning an
 * RRULE, so a fortnightly appointment otherwise imports as N separate one-off commitments. This
 * groups same-series instances back into a single recurring commitment when their local date
 * spacing is perfectly uniform (covers weekly/fortnightly/daily-style series); anything irregular
 * — a skipped week, a moved occurrence, differing times — falls back to individual commitments so
 * nothing is silently misrepresented. The exception is a weekday set: Tuesday-and-Thursday
 * arrives as alternating gaps, so when the dates seen are exactly what a weekly or fortnightly
 * weekday rule produces between the first and last date, it groups as one weeks rule.
 */
export function groupCalendarSeries<TEvent extends CalendarSeriesEvent>(
  events: TEvent[],
  timezone: string
): { series: Array<CalendarSeriesGroup<TEvent>>; ungrouped: TEvent[] } {
  const bySeries = new Map<string, TEvent[]>();
  const ungrouped: TEvent[] = [];
  for (const event of events) {
    if (!event.recurring || !event.seriesId) {
      ungrouped.push(event);
      continue;
    }
    bySeries.set(event.seriesId, [...(bySeries.get(event.seriesId) ?? []), event]);
  }
  const series: Array<CalendarSeriesGroup<TEvent>> = [];
  for (const [seriesId, group] of bySeries) {
    const sorted = [...group].sort((left, right) => left.startsAt.localeCompare(right.startsAt));
    if (sorted.length < 2) {
      ungrouped.push(...sorted);
      continue;
    }
    const parsed = sorted.map((event) => ({
      event,
      start: localDateTime(event.startsAt, timezone),
      end: localDateTime(event.endsAt, timezone)
    }));
    const first = parsed[0]!;
    const uniformShape = parsed.every(
      (item) =>
        item.event.title === first.event.title &&
        (item.event.location ?? null) === (first.event.location ?? null) &&
        item.start.time === first.start.time &&
        item.end.time === first.end.time
    );
    const ordinals = parsed.map((item) => dateOrdinal(item.start.date));
    const interval = ordinals[1]! - ordinals[0]!;
    const uniformInterval =
      interval > 0 && ordinals.every((ordinal, index) => index === 0 || ordinal - ordinals[index - 1]! === interval);
    const weeksRepeat = uniformShape && !uniformInterval ? weekdaySetRepeat(ordinals, parsed[0]!.start.date) : null;
    if (uniformShape && weeksRepeat) {
      series.push({
        seriesId,
        title: first.event.title,
        location: first.event.location,
        startDate: first.start.date,
        intervalDays: null,
        repeat: weeksRepeat,
        localStartTime: first.start.time,
        localEndTime: first.end.time,
        events: sorted
      });
    } else if (uniformShape && uniformInterval) {
      series.push({
        seriesId,
        title: first.event.title,
        location: first.event.location,
        startDate: first.start.date,
        intervalDays: interval,
        repeat: { unit: "days", intervalDays: interval },
        localStartTime: first.start.time,
        localEndTime: first.end.time,
        events: sorted
      });
    } else {
      ungrouped.push(...sorted);
    }
  }
  return { series, ungrouped };
}

/**
 * A weekly (1) or fortnightly (2) rule on the weekdays seen, if every date it falls on from the
 * first seen date to the last is exactly a date that was seen — no gap a rule would fill, no date it
 * would not produce. Two events on one day are not a weekday set.
 */
function weekdaySetRepeat(ordinals: number[], startDate: string): CommitmentRepeat | null {
  if (new Set(ordinals).size !== ordinals.length) return null;
  const weekdays = normalizeRepeatWeekdays(ordinals.map(weekdayOfOrdinal));
  const seen = new Set(ordinals);
  for (const intervalWeeks of [1, 2]) {
    const repeat: CommitmentRepeat = { unit: "weeks", intervalWeeks, weekdays };
    let matches = true;
    for (let ordinal = ordinals[0]!; ordinal <= ordinals[ordinals.length - 1]! && matches; ordinal += 1) {
      matches = commitmentRepeatFallsOn(repeat, startDate, dateFromOrdinal(ordinal)) === seen.has(ordinal);
    }
    if (matches) return repeat;
  }
  return null;
}

/** 0 = Sunday .. 6 = Saturday; day 0 of the epoch, 1970-01-01, was a Thursday. */
function weekdayOfOrdinal(ordinal: number): number {
  return (((ordinal + 4) % 7) + 7) % 7;
}

function dateFromOrdinal(ordinal: number): string {
  return new Date(ordinal * DAY).toISOString().slice(0, 10);
}

function localDateTime(iso: string, timezone: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date(iso));
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "00";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, time: `${get("hour")}:${get("minute")}` };
}

function dateOrdinal(value: string): number {
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  return Math.floor(Date.UTC(year, month - 1, day) / DAY);
}
