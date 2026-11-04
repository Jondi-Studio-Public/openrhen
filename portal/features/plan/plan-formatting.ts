import { dateTimeFormat, displayLocale } from "@/shared/locale";
import type { StoredAction } from "@/state/portal-state";
import { dateOnly, dateInput as zonedDateInput, iso as zonedDateValue } from "@/features/today/local-datetime";

/** The bit of a forecast the health chip needs; `ClientForecast` satisfies this without importing it here. */
export interface HealthChipForecast {
  health: string;
  overdue?: boolean;
  /** Who owned the passed date; a lapsed self-set (`internal`) date is stale, not overdue. */
  proposal?: { deadlineOwner?: string };
  /** "adherence" for a maintenance project — see `adherence.health` below for what the chip should show. */
  healthBasis?: string;
  /**
   * The real classification for a maintenance project. The engine's own top-level `health` stays
   * "unknown" for these (it never had a deadline to be feasible against, and the ranking ladder reads
   * "behind"/"at_risk" as proof one exists — see `ProjectAdherence` in the engine's model/types.ts), so
   * the chip reads this instead whenever `healthBasis` is "adherence".
   */
  adherence?: { health: string };
}

/** The health the chip actually shows: a maintenance project's real adherence, everyone else's `health` as is. */
export function displayHealth(forecast: HealthChipForecast | undefined): string {
  return forecast?.healthBasis === "adherence" && forecast.adherence
    ? forecast.adherence.health
    : (forecast?.health ?? "unknown");
}

/**
 * Formatting shared by the Plan page and its panels. `datetime-local` inputs read and write local
 * wall-clock text in the *planning* timezone (never the browser's — finding 30), while the stored
 * value stays an ISO instant. The one implementation of both conversions lives in
 * `features/today/local-datetime.ts`; this used to keep its own near-identical copy (built off the
 * browser's own offset, which was silently wrong whenever the planning timezone differed from it),
 * re-exported here under their established names so every existing import site keeps working.
 */
export const dateInput = zonedDateInput;
export const dateValue = (value: string, timezone: string): string | undefined =>
  value ? zonedDateValue(value, timezone) : undefined;

export { dateOnly };

export function bandLabel(kind: string) {
  return (
    (
      {
        detailed: "Days 0–7 · exact times",
        daily: "Days 8–14 · by day",
        weekly: "Days 15–30 · by week",
        fortnightly: "Days 31–90 · by fortnight",
        monthly: "Days 91–180 · by month"
      } as Record<string, string>
    )[kind] ?? kind
  );
}

/**
 * The health chip's text: a past-deadline project reads as overdue even when the engine could not
 * otherwise forecast it, and stays legible as "behind · overdue" when it already had a worse health.
 */
export function healthChipText(forecast: HealthChipForecast | undefined): string {
  const health = displayHealth(forecast);
  // "unknown" is the engine's word for "no forecast yet" (no deadline or estimate to forecast from).
  const label = health === "unknown" ? "not forecast" : health.replace("_", " ");
  if (!forecast?.overdue) return label;
  if (isLapsedSelfSet(forecast)) return health === "unknown" ? "date lapsed" : `${label} · date lapsed`;
  return health === "unknown" ? "overdue" : `${label} · overdue`;
}

/** A passed self-set date is stale, not overdue: it reads as lapsed, in the plain palette. */
export function isLapsedSelfSet(forecast: HealthChipForecast | undefined): boolean {
  return Boolean(forecast?.overdue && forecast.proposal?.deadlineOwner === "internal");
}

/** The health chip's class list: `.health.overdue` layers the overdue palette over whichever health it is. */
export function healthChipClass(forecast: HealthChipForecast | undefined): string {
  const health = displayHealth(forecast);
  return forecast?.overdue && !isLapsedSelfSet(forecast) ? `health ${health} overdue` : `health ${health}`;
}

/**
 * The engine writes forecast reasons with raw ISO instants ("…projected before 2026-10-29T06:00:00.000Z.").
 * Shown to a person they read as the planning timezone's own date and time instead.
 */
export function localiseReason(reason: string, timezone: string): string {
  const format = dateTimeFormat(displayLocale(), { timeZone: timezone, dateStyle: "medium", timeStyle: "short" });
  return reason.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})/g, (iso) => {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? iso : format.format(date);
  });
}

export function formatMinutes(minutes: number) {
  if (minutes < 120) return `${Math.round(minutes)} min`;
  const hours = minutes / 60;
  return `${hours >= 100 ? Math.round(hours) : hours.toFixed(1)} hr`;
}

/** The trailing sentence on an action row that says how a recurring series ends, if it recurs at all. */
export function recurrenceSummary(item: StoredAction, now = new Date()) {
  if (item.schedulingMode === "cadence") return cadenceSummary(item, now);
  return item.schedulingMode === "recurring"
    ? item.recurrence?.completedAt
      ? " · goal complete"
      : item.recurrence?.completionMode === "total_minutes"
        ? ` · recurring until ${Math.round((item.recurrence.accumulatedMinutes ?? 0) / 60)}h of ${Math.round((item.recurrence.targetTotalMinutes ?? 0) / 60)}h`
        : item.recurrence?.completionMode === "manual"
          ? " · recurring until marked complete"
          : ` · recurring through ${item.recurrence?.endDate}`
    : "";
}

/**
 * A cadence in one breath: how often, when it was last done, and whether it is due. The due
 * arithmetic mirrors the engine's (whole local days, never done → due from the start), kept here in
 * plain form because the portal does not depend on the engine package.
 */
function cadenceSummary(item: StoredAction, now: Date) {
  const rule = item.recurrence;
  if (!rule) return " · cadence";
  if (rule.period) return periodCadenceSummary(rule);
  const every = rule.intervalDays === 1 ? "every day" : `every ${rule.intervalDays} days`;
  if (rule.completedAt) return ` · ${every} · goal complete`;
  const today = localDay(now, rule.timezone);
  const dueDate = rule.lastCompletedLocalDate
    ? addDays(rule.lastCompletedLocalDate, rule.intervalDays)
    : rule.startDate;
  const overdue = dayOrdinal(today) - dayOrdinal(dueDate);
  const lastDone = rule.lastCompletedLocalDate
    ? rule.lastCompletedLocalDate === today
      ? "done today"
      : `last done ${shortDate(rule.lastCompletedLocalDate)}`
    : "never done";
  const due =
    rule.lastCompletedLocalDate === today
      ? ""
      : overdue > 0
        ? ` · ${overdue} ${overdue === 1 ? "day" : "days"} overdue`
        : overdue === 0
          ? " · due today"
          : ` · due ${shortDate(dueDate)}`;
  const goal =
    rule.completionMode === "total_minutes"
      ? ` · ${Math.round((rule.accumulatedMinutes ?? 0) / 60)}h of ${Math.round((rule.targetTotalMinutes ?? 0) / 60)}h`
      : "";
  return ` · ${every} · ${lastDone}${due}${goal}`;
}

/**
 * a period/target rule's summary is deliberately simpler than the plain-interval one above —
 * "how often" and "last done", without recomputing the engine's own remaining-count and pressure math
 * here (that would drift from `cadence.ts` the moment either side changed).
 */
function periodCadenceSummary(rule: NonNullable<StoredAction["recurrence"]>) {
  const target = rule.targetOccurrences ?? 1;
  const times = target === 1 ? "once" : `${target} times`;
  const within =
    rule.period?.unit === "month"
      ? "a calendar month"
      : `each ${rule.period && "length" in rule.period ? rule.period.length : "?"}-day block`;
  const lastDone = rule.lastCompletedLocalDate
    ? ` · last done ${shortDate(rule.lastCompletedLocalDate)}`
    : " · never done";
  return ` · ${times} within ${within}${lastDone}`;
}

/** Already ticked for the rule's local day, so a "Done today" button has nothing left to do until tomorrow. */
export function cadenceDoneToday(item: StoredAction, now: Date): boolean {
  const rule = item.recurrence;
  if (!rule?.lastCompletedLocalDate) return false;
  return rule.lastCompletedLocalDate === localDay(now, rule.timezone);
}

function localDay(date: Date, timezone: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}
function dayOrdinal(value: string) {
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}
function addDays(value: string, days: number) {
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}
function shortDate(value: string) {
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  return dateTimeFormat(displayLocale(), { day: "numeric", month: "short", timeZone: "UTC" }).format(
    new Date(Date.UTC(year, month - 1, day))
  );
}
