"use client";

import Link from "next/link";
import { openGoTo } from "@/shared/use-go-to";
import { PlusIcon, SearchIcon, TabIcon } from "./icons";
import { activeTab, primaryTabs } from "./app-nav-tabs";
import styles from "./app-nav.module.css";

/**
 * The five places, drawn twice by the shell: the bottom tab bar a phone shows and the side rail a desk
 * shows. Which one is visible is decided by the stylesheet at 1024px. Everything that is not one of the
 * five is reached from inside its place or by Go to (Ctrl K), so neither copy carries secondary links.
 *
 * Links are client-side (`next/link`), so the shell stays mounted between pages.
 */
export function AppNav({
  variant,
  pathname,
  onCapture,
  inboxCount = 0,
  youAlert = false,
  planUpdated = null
}: {
  variant: "tabs" | "rail";
  pathname: string | null;
  onCapture: () => void;
  /** Everything in the Inbox waiting for a decision; the Inbox tab wears it as a badge when above zero. */
  inboxCount?: number;
  /** A connection has lapsed; the You tab wears a dot. */
  youAlert?: boolean;
  /** When the plan on screen was worked out ("8:33 am", "Mon 8:33 am"); the rail's foot says it. */
  planUpdated?: string | null;
}) {
  const rail = variant === "rail";
  const tab = activeTab(pathname);

  return (
    <nav className={`app-nav ${rail ? styles.rail : styles.tabs}`} data-variant={variant} aria-label="Primary">
      {rail && (
        <>
          <Link className={styles.brand} href="/">
            <span className={styles.mark} aria-hidden="true">
              <svg
                viewBox="0 0 24 24"
                width="14"
                height="14"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="m5 12.5 4.5 4.5L19 7.5" />
              </svg>
            </span>
            OpenRhen
          </Link>
          <button
            type="button"
            className={styles.search}
            aria-haspopup="dialog"
            aria-keyshortcuts="Control+K Meta+K"
            onClick={openGoTo}
          >
            <SearchIcon size={16} />
            <span>Go to…</span>
            <kbd className={styles.kbd}>Ctrl K</kbd>
          </button>
        </>
      )}
      {!rail && (
        // The phone has no Ctrl K, so Go to gets its own button, held at the top right of the screen.
        <button
          type="button"
          className={styles.phoneSearch}
          aria-label="Go to"
          aria-haspopup="dialog"
          onClick={openGoTo}
        >
          <SearchIcon size={20} />
        </button>
      )}
      <ul className={styles.list}>
        {primaryTabs.map((item) => (
          <li key={item.tab}>
            <Link
              className={styles.link}
              aria-current={tab === item.tab ? "page" : undefined}
              data-tab={item.tab}
              href={item.href}
            >
              <TabIcon tab={item.tab} />
              <span className={styles.label}>{item.label}</span>
              {item.tab === "inbox" && inboxCount > 0 && (
                // Keyed on the count, so a change remounts the badge and plays its one small pop.
                <span key={inboxCount} className={styles.badge} role="img" aria-label={`${inboxCount} to review`}>
                  {inboxCount > 99 ? "99+" : inboxCount}
                </span>
              )}
              {item.tab === "you" && youAlert && (
                <span className={styles.dot} role="img" aria-label="A connection needs attention" />
              )}
            </Link>
          </li>
        ))}
      </ul>
      <button
        type="button"
        className={styles.capture}
        aria-label="Capture a thought"
        aria-haspopup="dialog"
        onClick={onCapture}
      >
        <PlusIcon size={rail ? 18 : 24} />
        {rail && <span>Capture</span>}
      </button>
      {rail && planUpdated && (
        <p className={styles.updated} aria-live="polite">
          Plan updated {planUpdated}
        </p>
      )}
    </nav>
  );
}
