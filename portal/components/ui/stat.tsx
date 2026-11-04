import type { ReactNode } from "react";
import { cx } from "./cx";
import styles from "./stat.module.css";

/** A single figure with a quiet label under it, such as "4 hours free". Read as value, then label. */
export function Stat({ value, label, className }: { value: ReactNode; label: string; className?: string }) {
  return (
    <div className={cx(styles.stat, className)}>
      <span className={styles.value}>{value}</span>
      <span className={styles.label}>{label}</span>
    </div>
  );
}

/** A thin progress bar for a fraction from 0 to 1 (clamped). `label` is its accessible name. */
export function Meter({ value, label, className }: { value: number; label: string; className?: string }) {
  const fraction = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={1}
      aria-valuenow={fraction}
      aria-valuetext={`${Math.round(fraction * 100)}%`}
      className={cx(styles.meter, className)}
    >
      <i className={styles.fill} style={{ width: `${fraction * 100}%` }} />
    </div>
  );
}
