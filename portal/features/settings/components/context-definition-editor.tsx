"use client";

import type { ReactNode } from "react";
import { Field } from "@/components/field";
import { ContextChoices, MinuteInput } from "@/features/settings/components/settings-fields";
import type { ConditionDefinition } from "@/features/settings/context-summary";
import { LOCATION_COORDINATES_REQUIRED, hasCoordinates } from "@/features/settings/location-coordinates";
import { contactAddressProblem } from "@/features/commitments/contact-message";
import type { PortalState, RoutinePreset } from "@/state/portal-state";

export interface GeocodeMatch {
  label: string;
  latitude: number;
  longitude: number;
}

/**
 * The place search is a tool for finding a place, not a field: the query itself is never stored,
 * only the coordinates and the label of the match taken. The manager holds it and resets it per
 * entry, because a query left over from another place would otherwise read as this one's saved
 * address. The "Set to …" line below is the stored truth.
 */
export interface PlaceLookup {
  query: string;
  matches: GeocodeMatch[];
  looking: boolean;
  error: string;
  onQueryChange: (query: string) => void;
  onLookUp: () => void;
  onSelectMatch: (match: GeocodeMatch) => void;
}

/** The one editor behind all three condition kinds; each kind only adds the fields it can use. */
export function ConditionDefinitionEditor({
  draft,
  creating,
  definitions,
  routinePresets,
  commitmentRecurrenceRules,
  commitments,
  saving,
  homeLocked = false,
  lookup,
  onChange,
  onSave,
  onCancel,
  closeControl
}: {
  draft: Record<string, unknown>;
  creating: boolean;
  definitions: ConditionDefinition[];
  routinePresets: RoutinePreset[];
  /** Live kind only: the picker's two option lists. */
  commitmentRecurrenceRules: PortalState["commitmentRecurrenceRules"];
  commitments: PortalState["commitments"];
  saving: boolean;
  /** This is the current home base, which the server refuses to archive while it still is. */
  homeLocked?: boolean;
  lookup: PlaceLookup;
  onChange: (patch: Record<string, unknown>) => void;
  onSave: () => void;
  onCancel: () => void;
  /** The Archive / Restore control of a context that exists. */
  closeControl?: ReactNode;
}) {
  // Only on the way in. An existing place without coordinates has to stay editable, or the rows
  // that most need fixing would be the ones nobody could save.
  const placeUnset =
    creating &&
    draft.kind === "location" &&
    !hasCoordinates({ latitude: draft.latitude as number | null, longitude: draft.longitude as number | null });
  // Only meaningful in the branch that already knows both coordinates are set.
  const coordinates = `${Number(draft.latitude).toFixed(5)}, ${Number(draft.longitude).toFixed(5)}`;
  const address = typeof draft.address === "string" ? draft.address.trim() : "";
  const addressProblem = draft.kind === "contact" ? contactAddressProblem(draft) : undefined;
  return (
    <div className="editor-grid settings-grid condition-editor">
      <Field label="Name">
        <input
          autoFocus
          value={String(draft.name ?? "")}
          onChange={(event) => onChange({ name: event.target.value })}
        />
      </Field>
      {creating && (
        <Field label="Id">
          <input
            value={String(draft.id ?? "")}
            placeholder="from the name"
            onChange={(event) => onChange({ id: event.target.value })}
          />
          <small>
            Used by every requirement and grant. Lowercase, hyphens only, and fixed once things point at it.
          </small>
        </Field>
      )}
      <div className="field">
        <span>Status</span>
        <span className="field-value">{draft.status === "archived" ? "Archived" : "Active"}</span>
        {!creating && !homeLocked && closeControl}
        {homeLocked && <small>This is your home base. Choose another home base first.</small>}
      </div>
      {draft.kind === "capability" && (
        <Field label="Portability">
          <select
            value={String(draft.portability ?? "fixed")}
            onChange={(event) => onChange({ portability: event.target.value })}
          >
            <option value="fixed">Fixed — belongs to a place</option>
            <option value="portable">Portable — travels with you</option>
          </select>
          <small>Portable keeps its own answer when you change location, so moving never silently drops it.</small>
        </Field>
      )}
      {draft.kind === "location" && (
        <>
          <Field label="Where it is" wide>
            <div className="geocode-row">
              <input
                value={lookup.query}
                placeholder="Type a place, e.g. City Library"
                onChange={(event) => lookup.onQueryChange(event.target.value)}
              />
              <button
                type="button"
                className="quiet small"
                disabled={lookup.looking || !lookup.query.trim()}
                onClick={() => lookup.onLookUp()}
              >
                {lookup.looking ? "Looking up…" : "Find"}
              </button>
            </div>
            {lookup.matches.length > 0 && (
              <ul className="geocode-matches">
                {lookup.matches.map((match) => (
                  <li key={`${match.latitude},${match.longitude}`}>
                    <button type="button" className="quiet small" onClick={() => lookup.onSelectMatch(match)}>
                      {match.label}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="geocode-row">
              <input
                type="number"
                step="0.00001"
                placeholder="latitude"
                value={draft.latitude === undefined || draft.latitude === null ? "" : Number(draft.latitude)}
                onChange={(event) =>
                  onChange({
                    latitude: event.target.value === "" ? null : Number(event.target.value),
                    address: null
                  })
                }
              />
              <input
                type="number"
                step="0.00001"
                placeholder="longitude"
                value={draft.longitude === undefined || draft.longitude === null ? "" : Number(draft.longitude)}
                onChange={(event) =>
                  onChange({
                    longitude: event.target.value === "" ? null : Number(event.target.value),
                    address: null
                  })
                }
              />
            </div>
            {draft.latitude !== undefined && draft.latitude !== null ? (
              <small>
                Set to {address ? `${address} (${coordinates})` : coordinates}.{" "}
                <button
                  type="button"
                  className="quiet small"
                  onClick={() => onChange({ latitude: null, longitude: null, address: null })}
                >
                  Clear
                </button>
              </small>
            ) : placeUnset ? (
              <small className="form-error">{LOCATION_COORDINATES_REQUIRED}</small>
            ) : (
              <small>
                Search needs the Geocoding API enabled on your key; the two boxes accept coordinates directly either
                way. Without them this place still works, it just cannot have its travel measured.
              </small>
            )}
            {lookup.error && <small className="form-error">{lookup.error}</small>}
          </Field>
          <Field label="Travel time (minutes)">
            <input
              type="number"
              min="0"
              value={
                draft.travelMinutes === undefined || draft.travelMinutes === null ? "" : Number(draft.travelMinutes)
              }
              onChange={(event) =>
                onChange({ travelMinutes: event.target.value === "" ? null : Number(event.target.value) })
              }
            />
            <small>Leave empty and work needing this place is simply unavailable rather than offered as a trip.</small>
          </Field>
          <Field label="Usual mode">
            <select
              value={String(draft.usualTransportMode ?? "")}
              onChange={(event) => onChange({ usualTransportMode: event.target.value || null })}
            >
              <option value="">No opinion — falls to the default mode</option>
              <option value="car">Car</option>
              <option value="bike">Bike</option>
              <option value="walk">Walk</option>
            </select>
            <small>How a commitment here is reached, unless the commitment itself names a mode.</small>
          </Field>
          <Field label="Setup before">
            <MinuteInput
              value={Number(draft.setupBeforeMinutes ?? 0)}
              onChange={(value) => onChange({ setupBeforeMinutes: value })}
            />
            <small>Protected before a commitment here, and applied during import review.</small>
          </Field>
          <Field label="Transition after">
            <MinuteInput
              value={Number(draft.transitionAfterMinutes ?? 0)}
              onChange={(value) => onChange({ transitionAfterMinutes: value })}
            />
          </Field>
          <Field label="Default routine">
            <select
              value={String(draft.defaultRoutinePresetId ?? "")}
              onChange={(event) => onChange({ defaultRoutinePresetId: event.target.value || null })}
            >
              <option value="">None</option>
              {routinePresets
                .filter((item) => item.status === "active" || item.id === draft.defaultRoutinePresetId)
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
            </select>
            <small>
              Applied to future commitments at this place — inherited automatically, editable per commitment.
            </small>
          </Field>
          <Field label="Available here" wide group>
            <ContextChoices
              options={definitions
                .filter(
                  (entry) => entry.kind !== "location" && entry.kind !== "live" && entry.portability !== "portable"
                )
                .map((entry) => entry.id)}
              selected={(draft.grants as string[]) ?? []}
              onChange={(grants) => onChange({ grants })}
            />
            <small>Portable things are deliberately absent — you carry those, this place does not supply them.</small>
          </Field>
        </>
      )}
      {draft.kind === "contact" && (
        <>
          <Field label="How you reach them" wide group>
            <ContextChoices
              options={["in_person", "sync_remote", "async"]}
              selected={(draft.channels as string[]) ?? []}
              onChange={(channels) => onChange({ channels })}
            />
            <small>Any channel other than in person makes them reachable wherever you are.</small>
          </Field>
          <Field label="Phone">
            <input
              type="tel"
              autoComplete="off"
              value={String(draft.phone ?? "")}
              onChange={(event) => onChange({ phone: event.target.value })}
            />
          </Field>
          <Field label="Email">
            <input
              type="email"
              autoComplete="off"
              value={String(draft.email ?? "")}
              onChange={(event) => onChange({ email: event.target.value })}
            />
            <small>
              Either one lets <strong>Let {String(draft.name || "them")} know?</strong> open a text or email with the
              message written. OpenRhen never sends it; you do.
            </small>
            {addressProblem && <small className="form-error">{addressProblem}</small>}
          </Field>
        </>
      )}
      {draft.kind === "live" && (
        <Field label="Tracks" wide>
          <select
            value={draft.recurrenceRuleId ? "rule" : draft.commitmentId ? "commitment" : ""}
            onChange={(event) => {
              const mode = event.target.value;
              onChange({
                recurrenceRuleId: mode === "rule" ? (commitmentRecurrenceRules[0]?.id ?? "") : undefined,
                commitmentId: mode === "commitment" ? (commitments[0]?.id ?? "") : undefined
              });
            }}
          >
            <option value="">— choose one —</option>
            <option value="rule">A recurring commitment</option>
            <option value="commitment">A one-off commitment</option>
          </select>
          {draft.recurrenceRuleId !== undefined && (
            <select
              value={String(draft.recurrenceRuleId ?? "")}
              onChange={(event) => onChange({ recurrenceRuleId: event.target.value })}
            >
              <option value="">— none —</option>
              {commitmentRecurrenceRules.map((rule) => (
                <option key={rule.id} value={rule.id}>
                  {rule.title}
                </option>
              ))}
            </select>
          )}
          {draft.commitmentId !== undefined && (
            <select
              value={String(draft.commitmentId ?? "")}
              onChange={(event) => onChange({ commitmentId: event.target.value })}
            >
              <option value="">— none —</option>
              {commitments
                .filter((commitment) => commitment.status !== "cancelled")
                .map((commitment) => (
                  <option key={commitment.id} value={commitment.id}>
                    {commitment.title}
                  </option>
                ))}
            </select>
          )}
          <small>
            Satisfied only while now falls inside a live, confirmed occurrence of whichever you pick — never its setup,
            travel, or transition buffers.
          </small>
        </Field>
      )}
      <div className="condition-editor-actions">
        <button type="button" disabled={saving || placeUnset || Boolean(addressProblem)} onClick={onSave}>
          {saving ? "Saving…" : "Save"}
        </button>
        <button type="button" className="quiet" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
