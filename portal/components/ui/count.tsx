import type { HTMLAttributes } from "react";
import { cx } from "./cx";
import styles from "./count.module.css";

/**
 * A number in a small pill, such as how many items wait in a tab. `hot` marks a count that needs
 * attention. Digits are tabular so the pill does not jitter as the number changes. Pass `aria-label`
 * when the bare number would be unclear ("3 unread").
 */
export function Count({
  value,
  hot = false,
  className,
  ...rest
}: Omit<HTMLAttributes<HTMLSpanElement>, "children"> & { value: number; hot?: boolean }) {
  return (
    <span className={cx(styles.count, hot && styles.hot, className)} {...rest}>
      {value}
    </span>
  );
}
