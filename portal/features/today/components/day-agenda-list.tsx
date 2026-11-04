"use client";

import { useState } from "react";
import type { DayPlan, DayPlanItem, DayPlanUntimed, DayPlanWait } from "@/features/today/day-plan";
import { formatZonedTime } from "@/shared/date-format";
import { formatDeadline } from "./day-timeline";

const SOURCE_LABEL: Record<DayPlanItem["source"], string> = {
  fixed: "fixed",
  recorded: "recorded",
  engine: "planned",
  reserved: "reserved"
};

/** The chip for a commitment the projection could give no journey figure at all
 * */
const TRAVEL_GAP_LABEL: Record<NonNullable<DayPlanItem["travelGap"]>, string> = {
  no_place: "no place set",
  no_estimate: "travel time is a guess"
};

/**
 * The same day as a list in start order: the accessible route through the timeline and the view
 * for anyone who would rather read than scan. Every row is the same button the block is, so a tap
 * goes to the same editor either way; the "next up" chips come last, still without a time.
 */
export function DayAgendaList({
  plan,
  timezone,
  showReserved,
  foldPast = false,
  onSelect,
  onSelectWait,
  onSelectUntimed
}: {
  plan: DayPlan;
  timezone: string;
  showReserved: boolean;
  /**
   * On the day that has a now, fold the rows that have already ended into one "N earlier today" line,
   * so a phone opens on what is next rather than on a screenful of the morning. Off elsewhere.
   */
  foldPast?: boolean;
  onSelect: (item: DayPlanItem) => void;
  onSelectWait?: ((wait: DayPlanWait) => void) | undefined;
  onSelectUntimed?: ((chip: DayPlanUntimed) => void) | undefined;
}) {
  const [showPast, setShowPast] = useState(false);
  const time = (value: Date) => formatZonedTime(value, timezone);
  type Row = { kind: "item"; item: DayPlanItem } | { kind: "wait"; wait: DayPlanWait };
  const baseItems = showReserved
    ? [...plan.items, ...plan.reserved].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
    : plan.items;
  const baseRows: Row[] = baseItems.map((item): Row => ({ kind: "item", item }));
  // Waits interleave by start time only when there are any — merging is a stable sort over rows that
  // are each already in start order, so this changes nothing when `plan.waits` is empty.
  const rows: Row[] = plan.waits.length
    ? [...baseRows, ...plan.waits.map((wait): Row => ({ kind: "wait", wait }))].sort(
        (a, b) =>
          (a.kind === "item" ? a.item.startsAt : a.wait.startsAt).getTime() -
          (b.kind === "item" ? b.item.startsAt : b.wait.startsAt).getTime()
      )
    : baseRows;
  if (!rows.length && !plan.untimed.length) return <p className="empty">Nothing is placed on this day yet.</p>;
  const nowAt = foldPast ? plan.nowAt : null;
  const endedAt = (row: Row) => (row.kind === "item" ? row.item.endsAt : row.wait.endsAt);
  const isPast = (row: Row) => nowAt !== null && endedAt(row) <= nowAt;
  const pastCount = rows.filter(isPast).length;
  // One folded row would cost a tap to save a line, so a lone past row stays where it is.
  const folding = pastCount >= 2;
  return (
    <div className="day-agenda">
      {folding && (
        <button
          type="button"
          className="day-agenda-fold"
          aria-expanded={showPast}
          onClick={() => setShowPast(!showPast)}
        >
          {showPast ? "Hide earlier" : `${pastCount} earlier today`}
        </button>
      )}
      <ol className="day-agenda-list" aria-label="Day agenda">
        {rows.map((row) => {
          if (folding && !showPast && isPast(row)) return null;
          if (row.kind === "wait") {
            const wait = row.wait;
            const body = (
              <>
                <span className="day-agenda-time">
                  <span>{time(wait.startsAt)}–</span>
                  <wbr />
                  <span>{time(wait.endsAt)}</span>
                </span>
                <span className="day-agenda-body">
                  <strong>
                    Waiting · {wait.title.split(" · ")[0]} until {time(wait.endsAt)}
                  </strong>
                </span>
                <span className="day-agenda-source">{wait.running ? "running" : "projected"}</span>
              </>
            );
            return (
              <li
                key={wait.id}
                className={`day-agenda-row day-agenda-row-fixed day-agenda-row-window day-agenda-row-wait${wait.stale ? " stale" : ""}`}
              >
                {onSelectWait ? (
                  <button type="button" onClick={() => onSelectWait(wait)}>
                    {body}
                  </button>
                ) : (
                  body
                )}
              </li>
            );
          }
          const item = row.item;
          return (
            <li
              key={item.id}
              className={`day-agenda-row day-agenda-row-${item.source}${item.window ? " day-agenda-row-window" : ""}${item.stale ? " stale" : ""}`}
            >
              <button type="button" onClick={() => onSelect(item)}>
                <span className="day-agenda-time">
                  {item.marker ? (
                    <span>{time(item.startsAt)}</span>
                  ) : (
                    <>
                      <span>{item.clippedStart ? "…" : time(item.startsAt)}–</span>
                      <wbr />
                      <span>{item.clippedEnd ? "…" : time(item.endsAt)}</span>
                    </>
                  )}
                </span>
                <span className="day-agenda-body">
                  {/*
                  A window is context for the day rather than an event in it, so its row is the
                  quiet one: a single clipped line whatever the action is called. A recurring
                  action's title is a whole instruction — "stretch for ten minutes twice daily, log
                  it each evening, and keep going for eight weeks" — and wrapping all
                  of it made the row that says nothing happens yet the tallest thing on the day. The
                  full wording stays on the hover title and in the detail sheet.
                */}
                  <strong {...(item.window ? { title: item.title } : {})}>{item.title}</strong>
                  {item.travelGap && (
                    <small className="day-agenda-travel-gap" title={TRAVEL_GAP_LABEL[item.travelGap]}>
                      {TRAVEL_GAP_LABEL[item.travelGap]}
                    </small>
                  )}
                  {(item.subtitle || item.steps || item.deadlineAt) && (
                    <small>
                      {item.kind === "reserved" || item.kind === "soft"
                        ? item.kind === "soft"
                          ? `${item.subtitle} · not held for anyone`
                          : item.deadlineAt
                            ? `Reserved by ${formatDeadline(item.deadlineAt, timezone)} · not a session`
                            : "Reserved · not a session"
                        : // A leg is movement, not work, and the row says so rather than letting the
                          // minutes read as time spent on whatever waits at the other end. The block
                          // starts when you need to leave, so the row says that in words too.
                          item.kind === "travel"
                          ? `Travel · ${item.subtitle} · Leave by ${time(item.startsAt)}`
                          : item.subtitle}
                      {item.steps?.length
                        ? ` · ${item.steps.map((step) => `${step.title} ${time(step.startsAt)}`).join(" · ")}`
                        : ""}
                    </small>
                  )}
                </span>
                <span className="day-agenda-source">{item.projected ? "projected" : SOURCE_LABEL[item.source]}</span>
              </button>
            </li>
          );
        })}
      </ol>
      {plan.untimed.length > 0 && (
        <div className="day-agenda-untimed" role="group" aria-label="Next up, not yet timed">
          <span className="day-timeline-untimed-label">Next up · not timed</span>
          {plan.untimed.map((chip) =>
            onSelectUntimed ? (
              <button
                key={chip.id}
                type="button"
                className="day-timeline-chip"
                title={chip.reason}
                onClick={() => onSelectUntimed(chip)}
              >
                {chip.title} · {chip.minutes} min
              </button>
            ) : (
              <span key={chip.id} className="day-timeline-chip">
                {chip.title} · {chip.minutes} min
              </span>
            )
          )}
        </div>
      )}
    </div>
  );
}
