// RRULE subset for the calendar feed parser (design v4 (d)): DAILY, WEEKLY, MONTHLY, YEARLY with INTERVAL, COUNT, UNTIL,
// WKST, BYDAY (ordinals), BYMONTHDAY (negatives), BYMONTH and BYSETPOS. Anything else is refused with a reason.
// Works in whole local days (days since 1970-01-01 of the series' own wall calendar); times and zones are the caller's.

export const MAX_INTERVAL = 1000;
export const MAX_COUNT = 10_000;
export const MAX_PERIODS = 20_000;

export type Freq = "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
export interface DayRule {
  ord: number | null;
  /** 0 = Monday ... 6 = Sunday */
  day: number;
}
export interface UntilSpec {
  /** Local date (YYYYMMDD parts) or UTC instant. */
  kind: "date" | "floating" | "utc";
  y: number;
  m: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}
export interface Rule {
  freq: Freq;
  interval: number;
  count: number | null;
  until: UntilSpec | null;
  wkst: number;
  byDay: DayRule[];
  byMonthDay: number[];
  byMonth: number[];
  bySetPos: number[];
}

const DAYS: Record<string, number> = { MO: 0, TU: 1, WE: 2, TH: 3, FR: 4, SA: 5, SU: 6 };
const MS_DAY = 86_400_000;

export const dayNumber = (y: number, m: number, d: number): number => Math.floor(Date.UTC(y, m - 1, d) / MS_DAY);
export const dayFields = (n: number): { y: number; m: number; d: number } => {
  const date = new Date(n * MS_DAY);
  return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() };
};
/** 0 = Monday ... 6 = Sunday */
export const weekdayOf = (n: number): number => (((n + 3) % 7) + 7) % 7;
const daysInMonth = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate();

export function validDate(y: number, m: number, d: number): boolean {
  return y >= 1 && y <= 9999 && m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
}

export type ParsedRule = { rule: Rule } | { reason: string };

function ints(text: string, min: number, max: number, allowNegative: boolean): number[] | null {
  const out: number[] = [];
  for (const piece of text.split(",")) {
    if (!/^[+-]?\d+$/.test(piece.trim())) return null;
    const n = Number(piece);
    const abs = Math.abs(n);
    if (n === 0 || abs < min || abs > max || (!allowNegative && n < 0)) return null;
    out.push(n);
  }
  return out;
}

export function parseUntil(value: string): UntilSpec | null {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/i.exec(value.trim());
  if (!match) return null;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (!validDate(y, m, d)) return null;
  if (match[4] === undefined) return { kind: "date", y, m, d, h: 23, mi: 59, s: 59 };
  const [h, mi, s] = [Number(match[4]), Number(match[5]), Number(match[6])];
  if (h > 23 || mi > 59 || s > 60) return null;
  return { kind: match[7] ? "utc" : "floating", y, m, d, h, mi, s: Math.min(s, 59) };
}

export function parseRule(text: string): ParsedRule {
  const parts: Record<string, string> = {};
  for (const piece of text.split(";")) {
    const eq = piece.indexOf("=");
    if (eq <= 0) {
      if (piece.trim()) return { reason: "unreadable rule" };
      continue;
    }
    const key = piece.slice(0, eq).trim().toUpperCase();
    if (key in parts) return { reason: "repeated rule part" };
    parts[key] = piece.slice(eq + 1).trim();
  }
  const allowed = new Set(["FREQ", "INTERVAL", "COUNT", "UNTIL", "WKST", "BYDAY", "BYMONTHDAY", "BYMONTH", "BYSETPOS"]);
  for (const key of Object.keys(parts)) {
    if (!allowed.has(key)) return { reason: `unsupported rule part ${/^[A-Z-]{1,20}$/.test(key) ? key : "?"}` };
  }
  const freq = parts.FREQ?.toUpperCase();
  if (freq !== "DAILY" && freq !== "WEEKLY" && freq !== "MONTHLY" && freq !== "YEARLY") {
    return { reason: freq ? "unsupported frequency" : "rule has no frequency" };
  }
  let interval = 1;
  if (parts.INTERVAL !== undefined) {
    if (!/^\d+$/.test(parts.INTERVAL)) return { reason: "bad interval" };
    interval = Number(parts.INTERVAL);
    if (interval < 1 || interval > MAX_INTERVAL) return { reason: "interval out of range" };
  }
  let count: number | null = null;
  if (parts.COUNT !== undefined) {
    if (!/^\d+$/.test(parts.COUNT)) return { reason: "bad count" };
    count = Number(parts.COUNT);
    if (count < 1 || count > MAX_COUNT) return { reason: "count out of range" };
  }
  let until: UntilSpec | null = null;
  if (parts.UNTIL !== undefined) {
    until = parseUntil(parts.UNTIL);
    if (!until) return { reason: "bad until" };
  }
  let wkst = 0;
  if (parts.WKST !== undefined) {
    const w = DAYS[parts.WKST.toUpperCase()];
    if (w === undefined) return { reason: "bad week start" };
    wkst = w;
  }
  const byDay: DayRule[] = [];
  if (parts.BYDAY !== undefined) {
    for (const piece of parts.BYDAY.split(",")) {
      const m = /^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/i.exec(piece.trim());
      if (!m) return { reason: "bad day list" };
      const ord = m[1] === undefined ? null : Number(m[1]);
      if (ord !== null && (ord === 0 || Math.abs(ord) > 53)) return { reason: "bad day ordinal" };
      if (ord !== null && (freq === "DAILY" || freq === "WEEKLY"))
        return { reason: "ordinal day on a daily or weekly rule" };
      byDay.push({ ord, day: DAYS[m[2]!.toUpperCase()]! });
    }
  }
  let byMonthDay: number[] = [];
  if (parts.BYMONTHDAY !== undefined) {
    const list = ints(parts.BYMONTHDAY, 1, 31, true);
    if (!list) return { reason: "bad month day list" };
    byMonthDay = list;
  }
  let byMonth: number[] = [];
  if (parts.BYMONTH !== undefined) {
    const list = ints(parts.BYMONTH, 1, 12, false);
    if (!list) return { reason: "bad month list" };
    byMonth = list;
  }
  let bySetPos: number[] = [];
  if (parts.BYSETPOS !== undefined) {
    const list = ints(parts.BYSETPOS, 1, 366, true);
    if (!list) return { reason: "bad set position list" };
    bySetPos = list;
  }
  if (freq === "WEEKLY" && byMonthDay.length > 0) return { reason: "month day on a weekly rule" };
  return { rule: { freq, interval, count, until, wkst, byDay, byMonthDay, byMonth, bySetPos } };
}

export class BudgetExceeded extends Error {
  constructor() {
    super("time budget exceeded");
  }
}

export interface ExpandContext {
  /** Throws BudgetExceeded when the parse deadline has passed. */
  checkBudget(): void;
}

export interface Expansion {
  /** Local day numbers of occurrences, ascending, each >= fromDay. */
  days: number[];
  /** True when the period cap stopped the expansion before it reached `toDay` or its COUNT. */
  capped: boolean;
}

/**
 * Expand `rule` for a series starting on local day `startDay`. Returns occurrence days in [fromDay, toDay].
 * With COUNT the walk starts at DTSTART and counts every occurrence; without it, it jumps to the period at `fromDay`.
 */
export function expandDays(
  rule: Rule,
  startDay: number,
  fromDay: number,
  toDay: number,
  ctx: ExpandContext
): Expansion {
  const start = dayFields(startDay);
  const startWeekday = weekdayOf(startDay);
  const startMonthIndex = start.y * 12 + (start.m - 1);
  const periodMin = rule.freq === "DAILY" ? 1 : rule.freq === "WEEKLY" ? 7 : rule.freq === "MONTHLY" ? 31 : 366;
  let p = 0;
  if (rule.count === null && fromDay > startDay)
    p = Math.max(0, Math.floor((fromDay - startDay) / (periodMin * rule.interval)) - 1);

  const byDay = rule.byDay;
  const noRefine = rule.byDay.length === 0 && rule.byMonthDay.length === 0;
  const weekStartOfStart = startDay - ((startWeekday - rule.wkst + 7) % 7);

  const candidatesFor = (index: number): number[] => {
    if (rule.freq === "DAILY") {
      // BYMONTH, BYMONTHDAY and BYDAY only limit a daily rule (RFC 5545 section 3.3.10).
      const day = startDay + index * rule.interval;
      const f = dayFields(day);
      if (rule.byMonth.length > 0 && !rule.byMonth.includes(f.m)) return [];
      if (rule.byMonthDay.length > 0) {
        const dim = daysInMonth(f.y, f.m);
        if (!rule.byMonthDay.some((n) => (n > 0 ? n === f.d : dim + n + 1 === f.d))) return [];
      }
      if (byDay.length > 0 && !byDay.some((r) => r.day === weekdayOf(day))) return [];
      return [day];
    }
    if (rule.freq === "WEEKLY") {
      const base = weekStartOfStart + 7 * rule.interval * index;
      const wanted = byDay.length ? byDay.map((r) => r.day) : [startWeekday];
      return [...new Set(wanted.map((wd) => base + ((wd - rule.wkst + 7) % 7)))]
        .filter((day) => rule.byMonth.length === 0 || rule.byMonth.includes(dayFields(day).m))
        .sort((a, b) => a - b);
    }
    // MONTHLY and YEARLY: enumerate the days of the period and keep those the rule names.
    let first: number;
    let length: number;
    if (rule.freq === "MONTHLY") {
      const mi = startMonthIndex + index * rule.interval;
      const y = Math.floor(mi / 12);
      const m = (mi % 12) + 1;
      if (y > 9999) return [];
      first = dayNumber(y, m, 1);
      length = daysInMonth(y, m);
    } else {
      const y = start.y + index * rule.interval;
      if (y > 9999) return [];
      first = dayNumber(y, 1, 1);
      length = dayNumber(y + 1, 1, 1) - first;
    }
    const out: number[] = [];
    for (let i = 0; i < length; i++) {
      const day = first + i;
      const f = dayFields(day);
      if (rule.freq === "YEARLY" && rule.byMonth.length === 0 && noRefine) {
        if (f.m === start.m && f.d === start.d) out.push(day);
        continue;
      }
      if (rule.byMonth.length > 0 && !rule.byMonth.includes(f.m)) continue;
      if (rule.freq === "YEARLY" && rule.byMonth.length > 0 && noRefine && f.d !== start.d) continue;
      if (rule.freq === "MONTHLY" && noRefine && f.d !== start.d) continue;
      if (rule.byMonthDay.length > 0) {
        const dim = daysInMonth(f.y, f.m);
        if (!rule.byMonthDay.some((n) => (n > 0 ? n === f.d : dim + n + 1 === f.d))) continue;
      }
      if (byDay.length > 0) {
        const wd = weekdayOf(day);
        const inMonthScope = rule.freq === "MONTHLY" || rule.byMonth.length > 0;
        const scopeStart = inMonthScope ? dayNumber(f.y, f.m, 1) : first;
        const scopeLen = inMonthScope ? daysInMonth(f.y, f.m) : length;
        const idx = day - scopeStart;
        const fromStart = Math.floor(idx / 7) + 1;
        const fromEnd = -(Math.floor((scopeLen - 1 - idx) / 7) + 1);
        if (!byDay.some((r) => r.day === wd && (r.ord === null || r.ord === fromStart || r.ord === fromEnd))) continue;
      }
      out.push(day);
    }
    return out;
  };

  const days: number[] = [];
  let produced = 0;
  let capped = false;
  let periods = 0;
  for (; ; p++) {
    if (++periods > MAX_PERIODS) {
      capped = true;
      break;
    }
    if (periods % 256 === 0) ctx.checkBudget();
    let set = candidatesFor(p);
    if (rule.bySetPos.length > 0 && set.length > 0) {
      const picked = new Set<number>();
      for (const pos of rule.bySetPos) {
        const at = pos > 0 ? pos - 1 : set.length + pos;
        if (at >= 0 && at < set.length) picked.add(set[at]!);
      }
      set = [...picked].sort((a, b) => a - b);
    }
    if (p === 0) {
      // RFC 5545: DTSTART is the first instance even when the rule would not produce it.
      set = set.filter((d) => d >= startDay);
      if (!set.includes(startDay)) set = [startDay, ...set];
    }
    for (const day of set) {
      if (rule.count !== null && produced >= rule.count) return { days, capped };
      produced++;
      if (day >= fromDay && day <= toDay) days.push(day);
    }
    if (rule.count !== null && produced >= rule.count) break;
    // Stop once this period starts after the window end: candidates for later periods are all later.
    const next = periodStart(rule, startDay, startMonthIndex, start.y, weekStartOfStart, p + 1);
    if (next > toDay) break;
  }
  return { days, capped };
}

function periodStart(
  rule: Rule,
  startDay: number,
  startMonthIndex: number,
  startYear: number,
  weekStart: number,
  index: number
): number {
  if (rule.freq === "DAILY") return startDay + index * rule.interval;
  if (rule.freq === "WEEKLY") return weekStart + 7 * rule.interval * index;
  if (rule.freq === "MONTHLY") {
    const mi = startMonthIndex + index * rule.interval;
    return dayNumber(Math.floor(mi / 12), (mi % 12) + 1, 1);
  }
  return dayNumber(startYear + index * rule.interval, 1, 1);
}
