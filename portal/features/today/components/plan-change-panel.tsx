"use client";

import { useEffect, useEffectEvent, useState } from "react";
import type { PlanChangeSummary } from "@/features/planning/plan-diff";
import type { StoredCommitment } from "@/state/portal-state";
import { formatZonedTime } from "@/shared/date-format";

const deltaLabel = (minutes: number) => `${minutes > 0 ? "+" : ""}${minutes} min`;

/**
 * "What changed" — the auditable half of auto-absorb. Folded by default: most disruptions reflow
 * quietly and this is the receipt for the rare one that reshaped the day, not a thing to greet the
 * reader with. The diff is a fact about the day, not the minute, so it is fetched once, the first
 * time the panel is opened, rather than polled.
 */
export function PlanChangePanel({
  disruption,
  timezone
}: {
  /** Null when Today has nothing to say about a disruption — the panel then renders nothing at all. */
  disruption: StoredCommitment | null;
  timezone: string;
}) {
  const [opened, setOpened] = useState(false);
  const [summary, setSummary] = useState<PlanChangeSummary | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const disruptionId = disruption?.id;
  // The effect below starts a fetch whenever the panel opens or the disruption changes, unless a summary
  // is already held. The loading flag and the old error are cleared at those same moments, while
  // rendering, so the effect itself writes nothing before its request settles.
  const fetchKey = `${opened}|${disruptionId ?? ""}`;
  const [startedKey, setStartedKey] = useState(fetchKey);
  if (startedKey !== fetchKey) {
    setStartedKey(fetchKey);
    if (opened && disruptionId && !summary) {
      setLoading(true);
      setError("");
    }
  }
  // Reads the summary as it is when the effect fires, without the effect depending on it: the fetch's
  // own completion must not become a trigger for another one.
  const hasSummary = useEffectEvent(() => summary !== null);

  useEffect(() => {
    if (!opened || !disruptionId || hasSummary()) return;
    let cancelled = false;
    fetch(`/api/planning/changes?disruptionId=${encodeURIComponent(disruptionId)}`)
      .then((response) => response.json())
      .then((payload: PlanChangeSummary) => {
        if (!cancelled) setSummary(payload);
      })
      .catch(() => {
        if (!cancelled) setError("What changed could not be loaded.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [opened, disruptionId]);

  const nothingChanged =
    summary?.available &&
    summary.moved.length === 0 &&
    summary.dropped.length === 0 &&
    summary.added.length === 0 &&
    summary.sleepShiftMinutes === 0;

  if (!disruption) return null;

  return (
    <details className="today-panel plan-change-panel" onToggle={(event) => setOpened(event.currentTarget.open)}>
      <summary>
        <h2>What changed</h2>
      </summary>
      <div className="today-panel-body">
        {loading && <p className="microcopy">Loading…</p>}
        {error && <p className="form-warning">{error}</p>}
        {summary && !summary.available && (
          <p className="microcopy">The earlier plan is no longer stored, so no comparison is available.</p>
        )}
        {summary?.available && (
          <>
            {nothingChanged && <p className="microcopy">Nothing else moved.</p>}
            {summary.moved.map((item) => (
              <p className="plan-change-row" key={`moved-${item.kind}-${item.targetId}`}>
                {item.title} — {formatZonedTime(item.fromStartsAt, timezone)} →{" "}
                {formatZonedTime(item.toStartsAt, timezone)}, {deltaLabel(item.deltaMinutes)}
              </p>
            ))}
            {summary.dropped.map((item) => (
              <p className="plan-change-row" key={`dropped-${item.kind}-${item.targetId}`}>
                {item.title} — dropped
              </p>
            ))}
            {summary.added.map((item) => (
              <p className="plan-change-row" key={`added-${item.kind}-${item.targetId}`}>
                {item.title} — added at {formatZonedTime(item.startsAt, timezone)}
              </p>
            ))}
            {summary.sleepShiftMinutes !== 0 && (
              <p className="plan-change-row">
                Bedtime moves {Math.abs(summary.sleepShiftMinutes)} min{" "}
                {summary.sleepShiftMinutes > 0 ? "later" : "earlier"}
              </p>
            )}
          </>
        )}
      </div>
    </details>
  );
}
