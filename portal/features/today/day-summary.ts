import type { DayPlan, DayPlanItem } from "./day-plan";
import { formatZonedTime } from "@/shared/date-format";

/**
 * "7 h 48 m", "45 m", "3 h": the free-time figure every Day surface states, rounded to the minute.
 * Hours and minutes rather than a raw minute count, because 468 reads as a number to work out.
 */
export function durationLabel(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  if (hours === 0) return `${rest} m`;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} m`;
}

/**
 * The things a day is built around: stated commitments, in start order, that take up time. A
 * tentative one is not yet a fact and an anchor costs the place rather than the hour, so neither
 * counts; a window or a marker is not a thing at all.
 */
export function fixedThings(plan: DayPlan): DayPlanItem[] {
  return [...plan.items]
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
    .filter(
      (item) =>
        item.kind === "commitment" &&
        item.source === "fixed" &&
        !item.tentative &&
        !item.window &&
        !item.marker &&
        item.presence !== "anchor"
    );
}

/**
 * A commitment's name as a sentence can carry it: the part before a colon and without a trailing
 * bracket, so "Dentist: check-up and clean" reads "Dentist". The block itself keeps the full title.
 */
export function shortTitle(title: string): string {
  const head = title
    .split(":")[0]!
    .replace(/\s*\([^)]*\)\s*$/, "")
    .trim();
  return head || title;
}

const NUMBER_WORDS = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];

/**
 * The one sentence under the Day heading: how much time is free, then what the day is built around.
 * At most three fixed things are named; the rest are counted, so the sentence stays one line on a
 * desk. `freeMinutes` is null when nothing says how much of the day is free.
 */
export function dayAnswer(plan: DayPlan, freeMinutes: number | null, timezone: string): string {
  const free = freeMinutes === null ? "" : `${durationLabel(freeMinutes)} free. `;
  const fixed = fixedThings(plan);
  if (fixed.length === 0) return `${free}Nothing fixed.`.trim();
  const named = fixed
    .slice(0, 3)
    .map((item) => `${shortTitle(item.title)} at ${formatZonedTime(item.startsAt, timezone)}`);
  const more = fixed.length - named.length;
  const list =
    more > 0
      ? `${named.join(", ")} and ${more} more`
      : named.length === 1
        ? named[0]!
        : `${named.slice(0, -1).join(", ")} and ${named.at(-1)}`;
  const count = NUMBER_WORDS[fixed.length] ?? String(fixed.length);
  return `${free}${count} fixed ${fixed.length === 1 ? "thing" : "things"}: ${list}.`;
}

/**
 * The part of the day worth drawing, in minutes after the day's own midnight: from the hour you get
 * up to the hour you go to bed. Sleep is read from the day's sleep blocks (the night ending before
 * noon, the one starting after it); without them it is 7 am to 10 pm. The range always widens, on
 * the hour, to take in everything else the day holds and the now-line, so nothing awake is ever
 * cropped off — only the night is.
 */
export function wakingRange(
  plan: DayPlan,
  extra: Date[] = [],
  spans: ReadonlyArray<{ startsAt: Date; endsAt: Date }> = []
): { start: number; end: number } {
  const offset = (at: Date) => (at.getTime() - plan.bounds.startsAt.getTime()) / 60_000;
  const length = offset(plan.bounds.endsAt);
  const noon = 12 * 60;
  let wake = 7 * 60;
  let bed = 22 * 60;
  const sleeps = plan.items.filter((item) => item.kind === "sleep" && !item.window && !item.marker);
  const mornings = sleeps.map((item) => offset(item.endsAt)).filter((end) => end > 0 && end <= noon);
  const evenings = sleeps.map((item) => offset(item.startsAt)).filter((start) => start >= noon && start < length);
  if (mornings.length) wake = Math.max(...mornings);
  if (evenings.length) bed = Math.min(...evenings);
  let start = wake;
  let end = bed;
  const awake = [
    ...plan.items.filter((item) => item.kind !== "sleep" && !item.window),
    ...plan.waits,
    ...plan.locations.filter((stay) => stay.locationId === null),
    ...spans
  ];
  for (const item of awake) {
    start = Math.min(start, offset(item.startsAt));
    end = Math.max(end, offset(item.endsAt));
  }
  for (const at of [...extra, ...(plan.nowAt ? [plan.nowAt] : [])]) {
    start = Math.min(start, offset(at) - 30);
    end = Math.max(end, offset(at) + 30);
  }
  start = Math.max(0, Math.floor(start / 60) * 60);
  end = Math.min(length, Math.ceil(end / 60) * 60);
  return end > start ? { start, end } : { start: 0, end: length };
}
