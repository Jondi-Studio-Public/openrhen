"use client";

import Link from "next/link";
import { usePortal } from "@/state/portal-provider";
import { useNow } from "@/shared/clock";
import { reviewProgress } from "@/features/review/review-progress";
import styles from "./review-due-line.module.css";

/**
 * One line on Now while steps of this week's review remain and the week has not been marked reviewed.
 * It says how many are left and links to the review; it is gone once the review is finished.
 */
export function ReviewDueLine() {
  const { state, forecasts, ready } = usePortal();
  const now = useNow("minute");
  if (!ready) return null;
  const progress = reviewProgress(state, forecasts, now);
  if (!progress.due) return null;
  const left = progress.stepsLeft === 1 ? "1 step" : `${progress.stepsLeft} steps`;
  return (
    <p className={styles.line}>
      <span className={styles.dot} aria-hidden="true" />
      <span>Weekly review: {left} left.</span>{" "}
      <Link href="/review" className={styles.link}>
        Open review
      </Link>
    </p>
  );
}
