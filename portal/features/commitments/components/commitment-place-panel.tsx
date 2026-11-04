"use client";

import type { StoredCommitment } from "@/state/portal-state";
import { type ConditionDefinition, placeOptions, placeTravelNote } from "@/features/settings/context-summary";

/**
 * Where the commitment happens, as the planner understands it: the linked place, the fallback travel
 * cost it charges to get there, and the free-text label if it says something the place does not
 * (a room number, say). A commitment with no place is stated as such rather than left blank —
 * without one, an inherited routine has nothing to inherit from.
 */
export function CommitmentPlacePanel({
  commitment,
  conditionDefinitions
}: {
  commitment: StoredCommitment;
  conditionDefinitions: ConditionDefinition[];
}) {
  const selectedId = commitment.locationId ?? "";
  // The picker's own option list, so an archived or one-off place the commitment already points at
  // still resolves to its name here instead of reading as none.
  const options = placeOptions(conditionDefinitions, selectedId);
  const place = options.find((option) => option.id === selectedId);
  const travel = selectedId ? placeTravelNote(options, selectedId) : "";
  return (
    <section className="commitment-section" aria-labelledby="commitment-place-heading">
      <div className="section-heading">
        <h2 id="commitment-place-heading">Place</h2>
      </div>
      {place ? (
        <p>
          <strong>{place.name}</strong>
          {travel ? ` · ${travel}` : " · no travel estimate saved"}
        </p>
      ) : (
        <p className="empty">No place is linked, so travel is not planned and no routine can be inherited.</p>
      )}
      {commitment.location && commitment.location !== place?.name && (
        <p className="microcopy">Labelled “{commitment.location}” on the schedule.</p>
      )}
    </section>
  );
}
