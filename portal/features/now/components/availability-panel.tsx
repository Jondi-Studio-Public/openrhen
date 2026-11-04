"use client";

import { useState } from "react";
import { createClientId } from "@/shared/client-id";
import styles from "../now-page.module.css";
import { Sheet } from "@/components/sheet";
import {
  LocationSuggestionNotice,
  SituationPanel,
  situationCommand,
  type LocationPromptView
} from "@/components/situation-panel";
import type { PortalState } from "@/state/portal-state";
import type { SaveEntityCommand } from "@/features/now/now-model";
import { energyLabel } from "@/features/settings/settings-format";

type ConditionDefinition = PortalState["conditionDefinitions"][number];

interface Props {
  state: PortalState;
  saving: boolean;
  now: Date;
  situationLocation: ConditionDefinition | undefined;
  situationLocationTrusted: boolean;
  sleepDue: boolean;
  saveEntityCommand: SaveEntityCommand;
  /** Set only when a geolocation signal has something to ask about; see `use-location-observation.ts`. */
  locationPrompt?: LocationPromptView | null | undefined;
  onConfirmLocationPrompt?: (() => void) | undefined;
  onDismissLocationPrompt?: (() => void) | undefined;
  /**
   * `full` is the whole panel inline. `summary` is one row of chips — energy, place, what is carried —
   * that opens the same panel in a sheet, so the directive is never pushed down or outweighed by
   * controls that change a few times a day. Now uses `summary` on every screen width.
   */
  variant?: "full" | "summary";
}

/**
 * Says an energy: the chip here and the energy need on Now's needs list both send it. Picking an
 * energy is saying it, even when it is the one already stored, so it asserts it and the server dates it.
 */
export function energyCommand(state: PortalState, energy: PortalState["currentEnergy"]) {
  return {
    commandId: createClientId(),
    expectedVersion: state.settings.version ?? null,
    type: "save_entity" as const,
    entityType: "current_availability" as const,
    entity: { currentEnergy: energy, assertedConditions: state.assertedConditions, energyAsserted: true }
  };
}

/**
 * What is true right now: reported energy and where the person is. Both immediately re-filter the
 * ranked work below, which is why they sit above it rather than in settings.
 */
export function AvailabilityPanel(props: Props) {
  if (props.variant === "summary") return <AvailabilitySummary {...props} />;
  return (
    <section className="context-now">
      <AvailabilityBody {...props} />
    </section>
  );
}

function AvailabilityBody({
  state,
  saving,
  now,
  situationLocation,
  situationLocationTrusted,
  sleepDue,
  saveEntityCommand,
  locationPrompt,
  onConfirmLocationPrompt,
  onDismissLocationPrompt
}: Props) {
  return (
    <>
      <div className="section-heading">
        <h2>Available right now</h2>
        <span>
          {energyLabel(state.currentEnergy).toLowerCase()}
          {situationLocationTrusted
            ? ` · at ${situationLocation!.name}`
            : situationLocation
              ? " · location needs confirming"
              : ""}
        </span>
      </div>
      <div className="availability-now">
        <div>
          <strong>Current energy</strong>
          <div className="choice-list context-choice-list">
            {(["high", "medium", "low", "recovery"] as const).map((energy) => (
              <label key={energy}>
                <input
                  type="radio"
                  name="current-energy"
                  disabled={saving}
                  checked={state.currentEnergy === energy}
                  // A click, not a change: the radio already selected fires no change, and tapping it again
                  // is how the person says the stored energy still holds.
                  readOnly
                  onClick={() => void saveEntityCommand(energyCommand(state, energy))}
                />
                <span>{energyLabel(energy)}</span>
              </label>
            ))}
          </div>
        </div>
        <SituationPanel
          state={state}
          saving={saving}
          now={now}
          save={(situation) => void saveEntityCommand(situationCommand(state, situation))}
          locationPrompt={locationPrompt}
          onConfirmLocationPrompt={onConfirmLocationPrompt}
          onDismissLocationPrompt={onDismissLocationPrompt}
        />
      </div>
      <p className="microcopy">
        {sleepDue
          ? "Availability changes update the ranked work underneath, but an overdue sleep limit takes priority until sleep is recorded or replanned."
          : "Energy and where you are immediately filter the next action. Future energy is not predicted in this MVP."}
      </p>
    </>
  );
}

/**
 * One row of chips (energy, place, what is carried) that opens the panel in a sheet. The same on a
 * phone and a desk: the situation changes a few times a day, so it should never outweigh the hero.
 * A place that has aged out is asked on Now's needs list ("Still at Home"), not under the chips.
 */
function AvailabilitySummary(props: Props) {
  const {
    state,
    saving,
    situationLocation,
    situationLocationTrusted,
    locationPrompt,
    onConfirmLocationPrompt,
    onDismissLocationPrompt
  } = props;
  const [open, setOpen] = useState(false);
  const carried = state.conditionDefinitions
    .filter((entry) => entry.status !== "archived" && state.currentSituation.carrying[entry.id] === true)
    .map((entry) => entry.name);
  const place = situationLocationTrusted
    ? `at ${situationLocation!.name}`
    : situationLocation
      ? "location needs confirming"
      : "location not said";
  const summary = `${energyLabel(state.currentEnergy).toLowerCase()} · ${place} · ${carried.length ? `carrying ${carried.join(", ")}` : "carrying nothing"}`;
  const placeChip = situationLocationTrusted
    ? situationLocation!.name
    : situationLocation
      ? `${situationLocation.name}?`
      : "Where are you?";
  return (
    <section className="context-now-summary">
      <button
        type="button"
        className={styles.situation}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Your situation: ${summary}`}
        onClick={() => setOpen(true)}
      >
        <span className={styles.part} data-unsure={!situationLocationTrusted}>
          {placeChip}
        </span>
        <span className={styles.part}>{carried.length ? carried.join(", ") : "Carrying nothing"}</span>
        <span className={styles.part}>Energy: {energyLabel(state.currentEnergy).toLowerCase()}</span>
      </button>
      {locationPrompt && onConfirmLocationPrompt && onDismissLocationPrompt && (
        <LocationSuggestionNotice
          prompt={locationPrompt}
          currentLocationId={state.currentSituation.locationId}
          saving={saving}
          onConfirm={onConfirmLocationPrompt}
          onDismiss={onDismissLocationPrompt}
        />
      )}
      <Sheet open={open} onClose={() => setOpen(false)} title="Your situation" className="availability-sheet">
        <section className="context-now">
          <AvailabilityBody {...props} />
        </section>
      </Sheet>
    </section>
  );
}
