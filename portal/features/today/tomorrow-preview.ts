import type { PortalState } from "@/state/portal-state";
import { nextDayKey, zonedDayBounds, type ZonedDayBounds } from "./local-datetime";
import { localDayKey } from "./today-view";

/**
 * The rough shape of tomorrow, read before bed. Everything here is a stated fact clipped to the next
 * local day — no projection — because a plan replayed from now says nothing useful about a day that
 * has not started. The counts are of things that land on that day, not of everything that touches it.
 */
export interface TomorrowBrief {
  dayKey: string;
  bounds: ZonedDayBounds;
  sleep: TomorrowSleep | null;
  firstCommitment: TomorrowCommitment | null;
  commitments: number;
  preparationSteps: number;
  occurrences: number;
  /** Null when nothing tomorrow names a place away from home. */
  travel: TomorrowTravel | null;
}

export interface TomorrowSleep {
  startsAt: Date;
  wakeAt: Date;
  minutes: number;
  /** The night normally begins the evening before; saying so stops the brief reading like a nap. */
  startsBeforeDay: boolean;
}

export interface TomorrowCommitment {
  id: string;
  title: string;
  startsAt: Date;
  /** Already under way at midnight: its stated start is on the day before, not tomorrow morning. */
  startsBeforeDay: boolean;
}

export interface TomorrowTravel {
  /** How many of tomorrow's commitments are somewhere other than home. */
  commitments: number;
  /** The distinct places, named as the context defines them. */
  places: string[];
}

export type TomorrowState = Pick<
  PortalState,
  "settings" | "commitments" | "routineSteps" | "occurrences" | "sleepPlans" | "conditionDefinitions"
>;

/**
 * The local day after the one `now` falls on. The advance is calendar arithmetic rather than adding
 * 24 hours, so a day on which the clocks change still has exactly one successor: adding a day's worth
 * of milliseconds would land back on the same local date in spring and skip one in autumn.
 */
export function tomorrowDayKey(now: Date, timezone: string): string {
  return nextDayKey(localDayKey(now, timezone));
}

const date = (value: string | Date) => (value instanceof Date ? value : new Date(value));
const minutesBetween = (a: Date, b: Date) => Math.max(0, Math.round((b.getTime() - a.getTime()) / 60_000));

export function tomorrowBrief(state: TomorrowState, now: Date): TomorrowBrief {
  const timezone = state.settings.timezone;
  const dayKey = tomorrowDayKey(now, timezone);
  const bounds = zonedDayBounds(dayKey, timezone);
  // Half-open, matching the day bounds: something that ends exactly at midnight belongs to the day
  // it ran in, not to the one that starts as it finishes.
  const touchesDay = (startsAt: Date, endsAt: Date) => startsAt < bounds.endsAt && endsAt > bounds.startsAt;

  const commitments = state.commitments
    .filter((item) => item.status !== "cancelled")
    .filter((item) => touchesDay(date(item.startsAt), date(item.endsAt)))
    .sort((a, b) => date(a.startsAt).getTime() - date(b.startsAt).getTime() || a.id.localeCompare(b.id));
  const first = commitments[0];

  // Counted as preparation still to do: a step already ticked off is not part of tomorrow's shape.
  const preparationSteps = state.routineSteps.filter(
    (step) =>
      step.status !== "completed" &&
      step.status !== "cancelled" &&
      step.scheduledStartAt !== undefined &&
      step.scheduledEndAt !== undefined &&
      touchesDay(date(step.scheduledStartAt), date(step.scheduledEndAt))
  ).length;

  // Occurrences are already stamped with the local day the recurrence rule placed them on; deriving
  // it again from their instants would let the two disagree on a day the clocks change.
  const occurrences = state.occurrences.filter(
    (item) => item.status !== "cancelled" && item.localDate === dayKey
  ).length;

  return {
    dayKey,
    bounds,
    sleep: sleepEndingOn(state, bounds),
    firstCommitment: first
      ? {
          id: first.id,
          title: first.title,
          startsAt: date(first.startsAt),
          startsBeforeDay: date(first.startsAt) < bounds.startsAt
        }
      : null,
    commitments: commitments.length,
    preparationSteps,
    occurrences,
    travel: travelAwayFromHome(commitments, state)
  };
}

/**
 * The night that ends on the day, which is the one the brief is about: a night beginning tomorrow
 * evening belongs to the day after. Actual times win over planned ones where they exist, as they do
 * everywhere else sleep is drawn, so a night already under way is reported as it is being slept.
 */
function sleepEndingOn(state: TomorrowState, bounds: ZonedDayBounds): TomorrowSleep | null {
  const nights = state.sleepPlans
    .filter((plan) => plan.status !== "cancelled")
    .map((plan) => ({
      startsAt: date(plan.actualStartAt ?? plan.plannedStartAt),
      wakeAt: date(plan.actualWakeAt ?? plan.plannedWakeAt)
    }))
    .filter((night) => night.wakeAt > night.startsAt)
    .filter((night) => night.wakeAt > bounds.startsAt && night.wakeAt < bounds.endsAt)
    .sort((a, b) => a.wakeAt.getTime() - b.wakeAt.getTime());
  const night = nights[0];
  if (!night) return null;
  return {
    startsAt: night.startsAt,
    wakeAt: night.wakeAt,
    minutes: minutesBetween(night.startsAt, night.wakeAt),
    startsBeforeDay: night.startsAt < bounds.startsAt
  };
}

/**
 * Which of tomorrow's commitments take you somewhere. Home is excluded when one is chosen, because a
 * commitment at home is the absence of a journey; without a home base every named place counts,
 * since nothing then says which of them you were already at.
 */
function travelAwayFromHome(commitments: TomorrowState["commitments"], state: TomorrowState): TomorrowTravel | null {
  const home = state.settings.homeLocationId;
  const away = commitments.filter((item) => item.locationId !== undefined && item.locationId !== home);
  if (!away.length) return null;
  const places = new Map<string, string>();
  for (const item of away) places.set(item.locationId!, placeName(item.locationId!, item.location, state));
  return { commitments: away.length, places: [...places.values()] };
}

/** The context's own name for the place, falling back to whatever the commitment wrote by hand. */
function placeName(locationId: string, label: string | undefined, state: TomorrowState): string {
  const definition = state.conditionDefinitions.find((item) => item.id === locationId && item.kind === "location");
  return definition?.name ?? label ?? locationId;
}
