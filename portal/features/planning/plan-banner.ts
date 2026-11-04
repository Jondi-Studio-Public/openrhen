import { dateTimeFormat, displayLocale } from "@/shared/locale";
import { PARTS_LOCALE } from "@openrhen/contracts";
import type { PortalState } from "@/state/portal-state";
import { outOfDatePlanWarning, serverNow, type PlanHealth } from "./planning-runtime";

/**
 * How loud the top banner is. `working` is the ordinary wait for a plan (neutral, with a moving bar);
 * `warning` is a plan that is old or retrying but still usable; `danger` is reserved for something
 * that has actually failed or cannot be reached. Red for an expected wait teaches people to ignore red.
 */
export type BannerTone = "working" | "warning" | "danger";

export interface PlanBanner {
  tone: BannerTone;
  text: string;
}

const STAND_IN_MESSAGES = new Set([
  "The Plan and Forecast Engine has not produced a result yet.",
  "The last Plan and Forecast Engine calculation failed."
]);

/** "9:40 am" for a plan from today, "Mon 9:40 am" for an older one. */
export function planTime(iso: string, timezone: string, now: Date): string {
  const at = new Date(iso);
  const day = (value: Date) =>
    dateTimeFormat(PARTS_LOCALE, { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
      value
    );
  const parts = Object.fromEntries(
    dateTimeFormat(displayLocale(), {
      timeZone: timezone,
      weekday: "short",
      hour: "numeric",
      minute: "2-digit",
      hourCycle: "h12"
    })
      .formatToParts(at)
      .map((part) => [part.type, part.value])
  );
  const time = `${parts.hour}:${parts.minute} ${parts.dayPeriod!.toLowerCase()}`;
  return day(at) === day(now) ? time : `${parts.weekday} ${time}`;
}

/**
 * The plan's part of the top banner, or null when the plan is current and there is nothing to say.
 * Plain words: the person needs to know whether the plan on screen is usable and whether anything is
 * wrong, not which service is behind it.
 */
export function planningBanner(input: {
  planning: PortalState["planning"];
  timezone: string;
  /** The loaded plan has crossed `validUntil` while this tab sat open. */
  expired?: boolean;
  health?: PlanHealth | null;
  clockOffsetMs?: number;
  now: Date;
}): PlanBanner | null {
  const { planning, timezone, expired = false, health = null, clockOffsetMs = 0, now } = input;
  if (!planning) return null;
  // `status` is computed by the server when the state is read and never moves on its own, so a plan
  // that crossed `validUntil` while this tab sat open still says "current". Say what the status row
  // and the disabled Start already know.
  if (planning.status === "current" && !expired) return null;
  const when = (value: string) =>
    dateTimeFormat(displayLocale(), { timeZone: timezone, dateStyle: "medium", timeStyle: "short" }).format(
      new Date(value)
    );
  // The same wording whatever the stored status says, so a plan that is genuinely stuck reads the
  // same on a tab loaded after the boundary as on one that watched it pass.
  const outOfDate = outOfDatePlanWarning({
    health,
    validUntil: planning.validUntil ?? null,
    now: serverNow(clockOffsetMs, now),
    format: when
  });
  // Stuck or unreachable is a real fault; a refresh that failed and will retry is not yet one.
  const outOfDateTone: BannerTone = health?.refresh === "retrying" && !health.unreachable ? "warning" : "danger";
  if (health?.refresh === "stalled" && outOfDate) return { tone: "danger", text: outOfDate };
  if (planning.status === "current") return outOfDate ? { tone: outOfDateTone, text: outOfDate } : null;
  const from = planning.lastSuccessfulAt ? planTime(planning.lastSuccessfulAt, timezone, now) : null;
  // The runtime's own stand-in messages repeat what the banner already says; only a real error adds anything.
  const detail = planning.message && !STAND_IN_MESSAGES.has(planning.message) ? ` Detail: ${planning.message}` : "";
  if (planning.status === "pending") {
    // A pending job carrying an error message is a retry after a failure, not an ordinary refresh.
    if (planning.message)
      return {
        tone: "warning",
        text: from
          ? `Using the plan from ${from}. The last refresh failed and is retrying.${detail}`
          : `Your first plan failed and is retrying. Capture still works.${detail}`
      };
    return {
      tone: "working",
      text: from
        ? `Using the plan from ${from}. A fresh one is on its way; Start is off until it lands.`
        : "Working out your plan…"
    };
  }
  if (planning.status === "failed")
    return {
      tone: "danger",
      text: from
        ? `The last plan refresh failed. Using the plan from ${from}; Start is off until a new one lands.${detail}`
        : `The planner could not work out a plan. Capture still works.${detail}`
    };
  if (planning.status === "stale")
    return {
      tone: "warning",
      text: from
        ? `The plan from ${from} is out of date and no refresh is running. Start is off until a new one lands.`
        : "The plan is out of date and no refresh is running. Start is off until a new one lands."
    };
  return { tone: "warning", text: "No plan yet, and none is being worked out. Capture still works." };
}
