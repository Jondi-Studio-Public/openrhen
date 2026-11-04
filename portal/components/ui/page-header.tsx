import type { ReactNode } from "react";
import { cx } from "./cx";
import styles from "./page-header.module.css";

/**
 * The top of a page: the h1, one sentence under it that answers what the person came to find out
 * ("You have 3 hours free today"), and the page's actions on the right. On phones (under 720px)
 * the actions drop below the text.
 */
export function PageHeader({
  title,
  answer,
  actions,
  className
}: {
  title: string;
  answer?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cx(styles.head, className)}>
      <div className={styles.text}>
        <h1 className={styles.title}>{title}</h1>
        {answer ? <p className={styles.answer}>{answer}</p> : null}
      </div>
      {actions ? <div className={styles.actions}>{actions}</div> : null}
    </header>
  );
}
