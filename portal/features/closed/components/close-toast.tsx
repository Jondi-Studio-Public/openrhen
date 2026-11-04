"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { createClientId } from "@/shared/client-id";
import { usePortal } from "@/state/portal-provider";
import { closeToastText, failureText, restoreToastText, undoCommandFor } from "../close-commands";
import { closeToasts, useCloseToast, type CloseToast } from "../close-toast-store";
import styles from "./close-toast.module.css";

/** How long a close's toast waits for an Undo. */
export const CLOSE_TOAST_MS = 10_000;

/**
 * The toast after an Archive, Cancel or Restore. The shell mounts this once, so it survives the navigation a close
 * often causes. The live region stays mounted so a screen reader hears each new message, not only the first.
 */
export function CloseToastRegion() {
  const toast = useCloseToast();
  return (
    <div className={styles.region} role="status" aria-live="polite" aria-label="Archive and cancel results">
      {toast && <ToastCard key={toast.key} toast={toast} />}
    </div>
  );
}

function ToastCard({ toast }: { toast: CloseToast }) {
  const { closeEntityCommand } = usePortal();
  const [held, setHeld] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [error, setError] = useState("");
  const undoButton = useRef<HTMLButtonElement>(null);
  // One id per card, so a second press after a lost answer replays the receipt instead of restoring twice.
  const undoId = useRef<string>("");
  const dismiss = () => closeToasts.dismiss(toast.key);

  // Ten seconds, held while the pointer or focus is on it and after a failed Undo (the reason stays until read).
  const frozen = held || undoing || error !== "";
  useEffect(() => {
    if (frozen) return;
    const timer = window.setTimeout(() => closeToasts.dismiss(toast.key), CLOSE_TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [frozen, toast.key]);

  // The button that closed the row is gone with the row, which would drop a keyboard user's focus to the page; Undo is
  // the next thing they need. Focus a mouse user has already put elsewhere is left alone.
  useEffect(() => {
    if (toast.kind !== "closed") return;
    const timer = window.setTimeout(() => {
      const active = document.activeElement;
      if (!active || active === document.body) undoButton.current?.focus({ preventScroll: true });
    }, 30);
    return () => window.clearTimeout(timer);
  }, [toast]);

  async function undo() {
    if (toast.kind !== "closed" || undoing) return;
    undoId.current ||= createClientId();
    setUndoing(true);
    setError("");
    try {
      const restored = await closeEntityCommand(undoCommandFor(toast.closed, { commandId: undoId.current }), {
        handles: () => true
      });
      closeToasts.show({ kind: "notice", text: restoreToastText(toast.title, restored) });
    } catch (caught) {
      setError(failureText(caught, "undo"));
      setUndoing(false);
    }
  }

  return (
    <div
      className={styles.toast}
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
    >
      <span className={error ? `${styles.text} ${styles.error}` : styles.text}>
        {error || (toast.kind === "closed" ? closeToastText(toast.title, toast.closed) : toast.text)}
      </span>
      {toast.kind === "closed" && (
        <Button ref={undoButton} variant="ghost" size="sm" disabled={undoing} onClick={() => void undo()}>
          Undo
        </Button>
      )}
      <Button variant="ghost" size="sm" className={styles.close} aria-label="Dismiss" onClick={dismiss}>
        ×
      </Button>
    </div>
  );
}
