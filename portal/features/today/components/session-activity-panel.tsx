"use client";

import type { SessionHistoryItem } from "@/state/portal-state";

/** What actually happened today: every session that ended, with what it left behind. */
export function SessionActivityPanel({ sessions }: { sessions: SessionHistoryItem[] }) {
  return (
    <>
      {sessions.length ? (
        sessions.map((item) => (
          <article className="row-card" key={item.id}>
            <div>
              <strong>{item.actionTitle}</strong>
              <p>
                {item.result}
                {item.remainingAfterMinutes ? ` · ${item.remainingAfterMinutes} min remaining` : ""}
              </p>
            </div>
            <span>{item.activeMinutes} active min</span>
          </article>
        ))
      ) : (
        <p className="empty">Sessions you finish, stop or get blocked on today will show here.</p>
      )}
    </>
  );
}
