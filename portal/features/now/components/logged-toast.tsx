"use client";

import { loggedLine } from "@/features/now/logged-session";
import type { LoggedSession } from "@/state/portal-provider";
import styles from "../session-logging.module.css";

/**
 * "Logged 42 min on X" for ten seconds after a session is saved; the provider owns the expiry, so it
 * runs out wherever the person is. It has no Undo: a person's session
 * write keeps no row snapshot to put back (only an agent's does), so offering one would be a button
 * that cannot work.
 */
export function LoggedToast({ logged }: { logged: LoggedSession | null | undefined }) {
  // The live region stays mounted so a screen reader hears each new line, not only the first.
  return (
    <div className={styles.toastRegion} role="status" aria-live="polite">
      {logged ? <p className={styles.toast}>{loggedLine(logged.minutes, logged.title)}</p> : null}
    </div>
  );
}
