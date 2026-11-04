"use client";

import { dateTimeFormat, displayLocale } from "@/shared/locale";
import { useState } from "react";
import { usePortal } from "@/state/portal-provider";
import { HISTORY_WINDOW_DAYS } from "@/shared/history-window";
import { sessionSource } from "@/features/history/session-source";
import { sessionTags } from "@/features/history/session-tags";
import { HistoryCalendar, type CalendarRange } from "@/features/history/history-calendar";
import { localDayKey } from "@/features/today/today-view";

export default function HistoryPage() {
  const { state, ready } = usePortal();
  // The lists follow the week or month the calendar shows; before it reports one, nothing is filtered.
  const [range, setRange] = useState<CalendarRange | null>(null);
  if (!ready)
    return (
      <main className="content-page">
        <p>Loading history…</p>
      </main>
    );
  const inRange = (dayKey: string) => !range || (dayKey >= range.start && dayKey <= range.end);
  const sessions = state.completedToday
    .filter((session) => inRange(localDayKey(new Date(session.endedAt), state.settings.timezone)))
    .sort((a, b) => b.endedAt.localeCompare(a.endedAt));
  const closedOccurrences = state.occurrences
    .filter((item) => (item.status === "completed" || item.status === "missed") && inRange(item.localDate))
    .sort((a, b) => b.windowEndsAt.localeCompare(a.windowEndsAt));
  return (
    <main className="content-page history-page">
      <h1>History</h1>
      <p className="reason">
        What actually happened: work, required routines, repeating actions and sleep, kept as a record, not a
        productivity score. Sessions are kept for {HISTORY_WINDOW_DAYS} days; the lists below follow the week or month
        shown.
      </p>
      <HistoryCalendar state={state} onRangeChange={setRange} />
      {closedOccurrences.length > 0 && (
        <section>
          <div className="section-heading">
            <h2>Repeating actions</h2>
            <span>{closedOccurrences.length}</span>
          </div>
          {closedOccurrences.map((occurrence) => {
            const action = state.actions.find((item) => item.id === occurrence.actionId);
            return (
              <article className="row-card" key={occurrence.id}>
                <div>
                  <strong>
                    {action?.title ?? "Recurring action"} · {occurrence.windowName}
                  </strong>
                  <p>
                    {occurrence.localDate} · {occurrence.anchorSource.replaceAll("_", " ")}
                  </p>
                </div>
                <span className={`health ${occurrence.status === "completed" ? "ahead" : "behind"}`}>
                  {occurrence.status}
                </span>
              </article>
            );
          })}
        </section>
      )}
      <div className="section-heading">
        <h2>Sessions</h2>
        {range && <span>{range.title}</span>}
      </div>
      {sessions.length ? (
        sessions.map((session) => {
          const wallMinutes = Math.max(
            0,
            Math.round((new Date(session.endedAt).getTime() - new Date(session.startedAt).getTime()) / 60_000)
          );
          const paused = Math.max(0, wallMinutes - session.activeMinutes);
          const overrun = session.activeMinutes - session.plannedMinutes;
          const source = sessionSource(session, state);
          return (
            <article className="history-card" key={session.id}>
              <div className="section-heading">
                <div>
                  <h2>{session.actionTitle}</h2>
                  <p>{[source, session.result.replaceAll("_", " "), ...sessionTags(session)].join(" · ")}</p>
                </div>
                <time>
                  {dateTimeFormat(displayLocale(), {
                    dateStyle: "medium",
                    timeStyle: "short",
                    timeZone: state.settings.timezone
                  }).format(new Date(session.endedAt))}
                </time>
              </div>
              <div className="metric-row history-metrics">
                <div>
                  <strong>{session.plannedMinutes}</strong>
                  <span>planned min</span>
                </div>
                <div>
                  <strong>{session.activeMinutes}</strong>
                  <span>{session.targetType === "sleep" ? "recorded sleep min" : "active min"}</span>
                </div>
                <div>
                  <strong className={overrun > 0 ? "overtime" : undefined}>
                    {overrun > 0 ? `+${overrun}` : overrun < 0 ? `−${-overrun}` : overrun}
                  </strong>
                  <span>vs. planned</span>
                </div>
                <div title="Minutes between starting and finishing that were not active work: paused, or waiting for you to say what happened.">
                  <strong>{paused}</strong>
                  <span>min paused</span>
                </div>
                {(!session.targetType || session.targetType === "action") && (
                  <div>
                    <strong>
                      {session.remainingBeforeMinutes} → {session.remainingAfterMinutes}
                    </strong>
                    <span>remaining effort</span>
                  </div>
                )}
              </div>
              {session.blockingReason && <p>Blocked: {session.blockingReason.replaceAll("_", " ")}</p>}
              {session.overrideReason && <p>Override: {session.overrideReason.replaceAll("_", " ")}</p>}
              {session.resultNote && <p>{session.resultNote}</p>}
            </article>
          );
        })
      ) : (
        <p className="empty">
          {range && state.completedToday.length
            ? `No sessions in ${range.title}.`
            : "Completed, stopped, blocked, did-not-start, and sleep sessions will appear here."}
        </p>
      )}
    </main>
  );
}
