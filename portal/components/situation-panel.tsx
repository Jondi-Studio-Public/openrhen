"use client";

import { useEffect, useMemo, useState } from "react";
import type { ConditionDefinition, CurrentSituation, PlanningEntityCommand, Truth } from "@openrhen/contracts";
import { resolveSituation, type ResolutionSource } from "@openrhen/contracts/readiness";
import type { PortalState } from "@/state/portal-state";
import { createClientId } from "@/shared/client-id";

/**
 * Replaces the flat checkbox grid, where `home` and `desktop` were the same kind of thing and every
 * one of them had to be ticked by hand. A location is chosen, capabilities that belong to that
 * location follow from it, and the ones that travel with you keep their own answer across a move.
 *
 * Each row says where its answer came from. Without that, an inferred capability and an asserted one
 * look identical, and there is no way to tell a wrong guess from a wrong fact.
 */
/** A named place offered for confirmation, from either a browser reading or a phone ping. */
export interface LocationPromptView {
  locationId: string;
  locationName: string;
}

interface Props {
  state: PortalState;
  saving: boolean;
  now: Date;
  save: (situation: Partial<CurrentSituation>) => void;
  /** Set only when a geolocation signal has something to ask about; see `use-location-observation.ts`. */
  locationPrompt?: LocationPromptView | null | undefined;
  onConfirmLocationPrompt?: (() => void) | undefined;
  onDismissLocationPrompt?: (() => void) | undefined;
}

const truthLabel: Record<Truth, string> = { yes: "available", no: "not available", unknown: "unanswered" };

/**
 * "N of 100 lookups left today". Fetched once
 * per mount from the small read route rather than threaded onto the state fetch: it is the one thing
 * here that moves independently of a save — the worker's own scheduled ticks spend it too — so it
 * would otherwise be stale the moment either happens elsewhere. Read-only and best-effort: a failed
 * read just leaves the line off rather than blocking the rest of the panel.
 */
function useTravelLookupsRemaining(): { remaining: number; limit: number } | null {
  const [budget, setBudget] = useState<{ remaining: number; limit: number } | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/travel/budget")
      .then(async (response) => {
        if (!response.ok) return;
        const payload = (await response.json()) as { remaining: number; limit: number };
        if (!cancelled) setBudget(payload);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  return budget;
}

/** How long ago the location was asserted, phrased for a sentence rather than as a timestamp. */
function staleness(setAt: string | undefined, now: Date): string {
  if (!setAt) return "a while ago";
  const hours = (now.getTime() - new Date(setAt).getTime()) / 3_600_000;
  if (!Number.isFinite(hours) || hours < 0) return "a while ago";
  if (hours < 48) return `${Math.round(hours)} hours ago`;
  return `${Math.round(hours / 24)} days ago`;
}

function sourceLabel(source: ResolutionSource, definitions: ConditionDefinition[]): string {
  switch (source.kind) {
    case "overridden":
      return "you said so";
    case "carried":
      return source.truth === "unknown" ? "not answered yet" : source.truth === "yes" ? "with you" : "not with you";
    case "granted":
      return `here at ${definitions.find((entry) => entry.id === source.locationId)?.name ?? source.locationId}`;
    case "here":
      return source.truth === "yes" ? "where you are" : "elsewhere";
    case "reachable-remotely":
      return "reachable by message or call";
    case "composite":
      return "from what it needs";
    case "location-unknown":
      return "depends where you are";
    case "undefined":
      return "not defined";
    default:
      return "unknown";
  }
}

export function SituationPanel({
  state,
  saving,
  now,
  save,
  locationPrompt,
  onConfirmLocationPrompt,
  onDismissLocationPrompt
}: Props) {
  const definitions = state.conditionDefinitions.filter((entry) => entry.status !== "archived");
  const situation = state.currentSituation;
  const commitments = state.commitments;
  const resolved = useMemo(
    () => resolveSituation({ situation, definitions, now, commitments }),
    [situation, definitions, now, commitments]
  );

  const locations = definitions.filter((entry) => entry.kind === "location");
  const capabilities = definitions.filter((entry) => entry.kind === "capability");
  const contacts = definitions.filter((entry) => entry.kind === "contact");
  const portable = capabilities.filter((entry) => entry.portability === "portable" && !entry.pathways.length);
  const inferred = [
    ...capabilities.filter((entry) => entry.portability !== "portable" || entry.pathways.length),
    ...contacts
  ];

  const budget = useTravelLookupsRemaining();

  const describe = (id: string) => {
    const source = resolved.sourceOf?.(id) ?? { kind: "undefined" as const, truth: resolved.resolve(id) };
    return { truth: source.truth, why: sourceLabel(source, definitions) };
  };

  return (
    <div className="situation-panel">
      <div>
        <strong>Where you are</strong>
        <select
          className="situation-location"
          disabled={saving}
          // Shows what was actually said, not what is still trusted. Blanking it on staleness would
          // discard the answer and leave re-picking the same option firing no change at all.
          value={situation.locationId ?? ""}
          onChange={(event) => save({ locationId: event.target.value || null })}
        >
          <option value="">Not saying</option>
          {locations.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name}
            </option>
          ))}
        </select>
        {resolved.locationStale && situation.locationId && (
          <p className="microcopy">
            You last said this {staleness(situation.locationSetAt, now)}, which is too long ago to rely on, so anything
            that follows from it is being treated as unanswered.{" "}
            <button className="quiet" disabled={saving} onClick={() => save({ locationId: situation.locationId })}>
              I am still at{" "}
              {definitions.find((entry) => entry.id === situation.locationId)?.name ?? situation.locationId}
            </button>
          </p>
        )}
        {locationPrompt && onConfirmLocationPrompt && onDismissLocationPrompt && (
          <LocationSuggestionNotice
            prompt={locationPrompt}
            currentLocationId={situation.locationId}
            saving={saving}
            onConfirm={onConfirmLocationPrompt}
            onDismiss={onDismissLocationPrompt}
          />
        )}
      </div>

      {portable.length > 0 && (
        <div>
          <strong>With you</strong>
          <div className="choice-list context-choice-list">
            {portable.map((entry) => {
              const carried = situation.carrying[entry.id];
              return (
                <label key={entry.id}>
                  <input
                    type="checkbox"
                    disabled={saving}
                    // Indeterminate would be truer than unchecked for an unanswered capability, but a
                    // checkbox cannot be left indeterminate once touched; the row's own label carries
                    // the distinction instead.
                    checked={carried === true}
                    onChange={(event) =>
                      save({ carrying: { ...situation.carrying, [entry.id]: event.target.checked } })
                    }
                  />
                  <span>{entry.name}</span>
                  {/* The tick already says yes or no under "With you"; only an unanswered one needs words. */}
                  {carried === undefined && <small className="situation-truth unknown">not answered yet</small>}
                </label>
              );
            })}
          </div>
          <p className="microcopy">
            These stay with you when you change location, so moving never silently drops the laptop you carried there.
          </p>
        </div>
      )}

      <div>
        <strong>How you can get about</strong>
        <div className="choice-list context-choice-list">
          {(["car", "bike", "walk"] as const).map((mode) => (
            <label key={mode}>
              <input
                type="checkbox"
                disabled={saving || (situation.transportModes.length === 1 && situation.transportModes.includes(mode))}
                checked={situation.transportModes.includes(mode)}
                onChange={(event) =>
                  save({
                    transportModes: event.target.checked
                      ? [...new Set([...situation.transportModes, mode])]
                      : situation.transportModes.filter((entry) => entry !== mode)
                  })
                }
              />
              <span>{mode === "car" ? "Car" : mode === "bike" ? "Bike" : "On foot"}</span>
            </label>
          ))}
        </div>
        <p className="microcopy">
          Work that needs another place is offered as a trip, timed by the quickest of these. Keep at least one; to stop
          trips altogether, use Travel off.
        </p>
        {/* An on/off setting, not a choice in a list, so it is a switch rather than a checkbox. */}
        <button
          type="button"
          role="switch"
          aria-checked={situation.travelOff}
          className="switch situation-travel-off"
          disabled={saving}
          onClick={() => save({ travelOff: !situation.travelOff })}
        >
          <span className="switch-track" aria-hidden="true">
            <span className="switch-thumb" />
          </span>
          <span>Travel off</span>
        </button>
        <p className="microcopy">
          {situation.travelOff
            ? "No trip is offered anywhere, however far the work would be worth it. A commitment's own journey and the way home are still planned — this only stops the ones the plan would otherwise send you on."
            : "Stops directed trips only: turn this on when you are staying put today, without losing the travel a commitment or the way home still needs."}
        </p>
        {budget && (
          <p className="microcopy">
            {budget.remaining} of {budget.limit} travel-time lookups left today.
          </p>
        )}
      </div>

      {inferred.length > 0 && (
        <div>
          <strong>Follows from where you are</strong>
          <ul className="situation-inferred">
            {inferred.map((entry) => {
              const { truth, why } = describe(entry.id);
              return (
                <li key={entry.id}>
                  <span>{entry.name}</span>
                  <small className={`situation-truth ${truth}`}>{truthLabel[truth]}</small>
                  <small className="situation-source">{why}</small>
                  <button
                    className="quiet"
                    disabled={saving}
                    onClick={() => {
                      const next = { ...situation.overrides };
                      if (situation.overrides[entry.id]) delete next[entry.id];
                      else next[entry.id] = truth === "yes" ? "unavailable" : "available";
                      save({ overrides: next });
                    }}
                  >
                    {situation.overrides[entry.id]
                      ? "Use the usual answer"
                      : truth === "yes"
                        ? "Not right now"
                        : "Actually available"}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Builds the command that persists a partial change to the situation. */
export function situationCommand(state: PortalState, situation: Partial<CurrentSituation>) {
  return {
    commandId: createClientId(),
    expectedVersion: state.settings.version ?? null,
    type: "save_entity" as const,
    entityType: "current_availability" as const,
    // The legacy pair still travels alongside while the flat columns exist, so a downgrade or a
    // half-applied deploy does not lose the energy setting.
    entity: {
      currentEnergy: state.currentEnergy,
      assertedConditions: state.assertedConditions,
      currentSituation: situation
    }
  };
}

/**
 * The one-tap way to tell the plan you have arrived, offered directly on whatever Now panel is
 * holding a located commitment's clock — the sidebar's location select is easy to miss while a
 * commitment is actively running ("I am here" had nowhere obvious to be said).
 * Fires the exact command the manual select and the "I am still at" prompt both use, so an accepted
 * press is indistinguishable from a hand-picked assertion — including the server's own follow-through
 * of skipping whatever preparation the arrival made moot (`routine-step-arrival.ts`).
 *
 * Renders nothing once the situation already agrees with `locationId`, so it disappears the moment
 * the assertion lands rather than staying pressable on an already-settled situation.
 */
export function ArrivalButton({
  state,
  saving,
  locationId,
  locationName,
  saveEntityCommand
}: {
  state: PortalState;
  saving: boolean;
  locationId: string;
  locationName: string;
  saveEntityCommand: (command: PlanningEntityCommand) => Promise<void>;
}) {
  if (state.currentSituation.locationId === locationId) return null;
  return (
    <button
      type="button"
      className="quiet"
      disabled={saving}
      onClick={() => void saveEntityCommand(situationCommand(state, { locationId }))}
    >
      I’m at {locationName}
    </button>
  );
}

/**
 * The compact prompt a geolocation signal raises — shared between the full panel and the collapsed
 * summary chip, so a suggestion is just as visible before the panel is opened as after.
 */
export function LocationSuggestionNotice({
  prompt,
  currentLocationId,
  saving,
  onConfirm,
  onDismiss
}: {
  prompt: LocationPromptView;
  currentLocationId: string | null;
  saving: boolean;
  onConfirm: () => void;
  onDismiss: () => void;
}) {
  return (
    <p className="microcopy location-suggestion-prompt">
      <span>
        {prompt.locationId === currentLocationId
          ? `Still at ${prompt.locationName}?`
          : `Looks like you're at ${prompt.locationName} — confirm?`}
      </span>
      <button className="quiet" disabled={saving} onClick={onConfirm}>
        Confirm
      </button>
      <button className="quiet" disabled={saving} onClick={onDismiss}>
        Dismiss
      </button>
    </p>
  );
}
