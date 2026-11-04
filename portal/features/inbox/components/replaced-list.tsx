"use client";

import { dateTimeFormat, displayLocale } from "@/shared/locale";
import { useState } from "react";
import type { HandledRow } from "@/shared/recently-handled";

const when = () => dateTimeFormat(displayLocale(), { dateStyle: "medium", timeStyle: "short" });

/**
 * The foot of the Emails room: Mail proposals a later reading of the mail replaced in the last seven
 * days, folded away like Recently handled (its count stays in view) but with a Restore on each. Nothing replaced leaves the
 * Inbox without a trace, and Restore puts it back to Needs review (security review J5). A restore
 * that fails is shown here, since the row it was for has not moved.
 */
export function ReplacedList({
  rows,
  error,
  onRestore
}: {
  rows: readonly HandledRow[];
  error?: string;
  onRestore: (id: string) => Promise<void> | void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const restore = async (id: string) => {
    setBusy(id);
    try {
      await onRestore(id);
    } finally {
      setBusy(null);
    }
  };
  return (
    <details className="inbox-history inbox-replaced">
      <summary>
        Replaced <span>{rows.length}</span>
      </summary>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {rows.length ? (
        <ul className="inbox-history-list">
          {rows.map((row) => (
            <li className="inbox-handled-row" key={row.id}>
              <div>
                <strong>{row.title}</strong>
                <span>
                  {row.detail} · {when().format(new Date(row.at))}
                </span>
              </div>
              <button
                type="button"
                className="small"
                disabled={busy === row.id}
                aria-label={`Restore ${row.title}`}
                onClick={() => void restore(row.id)}
              >
                Restore
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="empty">Nothing replaced in the last 7 days.</p>
      )}
    </details>
  );
}
