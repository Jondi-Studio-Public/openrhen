"use client";

import { useEffect, useRef } from "react";
import type { OfferLogShown } from "@openrhen/contracts";
import { createClientId } from "@/shared/client-id";
import type { NowCandidate, NowModel } from "@/features/now/now-model";

/**
 * Tells the offer log (`POST /api/offer-log/shown`) what the open Now page resolved to, so "what was shown" is
 * recorded apart from what the engine offered. Fire-and-forget: a failed request is silence, never retried, never a
 * banner, and nothing on the page changes. `shown` is a lower bound (a background tab, a second surface or a missed
 * request all leave no row).
 */

export type ShownTarget = Omit<OfferLogShown, "clientId" | "surface">;

const LABEL_MAX = 300;
const clip = (value: string | undefined | null) => (value ?? "").slice(0, LABEL_MAX);

/**
 * The screen's resolution as a beacon body. `suppressedBy` is the engine's primary whenever the screen put something
 * else on top of it (a commitment, sleep, a routine step...); absent when the primary is itself what is shown or the
 * model has none.
 */
export function shownTargetFor(activity: NowModel["activity"], primary: NowCandidate | null): ShownTarget {
  const suppressedBy: ShownTarget["suppressedBy"] =
    activity.kind !== "recommended" && primary
      ? { targetType: "action", targetId: primary.action.id, label: clip(primary.action.title) }
      : undefined;
  const withSuppressed = (target: ShownTarget): ShownTarget => (suppressedBy ? { ...target, suppressedBy } : target);
  switch (activity.kind) {
    case "session": {
      const { session } = activity;
      return withSuppressed({
        resolutionKind: "session",
        targetType: session.targetType ?? "action",
        targetId: session.targetId ?? session.actionId,
        label: clip(session.targetTitle)
      });
    }
    case "routine_step":
      return withSuppressed({
        resolutionKind: "routine_step",
        targetType: "routine_step",
        targetId: activity.step.id,
        label: clip(activity.step.title)
      });
    case "commitment":
      return withSuppressed({
        resolutionKind: "commitment",
        targetType: "fixed_commitment",
        targetId: activity.commitment.id,
        label: clip(activity.commitment.title)
      });
    case "travel":
      return withSuppressed({
        resolutionKind: "travel",
        // Keyed like the `started` row a travel or return phase writes (the commitment the leg leads to), so the
        // two join; a leg that names no commitment falls back to its destination.
        targetType: activity.directive.then?.kind === "commitment" ? "fixed_commitment" : "travel",
        targetId:
          activity.directive.then?.kind === "commitment"
            ? activity.directive.then.targetId
            : activity.directive.toLocationId,
        label: clip(activity.directive.title)
      });
    case "sleep":
      return withSuppressed({
        resolutionKind: "sleep",
        targetType: "sleep",
        targetId: activity.plan.id,
        label: "Sleep"
      });
    case "recommended":
      return {
        resolutionKind: "recommended",
        targetType: "action",
        targetId: activity.candidate.action.id,
        label: clip(activity.candidate.action.title)
      };
    case "free":
      return { resolutionKind: "free", targetType: "none", targetId: "free", label: "" };
  }
}

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
      keepalive: true,
      body: JSON.stringify({ ...target, surface: "portal", clientId: createClientId() })
    });
  } catch {
    // A convenience signal: a failed beacon loses one row and nothing else.
  }
}

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
    const fire = () => {
      const current = latest.current;
      const currentKey = shownKey(current);
      if (!shouldSendShown(currentKey, lastSentKey.current, isVisible())) return;
      lastSentKey.current = currentKey;
      void send(current);
    };
    fire();
    document.addEventListener("visibilitychange", fire);
    return () => document.removeEventListener("visibilitychange", fire);
    // `key` is the dependency on purpose: a recalculation that resolves to the same exposure re-runs nothing.
  }, [enabled, key]);
}
