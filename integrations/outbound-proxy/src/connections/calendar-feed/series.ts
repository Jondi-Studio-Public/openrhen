// Series mapping for the calendar feed (build plan PR 5; series design v3 as amended). A repeating master whose rule the
// portal's commitment recurrence can follow exactly gets a rule descriptor; anything else gets a fixed reason and is not
// imported as a series (plan path D). The proxy still emits every expanded instance; the descriptor is an extra.
//
// "Exactly" is checked, not assumed: the mapped repeat is expanded by the contracts function the portal uses
// (`commitmentRepeatFallsOn`) over the next 400 days and must produce the same dates as the proxy's own expansion, at
// the same instants (the contracts `zonedDateTime`, not this folder's `localToInstant`). Anything that differs, such as a
// wall time inside a daylight-saving gap or fold, makes the series unrepresentable rather than subtly wrong.
import { CALENDAR_FEED_SERIES_MAX_CHARS } from "@openrhen/contracts/integrations/calendar-feed-limits";
import type { CalendarFeedSeries, CalendarFeedSeriesException } from "@openrhen/contracts/integrations/calendar-feed";
import { commitmentRepeatFallsOn } from "@openrhen/contracts/commitment-repeat-falls-on";
import type { CommitmentRepeat } from "@openrhen/contracts/commitment-repeat";
import { zonedDateTime } from "@openrhen/contracts/zoned-time";
import { dayFields, dayNumber, expandDays, weekdayOf, type ExpandContext, type Rule } from "./rrule.js";
import { instantToLocal, localToInstant, type LocalDateTime } from "./zones.js";

/** How far ahead the safety net compares the two expansions. The planner's horizon is 180 days; this is deliberately wider. */
export const SAFETY_NET_DAYS = 400;
const LAST_DAY = dayNumber(9999, 12, 31);

/** One RECURRENCE-ID override of a master, already reduced to what the series needs. */
export interface SeriesOverride {
  /** The original occurrence date, `YYYYMMDD` in the series zone. */
  key: string;
  status: "confirmed" | "tentative" | "cancelled";
  title: string;
  location: string;
  allDay: boolean;
  startUtc: number;
  /** Milliseconds, for a timed override. */
  length: number;
}

export interface SeriesInput {
  uid: string;
  stem: string;
  title: string;
  location: string;
  status: "confirmed" | "tentative" | "cancelled";
  /** The DTSTART moment kind. Only `zoned` (a TZID was given) is representable. */
  startKind: "date" | "utc" | "floating" | "zoned";
  zone: string;
  startLocal: LocalDateTime;
  /** Milliseconds, for a timed master. */
  length: number;
  rule: Rule;
  /** Local `YYYYMMDD` in the series zone. */
  exdates: ReadonlySet<string>;
  overrides: readonly SeriesOverride[];
  /** A RANGE=THISANDFUTURE change exists for this UID. It is skipped by the parser, so the rule alone would be wrong. */
  hasThisAndFuture: boolean;
}

export type SeriesOutcome = { series: CalendarFeedSeries } | { reason: string };

const pad = (n: number, w = 2) => String(n).padStart(w, "0");
const isoOfDay = (day: number): string => {
  const f = dayFields(day);
  return `${pad(f.y, 4)}-${pad(f.m)}-${pad(f.d)}`;
};
const isoOfKey = (key: string): string => `${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6, 8)}`;
const hhmm = (l: { h: number; mi: number }): string => `${pad(l.h)}:${pad(l.mi)}`;

// Many series share a zone and a wall time, and each is checked over 400 days: remember the instants (one parse runs in
// a fresh worker, so this lives and dies with it; the cap only guards a long-lived caller such as a test run).
const instants = new Map<string, number>();
function memo(key: string, compute: () => number): number {
  const known = instants.get(key);
  if (known !== undefined) return known;
  if (instants.size >= 100_000) instants.clear();
  const value = compute();
  instants.set(key, value);
  return value;
}

class Unrepresentable extends Error {}
const refuse = (reason: string): never => {
  throw new Unrepresentable(reason);
};

/** RRULE to the portal's repeat, or a reason. Only shapes `commitmentRepeatFallsOn` can express; the safety net still has the last word. */
export function mapRepeat(rule: Rule, startDay: number): CommitmentRepeat | string {
  const start = dayFields(startDay);
  const startWeekday = weekdayOf(startDay);
  const sunday0 = (monday0: number) => (monday0 + 1) % 7;
  const plainDays = rule.byDay.every((d) => d.ord === null);
  const weekdaysOf = () => [...new Set(rule.byDay.map((d) => sunday0(d.day)))].sort((a, b) => a - b);
  switch (rule.freq) {
    case "DAILY":
      if (rule.byDay.length + rule.byMonthDay.length + rule.byMonth.length + rule.bySetPos.length === 0)
        return { unit: "days", intervalDays: rule.interval };
      if (
        rule.interval === 1 &&
        rule.byDay.length > 0 &&
        plainDays &&
        rule.byMonthDay.length + rule.byMonth.length + rule.bySetPos.length === 0
      )
        return { unit: "weeks", intervalWeeks: 1, weekdays: weekdaysOf() };
      return "daily rule with limits";
    case "WEEKLY":
      if (rule.byMonthDay.length + rule.byMonth.length + rule.bySetPos.length > 0) return "weekly rule with limits";
      return {
        unit: "weeks",
        intervalWeeks: rule.interval,
        weekdays: rule.byDay.length > 0 ? weekdaysOf() : [sunday0(startWeekday)]
      };
    case "MONTHLY": {
      if (rule.byMonth.length > 0) return "monthly rule with limits";
      if (rule.byDay.length === 0) {
        if (rule.bySetPos.length > 0) return "monthly rule with limits";
        if (rule.byMonthDay.length === 0)
          return { unit: "months", intervalMonths: rule.interval, anchor: "day_of_month" };
        if (rule.byMonthDay.length === 1 && rule.byMonthDay[0] === -1)
          return { unit: "months", intervalMonths: rule.interval, anchor: "last_day" };
        if (rule.byMonthDay.length === 1 && rule.byMonthDay[0] === start.d)
          return { unit: "months", intervalMonths: rule.interval, anchor: "day_of_month" };
        return "monthly rule on several or other days";
      }
      if (rule.byMonthDay.length > 0 || rule.byDay.length !== 1) return "monthly rule on several or other days";
      const only = rule.byDay[0]!;
      if (only.day !== startWeekday) return "monthly weekday differs from the start";
      let ordinal = only.ord;
      if (ordinal === null) {
        if (rule.bySetPos.length !== 1) return "monthly rule on several or other days";
        ordinal = rule.bySetPos[0]!;
      } else if (rule.bySetPos.length > 0) return "monthly rule on several or other days";
      if (ordinal >= 1 && ordinal <= 4) return { unit: "months", intervalMonths: rule.interval, anchor: "nth_weekday" };
      if (ordinal === -1) return { unit: "months", intervalMonths: rule.interval, anchor: "last_weekday" };
      return "monthly weekday position not supported";
    }
    case "YEARLY":
      if (rule.byDay.length > 0 || rule.bySetPos.length > 0) return "yearly rule with limits";
      if (rule.byMonth.length > 0 && !(rule.byMonth.length === 1 && rule.byMonth[0] === start.m))
        return "yearly rule in other months";
      if (rule.byMonthDay.length > 0 && !(rule.byMonthDay.length === 1 && rule.byMonthDay[0] === start.d))
        return "yearly rule on other days";
      return { unit: "months", intervalMonths: 12 * rule.interval, anchor: "day_of_month" };
  }
}

/** Build the descriptor for one repeating master, or say why it cannot be one. Throws only `BudgetExceeded` (from `ctx`). */
export function buildSeries(input: SeriesInput, nowMs: number, ctx: ExpandContext): SeriesOutcome {
  try {
    return { series: build(input, nowMs, ctx) };
  } catch (error) {
    if (error instanceof Unrepresentable) return { reason: error.message };
    throw error;
  }
}

function build(input: SeriesInput, nowMs: number, ctx: ExpandContext): CalendarFeedSeries {
  const { rule, zone } = input;
  // Precondition: a TZID, a timed event, wall times on the minute, one local day.
  if (input.hasThisAndFuture) refuse("this-and-future change");
  if (input.startKind === "date") refuse("all-day repeating event");
  if (input.startKind !== "zoned") refuse("no time zone on the start");
  const local = input.startLocal;
  if (local.s !== 0) refuse("start time has seconds");
  const startDay = dayNumber(local.y, local.m, local.d);
  const startDate = isoOfDay(startDay);
  const startTime = hhmm(local);
  const startInstant = localToInstant(zone, { ...local, s: 0 });
  const endLocal = instantToLocal(zone, startInstant + input.length);
  if (endLocal.s !== 0) refuse("end time has seconds");
  if (
    dayNumber(endLocal.y, endLocal.m, endLocal.d) !== startDay ||
    endLocal.h * 60 + endLocal.mi <= local.h * 60 + local.mi
  )
    refuse("event does not end on its start day");
  const endTime = hhmm(endLocal);

  const mapped = mapRepeat(rule, startDay);
  if (typeof mapped === "string") return refuse(mapped);
  const repeat = mapped;
  // The contracts rule: a weekly or monthly repeat must fall on its own start date, or the portal rejects it.
  if (!commitmentRepeatFallsOn(repeat, startDate, startDate)) refuse("start date is not on the rule");

  const proxyStart = (day: number): number =>
    memo(`p|${zone}|${day}|${startTime}`, () =>
      localToInstant(zone, { ...dayFields(day), h: local.h, mi: local.mi, s: 0 })
    );
  const portalStart = (day: number): number =>
    memo(`c|${zone}|${day}|${startTime}`, () => zonedDateTime(isoOfDay(day), startTime, zone).getTime());
  const portalEnd = (day: number): number =>
    memo(`c|${zone}|${day}|${endTime}`, () => zonedDateTime(isoOfDay(day), endTime, zone).getTime());

  // UNTIL as an instant (a UTC one is absolute; a floating or date one is wall time in the series zone), compared per
  // instance, never by its date.
  const until = rule.until;
  const untilMs =
    until === null
      ? null
      : until.kind === "utc"
        ? Date.UTC(until.y, until.m - 1, until.d, until.h, until.mi, until.s)
        : localToInstant(zone, { y: until.y, m: until.m, d: until.d, h: until.h, mi: until.mi, s: until.s });
  const proxyOk = (day: number) => untilMs === null || proxyStart(day) <= untilMs;
  const portalOk = (day: number) => untilMs === null || portalStart(day) <= untilMs;

  // The last instance, when COUNT or UNTIL bounds the series. COUNT counts every instance, excluded ones included.
  let endDay: number | null = null;
  if (rule.count !== null) {
    const all = expandDays(rule, startDay, startDay, LAST_DAY, ctx);
    if (all.capped) refuse("recurrence too long");
    endDay = all.days.filter(portalOk).at(-1) ?? null;
    if (endDay === null) refuse("series ends before it starts");
  } else if (until !== null) {
    const untilDay = dayNumber(until.y, until.m, until.d);
    const periodDays = rule.freq === "DAILY" ? 1 : rule.freq === "WEEKLY" ? 7 : rule.freq === "MONTHLY" ? 31 : 366;
    const from = Math.max(startDay, untilDay - Math.max(SAFETY_NET_DAYS, periodDays * rule.interval * 2));
    const near = expandDays(rule, startDay, from, untilDay + 1, ctx);
    if (near.capped) refuse("recurrence too long");
    endDay = near.days.filter(portalOk).at(-1) ?? null;
    if (endDay === null) refuse("series ends before it starts");
  }

  // The 400-day safety net, from yesterday (in the series zone) so a rule that began years ago is checked where it matters.
  const today = instantToLocal(zone, nowMs);
  const todayDay = dayNumber(today.y, today.m, today.d);
  const yesterdayDate = isoOfDay(todayDay - 1);
  const rangeFrom = Math.max(startDay, todayDay - 1);
  const rangeTo = todayDay + SAFETY_NET_DAYS;
  const expansion = expandDays(rule, startDay, rangeFrom, rangeTo, ctx);
  if (expansion.capped) refuse("recurrence too long");
  const proxyDays = expansion.days.filter(proxyOk);
  const portalDays: number[] = [];
  for (let day = rangeFrom; day <= rangeTo && (endDay === null || day <= endDay); day++) {
    if (commitmentRepeatFallsOn(repeat, startDate, isoOfDay(day))) portalDays.push(day);
  }
  ctx.checkBudget();
  if (proxyDays.length !== portalDays.length || proxyDays.some((day, i) => day !== portalDays[i]))
    refuse("repeat does not match the feed's dates");
  let checked = 0;
  for (const day of proxyDays) {
    if (++checked % 64 === 0) ctx.checkBudget();
    if (proxyStart(day) !== portalStart(day) || proxyStart(day) + input.length !== portalEnd(day))
      refuse("a wall time changes with daylight saving");
  }

  // Exceptions: dates still ahead (older than yesterday are dropped). An override replaces an exclusion on its date.
  const onRule = new Set(portalDays.map(isoOfDay));
  const rangeFromDate = isoOfDay(rangeFrom);
  const rangeToDate = isoOfDay(rangeTo);
  const endDate = endDay === null ? null : isoOfDay(endDay);
  // A date the rule does not produce: false only inside the checked range, where that is known.
  const isInstance = (date: string): boolean => {
    if (date < startDate || (endDate !== null && date > endDate)) return false;
    return date < rangeFromDate || date > rangeToDate ? true : onRule.has(date);
  };
  const byDate = new Map<string, CalendarFeedSeriesException>();
  for (const key of [...input.exdates].sort()) {
    const date = isoOfKey(key);
    if (date >= yesterdayDate && isInstance(date)) byDate.set(date, { kind: "cancelled", date });
  }
  for (const o of [...input.overrides].sort((a, b) => (a.key < b.key ? -1 : 1))) {
    const date = isoOfKey(o.key);
    if (date < yesterdayDate) continue;
    if (o.status === "cancelled") {
      if (isInstance(date)) byDate.set(date, { kind: "cancelled", date });
      continue;
    }
    if (o.allDay) refuse("a change turns one date all-day");
    if (!isInstance(date)) refuse("a change on a date the rule does not produce");
    const s = instantToLocal(zone, o.startUtc);
    const e = instantToLocal(zone, o.startUtc + o.length);
    if (s.s !== 0 || e.s !== 0) refuse("a change has seconds in its times");
    const exception = {
      kind: "changed" as const,
      date,
      title: o.title,
      location: o.location,
      startDate: `${pad(s.y, 4)}-${pad(s.m)}-${pad(s.d)}`,
      localStartTime: hhmm(s),
      endDate: `${pad(e.y, 4)}-${pad(e.m)}-${pad(e.d)}`,
      localEndTime: hhmm(e)
    };
    // The safety net for exceptions: the portal writes this row from the wall-clock fields through the contracts
    // function, so it must land on the very instants the feed gave (not so on a repeated or skipped clock hour).
    if (
      zonedDateTime(exception.startDate, exception.localStartTime, zone).getTime() !== o.startUtc ||
      zonedDateTime(exception.endDate, exception.localEndTime, zone).getTime() !== o.startUtc + o.length
    )
      refuse("a change falls on a repeated or skipped clock time");
    const same =
      exception.title === input.title &&
      exception.location === input.location &&
      exception.startDate === date &&
      exception.endDate === date &&
      exception.localStartTime === startTime &&
      exception.localEndTime === endTime;
    if (!same) byDate.set(date, exception);
    else byDate.delete(date);
  }
  const exceptions = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const series: CalendarFeedSeries = {
    uid: input.uid,
    idPrefix: input.stem,
    timezone: zone,
    status: input.status,
    title: input.title,
    location: input.location,
    startDate,
    endDate,
    repeat,
    localStartTime: startTime,
    localEndTime: endTime,
    exceptions
  };
  if (JSON.stringify(series).length > CALENDAR_FEED_SERIES_MAX_CHARS) refuse("too many changes to describe");
  return series;
}
