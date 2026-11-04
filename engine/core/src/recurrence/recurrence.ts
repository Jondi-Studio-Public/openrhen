import { commitmentOccurrenceId, commitmentRepeatFallsOn, zonedDateTime } from "@openrhen/contracts";
import { effectiveCommitmentEnd } from "../model/types.js";
import { localDateFormat } from "../model/zoned-formats.js";
import type {
  ActionOccurrence,
  ActionRecurrenceRule,
  ClockWindow,
  CommitmentRecurrenceRule,
  FixedCommitment,
  OccurrenceAnchorSource,
  RecurrenceAnchor,
  RecurrenceWindow
} from "../model/types.js";

const DAY = 86_400_000;

export interface ResolveOccurrencesInput {
  rule: ActionRecurrenceRule;
  from: Date;
  through: Date;
  anchors?: RecurrenceAnchor[];
  preferredWakeTime?: string;
  statuses?: Record<string, ActionOccurrence["status"]>;
  routineCoveredWindowIds?: string[];
}

export function resolveRecurrenceOccurrences(input: ResolveOccurrencesInput): ActionOccurrence[] {
  if (input.rule.completedAt) return [];
  const through = localDate(new Date(input.through.getTime() - 1), input.rule.timezone);
  const start = laterDate(input.rule.startDate, localDate(input.from, input.rule.timezone));
  const end = earlierDate(input.rule.endDate ?? through, through);
  if (start > end) return [];
  const wakeAnchorByDate = wakeAnchorMap(input.anchors ?? []);
  const sleepAnchorByDate = sleepStartAnchorMap(input.anchors ?? []);
  const occurrences: ActionOccurrence[] = [];
  const seriesStart = dateOrdinal(input.rule.startDate);
  for (let cursor = start; cursor <= end; cursor = addLocalDays(cursor, 1)) {
    if ((dateOrdinal(cursor) - seriesStart) % Math.max(1, input.rule.intervalDays) !== 0) continue;
    for (const window of input.rule.windows) {
      const anchor = window.anchor === "sleep_start" ? sleepAnchorByDate.get(cursor) : wakeAnchorByDate.get(cursor);
      const resolved = resolveWindow(cursor, input.rule.timezone, window, anchor, input.preferredWakeTime);
      if (!resolved || resolved.endsAt <= input.from || resolved.startsAt >= input.through) continue;
      const id = occurrenceId(input.rule.id, cursor, window.id);
      occurrences.push({
        id,
        actionId: input.rule.actionId,
        recurrenceRuleId: input.rule.id,
        windowId: window.id,
        windowName: window.name,
        localDate: cursor,
        windowStartsAt: resolved.startsAt,
        windowEndsAt: resolved.endsAt,
        anchorSource: resolved.source,
        status: input.statuses?.[id] ?? "pending",
        ...(input.routineCoveredWindowIds?.includes(window.id) ? { routineCovered: true } : {})
      });
    }
  }
  return occurrences.sort(
    (a, b) => a.windowStartsAt.getTime() - b.windowStartsAt.getTime() || a.id.localeCompare(b.id)
  );
}

export interface ResolveCommitmentOccurrencesInput {
  rule: CommitmentRecurrenceRule;
  from: Date;
  through: Date;
  /**
   * The per-date overlay (the commitment timeline design note, "Recurring occurrences carry their
   * per-date facts"): given the rule-generated occurrence, returns the stored row's own values when
   * that row is `scheduleSource: "custom"`, or `undefined` when there is no such row, so the caller
   * can tell "no override" apart from "overridden onto the same values". Called for every generated
   * occurrence, including the one extra local day scanned each side of `[from, through)` — a
   * non-overridden occurrence on one of those extra days is dropped rather than emitted, so widening
   * the scan cannot surface an ordinary occurrence outside its usual window.
   */
  overlay?: (occurrence: FixedCommitment) => FixedCommitment | undefined;
}

export function resolveCommitmentRecurrenceRepeats(input: ResolveCommitmentOccurrencesInput): FixedCommitment[] {
  if (input.rule.status === "ended") return [];
  const through = localDate(new Date(input.through.getTime() - 1), input.rule.timezone);
  // The ordinary window, used to tell an in-window cursor (always emitted, overlay or not) from an
  // extra-day cursor (emitted only when an override actually moved something onto it) — "Moving an
  // occurrence to another day" allows a stored `custom` row to land up to one local day either side of
  // its own scheduled date, so the generator scans one extra day each side and filters by the real
  // (overlaid) times below.
  const ordinaryStart = laterDate(input.rule.startDate, localDate(input.from, input.rule.timezone));
  const ordinaryEnd = earlierDate(input.rule.endDate ?? through, through);
  const start = laterDate(input.rule.startDate, addLocalDays(ordinaryStart, -1));
  const end = earlierDate(input.rule.endDate ?? addLocalDays(through, 1), addLocalDays(through, 1));
  if (start > end) return [];
  const occurrences: FixedCommitment[] = [];
  for (let cursor = start; cursor <= end; cursor = addLocalDays(cursor, 1)) {
    if (!commitmentRepeatFallsOn(input.rule.repeat, input.rule.startDate, cursor)) continue;
    const inOrdinaryWindow = cursor >= ordinaryStart && cursor <= ordinaryEnd;
    const { startsAt, endsAt } = fromClock(
      cursor,
      input.rule.timezone,
      { startTime: input.rule.localStartTime, endTime: input.rule.localEndTime },
      "local_time"
    );
    const generated: FixedCommitment = {
      id: commitmentOccurrenceId(input.rule.id, cursor),
      title: input.rule.title,
      status: "confirmed",
      startsAt,
      endsAt,
      ...(input.rule.location ? { location: input.rule.location } : {}),
      ...(input.rule.locationId ? { locationId: input.rule.locationId } : {}),
      ...(input.rule.presence ? { presence: input.rule.presence } : {}),
      setupBeforeMinutes: input.rule.setupBeforeMinutes,
      transitionAfterMinutes: input.rule.transitionAfterMinutes,
      recurrenceRuleId: input.rule.id,
      localDate: cursor,
      ...(input.rule.projectId ? { projectId: input.rule.projectId } : {}),
      ...(input.rule.latenessMatters !== undefined ? { latenessMatters: input.rule.latenessMatters } : {}),
      ...(input.rule.transportMode ? { transportMode: input.rule.transportMode } : {}),
      ...(input.rule.contactId ? { contactId: input.rule.contactId } : {})
    };
    const overridden = input.overlay?.(generated);
    if (!inOrdinaryWindow && !overridden) continue;
    const occurrence = overridden ?? generated;
    // The lower bound only ever needs to exclude a date *before* today's (`ordinaryStart`/the
    // widened `start` already do that): a one-off commitment is never excluded by clock time at all
    // (`state.commitments` carries it unconditionally), and tracked overtime needs the same —
    // a shift running late must not drop out of its own horizon the instant the clock passes its
    // *scheduled* end, since its protected window (transition, then the leg home) is exactly what
    // `withTravelLegs`/the timeline still need this occurrence present to compute. So only the upper
    // bound is checked here by clock time; `effectiveCommitmentEnd` still guards a genuinely
    // *earlier* day's occurrence that this same widened scan could otherwise surface.
    if (
      (cursor < ordinaryStart && effectiveCommitmentEnd(occurrence) <= input.from) ||
      occurrence.startsAt >= input.through
    )
      continue;
    occurrences.push(occurrence);
  }
  return occurrences.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime() || a.id.localeCompare(b.id));
}

/**
 * Which sleep row decides a `wake` window on a date.
 *
 * An observed wake beats a planned one, because it is what happened. A row carrying no wake time at
 * all decides nothing and is skipped rather than claiming the date: the resolver would only fall
 * through to the preferred wake time, and letting such a row shadow one that does know the wake
 * would throw away the better answer.
 */
function wakeAnchorMap(anchors: RecurrenceAnchor[]) {
  const result = new Map<string, RecurrenceAnchor>();
  for (const anchor of anchors) {
    if (!wakeRank(anchor)) continue;
    const date = anchor.wakeLocalDate ?? anchor.localDate;
    const current = result.get(date);
    if (!current || wakeRank(anchor) > wakeRank(current)) result.set(date, anchor);
  }
  return result;
}

function wakeRank(anchor: RecurrenceAnchor) {
  return anchor.actualWakeAt ? 2 : anchor.plannedWakeAt ? 1 : 0;
}

/**
 * Which sleep row decides a `sleep_start` window on a date.
 *
 * A wake fact settles wake windows and nothing else. Ranking every anchor by whether it carries an
 * `actualWakeAt` — as one shared map used to — put last night's bedtime in charge of tonight's:
 * a sleep begun after local midnight has *today* as its sleep-start date, so the finished night
 * outranked tonight's plan and anchored today's wind-down window to the small hours, where it had
 * already passed and no occurrence was written at all. The row left in the database then kept
 * whatever the previous run resolved, usually the fixed fallback clock, hours away from the sleep
 * plan it was supposed to track.
 *
 * So a night already slept through is excluded here, and among what remains the latest start on the
 * date wins — the night still ahead rather than the one behind. An anchor with no sleep start cannot
 * decide the window and never claims the date; leaving it out lets the window's fallback clock
 * answer instead, which is a truer guess than a bedtime that has already been and gone. Where a
 * sleep has actually begun, the caller folds that actual start into `plannedSleepStartAt`, so an
 * observed start already outranks the plan it replaced.
 */
function sleepStartAnchorMap(anchors: RecurrenceAnchor[]) {
  const result = new Map<string, RecurrenceAnchor>();
  for (const anchor of anchors) {
    if (!anchor.plannedSleepStartAt || anchor.actualWakeAt) continue;
    const date = anchor.sleepLocalDate ?? anchor.localDate;
    const current = result.get(date);
    if (!current || anchor.plannedSleepStartAt > current.plannedSleepStartAt!) result.set(date, anchor);
  }
  return result;
}

export function occurrenceId(ruleId: string, localDateValue: string, windowId: string): string {
  return `${ruleId}:${localDateValue}:${windowId}`;
}

export function localDate(date: Date, timezone: string): string {
  return localDateFormat(timezone).format(date);
}

function resolveWindow(
  localDateValue: string,
  timezone: string,
  window: RecurrenceWindow,
  anchor: RecurrenceAnchor | undefined,
  preferredWakeTime: string | undefined
): { startsAt: Date; endsAt: Date; source: OccurrenceAnchorSource } | null {
  if (window.anchor === "local_time")
    return fromClock(
      localDateValue,
      timezone,
      { startTime: window.localStartTime ?? "00:00", endTime: window.localEndTime ?? "23:59" },
      "local_time"
    );
  const anchorValue =
    window.anchor === "wake"
      ? (anchor?.actualWakeAt ??
        anchor?.plannedWakeAt ??
        (preferredWakeTime ? zonedDateTime(localDateValue, preferredWakeTime, timezone) : undefined))
      : anchor?.plannedSleepStartAt;
  const source: OccurrenceAnchorSource | undefined =
    window.anchor === "wake"
      ? anchor?.actualWakeAt
        ? "actual_wake"
        : anchor?.plannedWakeAt
          ? "planned_wake"
          : preferredWakeTime
            ? "preferred_wake"
            : undefined
      : anchorValue
        ? "planned_sleep"
        : undefined;
  if (anchorValue && source) {
    const startsAt = new Date(anchorValue.getTime() + (window.startOffsetMinutes ?? 0) * 60_000);
    const endsAt = new Date(anchorValue.getTime() + (window.endOffsetMinutes ?? 0) * 60_000);
    if (endsAt > startsAt) return { startsAt, endsAt, source };
  }
  return window.fallback ? fromClock(localDateValue, timezone, window.fallback, "fallback") : null;
}

function fromClock(localDateValue: string, timezone: string, clock: ClockWindow, source: OccurrenceAnchorSource) {
  const startsAt = zonedDateTime(localDateValue, clock.startTime, timezone);
  let endsAt = zonedDateTime(localDateValue, clock.endTime, timezone);
  if (endsAt <= startsAt) endsAt = zonedDateTime(addLocalDays(localDateValue, 1), clock.endTime, timezone);
  return { startsAt, endsAt, source };
}

export function addLocalDays(value: string, days: number) {
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}
export function dateOrdinal(value: string) {
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  return Math.floor(Date.UTC(year, month - 1, day) / DAY);
}
function laterDate(a: string, b: string) {
  return a > b ? a : b;
}
function earlierDate(a: string, b: string) {
  return a < b ? a : b;
}
