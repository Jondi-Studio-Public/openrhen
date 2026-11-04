"use client";

import { canRestoreWithBatch, type ClosedRow as Row } from "@openrhen/contracts";
import { Button } from "@/components/ui/button";
import { dateTimeFormat, displayLocale } from "@/shared/locale";
import { closedByText, kindLine } from "../closed-words";
import { noun } from "../closable-row";
import styles from "./closed-list.module.css";

function whenText(iso: string | null, timeZone: string | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return dateTimeFormat(displayLocale(), {
    ...(timeZone ? { timeZone } : {}),
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}

/** One closed record: what it is, who closed it and when, why, and how to bring it back. */
export function ClosedRow({
  row,
  timeZone,
  busy,
  message,
  rowRef,
  onRestore,
  onOpenBlocker
}: {
  row: Row;
  timeZone: string | undefined;
  busy: boolean;
  message: string | undefined;
  rowRef?: ((element: HTMLLIElement | null) => void) | undefined;
  onRestore: (row: Row, includeChildren: boolean) => void;
  onOpenBlocker: (tab: "archived" | "cancelled") => void;
}) {
  const when = whenText(row.closedAt, timeZone);
  const others = row.batchSize - 1;
  const withBatch = canRestoreWithBatch(row);
  const blocker = row.blockedBy;
  return (
    <li className={styles.row} ref={rowRef} tabIndex={-1} aria-label={`${kindLine(row)}: ${row.title}`}>
      <div className={styles.text}>
        <p className={styles.title}>{row.title}</p>
        <p className={styles.meta}>{kindLine(row)}</p>
        <p className={styles.meta}>
          {closedByText(row.closedBy)}
          {when ? `, ${when}` : ""}
          {row.reason ? `. Reason: ${row.reason}` : ""}
        </p>
        {others > 0 && <p className={styles.meta}>Closed with {others} {others === 1 ? "other" : "others"}.</p>}
        {message && (
          <p role="alert" className={styles.problem}>
            {message}
          </p>
        )}
      </div>
      <div className={styles.actions}>
        {blocker ? (
          <>
            <Button disabled aria-label={`Restore ${noun(row.type)} "${row.title}" (restore ${blocker.title} first)`}>
              Restore
            </Button>
            <button type="button" className={styles.linkButton} onClick={() => onOpenBlocker(blocker.status)}>
              Restore {blocker.title} first
            </button>
          </>
        ) : withBatch ? (
          <>
            <Button disabled={busy} onClick={() => onRestore(row, true)}>
              Restore with the {others} closed with it
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => onRestore(row, false)}>
              Restore only this
            </Button>
          </>
        ) : (
          <Button
            disabled={busy}
            aria-label={`Restore ${noun(row.type)} "${row.title}"`}
            onClick={() => onRestore(row, false)}
          >
            Restore
          </Button>
        )}
      </div>
    </li>
  );
}
