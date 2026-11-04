"use client";

import { useLayoutEffect, useRef, type ReactNode } from "react";

/**
 * Keeps a panel's primary controls under the thumb. The Now panels each end in a `.actions` row
 * (Start, Pause, Finish…); wrapping a panel in this docks that row just above the tab bar on a phone
 * for as long as the panel is on screen, so the first thing to press is never a scroll away. On a
 * desk, where the whole panel is above the fold, the row stays where the panel put it. The panels
 * themselves are unchanged — this is only a positioning scope around them.
 *
 * While the row is docked its real height is published as `--docked-actions-height`, which the page's
 * bottom padding and the floating Capture button rise by: a notice line under the buttons (the plan
 * is not refreshing, say) makes the bar a row taller, and a fixed guess left Capture over Start.
 */
export function ActionBar({ children, className = "" }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  // No dependency list: the panel inside can swap its actions row on any render, so each render looks
  // again for the row to measure.
  useLayoutEffect(() => {
    const row = ref.current?.querySelector<HTMLElement>(":scope > .actions");
    if (!row) return;
    const root = document.documentElement;
    const publish = () => {
      if (getComputedStyle(row).position === "fixed")
        root.style.setProperty("--docked-actions-height", `${row.offsetHeight}px`);
      else root.style.removeProperty("--docked-actions-height");
    };
    publish();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(publish);
    observer?.observe(row);
    // A desk-width window narrowed to a phone docks the row without resizing it.
    window.addEventListener("resize", publish);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", publish);
      root.style.removeProperty("--docked-actions-height");
    };
  });
  return (
    <div ref={ref} className={`action-bar ${className}`.trim()}>
      {children}
    </div>
  );
}
