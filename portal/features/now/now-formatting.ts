import { dateTimeFormat, displayLocale } from "@/shared/locale";
import { PARTS_LOCALE } from "@openrhen/contracts";
import type { TravelSource } from "@openrhen/contracts";
import type { PortalState } from "@/state/portal-state";

/**
 * How well a journey's length is known, said plainly.
 * This is the one figure in a trip worth doubting, so where it came from is stated rather than
 * implied: a number read backwards off the other direction must not look like one somebody actually
 * timed. `sampleCount` names how many of your own trips the "own" tier rests on; every other tier
 * ignores it.
 */
export const travelSourceLabel = (source: TravelSource, sampleCount?: number): string => {
  switch (source) {
    case "live":
      return "live traffic";
    case "own":
      return sampleCount !== undefined ? `from your trips (${sampleCount})` : "from your trips";
    case "typical":
      return "typical for this time";
    case "fallback":
      return "the place's usual time";
    case "assumed":
      return "the way there, reversed";
    case "default":
      return "a rough 30-minute guess";
    case "estimated":
      return "rough estimate from distance";
    case "measured":
      return "measured";
    default:
      return "estimated";
  }
};

/** Names conditions the way the person named them, falling back to the raw id for anything unmigrated. */
export const formatConditionList = (ids: readonly string[], state: PortalState) => {
  const names = ids.map((id) => state.conditionDefinitions.find((entry) => entry.id === id)?.name ?? id);
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
};

/** A whole number when the value is whole, one decimal otherwise — a score component can carry halves. */
export const formatScore = (value: number) => (Number.isInteger(value) ? String(value) : value.toFixed(1));

export function formatRemaining(seconds: number) {
  const overtime = seconds < 0;
  const safe = Math.abs(seconds);
  const clock = `${Math.floor(safe / 60)}:${(safe % 60).toString().padStart(2, "0")}`;
  return overtime ? `+${clock}` : clock;
}

/** Minutes as a short span — "8 h 3 m", "8 h", "45 m" — for figures too long to read as minutes. */
export const hoursMinutes = (minutes: number) => {
  const safe = Math.max(0, Math.round(minutes));
  const hours = Math.floor(safe / 60);
  const rest = safe % 60;
  return hours ? (rest ? `${hours} h ${rest} m` : `${hours} h`) : `${rest} m`;
};

export const clock = (date: Date, timezone: string, seconds = false, locale: string = displayLocale()) =>
  dateTimeFormat(locale, {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
    ...(seconds ? { second: "2-digit" } : {})
  }).format(date);

export const localDate = (date: Date, timezone: string) =>
  dateTimeFormat(displayLocale(), { timeZone: timezone, weekday: "short", day: "numeric", month: "short" }).format(
    date
  );

/**
 * A weekday and a clock time, built from parts so the separators are this codebase's rather than
 * whichever spaces the platform's ICU happens to emit. The weekday is never dropped: the only
 * directives carrying an instant are the ones queued past a sleep boundary, where the day is the
 * whole point of saying it.
 */
export const dayClock = (value: string, timezone: string) => {
  const parts = Object.fromEntries(
    dateTimeFormat(displayLocale(), {
      timeZone: timezone,
      weekday: "short",
      hour: "numeric",
      minute: "2-digit",
      hourCycle: "h12"
    })
      .formatToParts(new Date(value))
      .map((part) => [part.type, part.value])
  );
  return `${parts.weekday} ${parts.hour}:${parts.minute} ${parts.dayPeriod!.toLowerCase()}`;
};

export const wallClock = (value: string) => {
  const [hour, minute] = value.split(":").map(Number) as [number, number];
  return `${hour % 12 || 12}:${minute.toString().padStart(2, "0")} ${hour < 12 ? "am" : "pm"}`;
};

export const localClockMinutes = (date: Date, timezone: string) => {
  const parts = Object.fromEntries(
    dateTimeFormat(PARTS_LOCALE, { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );
  return Number(parts.hour) * 60 + Number(parts.minute);
};

/** The stored project's title, or the placeholder the page has always shown for a dangling id. */
export const projectTitle = (state: PortalState, projectId?: string) =>
  projectId ? (state.projects.find((item) => item.id === projectId)?.title ?? "Unknown project") : undefined;

/** Which project an upcoming directive belongs to, following a routine step through its commitment. */
export const directiveProjectId = (
  state: PortalState,
  item: { kind: string; targetId: string }
): string | undefined => {
  if (item.kind === "action") return state.actions.find((action) => action.id === item.targetId)?.projectId;
  if (item.kind === "commitment")
    return state.commitments.find((commitment) => commitment.id === item.targetId)?.projectId;
  if (item.kind === "routine_step") {
    const step = state.routineSteps.find((entry) => entry.id === item.targetId);
    return step ? state.commitments.find((commitment) => commitment.id === step.commitmentId)?.projectId : undefined;
  }
  return undefined;
};

/**
 * The one plain sentence under "Why this, now": when it is due, if anything is, and that a session
 * fits. No scores, tiers or weights; those stay in the engine's own wording under the workings.
 */
export function plainWhySentence({
  deadline,
  approximate = false,
  minutes,
  now,
  timezone
}: {
  deadline: Date | string | null | undefined;
  /** Only the forecast's cut-off is known, which can sit before the real date. */
  approximate?: boolean;
  minutes: number | null | undefined;
  now: Date;
  timezone: string;
}): string {
  const session = minutes ? `a ${Math.round(minutes)} min session fits now` : "it fits now";
  const due = deadline ? new Date(deadline) : null;
  if (!due || Number.isNaN(due.getTime())) return `Nothing is due soon; ${session}.`;
  const date = localDate(due, timezone);
  return `${due.getTime() < now.getTime() ? "Was due" : approximate ? "Due around" : "Due"} ${date}, and ${session}.`;
}
