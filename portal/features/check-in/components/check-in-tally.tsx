"use client";

import { useEffect, useState } from "react";

interface CheckInSummary {
  answered: number;
  onTrack: number;
  deviated: number;
  unknown: number;
}

/**
 * A bare tally for Review: how often a check-in actually got answered, and what it said. Phase A is
 * record-only, so this is the only place any of it surfaces yet — nothing here feeds back into
 * planning. Deliberately minimal: one line, no drill-down, matching how Review states its other
 * counts (stale projects, due outcomes) as a plain number rather than a chart.
 */
export function CheckInTally() {
  const [summary, setSummary] = useState<CheckInSummary | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/check-ins/summary")
      .then((response) => (response.ok ? (response.json() as Promise<{ summary: CheckInSummary }>) : null))
      .then((payload) => {
        if (!cancelled && payload) setSummary(payload.summary);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  if (!summary || (summary.answered === 0 && summary.unknown === 0)) return null;
  const total = summary.answered + summary.unknown;
  return (
    <p className="microcopy">
      Check-ins: {summary.answered} of {total} answered ({summary.onTrack} on track, {summary.deviated} deviated) ·{" "}
      {summary.unknown} missed
    </p>
  );
}
