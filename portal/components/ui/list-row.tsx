import Link from "next/link";
import type { ReactNode } from "react";
import { cx } from "./cx";
import styles from "./list-row.module.css";

/** Stacks {@link ListRow}s and drops the first row's top border so the list sits flush in a Card. */
export function List({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx(styles.list, className)}>{children}</div>;
}

function Chevron() {
  return (
    <svg
      className={styles.chev}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <path d="M6 3l5 5-5 5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * One line of a list: an optional leading slot (or a fixed-width `time` column so times line up
 * down the page), a title with optional meta underneath, and an optional trailing slot. With `href`
 * the whole row is a link and shows a chevron; with `onClick` it is a button; otherwise it is plain.
 * `current` marks the row whose detail is open beside the list.
 */
export function ListRow({
  leading,
  time,
  title,
  meta,
  trailing,
  href,
  onClick,
  disabled,
  pressed,
  current = false,
  className
}: {
  leading?: ReactNode;
  time?: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
  trailing?: ReactNode;
  href?: string;
  onClick?: () => void;
  /** A button row that cannot be used right now; the sheet or card it sits in says why. */
  disabled?: boolean;
  /** For a row that is one of a set of choices: whether it is the chosen one. */
  pressed?: boolean;
  /** The row whose detail is showing beside the list; announced as aria-current. */
  current?: boolean;
  className?: string | undefined;
}) {
  const cls = cx(styles.row, current && styles.current, className);
  const currentAttr = current ? ("true" as const) : undefined;
  const body = (
    <>
      {time !== undefined ? <span className={styles.time}>{time}</span> : null}
      {leading ? <span className={styles.leading}>{leading}</span> : null}
      <span className={styles.main}>
        <span className={styles.title}>{title}</span>
        {meta ? <span className={styles.meta}>{meta}</span> : null}
      </span>
      {trailing ? <span className={styles.trailing}>{trailing}</span> : null}
      {href ? <Chevron /> : null}
    </>
  );
  if (href) {
    return (
      <Link href={href} className={cls} aria-current={currentAttr}>
        {body}
      </Link>
    );
  }
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-pressed={pressed}
        className={cls}
        aria-current={currentAttr}
      >
        {body}
      </button>
    );
  }
  return <div className={cls}>{body}</div>;
}
