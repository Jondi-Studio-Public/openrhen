import { DEFAULT_TIMEZONE, DEFAULT_LOCALE } from "@openrhen/contracts";
import type { PlanningResult } from "../model/types.js";

/** Plain-English dates, times and durations for reason text; never an ISO timestamp. */

const timeFormats = new Map<string, Intl.DateTimeFormat>();
const dateFormats = new Map<string, Intl.DateTimeFormat>();

/** Construct before storing, so an invalid zone or locale throws and is never cached. */
function cached(
  cache: Map<string, Intl.DateTimeFormat>,
  locale: string,
  timezone: string,
  options: Intl.DateTimeFormatOptions
) {
  const key = `${locale}\u0000${timezone}`;
  let format = cache.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat(locale, { ...options, timeZone: timezone });
    cache.set(key, format);
  }
  return format;
}

export function formatTime(value: Date, timezone = DEFAULT_TIMEZONE, locale = DEFAULT_LOCALE) {
  return cached(timeFormats, locale, timezone, { hour: "numeric", minute: "2-digit" }).format(value);
}

export function formatDate(value: Date, timezone = DEFAULT_TIMEZONE, locale = DEFAULT_LOCALE) {
  return cached(dateFormats, locale, timezone, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit"
  }).format(value);
}

/** Minutes as "4h 20m", "5h" or "45m". */
export function formatMinutes(minutes: number) {
  const total = Math.max(0, Math.round(minutes));
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  if (!hours) return `${rest}m`;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

const ISO_TIMESTAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z/g;

/** Rewrites any ISO timestamp in text written elsewhere (the forecast's reasons) as a local date. */
export function localiseTimes(text: string, timezone?: string, locale?: string) {
  return text.replace(ISO_TIMESTAMP, (match) => formatDate(new Date(match), timezone, locale));
}

/**
 * The plan with every forecast sentence (proposal, interventions, reasons) in the person's local
 * time. The scheduler writes them with ISO timestamps because it knows no timezone; this is the one
 * place the engine does, so what the portal shows and what the ranking quotes are the same text.
 */
export function localisePlanText(plan: PlanningResult, timezone?: string, locale?: string): PlanningResult {
  const say = (text: string) => localiseTimes(text, timezone, locale);
  return {
    ...plan,
    forecasts: plan.forecasts.map((forecast) => ({
      ...forecast,
      reasons: forecast.reasons.map(say),
      ...(forecast.proposal ? { proposal: { ...forecast.proposal, reason: say(forecast.proposal.reason) } } : {}),
      ...(forecast.interventions
        ? { interventions: forecast.interventions.map((item) => ({ ...item, reason: say(item.reason) })) }
        : {})
    }))
  };
}
