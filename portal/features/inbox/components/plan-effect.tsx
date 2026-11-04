import type { ReactNode } from "react";
import styles from "./plan-effect.module.css";

/** "What it does to your plan": the sentence an Inbox detail leads with, before any form. */
export function PlanEffect({ children }: { children: ReactNode }) {
  return (
    <div className={styles.effect}>
      <p className={styles.label}>What it does to your plan</p>
      <div className={styles.text}>{children}</div>
    </div>
  );
}
