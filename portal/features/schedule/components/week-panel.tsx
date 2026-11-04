"use client";

import { isClosedStatus } from "@openrhen/contracts";
import { dateTimeFormat, displayLocale } from "@/shared/locale";
import { useMemo, useState } from "react";
import { usePortal } from "@/state/portal-provider";
import type { StoredCommitment, StoredDeliverable } from "@/state/portal-state";
import { useNow } from "@/shared/clock";
import { buildWeekPlan, type WeekPlan } from "@/features/schedule/week-plan";
import type { DayPlanItem } from "@/features/today/day-plan";
import { durationLabel, shortTitle } from "@/features/today/day-summary";
import { nextDayKey, zonedDayStart } from "@/features/today/local-datetime";
import { dayCapacityMinutes, localDayKey } from "@/features/today/today-view";
import type { ClientSlot } from "@/state/portal-provider";
import { formatZonedDate } from "@/shared/date-format";
import { navigateTo } from "@/shared/navigate";
import { ChevronIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { IconButton } from "@/components/ui/icon-button";
import { PageHeader } from "@/components/ui/page-header";
import { PlaceTabs } from "@/components/place-tabs";
import { useMediaQuery } from "@/shared/use-media-query";
import { WeekDayList } from "./week-day-list";
import { WeekTimeline } from "./week-timeline";
import styles from "./week-panel.module.css";

/**
 * The week calendar and the controls that move it.
 *
 * The window is rolling rather than calendar-week snapped, so it opens on today and pages by seven
 * days from wherever it is. Which week is on screen is the only state here: the plan itself is built
 * from the same provider inputs Today builds its day from — the same hooks, the same engine result,
 * the same clock — because a week that fetched its own facts could disagree with the day view about
 * what is in it, and two answers to that question is one too many.
 *
 * Two things the canvas cannot say for itself are said underneath it. Past the last occurrence the
 * server has materialized, a recurring commitment is drawn from its rule rather than from a stored
 * row, and the reader is owed the difference. And a week already gone holds no forward plan at all —
 * the engine simulates from now — so what is drawn there is what was fixed, not what was done.
 */

/** Tighter than the day view's 48–56: seven of these have to fit beside each other. */
const WEEK_PIXELS_PER_HOUR = 40;

export function WeekPanel() {
  const {
    state,
    slots,
    allocations,
    recommendation,
    currentDirective,
    upcomingDirectives,
    dayPlan: engineDayPlan
  } = usePortal();
  const now = useNow("minute");
  // Seven columns do not fit a phone: it gets the days as a list, each one a way into Day.
  const phone = useMediaQuery("(max-width: 719px)");
  const timezone = state.settings.timezone;
  const todayKey = localDayKey(now, timezone);
  /**
   * Null is "wherever today is", not a missing value. Holding the anchor that way rather than
   * seeding it with today's key keeps the panel right across a day boundary and across hydration —
   * the clock reads the epoch before it starts, and a key captured then would have anchored the
   * week to January 1970 until something else re-rendered it.
   */
  const [chosenAnchor, setChosenAnchor] = useState<string | null>(null);
  const anchorDayKey = chosenAnchor ?? todayKey;
  // Rebuilt when the week, the state or the engine's result changes, and once a minute for the
  // now-line — the same minute-rounded clock Today hands `buildDayPlan`.
  const nowMinute = Math.floor(now.getTime() / 60_000);
  const week = useMemo(
    () =>
      buildWeekPlan({
        state,
        slots,
        allocations,
        recommendation,
        currentDirective,
        upcomingDirectives,
        engineDayPlan,
        anchorDayKey,
        now: new Date(nowMinute * 60_000),
        timezone
      }),
    [
      state,
      slots,
      allocations,
      recommendation,
      currentDirective,
      upcomingDirectives,
      engineDayPlan,
      anchorDayKey,
      nowMinute,
      timezone
    ]
  );

  // Counted as the grid draws them: sleep is left off the week.
  const items = week.days.reduce(
    (total, day) => total + day.plan.items.filter((item) => item.kind !== "sleep").length,
    0
  );
  const lastVisibleKey = week.days.at(-1)!.dayKey;
  const horizonKey = materializedHorizon(state.commitments);
  // Only worth saying where there are rules to project from and the window actually reaches past
  // what the job has already written down.
  const projectingBeyondHorizon =
    horizonKey !== null &&
    lastVisibleKey > horizonKey &&
    state.commitmentRecurrenceRules.some((rule) => rule.status === "active");
  const inThePast = anchorDayKey < todayKey;

  const selectItem = (item: DayPlanItem) => {
    // Only a commitment has a page of its own from here. A projected occurrence is drawn as text
    // rather than as a control, so it never reaches this — and it is not in `state.commitments`
    // either, which is the same fact stated twice and the second one is the safety net.
    if (item.kind !== "commitment") return;
    if (!state.commitments.some((commitment) => commitment.id === item.entityId)) return;
    navigateTo(`/commitments/${encodeURIComponent(item.entityId)}`);
  };

  const free = week.days.map((day) => freeMinutesOn(slots, day.plan.bounds, now, day.dayKey === todayKey));
  const due = week.days.map((day) => dueOn(state.deliverables, day.plan.bounds));
  const thisWeek = chosenAnchor === null;

  return (
    <>
      <PageHeader
        title={thisWeek ? "This week" : `Week of ${formatZonedDate(zonedDayStart(anchorDayKey, timezone), timezone)}`}
        answer={weekAnswer(week, free, timezone)}
        actions={
          <>
            <IconButton label="Previous week" onClick={() => setChosenAnchor(nextDayKey(anchorDayKey, -7))}>
              <ChevronIcon direction="left" />
            </IconButton>
            <Button size="sm" aria-pressed={thisWeek} onClick={() => setChosenAnchor(null)}>
              This week
            </Button>
            <IconButton label="Next week" onClick={() => setChosenAnchor(nextDayKey(anchorDayKey, 7))}>
              <ChevronIcon direction="right" />
            </IconButton>
          </>
        }
      />
      <PlaceTabs />
      <Card as="section" aria-label={`Week, ${items} ${items === 1 ? "item" : "items"}`} className={styles.card}>
        {phone ? (
          <WeekDayList week={week} timezone={timezone} todayKey={todayKey} free={free} due={due} />
        ) : (
          <WeekTimeline
            week={week}
            timezone={timezone}
            pixelsPerHour={WEEK_PIXELS_PER_HOUR}
            free={free}
            due={due}
            now={now}
            onSelect={selectItem}
          />
        )}
        <p className={styles.note}>
          {phone
            ? "Tap a day to open it."
            : "Sleep sits outside these hours. Today is tinted. Open any commitment to see its page."}
          {inThePast && " Past weeks show commitments only."}
          {projectingBeyondHorizon &&
            ` Occurrences after ${formatZonedDate(zonedDayStart(horizonKey, timezone), timezone)} are projected from their rules.`}
        </p>
      </Card>
    </>
  );
}

/**
 * The free time on one day of the week, from the engine's slots: what is left of today, the whole of
 * a later day, nothing for a day already gone, and null for a day the slots do not reach at all.
 */
export function freeMinutesOn(
  slots: ReadonlyArray<Pick<ClientSlot, "startsAt" | "endsAt" | "capacityMinutes">>,
  bounds: { startsAt: Date; endsAt: Date },
  now: Date,
  today: boolean
): number | null {
  if (bounds.endsAt <= now) return null;
  if (!slots.some((slot) => slot.endsAt > bounds.startsAt && slot.startsAt < bounds.endsAt)) return null;
  const capacity = dayCapacityMinutes(slots, bounds.startsAt, bounds.endsAt, now);
  return today ? capacity.remaining : (capacity.usable ?? capacity.remaining);
}

/**
 * What falls due on one day of the week: each open deliverable whose deadline lands inside it, named
 * short, the external deadline first because that is the one somebody else holds you to.
 */
export function dueOn(
  deliverables: ReadonlyArray<StoredDeliverable>,
  bounds: { startsAt: Date; endsAt: Date }
): Array<{ id: string; label: string }> {
  return deliverables
    .filter((item) => !(item.status === "completed" || isClosedStatus(item.status)))
    .flatMap((item) => {
      const deadline = item.externalDeadlineAt ?? item.internalDeadlineAt;
      if (!deadline) return [];
      const at = new Date(deadline);
      return at >= bounds.startsAt && at < bounds.endsAt
        ? [{ id: item.id, at, label: `${shortTitle(item.title)} due` }]
        : [];
    })
    .sort((a, b) => a.at.getTime() - b.at.getTime())
    .map(({ id, label }) => ({ id, label }));
}

/**
 * The sentence under the week's heading: the free time across it, and the day with the least room.
 * Today's figure is only what is left of it, so it is counted in the total but never named the
 * tightest: set against other days' whole figures it would win every evening and say nothing.
 */
export function weekAnswer(week: WeekPlan, free: Array<number | null>, timezone: string): string {
  const known = free.flatMap((minutes, index) => (minutes === null ? [] : [{ minutes, index }]));
  if (!known.length) return "Commitments for the seven days, with recurring ones shown from their rules.";
  const total = known.reduce((sum, day) => sum + day.minutes, 0);
  const whole = known.filter((day) => !week.days[day.index]!.plan.nowAt);
  if (!whole.length) return `${durationLabel(total)} free across these days.`;
  const tightest = whole.reduce((least, day) => (day.minutes < least.minutes ? day : least));
  const weekday = dateTimeFormat(displayLocale(), { timeZone: timezone, weekday: "long" }).format(
    week.days[tightest.index]!.plan.bounds.startsAt
  );
  return `${durationLabel(total)} free across these days. ${weekday} has the least room, ${durationLabel(tightest.minutes)}.`;
}

/**
 * The last day a recurring commitment has actually been written down for. The materialization job
 * only runs a fortnight or so ahead, so a week paged past this is a week drawn from rules — true,
 * but not yet a fact anybody could open, move or cancel.
 */
export function materializedHorizon(commitments: StoredCommitment[]): string | null {
  return commitments.reduce<string | null>(
    (latest, item) =>
      item.recurrenceRuleId && item.localDate && (latest === null || item.localDate > latest) ? item.localDate : latest,
    null
  );
}
