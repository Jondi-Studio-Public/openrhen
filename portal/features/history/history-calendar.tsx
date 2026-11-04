"use client";

import { dateTimeFormat, displayLocale } from "@/shared/locale";
import { useEffect, useMemo, useState } from "react";
import type { PortalState } from "@/state/portal-state";
import { localDayKey } from "@/features/today/today-view";
import {
  buildCalendar,
  shiftAnchor,
  spanWindowLabel,
  type CalendarDay,
  type CalendarView,
  type CalendarWeek
} from "./calendar-model";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const dayLabel = (key: string) =>
  dateTimeFormat(displayLocale(), { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(
    new Date(`${key}T00:00:00Z`)
  );

function DayCell({ day }: { day: CalendarDay }) {
  const empty = !day.sessions.length && !day.sleep.length && !day.occurrences.length;
  return (
    <li
      className={`history-cal-day${day.inRange ? "" : " outside"}${day.isToday ? " today" : ""}`}
      aria-label={dayLabel(day.key)}
    >
      <span className="history-cal-date" aria-hidden="true">
        {day.dayOfMonth}
      </span>
      {day.sessions.map((entry) => (
        <p className="history-cal-entry session" key={entry.id} title={entry.detail}>
          <span className="history-cal-sr">Session: </span>
          {entry.title}
        </p>
      ))}
      {day.sleep.map((entry) => (
        <p className="history-cal-entry sleep" key={entry.id} title={entry.detail}>
          <span className="history-cal-sr">Sleep: </span>
          {entry.title}
        </p>
      ))}
      {day.occurrences.map((entry) => (
        <p className={`history-cal-entry occurrence ${entry.detail}`} key={entry.id} title={entry.detail}>
          <span className="history-cal-sr">Recurring, {entry.detail}: </span>
          {entry.title}
        </p>
      ))}
      {empty && day.beforeSessionWindow && day.inRange && <p className="history-cal-old">Not kept</p>}
    </li>
  );
}

function Week({ week }: { week: CalendarWeek }) {
  return (
    <div className="history-cal-week">
      {week.laneCount > 0 && (
        <ul
          className="history-cal-bands"
          aria-label="Spans"
          style={{ gridTemplateRows: `repeat(${week.laneCount}, auto)` }}
        >
          {week.bands.map((band) => {
            const window = band.windowLabel;
            return (
              <li
                key={`${band.spanId}-${band.startColumn}`}
                className={`history-cal-band${band.continuesBefore ? " continues-before" : ""}${band.continuesAfter ? " continues-after" : ""}`}
                style={{ gridColumn: `${band.startColumn + 1} / ${band.endColumn + 2}`, gridRow: band.lane + 1 }}
              >
                <strong>{band.title}</strong>
                {window && <span> {window}</span>}
              </li>
            );
          })}
        </ul>
      )}
      <ol className="history-cal-days">
        {week.days.map((day) => (
          <DayCell day={day} key={day.key} />
        ))}
      </ol>
    </div>
  );
}

/** The period the calendar is showing, so the lists under it can follow it. */
export interface CalendarRange {
  start: string;
  end: string;
  title: string;
}

export function HistoryCalendar({
  state,
  onRangeChange
}: {
  state: PortalState;
  onRangeChange?: (range: CalendarRange) => void;
}) {
  const [now] = useState(() => new Date());
  const timezone = state.settings.timezone;
  const [view, setView] = useState<CalendarView>("week");
  const [anchor, setAnchor] = useState(() => localDayKey(now, timezone));
  const model = useMemo(() => buildCalendar({ view, anchor, now, state }), [view, anchor, now, state]);
  const { rangeStart, rangeEnd, title } = model;
  useEffect(() => {
    onRangeChange?.({ start: rangeStart, end: rangeEnd, title });
  }, [onRangeChange, rangeStart, rangeEnd, title]);
  const spanSummary = state.spans.filter((span) =>
    model.weeks.some((week) => week.bands.some((band) => band.spanId === span.id))
  );
  return (
    <section className="history-calendar" aria-labelledby="history-calendar-title">
      <div className="section-heading">
        <h2 id="history-calendar-title">Calendar</h2>
        <div className="history-cal-toggle" role="group" aria-label="Calendar view">
          {(["week", "month"] as const).map((option) => (
            <button
              type="button"
              key={option}
              aria-pressed={view === option}
              className={view === option ? "active" : undefined}
              onClick={() => setView(option)}
            >
              {option === "week" ? "Week" : "Month"}
            </button>
          ))}
        </div>
      </div>
      <div className="history-cal-nav">
        <button type="button" onClick={() => setAnchor(shiftAnchor(view, anchor, -1))}>
          Previous
        </button>
        <strong aria-live="polite">{model.title}</strong>
        <button type="button" onClick={() => setAnchor(localDayKey(now, timezone))}>
          Today
        </button>
        <button type="button" onClick={() => setAnchor(shiftAnchor(view, anchor, 1))}>
          Next
        </button>
      </div>
      {model.notice && <p className="reason history-cal-notice">{model.notice}.</p>}
      <div className="history-cal-scroll">
        <div className={`history-cal-grid ${view}`}>
          <div className="history-cal-weekdays" aria-hidden="true">
            {WEEKDAYS.map((name) => (
              <span key={name}>{name}</span>
            ))}
          </div>
          {model.weeks.map((week) => (
            <Week week={week} key={week.days[0]!.key} />
          ))}
        </div>
      </div>
      {spanSummary.length > 0 && (
        <ul className="history-cal-span-list" aria-label="Spans in view">
          {spanSummary.map((span) => (
            <li key={span.id}>
              {span.title}: {span.startDate === span.endDate ? span.startDate : `${span.startDate} to ${span.endDate}`}
              {spanWindowLabel(span) ? `, ${spanWindowLabel(span)} each day` : ""}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
