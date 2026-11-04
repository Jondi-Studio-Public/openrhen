"use client";

import { useEffect, useRef, useState } from "react";
import type { DayPlan, DayPlanItem, DayPlanUntimed, DayPlanWait } from "@/features/today/day-plan";
import type { TomorrowBrief } from "@/features/today/tomorrow-preview";
import { Card, CardHeader } from "@/components/ui/card";
import { cx } from "@/components/ui/cx";
import { Segmented } from "@/components/ui/segmented";
import { formatZonedTime } from "@/shared/date-format";
import { DayAgendaList } from "./day-agenda-list";
import { DayTimeline } from "./day-timeline";
import { TomorrowSummary } from "./tomorrow-summary";
import styles from "./day-plan-card.module.css";

export type DayPlanView = "timeline" | "list";

/**
 * The day on one card: a timeline from wake to bed on a desk, an agenda list on a phone, and either
 * on request. Which day is on it is the page's choice; the card only draws it. The night is cropped
 * off the timeline rather than scrolled past, so the card opens on the waking day with nothing to find.
 *
 * Moving to another day redraws the canvas behind a 160ms fade (opacity only; none under reduced
 * motion). The first draw does not fade.
 */
export function DayPlanCard({
  plan,
  timezone,
  phone,
  planStale = false,
  showReserved = false,
  onSelect,
  onSelectWait,
  onSelectUntimed,
  brief
}: {
  plan: DayPlan;
  timezone: string;
  phone: boolean;
  /** The plan on screen is not the latest; planned blocks are still drawn, greyed. */
  planStale?: boolean;
  /** Draw the latest-safe reservations behind the day; the page owns the switch. */
  showReserved?: boolean;
  onSelect: (item: DayPlanItem) => void;
  onSelectWait?: (wait: DayPlanWait) => void;
  onSelectUntimed?: (chip: DayPlanUntimed) => void;
  /** Tomorrow's brief, written above its canvas when tomorrow is the day on the card. */
  brief?: TomorrowBrief | null;
}) {
  const [chosenView, setView] = useState<DayPlanView | null>(null);
  const view = chosenView ?? (phone ? "list" : "timeline");
  const dayKey = plan.bounds.dayKey;
  // Once the reader has moved to another day, every day drawn after it fades in, the first one too.
  const [lastDay, setLastDay] = useState(dayKey);
  const [switched, setSwitched] = useState(false);
  if (lastDay !== dayKey) {
    setLastDay(dayKey);
    setSwitched(true);
  }
  /**
   * What the projected day looked like on the previous run, so a reshuffle can be named rather than
   * simply happening. Memory of the page's own history, held nowhere else and never sent anywhere:
   * blocks keep stable keys and do not animate, and this one line says how many of them moved.
   */
  const previousRun = useRef<{ calculatedAt: number; keys: string[] } | null>(null);
  const [replanned, setReplanned] = useState<{ at: Date; moved: number } | null>(null);

  useEffect(() => {
    const at = plan.calculatedAt;
    if (!at) return;
    const keys = plan.items.filter((item) => item.projected).map((item) => item.id);
    const previous = previousRun.current;
    previousRun.current = { calculatedAt: at.getTime(), keys };
    if (!previous || previous.calculatedAt === at.getTime()) return;
    const moved = keys.filter((key) => !previous.keys.includes(key)).length;
    setReplanned({ at, moved });
  }, [plan]);

  return (
    <Card as="section" aria-label="Day plan" className={styles.card}>
      <CardHeader
        title="Day plan"
        as="h2"
        className={cx(styles.head)}
        trailing={
          <Segmented<DayPlanView>
            label="Day plan view"
            value={view}
            onChange={setView}
            options={[
              { value: "timeline", label: "Timeline" },
              { value: "list", label: "List" }
            ]}
          />
        }
      />
      <div className={styles.notes}>
        {replanned && (
          <p className={styles.note} role="status">
            Plan updated {formatZonedTime(replanned.at, timezone)}:{" "}
            {replanned.moved === 0
              ? "nothing moved"
              : `${replanned.moved} block${replanned.moved === 1 ? "" : "s"} moved`}
          </p>
        )}
        {planStale && (
          <p className={styles.note}>This plan is out of date. Planned blocks are greyed until the next one lands.</p>
        )}
        {plan.displaced.length > 0 && (
          <p className={cx(styles.note, styles.warn)}>
            {plan.displaced.length === 1
              ? "One deadline is not reached in time."
              : `${plan.displaced.length} deadlines are not reached in time.`}{" "}
            The plan does not get to the work before its latest safe start.
          </p>
        )}
        {showReserved && (
          <p className={styles.note}>
            Reserved blocks show the latest each deadline&rsquo;s work could start and still fit. They are not sessions
            and not when to do the work.
          </p>
        )}
        {brief && <TomorrowSummary brief={brief} timezone={timezone} />}
      </div>
      <div key={dayKey} className={cx(styles.day, switched && styles.switched)} data-day={dayKey}>
        {view === "timeline" ? (
          <div className={styles.timeline}>
            <DayTimeline
              plan={plan}
              timezone={timezone}
              pixelsPerHour={phone ? 48 : 52}
              showReserved={showReserved}
              cropToWaking
              onSelect={onSelect}
              onSelectWait={onSelectWait}
              onSelectUntimed={onSelectUntimed}
            />
          </div>
        ) : (
          <DayAgendaList
            plan={plan}
            timezone={timezone}
            showReserved={showReserved}
            foldPast={phone}
            onSelect={onSelect}
            onSelectWait={onSelectWait}
            onSelectUntimed={onSelectUntimed}
          />
        )}
      </div>
    </Card>
  );
}
