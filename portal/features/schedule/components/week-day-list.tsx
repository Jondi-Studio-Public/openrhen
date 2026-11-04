"use client";

import Link from "next/link";
import { nextDayKey } from "@/features/today/local-datetime";
import { durationLabel, shortTitle } from "@/features/today/day-summary";
import { Badge } from "@/components/ui/badge";
import { columnHeading } from "./week-timeline";
import type { WeekPlan } from "@/features/schedule/week-plan";
import styles from "./week-day-list.module.css";

/** Day pages the coming week only (today and six more), so only those days can be opened from here. */
const DAYS_AHEAD = 6;

/**
 * The week on a phone: one row per day with its free time, how much it holds and the first three
 * non-routine things on it, and a tap opens that day. The grid stays for wider screens; seven columns on a
 * phone were two and a half days with an inner scroll.
 */
export function WeekDayList({
  week,
  timezone,
  todayKey,
  free,
  due
}: {
  week: WeekPlan;
  timezone: string;
  todayKey: string;
  free: Array<number | null>;
  due: Array<Array<{ id: string; label: string }>>;
}) {
  const lastOpenable = nextDayKey(todayKey, DAYS_AHEAD);
  return (
    <ol className={styles.list} aria-label="The week, day by day">
      {week.days.map((day, index) => {
        const { weekday, date } = columnHeading(day, timezone);
        const things = day.plan.items.filter((item) => !item.marker && !item.window && item.kind !== "sleep");
        // Routine steps (the morning water and meds) open every day alike, so the preview skips them
        // and names the first three things that make this day different.
        const distinct = things.filter((item) => item.kind !== "routine_step");
        const preview = distinct.slice(0, 3).map((item) => shortTitle(item.title));
        const more = distinct.length - preview.length;
        const minutes = free[index];
        const today = day.plan.nowAt !== null;
        const openable = day.dayKey >= todayKey && day.dayKey <= lastOpenable;
        const body = (
          <>
            <span className={styles.head}>
              <b>
                {weekday} {date}
              </b>
              {today && <span className={styles.today}>Today</span>}
              <span className={styles.meta}>
                {minutes != null ? `${durationLabel(minutes)} free` : "Free time unknown"}
                {" · "}
                {things.length} {things.length === 1 ? "item" : "items"}
              </span>
            </span>
            {preview.length === 0 && things.length > 0 && <span className={styles.preview}>Routine only</span>}
            {preview.length > 0 && (
              <span className={styles.preview}>
                {preview.join(" · ")}
                {more > 0 && ` · +${more} more`}
              </span>
            )}
            {due[index]?.map((chip) => (
              <Badge key={chip.id} tone="warn" className={styles.due}>
                {chip.label}
              </Badge>
            ))}
          </>
        );
        return (
          <li key={day.dayKey} className={today ? styles.rowToday : styles.row}>
            {openable ? (
              <Link className={styles.link} href={`/today?day=${day.dayKey}`}>
                {body}
              </Link>
            ) : (
              <div className={styles.link}>{body}</div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
