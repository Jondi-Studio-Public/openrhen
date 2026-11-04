"use client";

import { intervalCalendarSourceIds } from "@openrhen/contracts";
import { useEffect, useSyncExternalStore } from "react";
import { LiveUpdatesController, type EventSourceFactory } from "@/state/live-updates";

/** A calendar source id the sync holds review batches for: the interval-scheduled sources the registry holds. */
export type CalendarReviewProvider = string;

export interface CalendarReviewCount {
  counts: Record<CalendarReviewProvider, number>;
  /** The open review batch each provider's sync is holding, when there is one. */
  batchIds: Record<CalendarReviewProvider, string | null>;
  total: number;
}

function perProvider<T>(value: (provider: string) => T): Record<string, T> {
  return Object.fromEntries(intervalCalendarSourceIds().map((provider) => [provider, value(provider)]));
}

export const emptyCalendarReviewCount: CalendarReviewCount = {
  counts: perProvider(() => 0),
  batchIds: perProvider(() => null),
  total: 0
};

/**
 * How many calendar events wait for review, held in one module-level store so the Inbox tab's badge
 * (in the shell) and the Inbox page's Calendars section read one number from one request rather than
 * each asking. A failed read keeps the last known count: a badge that flickered to zero whenever the
 * server hiccuped would be worse than one a minute stale.
 */
let current: CalendarReviewCount = emptyCalendarReviewCount;
let lastFetchAt = 0;
let inFlight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function publish(next: CalendarReviewCount) {
  const providers = intervalCalendarSourceIds();
  const same =
    next.total === current.total &&
    providers.every(
      (provider) =>
        next.counts[provider] === current.counts[provider] && next.batchIds[provider] === current.batchIds[provider]
    );
  if (same) return;
  current = next;
  for (const listener of listeners) listener();
}

function asCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function asId(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/** Reads `/api/integrations/calendar-sync/review-count`. Concurrent callers share one request. */
export function refreshCalendarReviewCount(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const response = await fetch("/api/integrations/calendar-sync/review-count", { cache: "no-store" });
      if (!response.ok) return;
      const body = (await response.json()) as {
        counts?: Partial<Record<CalendarReviewProvider, unknown>>;
        batchIds?: Partial<Record<CalendarReviewProvider, unknown>>;
      } | null;
      const counts = perProvider((provider) => asCount(body?.counts?.[provider]));
      publish({
        counts,
        batchIds: perProvider((provider) => asId(body?.batchIds?.[provider])),
        total: Object.values(counts).reduce((sum, count) => sum + count, 0)
      });
    } catch {
      // Keep the last known count.
    } finally {
      lastFetchAt = Date.now();
      inFlight = null;
    }
  })();
  return inFlight;
}

/** Focus and visibility checks share this floor so tab switching cannot become polling. */
export const CALENDAR_REVIEW_MIN_INTERVAL_MS = 60_000;
/** The safety-net refresh for a tab left open with no pushes and no focus change. */
export const CALENDAR_REVIEW_POLL_MS = 5 * 60_000;

/** Test hook: forget everything the store knows. */
export function resetCalendarReviewCount() {
  current = emptyCalendarReviewCount;
  lastFetchAt = 0;
  inFlight = null;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The current count, without fetching: the Inbox page asks for a refresh itself when it mounts. */
export function useCalendarReviewCount(): CalendarReviewCount {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => emptyCalendarReviewCount
  );
}

/**
 * Mount once, in the shell. Keeps the count fresh on load, on every live `changed` event (already
 * debounced by the controller), and when the tab regains focus or visibility (at most once a minute),
 * with a five-minute interval behind those. `createEventSource` is for tests only.
 */
export function useCalendarReviewCountRefresh(createEventSource?: EventSourceFactory) {
  useEffect(() => {
    void refreshCalendarReviewCount();
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastFetchAt < CALENDAR_REVIEW_MIN_INTERVAL_MS) return;
      void refreshCalendarReviewCount();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    const timer = window.setInterval(() => void refreshCalendarReviewCount(), CALENDAR_REVIEW_POLL_MS);
    let controller: LiveUpdatesController | null = null;
    const factory =
      createEventSource ?? (typeof EventSource === "undefined" ? null : (url: string) => new EventSource(url));
    if (factory) {
      controller = new LiveUpdatesController({
        createEventSource: factory,
        callbacks: { onRefresh: () => void refreshCalendarReviewCount() }
      });
      controller.open();
    }
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      window.clearInterval(timer);
      controller?.close();
    };
  }, [createEventSource]);
}

/**
 * The calendars holding events for review with a batch to open: one Inbox row each, so the Inbox
 * badge counts these rows rather than the events inside them, and the count matches what is listed.
 */
export function calendarsWaiting(review: CalendarReviewCount): CalendarReviewProvider[] {
  return (Object.keys(review.counts) as CalendarReviewProvider[]).filter(
    (provider) => (review.counts[provider] ?? 0) > 0 && review.batchIds[provider] !== null
  );
}
