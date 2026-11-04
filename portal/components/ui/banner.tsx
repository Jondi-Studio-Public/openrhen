import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";
import styles from "./banner.module.css";

export type BannerTone = "neutral" | "warn" | "danger" | "info";

/**
 * A full-width message about the state of the page, with an optional icon and one action. Danger is
 * announced immediately (role="alert"); the other tones are polite (role="status").
 */
export function Banner({
  tone = "neutral",
  icon,
  action,
  stackActions,
  className,
  children,
  ...rest
}: Omit<HTMLAttributes<HTMLDivElement>, "role"> & {
  tone?: BannerTone;
  icon?: ReactNode;
  action?: ReactNode;
  /** On a narrow screen, put the action under the message so the text keeps the full width. */
  stackActions?: boolean;
}) {
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={cx(styles.banner, styles[tone], stackActions && styles.stack, className)}
      {...rest}
    >
      {icon ? (
        <span className={styles.icon} aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <div className={styles.text}>{children}</div>
      {action ? <div className={styles.action}>{action}</div> : null}
    </div>
  );
}
