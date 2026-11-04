"use client";

import { useEffect, useState } from "react";
import type { ClosedSummary } from "@openrhen/contracts";
import { usePortal } from "@/state/portal-provider";
import { fetchClosedSummary } from "./closed-client";

/**
 * The 24 hour agent-close summary for the Now and Today badge; null while loading or when the read fails (the badge
 * then shows nothing rather than an error). Re-read whenever the portal state changes, which is what a live update
 * or a restore here does.
 */
export function useClosedSummary(): ClosedSummary | null {
  const { state } = usePortal();
  const [summary, setSummary] = useState<ClosedSummary | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchClosedSummary()
      .then((next) => {
        if (!cancelled) setSummary(next);
      })
      .catch(() => {
        if (!cancelled) setSummary(null);
      });
    return () => {
      cancelled = true;
    };
  }, [state]);
  return summary;
}
