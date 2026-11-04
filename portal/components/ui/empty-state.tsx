import type { ReactNode } from "react";
import { cx } from "./cx";
import styles from "./empty-state.module.css";

/** What a list or page shows when there is nothing in it: say why, and offer the next step if there is one. */
export function EmptyState({
  title,
  body,
  action,
  className,
  titleAs: Title = "p"
}: {
  title: string;
  /** "h1" when the empty state is the whole page, so the page still has a heading. */
  titleAs?: "p" | "h1" | "h2";
  body?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx(styles.empty, className)}>
      <Title className={styles.title}>{title}</Title>
      {body ? <p className={styles.body}>{body}</p> : null}
      {action ? <div className={styles.action}>{action}</div> : null}
    </div>
  );
}
