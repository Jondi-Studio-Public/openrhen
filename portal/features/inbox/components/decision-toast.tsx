"use client";

import { useState } from "react";
import { RECENTLY_HANDLED_ID } from "@/components/recently-handled";
import { useToastClock, type DecisionToast as Toast } from "../use-inbox-decisions";

/** "Confirmed", "Ignored 3 changes", "Dropped 2 items", "Link confirmed", "Dismissed 2 findings". */
export function toastMessage(toast: Pick<Toast, "exit" | "ids" | "verb" | "noun" | "attempted" | "subject">): string {
  if (toast.subject && toast.ids.length === 1) return toast.subject;
  const verb = toast.verb ?? (toast.exit === "confirm" ? "Confirmed" : "Ignored");
  if (toast.noun) {
    return toast.ids.length > 1
      ? `${verb} ${toast.ids.length} ${toast.noun}s`
      : `${toast.noun.charAt(0).toUpperCase()}${toast.noun.slice(1)} ${verb.toLowerCase()}`;
  }
  const things = toast.verb ? "items" : "changes";
  if (toast.attempted && toast.attempted > toast.ids.length)
    return `${verb} ${toast.ids.length} of ${toast.attempted} ${things}`;
  return toast.ids.length > 1 ? `${verb} ${toast.ids.length} ${things}` : verb;
}

/** Opens the room's Recently handled list and moves focus to it, which is where a decided card went. */
export function showRecentlyHandled() {
  const list = document.getElementById(RECENTLY_HANDLED_ID);
  if (!(list instanceof HTMLDetailsElement)) return;
  list.open = true;
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  list.scrollIntoView?.({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
  list.querySelector("summary")?.focus({ preventScroll: true });
}

/**
 * What the last decision did, for six seconds: "Confirmed · View in Recently handled", or "Ignored ·
 * Undo" where the server can put the item back exactly as it was. A confirm has already made its
 * record, so it offers the way to the room's record instead of an undo.
 */
export function DecisionToast({ toast, onDismiss }: { toast: Toast | null; onDismiss: () => void }) {
  // The live region stays mounted so a screen reader hears each new message, not only the first.
  return (
    <div className="inbox-toast-region" role="status" aria-live="polite">
      {toast && <ToastCard key={toast.key} toast={toast} onDismiss={onDismiss} />}
    </div>
  );
}

function ToastCard({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const clock = useToastClock(toast, onDismiss);
  const [error, setError] = useState("");
  const [undoing, setUndoing] = useState(false);
  const action = toast.action;
  return (
    <div
      className="inbox-toast"
      onPointerEnter={clock.hold}
      onPointerLeave={clock.letGo}
      onFocus={clock.hold}
      onBlur={clock.letGo}
    >
      <span>{error || toastMessage(toast)}</span>
      {action.kind === "undo" ? (
        <button
          type="button"
          className="quiet small"
          disabled={undoing}
          onClick={async () => {
            setUndoing(true);
            try {
              await action.run();
              onDismiss();
            } catch (undoError) {
              setError(undoError instanceof Error ? undoError.message : "That could not be undone.");
              setUndoing(false);
            }
          }}
        >
          Undo
        </button>
      ) : (
        <button
          type="button"
          className="quiet small"
          onClick={() => {
            showRecentlyHandled();
            onDismiss();
          }}
        >
          View in Recently handled
        </button>
      )}
      <button type="button" className="quiet small inbox-toast-close" aria-label="Dismiss" onClick={onDismiss}>
        ×
      </button>
    </div>
  );
}
