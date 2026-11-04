"use client";

import { ArrivalButton } from "@/components/situation-panel";
import type { PortalState, StoredCommitment } from "@/state/portal-state";
import { LetSomeoneKnow } from "@/features/commitments/components/let-someone-know";
import { clock } from "@/features/now/now-formatting";
import type { NowProtectedCommitment, SaveEntityCommand } from "@/features/now/now-model";

/**
 * The compact sibling to `ProtectedCommitmentPanel`'s "Running late for X" headline, for the moment
 * that headline is otherwise unreachable: a different session (an action, a deliverable, a routine, a
 * sleep) is already holding the page while a *different* protected commitment goes late. Before this,
 * `protectedCommitment` — computed unconditionally regardless of session, same as the device API's
 * `late`/`arrival` fields — had nowhere to render at all outside
 * the one exclusive no-session branch of `app/page.tsx`.
 *
 * Deliberately not the full panel: `ProtectedCommitmentPanel`'s "Start tracking…" actions assume
 * nothing else is already running, which is false here by definition. This shows only the fact —
 * which commitment, since when — and, for a located commitment still awaiting arrival, the same
 * one-tap assertion the full panel offers, reusing the same `ArrivalButton` and the same
 * `start_activity`-adjacent situation write it already sends.
 *
 * Never rendered for a commitment the running session is itself tracking — that session's own panel
 * already says so — which the caller (`app/page.tsx`) is responsible for checking before mounting
 * this at all.
 */
export function LateCommitmentBanner({
  protectedCommitment,
  storedProtectedCommitment,
  state,
  timezone,
  saving,
  saveEntityCommand
}: {
  protectedCommitment: NowProtectedCommitment;
  storedProtectedCommitment: StoredCommitment | undefined;
  state: PortalState;
  timezone: string;
  saving: boolean;
  saveEntityCommand: SaveEntityCommand;
}) {
  if (!protectedCommitment.late) return null;
  const commitmentLocation = storedProtectedCommitment?.locationId
    ? state.conditionDefinitions.find((entry) => entry.id === storedProtectedCommitment.locationId)
    : undefined;
  return (
    <section className="late-commitment-banner" role="status">
      <p className="reason">
        Running late for {protectedCommitment.title} · {clock(new Date(protectedCommitment.startsAt), timezone)}
      </p>
      <div className="actions">
        <LetSomeoneKnow commitmentId={protectedCommitment.id} reason="late" />
      </div>
      {commitmentLocation && commitmentLocation.id !== state.currentSituation.locationId && (
        <div className="actions">
          <ArrivalButton
            state={state}
            saving={saving}
            locationId={commitmentLocation.id}
            locationName={commitmentLocation.name}
            saveEntityCommand={saveEntityCommand}
          />
        </div>
      )}
    </section>
  );
}
