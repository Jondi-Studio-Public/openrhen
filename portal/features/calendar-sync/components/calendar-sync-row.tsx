"use client";

import type { CalendarSyncProvider } from "@openrhen/contracts";
import { formatConnectionDateTime as formatDateTime } from "@/shared/connection-date-time";
import { Button } from "@/components/ui/button";
import { DetailCode, DetailSubheading } from "@/components/connection-detail";
import { useCalendarSync, type CalendarSyncRun } from "../use-calendar-sync";

/** One line for the outcome of a run: what changed, what waits, or why it failed. */
export function describeSyncOutcome(run: CalendarSyncRun): string {
  const summary = run.summary;
  if (summary?.status === "failed") return summary.message;
  if (summary?.status === "not_configured") return `Not configured: missing ${summary.missing.join(", ")}.`;
  if (summary?.status === "synced" || summary?.status === "needs_review") {
    const held = summary.heldForReview;
    return (
      `${summary.eventCount} event${summary.eventCount === 1 ? "" : "s"} read, ${summary.updated} updated, ` +
      `${summary.deleted} removed` +
      (held > 0 ? `, ${held} waiting for review in the Inbox.` : ".")
    );
  }
  return run.status === "failed" ? "The last sync failed." : "";
}

/**
 * "Sync now" plus the last run, the Connections cards' shared shape for the two calendar providers.
 * The roster provider card lays the same thing out by hand; this one exists because two cards need it.
 */
export function CalendarSyncRow({
  provider,
  notSetUp = false,
  onSynced
}: {
  provider: CalendarSyncProvider;
  notSetUp?: boolean;
  /** Called after a "Sync now" settles, so a summary of the same sync can reload. */
  onSynced?: () => void;
}) {
  const { lastRun, syncing, message, syncNow } = useCalendarSync(provider);
  const outcome = lastRun.state === "loaded" ? describeSyncOutcome(lastRun.run) : "";
  const failed = lastRun.state === "loaded" && lastRun.run.status === "failed";
  return (
    <>
      <DetailSubheading title="Sync">
        <Button
          size="sm"
          disabled={syncing || notSetUp || lastRun.state === "unavailable" || lastRun.state === "off"}
          onClick={() => void syncNow().then(() => onSynced?.())}
        >
          {syncing ? "Syncing…" : "Sync now"}
        </Button>
      </DetailSubheading>
      {notSetUp && lastRun.state !== "loaded" && <p className="empty">Not set up yet, so there is nothing to sync.</p>}
      {!notSetUp && lastRun.state === "loading" && <p className="empty">Checking the last sync…</p>}
      {!notSetUp && lastRun.state === "none" && (
        <p className="empty">No sync has run yet. It runs by itself every hour.</p>
      )}
      {!notSetUp && lastRun.state === "off" && (
        <>
          <p className="empty">Sync is off for this calendar.</p>
          <p className="microcopy">To turn it on, add this calendar to the server setting:</p>
          <DetailCode>CALENDAR_SYNC_PROVIDERS</DetailCode>
        </>
      )}
      {!notSetUp && lastRun.state === "unavailable" && <p className="empty">Sync history is not available yet.</p>}
      {lastRun.state === "loaded" && (
        <>
          <p className="microcopy">
            Last sync {formatDateTime(lastRun.run.startedAt)} · {lastRun.run.trigger} · {lastRun.run.status}
          </p>
          {outcome && <p className={failed ? undefined : "microcopy"}>{outcome}</p>}
        </>
      )}
      {message && <p className="microcopy">{message}</p>}
    </>
  );
}
