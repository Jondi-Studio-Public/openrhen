import { dateTimeFormat, displayLocale } from "@/shared/locale";
import { formatShortDate } from "@/shared/date-format";
/**
 * One wording for a unit's latest safe start, shared by Today's detail sheet and the Plan card
 * (the day plan surfaces design note, "Latest safe start" / invariant 7). The card and Today's sheet
 * must never disagree about the same unit, so both call this — never their own inline formatting.
 */

/** The bit of `ClientForecast` this needs; the full type satisfies it without importing it here. */
export interface LatestSafeStartForecast {
  latestSafeStarts: Record<string, Date | null>;
  unplacedUnitIds?: string[];
}

export interface LatestSafeStartInput {
  forecast: LatestSafeStartForecast | undefined;
  unitId: string;
  /** The "detailed" capacity envelope's own `endsAt`: only a band-placed start lies at or beyond it. */
  detailedEndsAt: Date | null;
  timeZone: string;
  /** The moment the date is read against, for dropping the year; defaults to the clock. */
  now?: Date;
}

export type LatestSafeStartResult =
  | { kind: "exact"; text: string }
  | { kind: "around"; text: string }
  | { kind: "unplaced"; text: string }
  | { kind: "none"; text: string };

const exactFormat = (timeZone: string) =>
  dateTimeFormat(displayLocale(), { timeZone, weekday: "short", hour: "numeric", minute: "2-digit" });

export function latestSafeStartText(input: LatestSafeStartInput): LatestSafeStartResult {
  const { forecast, unitId, detailedEndsAt, timeZone, now = new Date() } = input;
  if (forecast?.unplacedUnitIds?.includes(unitId))
    return { kind: "unplaced", text: "can't be placed before the deadline" };
  const at = forecast?.latestSafeStarts[unitId];
  if (!at) return { kind: "none", text: "" };
  if (detailedEndsAt && at.getTime() >= detailedEndsAt.getTime())
    return { kind: "around", text: `around ${formatShortDate(at, timeZone, now)}` };
  return { kind: "exact", text: exactFormat(timeZone).format(at) };
}
