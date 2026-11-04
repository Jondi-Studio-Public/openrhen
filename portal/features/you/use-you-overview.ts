"use client";

import { useEffect, useState } from "react";
import { fetchPhotoCheckins } from "@/features/photo-checkins/photo-checkin-client";
import { effectiveDurationMinutes } from "@/features/sleep-log/sleep-log-format";
import type { StoredSleepPlan } from "@/state/portal-state";

/** What the You overview says under each record and person; null while it is still loading. */
export interface YouOverview {
  lastNightMinutes: number | null | undefined;
  photoCount: number | undefined;
  openReports: number | undefined;
}

/** "7 h 30 m", or "8 h" on the hour. */
export function hoursLabel(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} m`;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} m`;
}

/** The latest night that has ended (actual wake, or a planned wake already past). */
export function lastNightMinutes(plans: readonly StoredSleepPlan[], now: Date): number | null {
  const ended = plans
    .filter((plan) => new Date(plan.actualWakeAt ?? plan.plannedWakeAt).getTime() <= now.getTime())
    .filter((plan) => plan.actualStartAt || plan.manual)
    .sort((a, b) => ((a.actualWakeAt ?? a.plannedWakeAt) < (b.actualWakeAt ?? b.plannedWakeAt) ? 1 : -1));
  return ended[0] ? effectiveDurationMinutes(ended[0]) : null;
}

async function json<T>(url: string): Promise<T | null> {
  try {
    const response = await fetch(url, { cache: "no-store" });
    return response.ok ? ((await response.json()) as T) : null;
  } catch {
    return null;
  }
}

/**
 * The few live facts the You overview shows, each loaded on its own so a slow one never holds the
 * rest. A read that fails leaves its row on the plain description rather than an error.
 */
export function useYouOverview(): YouOverview {
  const [overview, setOverview] = useState<YouOverview>({
    lastNightMinutes: undefined,
    photoCount: undefined,
    openReports: undefined
  });
  useEffect(() => {
    let live = true;
    const merge = (patch: Partial<YouOverview>) => {
      if (live) setOverview((previous) => ({ ...previous, ...patch }));
    };
    void json<{ sleepPlans?: StoredSleepPlan[] }>("/api/sleep-log?days=3").then((body) =>
      merge({ lastNightMinutes: body?.sleepPlans ? lastNightMinutes(body.sleepPlans, new Date()) : null })
    );
    void fetchPhotoCheckins()
      .then((trail) => merge({ photoCount: trail.photos.length }))
      .catch(() => undefined);
    void json<{ snapshots?: { reviewedAt: string | null }[] }>("/api/snapshots").then((body) => {
      if (body?.snapshots) merge({ openReports: body.snapshots.filter((item) => !item.reviewedAt).length });
    });
    return () => {
      live = false;
    };
  }, []);
  return overview;
}
