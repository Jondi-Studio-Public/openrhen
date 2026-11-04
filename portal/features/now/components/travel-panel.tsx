"use client";

import { useState } from "react";
import { situationCommand } from "@/components/situation-panel";
import type { PortalState } from "@/state/portal-state";
import { clock, travelSourceLabel } from "@/features/now/now-formatting";
import type { SaveEntityCommand, TravelDirective } from "@/features/now/now-model";
import { EvidenceDetails } from "./evidence-details";

type ConditionDefinition = PortalState["conditionDefinitions"][number];

/** What the journey is for, once you are there — the engine's own words for the thing that follows. */
function thenLine(directive: TravelDirective): string {
  const then = directive.then;
  if (!then) return "Nothing in particular waits at the other end; this leg is the plan.";
  return `then ${then.title} (${then.recommendedMinutes} min)`;
}

/**
 * Getting somewhere is the thing to do now.
 *
 * There is no Start here and no timer: arriving *is* the location assertion, the same command the
 * availability panel writes, and the recompute that follows turns the work at the other end into
 * ordinary in-place work. Nothing about the journey is decided here — its length, its mode, how well
 * it is known and what it is for are all the engine's, reported as given. The only thing this panel
 * can change is what the engine knows: measuring the leg when the figure is not a measured one.
 */
export function TravelPanel({
  directive,
  destination,
  state,
  saving,
  explanation,
  evidence,
  saveEntityCommand,
  underwayCommitment
}: {
  directive: TravelDirective;
  /** The destination as a defined context, when it still is one; the leg is named either way. */
  destination: ConditionDefinition | undefined;
  state: PortalState;
  saving: boolean;
  explanation: string;
  evidence: readonly string[];
  saveEntityCommand: SaveEntityCommand;
  /**
   * The protected commitment this leg is heading to, when there is one (the leave by push design note,
   * "On my way"). Absent for a directed trip or a leg home, which On my way's own infrastructure
   * never prompts about either.
   */
  underwayCommitment?: { id: string; startsAt: string };
}) {
  const [measuring, setMeasuring] = useState(false);
  const [measureError, setMeasureError] = useState("");
  const [pickingLocation, setPickingLocation] = useState(false);
  const situation = state.currentSituation;
  const placeName = destination?.name ?? directive.toLocationId;
  const isUnderway =
    underwayCommitment !== undefined &&
    situation.underway?.commitmentId === underwayCommitment.id &&
    situation.underway.occurrenceStartsAt === underwayCommitment.startsAt;
  const here = state.conditionDefinitions.find((entry) => entry.id === situation.locationId);
  // Measuring needs somewhere to measure from, somewhere to measure to, and a way of getting there —
  // the same three facts the availability panel requires before it offers the same lookup. A leg
  // from an assumed origin cannot be measured either: Manual Measure needs a confirmed current place,
  // and the origin here is exactly the thing not yet confirmed.
  const canMeasure = Boolean(
    !directive.originAssumed &&
    directive.source !== "live" &&
    directive.source !== "measured" &&
    here?.latitude !== undefined &&
    here?.longitude !== undefined &&
    destination?.latitude !== undefined &&
    destination?.longitude !== undefined &&
    situation.transportModes.length
  );
  const locations = state.conditionDefinitions.filter(
    (entry) => entry.kind === "location" && entry.status !== "archived"
  );
  // The place to assert on "Yes, I'm here": the last place ever said, stale or not, or home when
  // nothing has ever been said.
  const assumedLocationId = situation.locationId ?? state.settings.homeLocationId ?? null;
  const assumedLocationName =
    (assumedLocationId && state.conditionDefinitions.find((entry) => entry.id === assumedLocationId)?.name) || "home";

  async function refresh() {
    if (!destination) return;
    setMeasuring(true);
    setMeasureError("");
    try {
      const response = await fetch("/api/travel/refresh", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ toLocationId: destination.id })
      });
      const payload = (await response.json()) as { unroutable?: boolean; error?: string };
      if (!response.ok) throw new Error(payload.error ?? "The travel lookup failed.");
      if (payload.unroutable)
        setMeasureError(`No route was found to ${placeName}, so the estimate above is the best there is.`);
    } catch (error) {
      setMeasureError(error instanceof Error ? error.message : "The travel lookup failed.");
    } finally {
      setMeasuring(false);
    }
  }

  return (
    <>
      <p className="time">
        {directive.leaveBy ? (
          <>
            Leave by {clock(new Date(directive.leaveBy), state.settings.timezone)}
            {" — "}
            {minutesLine(directive)}
          </>
        ) : (
          <>
            {directive.title} · {minutesLine(directive)}
          </>
        )}
      </p>
      <p className="reason">{thenLine(directive)}</p>
      <p className="microcopy">
        {directive.mode ? `${modeLabel(directive.mode)} · ` : ""}
        {travelSourceLabel(directive.source, directive.sampleCount)}
        {canMeasure ? " — press Measure travel to time it properly" : ""}
      </p>
      <p className="microcopy">{explanation}</p>
      {isUnderway && <p className="microcopy">On your way to {placeName}.</p>}
      {directive.originAssumed && (
        <div className="travel-assumed-origin">
          <p className="microcopy">Assuming you’re at {assumedLocationName}.</p>
          <div className="actions">
            {assumedLocationId && (
              <button
                className="quiet"
                disabled={saving}
                onClick={() => void saveEntityCommand(situationCommand(state, { locationId: assumedLocationId }))}
              >
                Yes, I’m here
              </button>
            )}
            <button className="quiet" disabled={saving} onClick={() => setPickingLocation(true)}>
              I’m somewhere else
            </button>
          </div>
          {pickingLocation && (
            <select
              aria-label="Where are you?"
              disabled={saving}
              defaultValue=""
              onChange={(event) => {
                if (!event.target.value) return;
                void saveEntityCommand(situationCommand(state, { locationId: event.target.value }));
                setPickingLocation(false);
              }}
            >
              <option value="">Choose a place…</option>
              {locations.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </select>
          )}
        </div>
      )}
      <div className="actions">
        {underwayCommitment && !isUnderway && !directive.originAssumed && assumedLocationId && (
          <button
            className="quiet"
            disabled={saving}
            onClick={() =>
              void saveEntityCommand(
                situationCommand(state, {
                  underway: {
                    commitmentId: underwayCommitment.id,
                    occurrenceStartsAt: underwayCommitment.startsAt,
                    fromLocationId: assumedLocationId,
                    departedAt: new Date().toISOString()
                  }
                })
              )
            }
          >
            On my way
          </button>
        )}
        <button
          disabled={saving}
          onClick={() => void saveEntityCommand(situationCommand(state, { locationId: directive.toLocationId }))}
        >
          I’m at {placeName}
        </button>
        {canMeasure && (
          <button className="quiet" disabled={saving || measuring} onClick={() => void refresh()}>
            {measuring ? "Measuring…" : "Measure travel"}
          </button>
        )}
      </div>
      {measureError && (
        <p className="form-error" role="alert">
          {measureError}
        </p>
      )}
      <p className="microcopy">
        No timer to start: saying you are at {placeName} is enough, and the plan picks up from there.
      </p>
      {evidence.length > 0 && <EvidenceDetails summary="Why go now" evidence={evidence} />}
    </>
  );
}

function modeLabel(mode: NonNullable<TravelDirective["mode"]>): string {
  return mode === "car" ? "By car" : mode === "bike" ? "By bike" : "On foot";
}

/** "usually 22 min, allowing 28" when the two differ, else just the allowing figure on its own. */
function minutesLine(directive: TravelDirective): string {
  return directive.typicalMinutes !== undefined && directive.typicalMinutes !== directive.recommendedMinutes
    ? `usually ${directive.typicalMinutes} min, allowing ${directive.recommendedMinutes}`
    : `${directive.recommendedMinutes} min`;
}
