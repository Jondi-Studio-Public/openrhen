"use client";

import { Sheet } from "@/components/sheet";
import { Button } from "@/components/ui/button";
import { hoursMinutes } from "@/features/now/now-formatting";
import styles from "../now-page.module.css";

/**
 * "Switch to": the running task stops here and keeps the time it had left, then Now opens Something
 * else. The list cannot be shown before this: while a session is open the engine rules every other
 * task out, so its alternatives only exist once this one has ended and the plan has run again.
 */
export function SwitchToSheet({
  open,
  onClose,
  title,
  keepMinutes,
  saving,
  onSwitch
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  /** What the task keeps as its estimate, when it has one. */
  keepMinutes: number | null;
  saving: boolean;
  onSwitch: () => Promise<void>;
}) {
  return (
    <Sheet open={open} onClose={onClose} title="Switch to something else?">
      <div className={styles.sheetBody}>
        <p className={styles.sheetSub}>
          {title} stops now
          {keepMinutes ? ` and keeps its ${hoursMinutes(keepMinutes)}` : ""}. Then you pick what to do instead.
        </p>
        <div className={styles.sheetActions}>
          <Button variant="ghost" onClick={onClose}>
            Keep going
          </Button>
          <Button
            variant="primary"
            disabled={saving}
            onClick={() => {
              onClose();
              void onSwitch().catch(() => undefined);
            }}
          >
            Stop and choose
          </Button>
        </div>
      </div>
    </Sheet>
  );
}
