"use client";

import { useEffect, useSyncExternalStore } from "react";
import { mailSource, type EmailReviewCount } from "@/state/extensions";

export type { EmailReviewCount };

export const emptyEmailReviewCount: EmailReviewCount = { waiting: 0, toReview: 0 };

/**
 * The Emails window's two numbers, held in one module-level store like the calendar count so the shell
 * and the Inbox page share one request. A failed read keeps the last known count.
 */
let current: EmailReviewCount = emptyEmailReviewCount;
let lastFetchAt = 0;
let inFlight: Promise<void> | null = null;
let followUpQueued = false;
const listeners = new Set<() => void>();

function asCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** "3 waiting · 12 to review", leaving out a part that is zero; empty when both are. */
export function describeEmailReviewCount(count: EmailReviewCount): string {
  const parts: string[] = [];
  if (count.waiting > 0) parts.push(`${count.waiting} waiting`);
  if (count.toReview > 0) parts.push(`${count.toReview} to review`);
  return parts.join(" · ");
}

async function readEmailReviewCount(): Promise<void> {
  // Without a mail source there is nothing to count.
  const url = mailSource()?.reviewCountUrl;
  if (!url) return;
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) return;
    const body = (await response.json()) as { waiting?: unknown; toReview?: unknown } | null;
    const next = { waiting: asCount(body?.waiting), toReview: asCount(body?.toReview) };
    if (next.waiting === current.waiting && next.toReview === current.toReview) return;
    current = next;
    for (const listener of listeners) listener();
  } catch {
    // Keep the last known count.
  }
}

/**
 * Reads the mail source's review count route. Concurrent callers share one request, but a call made
 * while a read is in flight queues exactly one follow-up: that read may have taken its snapshot before
 * the change the caller is announcing, and sharing it would lose the refresh. The returned promise
 * settles once the follow-up has too.
 */
export function refreshEmailReviewCount(): Promise<void> {
  if (inFlight) {
    followUpQueued = true;
    return inFlight;
  }
  inFlight = (async () => {
    try {
      do {
        followUpQueued = false;
        await readEmailReviewCount();
      } while (followUpQueued);
    } finally {
      lastFetchAt = Date.now();
      inFlight = null;
    }
  })();
  return inFlight;
}

export const EMAIL_REVIEW_MIN_INTERVAL_MS = 60_000;
export const EMAIL_REVIEW_POLL_MS = 5 * 60_000;

/** Test hook: forget everything the store knows. */
export function resetEmailReviewCount() {
  current = emptyEmailReviewCount;
  lastFetchAt = 0;
  inFlight = null;
  followUpQueued = false;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useEmailReviewCount(): EmailReviewCount {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => emptyEmailReviewCount
  );
}

/**
 * Mount once, in the shell: refresh on load, when the tab regains focus (at most once a minute) and on a
 * five-minute interval. The Inbox page also refreshes it whenever its own proposals change.
 */
export function useEmailReviewCountRefresh() {
  useEffect(() => {
    void refreshEmailReviewCount();
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastFetchAt < EMAIL_REVIEW_MIN_INTERVAL_MS) return;
      void refreshEmailReviewCount();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    const timer = window.setInterval(() => void refreshEmailReviewCount(), EMAIL_REVIEW_POLL_MS);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      window.clearInterval(timer);
    };
  }, []);
}
