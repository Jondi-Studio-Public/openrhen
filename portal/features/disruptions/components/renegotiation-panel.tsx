"use client";

import { useEffect, useState } from "react";
import type { PortalState, StoredCommitment } from "@/state/portal-state";
import { LetSomeoneKnow } from "@/features/commitments/components/let-someone-know";
import { localDayKey } from "@/features/today/today-view";
import type { SaveEntityCommand } from "@/features/now/now-model";
import type { PlanChangeSummary } from "@/features/planning/plan-diff";
import { assessDisruption } from "../disruption-impact";
import { extendDisruption, dropDesiredWinCommand } from "../disruption-commands";
import { displacedSignature, isDismissed, writeDismissal } from "../renegotiation-dismissal";

/** How much a "Shorten the disruption" tap pulls the end time in by. */
const SHORTEN_MINUTES = 30;

/**
 * The consequence prompt for the rarer half of the two-tier split: a disruption that displaced a
 * planned target or pushed bedtime past the threshold, not one the day quietly absorbed. Mounted
 * unconditionally on Now whenever there is a disruption to talk about — this component fetches the
 * same server-side diff Today's "What changed" panel reads, assesses it, and renders nothing at all
 * for the ordinary absorbed case. Every action here reuses a write the portal already has; nothing
 * new is invented to answer "what do I do about it".
 */
export function RenegotiationPanel({
  disruption,
  state,
  now,
  timezone,
  saving,
  saveEntityCommand,
  refreshKey
}: {
  disruption: StoredCommitment;
  state: PortalState;
  now: Date;
  timezone: string;
  saving: boolean;
  saveEntityCommand: SaveEntityCommand;
  /**
   * Ties this panel's fetch to the same plan-refresh signal every other Now-page banner reacts to
   * (see `app/page.tsx`'s `knownLatestSuccessfulAt`), not only `disruption.id`. Before this, the
   * effect below only re-ran when the disruption itself changed, so a disruption's downstream impact
   * flipping to renegotiate-tier a few seconds *after* this panel's first mount — the plan reflowing
   * again, still under the same disruption — went unnoticed until something else remounted the
   * component. Optional so a caller with no such signal still gets the
   * original once-per-disruption behaviour.
   */
  refreshKey?: string | number | undefined;
}) {
  const [summary, setSummary] = useState<PlanChangeSummary | null>(null);
  // Dismissing itself never writes anything to the server — the facts stay exactly where Today's diff
  // panel keeps them — but it is remembered in `localStorage` so a remount doesn't
  // bring the same already-seen prompt straight back. Scoped to the signature it was said about,
  // rather than a bare boolean covering the rest of the mount's life: with `refreshKey` now able to
  // bring back a *different* signature without a remount, a boolean would wrongly keep hiding a
  // genuinely new "this changes today" fact just because some earlier verdict on this mount was
  // dismissed. `isDismissed` below is the cross-mount half of the same rule.
  const [dismissedSignature, setDismissedSignature] = useState<string | null>(null);
  const [shortening, setShortening] = useState(false);
  const [shortenError, setShortenError] = useState("");

  // Only a genuinely different disruption clears a remembered dismissal — a mere refresh must not
  // (see the `refreshKey`-keyed effect below, which never touches this state).
  const [shownDisruptionId, setShownDisruptionId] = useState(disruption.id);
  if (shownDisruptionId !== disruption.id) {
    setShownDisruptionId(disruption.id);
    setDismissedSignature(null);
    setShortenError("");
  }

  // A verdict belongs to the disruption and refresh it was fetched for; either one changing drops it
  // until the fetch below lands.
  const summaryKey = `${disruption.id}|${refreshKey}`;
  const [shownSummaryKey, setShownSummaryKey] = useState(summaryKey);
  if (shownSummaryKey !== summaryKey) {
    setShownSummaryKey(summaryKey);
    setSummary(null);
  }

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/planning/changes?disruptionId=${encodeURIComponent(disruption.id)}`)
      .then((response) => response.json())
      .then((payload: PlanChangeSummary) => {
        if (!cancelled) setSummary(payload);
      })
      .catch(() => {
        // A failed fetch says nothing about impact either way, so it fails silent here — the
        // reader still has Today's own panel, which makes the same request and can retry it.
      });
    return () => {
      cancelled = true;
    };
  }, [disruption.id, refreshKey]);

  if (!summary) return null;
  // `landedAt` is always present on a disruption reaching this panel (`activeDisruption` only ever
  // selects one that has landed), but falls back to the epoch rather than `now` if it were somehow
  // missing — excluding nothing, the same as before this filter existed, rather than excluding
  // everything.
  const landedAt = disruption.landedAt ? new Date(disruption.landedAt) : new Date(0);
  const impact = assessDisruption(summary, state, landedAt);
  if (impact.tier !== "renegotiate") return null;

  // Keyed to disruption id + the displaced set actually on screen: an unchanged verdict stays
  // dismissed across remounts and reloads, and a changed one (a target added or dropped) re-arms —
  // exactly what "Not now" promised the first time, not "silence this disruption forever".
  const signature = displacedSignature(impact.newlyDisplaced.map((item) => item.targetId));
  if (dismissedSignature === signature || isDismissed(disruption.id, signature)) return null;

  function dismiss(): void {
    writeDismissal(disruption.id, signature);
    setDismissedSignature(signature);
  }

  // The disruption's own window, not just "has a disruption": once it has ended, shortening it
  // further changes nothing the engine would replan around.
  const live = now.getTime() < new Date(disruption.endsAt).getTime();
  const todayKey = localDayKey(now, timezone);
  const existingPlan = state.dailyPlan?.localDate === todayKey ? state.dailyPlan : undefined;
  const desiredWinIds = new Set(existingPlan?.desiredActionIds ?? []);
  // Only offer to drop what is both newly displaced and was actually picked as one of today's wins —
  // dropping anything else would claim a write this panel has no business making.
  const droppableWins = impact.movable.filter((item) => item.kind === "action" && desiredWinIds.has(item.targetId));

  async function shorten() {
    setShortening(true);
    const failure = await extendDisruption(disruption, -SHORTEN_MINUTES, { state, now, saveEntityCommand });
    setShortening(false);
    setShortenError(failure);
  }

  function dropDesiredWin(actionId: string) {
    void saveEntityCommand(dropDesiredWinCommand(actionId, todayKey, existingPlan));
  }

  return (
    <section className="renegotiation-panel">
      <h2>This changes today</h2>
      {impact.newlyDisplaced.length > 0 && (
        <p className="microcopy">This displaces: {impact.newlyDisplaced.map((item) => item.title).join(", ")}</p>
      )}
      {impact.bedtimeShiftMinutes !== 0 && (
        <p className="microcopy">
          Bedtime moves {Math.abs(impact.bedtimeShiftMinutes)} min{" "}
          {impact.bedtimeShiftMinutes > 0 ? "later" : "earlier"}.
        </p>
      )}
      <div className="actions">
        {live && (
          <button className="quiet" disabled={saving || shortening} onClick={() => void shorten()}>
            Shorten the disruption
          </button>
        )}
        {droppableWins.map((item) => (
          <button className="quiet" key={item.targetId} disabled={saving} onClick={() => dropDesiredWin(item.targetId)}>
            Drop “{item.title}” from today’s wins
          </button>
        ))}
        {impact.immovable
          .filter((item) => item.kind === "commitment" && item.contactId)
          .map((item) => (
            <LetSomeoneKnow key={item.targetId} commitmentId={item.targetId} reason="displaced" />
          ))}
        {/*
          Bedtime alone (no newly-displaced target) is the case where dismissing IS the whole answer —
          the shifted night is already what the engine decided, so there is nothing left to negotiate.
        */}
        {impact.newlyDisplaced.length === 0 && (
          <button className="quiet" onClick={dismiss}>
            Accept the later bedtime
          </button>
        )}
        <button className="quiet" onClick={dismiss}>
          Not now
        </button>
      </div>
      {shortenError && (
        <p className="form-error" role="alert">
          {shortenError}
        </p>
      )}
      {/*
        A one-night override belongs to `SleepPlanEditor`, which already knows how to send a
        `sleep_plan` entity safely — reimplementing that here would just be a second, worse copy of
        the same form, so the way to actually change bedtime further is a link to where it lives.
      */}
      {impact.bedtimeShiftMinutes !== 0 && (
        <p className="microcopy">
          <a href="/today">Prefer to change it? Adjust tonight&rsquo;s sleep on Today.</a>
        </p>
      )}
    </section>
  );
}
