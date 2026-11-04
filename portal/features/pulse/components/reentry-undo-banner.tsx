"use client";

import { useEffect, useRef, useState } from "react";
import { Banner } from "@/components/ui/banner";
import { Button } from "@/components/ui/button";
import { usePortal } from "@/state/portal-provider";
import { postRevert, type ReentryDone } from "../reentry-client";
import styles from "./reentry-panel.module.css";

/**
 * After a re-entry: "Back on plan." with Undo, which puts the lapsed pulse and the unsettled items back through the
 * same undo the agents' writes use (`POST /api/commands/revert`). Dismiss keeps the re-entry.
 */
export function ReentryUndoBanner({ done, onClose }: { done: ReentryDone; onClose: () => void }) {
  const { acceptServerState } = usePortal();
  const wrapper = useRef<HTMLDivElement>(null);
  // The sheet that held focus is gone, so focus lands here and a screen reader reads the status.
  useEffect(() => wrapper.current?.focus(), []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function undo() {
    setBusy(true);
    setError("");
    try {
      const next = await postRevert(done.revertible);
      if (next) acceptServerState(next);
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The undo was not applied.");
    } finally {
      setBusy(false);
    }
  }
  const detail =
    done.unrecorded > 0
      ? ` ${done.unrecorded} ${done.unrecorded === 1 ? "answer was" : "answers were"} recorded as unrecorded, not done.`
      : "";
  return (
    <div ref={wrapper} tabIndex={-1} className={styles.undoWrap}>
      <Banner
        tone="info"
        action={
          <span className={styles.actions}>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => void undo()}>
              Undo
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={onClose}>
              Dismiss
            </Button>
          </span>
        }
      >
        Back on plan.{detail}
        {error && <span role="alert"> {error}</span>}
      </Banner>
    </div>
  );
}
