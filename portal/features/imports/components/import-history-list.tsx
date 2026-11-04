"use client";

import { dateTimeFormat, displayLocale } from "@/shared/locale";
import { describeImportBatchSource, type ImportBatchSummary } from "@/features/imports/import-queue";
import { useNow } from "@/shared/clock";
import { isWithinHandledWindow } from "@/shared/recently-handled";

const when = () => dateTimeFormat(displayLocale(), { dateStyle: "medium", timeStyle: "short" });

/**
 * What was written in the last seven days, under the queue and folded away: this room's "Recently
 * handled". A committed batch is not a
 * decision waiting to be made — it cannot be edited, committed again, or deleted — so it is
 * deliberately not the swipe-to-delete list above it: no delete, no selection, no gestures. Opening
 * a row still reads it, because "what exactly went in on Tuesday" is the question this answers, and
 * the review panel already refuses to save or commit anything whose status is committed.
 *
 * It is capped by the server rather than paged. A list of the last twenty-five imports answers that
 * question; a complete audit of every import ever made is a different feature.
 */
export function ImportHistoryList({
  history,
  selectedId,
  busy,
  onOpen,
  now
}: {
  history: ImportBatchSummary[];
  selectedId: string | null;
  busy: boolean;
  onOpen: (id: string) => void;
  /** The instant the seven days are counted back from. */
  now?: number;
}) {
  const clock = useNow("minute");
  const instant = now ?? clock.getTime();
  const recent = history.filter((item) => isWithinHandledWindow(item.committedAt ?? item.updatedAt, instant));
  return (
    <details className="inbox-history">
      <summary>
        Recently handled <span>{recent.length}</span>
      </summary>
      <ul className="inbox-history-list">
        {recent.map((item) => {
          const name = describeImportBatchSource(item);
          const at = item.committedAt ?? item.updatedAt;
          return (
            <li key={item.id}>
              <button
                type="button"
                className={`inbox-history-item${item.id === selectedId ? " selected" : ""}`}
                aria-current={item.id === selectedId ? "true" : undefined}
                disabled={busy}
                onClick={() => onOpen(item.id)}
              >
                <strong>{name}</strong>
                <span>
                  {item.recordCount} record{item.recordCount === 1 ? "" : "s"} · imported {when().format(new Date(at))}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {!recent.length && <p className="empty">No import was committed in the last 7 days.</p>}
      <p className="microcopy">
        These have been written to your plan. Opening one shows what it contained; it cannot be edited or committed
        again.
      </p>
    </details>
  );
}
