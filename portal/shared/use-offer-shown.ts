"use client";

import { useEffect, useRef } from "react";
import { shownTargetFor, type ShownTarget } from "@openrhen/contracts";
import { createClientId } from "@/shared/client-id";
import type { NowCandidate, NowModel } from "@/features/now/now-model";

export type { ShownTarget };

/**
 * Tells the offer log (`POST /api/offer-log/shown`) what the open Now page resolved to, so "what was shown" is
 * recorded apart from what the engine offered. Fire-and-forget: a failed request is silence, never retried, never a
 * banner, and nothing on the page changes. `shown` is a lower bound (a background tab, a second surface or a missed
 * request all leave no row).
 */

/** What makes two resolutions the same exposure: the kind and the target, not the label or the suppressed primary. */
export function shownKey(target: ShownTarget): string {
  return `${target.resolutionKind}|${target.targetType}|${target.targetId}`;
}

/** Whether to send now: the page is visible, and this is not the key last sent. */
export function shouldSendShown(key: string, lastSentKey: string | null, visible: boolean): boolean {
  return visible && key !== lastSentKey;
}

async function send(target: ShownTarget): Promise<void> {
  try {
    await fetch("/api/offer-log/shown", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...target, surface: "portal", clientId: createClientId() })
    });
  } catch {
    // A convenience signal: a failed beacon loses one row and nothing else.
  }
}

/** How long a resolution must stay put before it is logged as shown. */
export const SHOWN_SETTLE_MS = 2000;

const isVisible = () => typeof document === "undefined" || document.visibilityState === "visible";

/**
 * Sends a `shown` event when the resolved activity's key changes while the page is visible, and again when the tab
 * becomes visible if its key differs from the last one sent. Never during a replay.
 */
export function useOfferShown(args: {
  enabled: boolean;
  activity: NowModel["activity"];
  primary: NowCandidate | null;
}) {
  const { enabled, activity, primary } = args;
  const target = shownTargetFor(activity, primary);
  const key = shownKey(target);
  const latest = useRef(target);
  const lastSentKey = useRef<string | null>(null);

  useEffect(() => {
    latest.current = target;
  });

  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fire = () => {
      const current = latest.current;
      const currentKey = shownKey(current);
      if (!shouldSendShown(currentKey, lastSentKey.current, isVisible())) return;
      lastSentKey.current = currentKey;
      void send(current);
    };
    // Settled before it counts as shown: a resolution that flickers during load, or is replaced within a couple of
    // seconds, was not really on screen long enough to be an offer a person saw.
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(fire, SHOWN_SETTLE_MS);
    };
    schedule();
    document.addEventListener("visibilitychange", schedule);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", schedule);
    };
    // `key` is the dependency on purpose: a recalculation that resolves to the same exposure re-runs nothing.
  }, [enabled, key]);
}
