"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { BannerTone } from "@/features/planning/plan-banner";

/** How long an ordinary wait for a plan may last before the banner asks whether the worker is running. */
export const SLOW_WORKING_MS = 60_000;

/**
 * The one banner across the top of every page. `working` is neutral with a moving bar, `warning` is
 * amber, and only `danger` is red and interrupts a screen reader. A wait that runs past a minute adds a
 * pointer to Connections, since the usual cause of a plan that never arrives is a stopped worker.
 */
export function StatusBanner({ tone, text, action }: { tone: BannerTone; text: string; action?: ReactNode }) {
  const slow = useSlow(tone === "working");
  const ref = useBannerHeight(tone);
  return (
    <div
      ref={ref}
      // Keyed on tone so the entrance plays when the banner appears or changes kind, not on every poll.
      key={tone}
      className={`status-banner tone-${tone}`}
      role={tone === "danger" ? "alert" : "status"}
      aria-live={tone === "danger" ? "assertive" : "polite"}
    >
      <span>
        {text}
        {slow && (
          <>
            {" "}
            Is the planner worker running? <Link href="/connections">Check Connections</Link>
          </>
        )}
      </span>
      {action}
    </div>
  );
}

/**
 * Publishes the banner's height as `--status-banner-height` on the root, so the desk's sticky nav rail
 * can start below it and keep its foot (Connections, the view switch) on screen. Gone with the banner.
 */
function useBannerHeight(tone: BannerTone) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const banner = ref.current;
    const root = document.documentElement;
    if (!banner) return;
    const publish = () => root.style.setProperty("--status-banner-height", `${banner.offsetHeight}px`);
    publish();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(publish);
    observer?.observe(banner);
    return () => {
      observer?.disconnect();
      root.style.removeProperty("--status-banner-height");
    };
    // The banner is keyed on its tone, so a change of tone is a new element to observe.
  }, [tone]);
  return ref;
}

/** True once `active` has held continuously for `SLOW_WORKING_MS`; resets the moment it stops. */
function useSlow(active: boolean): boolean {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!active) {
      // oxlint-disable-next-line react/set-state-in-effect -- resets the timer's own result when the wait ends
      setSlow(false);
      return;
    }
    const timer = window.setTimeout(() => setSlow(true), SLOW_WORKING_MS);
    return () => window.clearTimeout(timer);
  }, [active]);
  return slow;
}
