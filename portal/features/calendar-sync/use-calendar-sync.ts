"use client";

import { useCallback, useEffect, useState } from "react";
import { type CalendarSyncProvider, type CalendarSyncResult } from "@openrhen/contracts";
import { invalidateConnectionLapses } from "@/features/connections/connection-lapses";
import { refreshCalendarReviewCount } from "./calendar-review-count";

/** The portal route that runs a calendar source's sync and reports its last run. */
export const calendarSyncPath = (provider: CalendarSyncProvider): string => `/api/connections/${provider}/sync`;

export interface CalendarSyncRun {
  startedAt: string;
  finishedAt: string | null;
  trigger: string;
  status: string;
  /** The run's `CalendarSyncResult`, as far as the server recorded one; read defensively. */
  summary: CalendarSyncResult | null;
}

export type CalendarSyncLastRun =
  | { state: "loading" }
  | { state: "none" }
  | { state: "unavailable" }
  /** The provider is not in the server's `CALENDAR_SYNC_PROVIDERS`: sync is off, which is not an error. */
  | { state: "off" }
  | { state: "loaded"; run: CalendarSyncRun };

/**
 * The last run and a "Sync now" for one calendar provider. A 404 from the sync route (the calendar provider's arrives
 * separately from Google's) or any failure to read it reads as `unavailable`, which the row shows as a
 * quiet line instead of an error, and disables the button.
 */
export function useCalendarSync(provider: CalendarSyncProvider) {
  const path = calendarSyncPath(provider);
  const [lastRun, setLastRun] = useState<CalendarSyncLastRun>({ state: "loading" });
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch(path, { cache: "no-store" });
      if (!response.ok) {
        setLastRun({ state: "unavailable" });
        return;
      }
      const body = (await response.json()) as { enabled?: boolean; lastRun?: CalendarSyncRun | null } | null;
      if (body?.enabled === false) {
        setLastRun({ state: "off" });
        return;
      }
      setLastRun(body?.lastRun ? { state: "loaded", run: body.lastRun } : { state: "none" });
    } catch {
      setLastRun({ state: "unavailable" });
    }
  }, [path]);

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- sets state only after the awaited request settles
    void load();
  }, [load]);

  const syncNow = async () => {
    setSyncing(true);
    setMessage(null);
    try {
      const response = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ trigger: "manual" }),
        cache: "no-store"
      });
      if (response.status === 404) setMessage("Sync is not available for this calendar yet.");
      else {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
          status?: string;
          message?: string;
        } | null;
        if (body?.error) setMessage(body.error);
        else if (body?.status === "not_enabled" || body?.status === "already_running") setMessage(body.message ?? null);
      }
    } catch {
      setMessage("The portal could not reach the sync endpoint.");
    } finally {
      await load();
      invalidateConnectionLapses();
      void refreshCalendarReviewCount();
      setSyncing(false);
    }
  };

  return { lastRun, syncing, message, syncNow, reload: load };
}
