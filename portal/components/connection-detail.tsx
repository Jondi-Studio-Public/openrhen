import type { ReactNode } from "react";
import { cx } from "./ui/cx";
import styles from "./connection-detail.module.css";

/** The vertical rhythm of a connection's details inside its sheet. */
export function DetailStack({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx(styles.stack, className)}>{children}</div>;
}

/** A bold label on the left and its button or note on the right. */
export function DetailSubheading({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <div className={styles.subheading}>
      <strong>{title}</strong>
      {children}
    </div>
  );
}

export function DetailDivider() {
  return <hr className={styles.divider} />;
}

/** Big numbers with a label under each. */
export function DetailMetrics({ items }: { items: ReadonlyArray<{ value: ReactNode; label: string }> }) {
  return (
    <div className={styles.metrics}>
      {items.map((item) => (
        <div key={item.label} className={styles.metric}>
          <strong>{item.value}</strong>
          <span>{item.label}</span>
        </div>
      ))}
    </div>
  );
}

/** Technical detail such as the names of missing settings; only ever shown inside a sheet. */
export function DetailCode({ children }: { children: ReactNode }) {
  return <code className={styles.code}>{children}</code>;
}

/** A label followed by small pills, such as a calendar's profiles. */
export function DetailChips({ label, items }: { label: string; items: readonly string[] }) {
  return (
    <div className={styles.chips}>
      <span>{label}</span>
      {items.map((item) => (
        <strong key={item}>{item}</strong>
      ))}
    </div>
  );
}

export function DetailList({ children }: { children: ReactNode }) {
  return <ul className={styles.list}>{children}</ul>;
}
