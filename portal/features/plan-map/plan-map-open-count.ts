"use client";

import { useEffect, useSyncExternalStore } from "react";
import { fetchPlanMap } from "@/features/plan-map/plan-map-client";
import { openCount } from "@/features/plan-map/plan-map-model";
import type { PlanMap } from "@openrhen/contracts";

/**
 * Suggested links and open findings still waiting for a decision, held in one module-level store like
 * the email and calendar counts so the shell's Inbox badge and the Inbox's Plan map room agree. The
 * room publishes whenever its own map loads, so a decision there moves the badge at once; the shell
 * refreshes it on load and every five minutes. A failed read keeps the last known count.
 */
let current = 0;
let inFlight: Promise<void> | null = null;
const listeners = new Set<() => void>();

export function publishPlanMapOpenCount(map: Pick<PlanMap, "links" | "findings"> | null) {
  if (!map) return;
  const next = openCount(map);
  if (next === current) return;
  current = next;
  for (const listener of listeners) listener();
}

export function refreshPlanMapOpenCount(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = fetchPlanMap()
    .then((map) => publishPlanMapOpenCount(map))
    .catch(() => {
      // Keep the last known count.
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

export const PLAN_MAP_OPEN_COUNT_POLL_MS = 5 * 60_000;

/** Test hook: forget everything the store knows. */
export function resetPlanMapOpenCount() {
  current = 0;
  inFlight = null;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function usePlanMapOpenCount(): number {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => 0
  );
}

/** Mount once, in the shell. */
export function usePlanMapOpenCountRefresh() {
  useEffect(() => {
    void refreshPlanMapOpenCount();
    const timer = window.setInterval(() => void refreshPlanMapOpenCount(), PLAN_MAP_OPEN_COUNT_POLL_MS);
    return () => window.clearInterval(timer);
  }, []);
}
