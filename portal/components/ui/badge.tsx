import type { HTMLAttributes } from "react";
import { cx } from "./cx";
import styles from "./badge.module.css";

export type BadgeTone = "neutral" | "accent" | "warn" | "danger" | "info";

/**
 * A small status pill. The tone carries meaning (warn, danger), so the words in it must say the
 * same thing: colour is never the only signal. The leading dot is decorative.
 */
export function Badge({
  tone = "neutral",
  dot = true,
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone; dot?: boolean }) {
  return (
    <span className={cx(styles.badge, styles[tone], className)} {...rest}>
      {dot ? <span className={styles.dot} aria-hidden="true" /> : null}
      {children}
    </span>
  );
}
