import type { ReactNode } from "react";
import { cx } from "@/components/ui/cx";
import { NOW_HERO_ATTRIBUTE } from "@/features/now/hero-transition";
import styles from "../now-page.module.css";

/**
 * The hero card every Now state shares: a kicker that says what kind of moment this is ("Do this now ·
 * about 45 min, until 9:20 am"), the one headline, the line under it, then the state's own panel.
 * Marked so a change of what it shows runs the `now-hero` view transition.
 */
export function NowHero({
  kicker,
  title,
  lead,
  label,
  className,
  children
}: {
  kicker?: ReactNode;
  title?: ReactNode;
  lead?: ReactNode;
  label?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={cx("now-hero", styles.hero, className)} aria-label={label} {...{ [NOW_HERO_ATTRIBUTE]: "" }}>
      {kicker ? (
        <p className={styles.kicker}>
          <span className={styles.ring} aria-hidden="true" />
          {kicker}
        </p>
      ) : null}
      {title || lead ? (
        <div className={styles.heading}>
          {title ? <h1>{title}</h1> : null}
          {lead ? <p className={styles.lead}>{lead}</p> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}
