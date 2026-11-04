import type { PlanningSettings, PortalState, StoredSleepPlan } from "@/state/portal-state";
import { localDayKey } from "@/features/today/today-view";
import { zonedWallTimeOnDay } from "@/features/today/local-datetime";

/**
 * What a disruption is, before it becomes a commitment.
 *
 * A disruption is captured while it is happening — in the car park, on the phone — so every field
 * but the title has a default and the whole shape is buckets rather than instants. Turning those
 * buckets into a real block is the only interesting thing here, and it lives in this pure module
 * rather than in the form, so a later voice layer can produce the same draft and get the same
 * commitment out of it.
 */
export type DisruptionSource = "work" | "family" | "life_admin" | "other";
/** A `disruptionWhenPresets` entry's id, or this literal — "earlier" is structural, not a preset: it
 * is the one bucket that opens a time input instead of an offset from now, so it stays a fixed
 * sentinel rather than something the settings list edits. */
export type DisruptionWhen = string;
export const EARLIER_WHEN = "earlier";
/** A `disruptionDurationPresets` entry's id. */
export type DisruptionDuration = string;

export interface DisruptionDraft {
  title: string;
  source: DisruptionSource;
  when: DisruptionWhen;
  /** Wall-clock time on today's local day; only read when `when` is "earlier". */
  earlierTime: string;
  duration: DisruptionDuration;
  /** The place it happens at, chosen the same way a commitment chooses one. */
  locationId: string;
  /** The display label, written from the chosen place's name; there is no free-text input for it. */
  location: string;
  /** Who is affected, chosen the same way a commitment chooses a contact. "" means none. */
  contactId: string;
}

/** Everything outside the draft that placing it on the clock depends on. */
export interface DisruptionContext {
  sleepPlans: StoredSleepPlan[];
  settings: PlanningSettings;
  timezone: string;
  now: Date;
}

/** The four fixed kind values, each carrying the settings-edited label — order is the button order. */
export function disruptionSourceOptions(settings: PlanningSettings): { value: DisruptionSource; label: string }[] {
  return (["work", "family", "life_admin", "other"] as const).map((value) => ({
    value,
    label: settings.disruptionKindLabels[value]
  }));
}

/** The "when" buckets, settings-edited, with the structural "earlier" bucket appended last. */
export function disruptionWhenOptions(settings: PlanningSettings): { value: DisruptionWhen; label: string }[] {
  return [
    ...settings.disruptionWhenPresets.map((preset) => ({ value: preset.id, label: preset.label })),
    { value: EARLIER_WHEN, label: "Earlier today" }
  ];
}

export function disruptionDurationOptions(settings: PlanningSettings): { value: DisruptionDuration; label: string }[] {
  return settings.disruptionDurationPresets.map((preset) => ({ value: preset.id, label: preset.label }));
}

const WALL_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const plus = (at: Date, minutes: number) => new Date(at.getTime() + minutes * 60_000);

function wallTimeOf(at: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).format(at);
}

/** The slice of portal state the draft reads, gathered once so the form and the save agree on it. */
export const disruptionContextFrom = (state: PortalState, now: Date): DisruptionContext => ({
  sleepPlans: state.sleepPlans,
  settings: state.settings,
  timezone: state.settings.timezone,
  now
});

function whenPreset(id: DisruptionWhen, settings: PlanningSettings) {
  return settings.disruptionWhenPresets.find((preset) => preset.id === id);
}

function durationPreset(id: DisruptionDuration, settings: PlanningSettings) {
  return settings.disruptionDurationPresets.find((preset) => preset.id === id);
}

/**
 * The draft the form opens with: named by nothing, Other, starting now, an hour long. Retro-logging
 * opens at the time it is now, so reaching back is a nudge rather than a fresh reading of the clock.
 * "Now" and "an hour" are read from the settings-edited presets rather than hardcoded, so a reader who
 * has reordered or relabeled them still opens on their own first entries.
 */
export const emptyDisruptionDraft = (
  { timezone, now, settings }: DisruptionContext,
  preset?: { contactId?: string }
): DisruptionDraft => ({
  title: "",
  source: "other",
  when: settings.disruptionWhenPresets[0]?.id ?? EARLIER_WHEN,
  earlierTime: wallTimeOf(now, timezone),
  duration:
    settings.disruptionDurationPresets.find((preset) => preset.kind === "minutes" && preset.minutes === 60)?.id ??
    settings.disruptionDurationPresets[0]?.id ??
    "",
  locationId: "",
  location: "",
  contactId: preset?.contactId ?? ""
});

/**
 * When the day is guessed to end for a disruption of unknown length: the next bedtime the sleep plan
 * already holds, or the preferred bedtime on the day it starts when no plan reaches past it. A guess
 * that lands before the disruption begins is no guess at all, so it is floored a minute after it.
 */
export function pessimisticEndAt(startsAt: Date, { sleepPlans, settings, timezone }: DisruptionContext): Date {
  const upcoming = sleepPlans
    .filter((plan) => plan.status === "planned" || plan.status === "sleeping")
    .map((plan) => new Date(plan.plannedStartAt))
    .filter((at) => at.getTime() > startsAt.getTime())
    .sort((one, other) => one.getTime() - other.getTime())[0];
  const bedtime = upcoming ?? zonedWallTimeOnDay(localDayKey(startsAt, timezone), settings.preferredBedtime, timezone);
  return new Date(Math.max(bedtime.getTime(), startsAt.getTime() + 60_000));
}

function startsAtOf(draft: DisruptionDraft, { timezone, now, settings }: DisruptionContext): Date {
  if (draft.when !== EARLIER_WHEN) return plus(now, whenPreset(draft.when, settings)?.delayMinutes ?? 0);
  // An unreadable time still has to produce a window, because the form draws the overlap hint from
  // one while it is being typed; validation is what refuses to save it.
  if (!WALL_TIME.test(draft.earlierTime)) return new Date(now.getTime());
  return zonedWallTimeOnDay(localDayKey(now, timezone), draft.earlierTime, timezone);
}

/** The block the draft would take, as instants. */
export function disruptionWindow(draft: DisruptionDraft, context: DisruptionContext): { startsAt: Date; endsAt: Date } {
  const startsAt = startsAtOf(draft, context);
  const preset = durationPreset(draft.duration, context.settings);
  const kind = preset?.kind ?? "minutes";
  if (kind === "rest_of_day" || (kind === "unknown" && draft.when !== EARLIER_WHEN))
    return { startsAt, endsAt: pessimisticEndAt(startsAt, context) };
  const minutes =
    kind === "unknown"
      ? context.settings.disruptionRetroFallbackMinutes
      : (preset?.minutes ?? context.settings.disruptionRetroFallbackMinutes);
  return { startsAt, endsAt: plus(startsAt, minutes) };
}

/**
 * Whether the block this draft resolves to is happening right now, at `context.now` — live enough
 * that tracking time against it means something. A retro-logged disruption that has already ended and
 * one whose "when" bucket is still in the future both read false here, which is what keeps the capture
 * sheet from ever offering to track either of them.
 */
export function disruptionIsLiveNow(draft: DisruptionDraft, context: DisruptionContext): boolean {
  const { startsAt, endsAt } = disruptionWindow(draft, context);
  return startsAt.getTime() <= context.now.getTime() && context.now.getTime() < endsAt.getTime();
}

/**
 * What a session started against this disruption right now would be planned for: the minutes left in
 * its window, floored at one so a disruption that is about to end still opens a session rather than
 * being refused one — mirroring the `active`-phase minutes the protected-commitment panel sends
 * (`protected-commitment-panel.tsx`).
 */
export function disruptionRemainingMinutes(draft: DisruptionDraft, context: DisruptionContext): number {
  const { endsAt } = disruptionWindow(draft, context);
  return Math.max(1, Math.round((endsAt.getTime() - context.now.getTime()) / 60_000));
}

/**
 * What is wrong with a disruption draft, or "" when nothing is. Only the title is ever missing —
 * everything else is a bucket that already holds a defensible answer — except the one time the
 * reader types a time themselves.
 */
export function validateDisruptionDraft(draft: DisruptionDraft, context: DisruptionContext): string {
  if (!draft.title.trim()) return "A disruption needs a name.";
  if (draft.when !== EARLIER_WHEN) return "";
  if (!WALL_TIME.test(draft.earlierTime)) return "Say what time it started.";
  if (startsAtOf(draft, context).getTime() > context.now.getTime())
    return "That time has not come round yet. Use Now or one of the +minute buckets.";
  return "";
}

/**
 * The commitment a disruption becomes. It is confirmed rather than proposed, because a thing that is
 * already happening is not up for review, and it carries no buffers: nobody sets up for being called
 * away. `origin` and `landedAt` are the provenance the ordinary editor never sends, which is what
 * lets a later edit of this record leave them alone.
 *
 * `landedAt` is when it hit, which for a retro-log is not when it started — that gap is the whole
 * record of "this is being written down after the fact".
 */
export function disruptionEntityFrom(
  draft: DisruptionDraft,
  id: string,
  context: DisruptionContext
): Record<string, unknown> {
  const { startsAt, endsAt } = disruptionWindow(draft, context);
  const preset = durationPreset(draft.duration, context.settings);
  return {
    id,
    title: draft.title.trim(),
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    status: "confirmed",
    setupBeforeMinutes: 0,
    transitionAfterMinutes: 0,
    presence: "blocking",
    origin: "disruption",
    disruptionSource: draft.source,
    disruptionOpenEnded: preset?.kind === "unknown" && draft.when !== EARLIER_WHEN,
    landedAt: context.now.toISOString(),
    ...(draft.location.trim() ? { location: draft.location.trim() } : {}),
    ...(draft.locationId ? { locationId: draft.locationId } : {}),
    ...(draft.contactId ? { contactId: draft.contactId } : {})
  };
}
