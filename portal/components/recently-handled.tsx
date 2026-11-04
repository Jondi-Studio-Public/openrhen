"use client";

import { dateTimeFormat, displayLocale } from "@/shared/locale";
import type { HandledRow } from "@/shared/recently-handled";

const when = () => dateTimeFormat(displayLocale(), { dateStyle: "medium", timeStyle: "short" });

/** Each room has one list, so the Inbox's toast can open it by this id ("View in Recently handled"). */
export const RECENTLY_HANDLED_ID = "inbox-recently-handled";

/**
 * The foot of an Inbox room: what was confirmed or ignored here in the last seven days, folded away.
 * It is a record, not a to-do, so it stays closed and offers no actions; the thing it names has
 * already been decided.
 */
export function RecentlyHandled({ rows, empty }: { rows: readonly HandledRow[]; empty?: string }) {
  return (
    <details className="inbox-history inbox-handled" id={RECENTLY_HANDLED_ID}>
      <summary>
        Recently handled <span>{rows.length}</span>
      </summary>
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
              <span className={`proposal-status ${row.outcome}`}>{row.outcome}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="empty">{empty ?? "Nothing handled here in the last 7 days."}</p>
      )}
    </details>
  );
}
