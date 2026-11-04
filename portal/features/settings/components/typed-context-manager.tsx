"use client";

import { useRef, useState } from "react";
import { Field } from "@/components/field";
import { CloseControl } from "@/features/closed/components/close-control";
import { ConditionDefinitionEditor, type GeocodeMatch } from "@/features/settings/components/context-definition-editor";
import {
  commitmentConditionTarget,
  conditionKindLabels,
  conditionKinds,
  conditionRequirementCounts,
  describeCondition,
  matchConditionDefinitions,
  placeOptions,
  type ConditionDefinition,
  type ConditionKind
} from "@/features/settings/context-summary";
import { locationCoordinatesProblem, locationsMissingCoordinates } from "@/features/settings/location-coordinates";
import type { PortalState, RoutinePreset } from "@/state/portal-state";

/** Locations, capabilities and contacts: three lists over one shared editor and one shared message. */
export function TypedConditionManager({
  definitions,
  actions,
  routinePresets,
  commitmentRecurrenceRules,
  commitments,
  saving,
  homeLocationId,
  onHomeLocationChange,
  onSave
}: {
  definitions: ConditionDefinition[];
  actions: PortalState["actions"];
  routinePresets: RoutinePreset[];
  /** For the live kind's picker and display: which series or one-off a condition tracks. */
  commitmentRecurrenceRules: PortalState["commitmentRecurrenceRules"];
  commitments: PortalState["commitments"];
  saving: boolean;
  /** Held in the planning-settings draft, so it is stored by the same Save as the rest of the form. */
  homeLocationId: string | undefined;
  onHomeLocationChange: (homeLocationId: string | undefined) => void;
  onSave: (entity: Record<string, unknown>, expectedVersion: number | null) => Promise<void>;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, unknown> | null>(null);
  const [message, setMessage] = useState("");
  const [placeQuery, setPlaceQuery] = useState("");
  const [matches, setMatches] = useState<GeocodeMatch[]>([]);
  const [lookingUp, setLookingUp] = useState(false);
  const [lookupError, setLookupError] = useState("");
  const [filters, setFilters] = useState<Record<string, string>>({});
  const lookupRun = useRef(0);
  // The typed query survives nothing — only a taken match's coordinates and label are stored — so a
  // query left in the box when the editor moves to another entry reads as that entry's saved
  // address. Every open, cancel and save starts from nothing, and any answer in flight is abandoned.
  const clearLookup = () => {
    lookupRun.current += 1;
    setPlaceQuery("");
    setMatches([]);
    setLookupError("");
    setLookingUp(false);
  };
  async function lookUp() {
    const run = ++lookupRun.current;
    setLookingUp(true);
    setLookupError("");
    setMatches([]);
    try {
      const response = await fetch("/api/travel/geocode", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: placeQuery.trim() })
      });
      const payload = (await response.json()) as { matches?: GeocodeMatch[]; error?: string };
      if (lookupRun.current !== run) return;
      if (!response.ok) throw new Error(payload.error ?? "The lookup failed.");
      setMatches(payload.matches ?? []);
      if (!payload.matches?.length) setLookupError("Nothing matched that. Try including the town.");
    } catch (error) {
      if (lookupRun.current !== run) return;
      setLookupError(error instanceof Error ? error.message : "The lookup failed.");
    } finally {
      if (lookupRun.current === run) setLookingUp(false);
    }
  }
  const counts = conditionRequirementCounts(actions);
  const start = (kind: ConditionKind, existing?: ConditionDefinition) => {
    setEditingId(existing?.id ?? "");
    setDraft(
      existing
        ? { ...existing }
        : {
            id: "",
            name: "",
            kind,
            status: "active",
            portability: "fixed",
            pathways: [],
            grants: [],
            channels: kind === "contact" ? ["in_person", "sync_remote", "async"] : [],
            setupBeforeMinutes: 0,
            transitionAfterMinutes: 0
          }
    );
    setMessage("");
    clearLookup();
  };
  async function save() {
    if (!draft) return;
    const name = String(draft.name ?? "").trim();
    if (!name) return setMessage("Name it first.");
    const id =
      String(draft.id ?? "").trim() ||
      name
        .toLocaleLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
    if (!id) return setMessage("That name does not produce a usable id. Use some letters or numbers.");
    const problem = locationCoordinatesProblem(
      { kind: draft.kind, latitude: draft.latitude as number | null, longitude: draft.longitude as number | null },
      editingId === ""
    );
    if (problem) return setMessage(problem);
    try {
      await onSave({ ...draft, id, name }, (draft.version as number | undefined) ?? null);
      setMessage(`Saved “${name}”.`);
      setEditingId(null);
      setDraft(null);
      clearLookup();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "It was not saved.");
    }
  }
  const set = (patch: Record<string, unknown>) => setDraft((current) => (current ? { ...current, ...patch } : current));
  const homes = placeOptions(definitions, homeLocationId ?? "");
  const editor = draft && (
    <ConditionDefinitionEditor
      draft={draft}
      creating={editingId === ""}
      homeLocked={Boolean(homeLocationId) && draft.id === homeLocationId}
      definitions={definitions}
      routinePresets={routinePresets}
      commitmentRecurrenceRules={commitmentRecurrenceRules}
      commitments={commitments}
      saving={saving}
      lookup={{
        query: placeQuery,
        matches,
        looking: lookingUp,
        error: lookupError,
        onQueryChange: setPlaceQuery,
        onLookUp: () => void lookUp(),
        onSelectMatch: (match) => {
          // The label is stored with the pair it came from: coordinates alone are unrecognisable,
          // and nothing else in the search survives the save.
          set({ latitude: match.latitude, longitude: match.longitude, address: match.label });
          setMatches([]);
          setPlaceQuery(match.label);
        }
      }}
      onChange={set}
      onSave={() => void save()}
      closeControl={
        editingId ? (
          <CloseControl
            type="condition_definition"
            id={editingId}
            // A close bumps the version, so it waits for unsaved edits to be saved or discarded.
            dirty={JSON.stringify(draft) !== JSON.stringify(definitions.find((entry) => entry.id === editingId))}
            onDone={() => {
              setEditingId(null);
              setDraft(null);
              clearLookup();
            }}
          />
        ) : null
      }
      onCancel={() => {
        setEditingId(null);
        setDraft(null);
        clearLookup();
      }}
    />
  );
  return (
    <>
      {conditionKinds.map((kind) => {
        // One-off places live and die with the commitments that made them; the settings list is for
        // the places the user actually keeps.
        const group = definitions.filter((entry) => entry.kind === kind && !entry.oneOff);
        const shown = matchConditionDefinitions(group, filters[kind] ?? "");
        // Deliberately outside the filter: an audit that hides half its findings is not an audit.
        const unplaced = kind === "location" ? locationsMissingCoordinates(group) : [];
        return (
          <section id={`conditions-${kind}`} className="settings-section" key={kind}>
            <div className="section-heading">
              <div>
                <h2>{conditionKindLabels[kind].title}</h2>
                <p>{conditionKindLabels[kind].reason}</p>
              </div>
              <button type="button" className="quiet small" onClick={() => start(kind)}>
                Add
              </button>
            </div>
            {kind === "location" && (
              <div className="editor-grid settings-grid">
                <Field label="Home base" wide>
                  <select
                    value={homeLocationId ?? ""}
                    onChange={(event) => onHomeLocationChange(event.target.value || undefined)}
                  >
                    <option value="">— none —</option>
                    {homes.map((place) => (
                      <option key={place.id} value={place.id}>
                        {place.name}
                      </option>
                    ))}
                  </select>
                  <small>
                    Where you sleep and return to between commitments; travel and the day plan assume it. Saved with the
                    rest of the planning settings.
                  </small>
                </Field>
              </div>
            )}
            {group.length > 4 && (
              <input
                className="condition-filter"
                value={filters[kind] ?? ""}
                placeholder={`Search ${group.length} ${conditionKindLabels[kind].title.toLocaleLowerCase()}…`}
                onChange={(event) => setFilters({ ...filters, [kind]: event.target.value })}
              />
            )}
            {unplaced.length > 0 && (
              <div className="form-warning" role="alert">
                {unplaced.length} place{unplaced.length === 1 ? " has" : "s have"} no actual location set, so travel to{" "}
                {unplaced.length === 1 ? "it" : "them"} can only ever be the guessed number.
                <ul>
                  {unplaced.map((entry) => (
                    <li key={entry.id}>
                      {entry.name}{" "}
                      <button type="button" className="quiet small" onClick={() => start("location", entry)}>
                        Set location
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {shown.map((entry) => {
              const count = counts.get(entry.id) ?? 0;
              return (
                <article className="row-card" key={entry.id}>
                  <div>
                    <strong>{entry.name}</strong>
                    <p>
                      {entry.kind === "live"
                        ? commitmentConditionTarget(entry, commitmentRecurrenceRules, commitments)
                        : describeCondition(entry)}{" "}
                      · {count} action{count === 1 ? "" : "s"}
                      {entry.status === "archived" ? " · archived" : ""}
                    </p>
                  </div>
                  {entry.id === homeLocationId && <span>Home</span>}
                  <button type="button" className="quiet small" onClick={() => start(kind, entry)}>
                    Edit
                  </button>
                </article>
              );
            })}
            {!group.length && <p className="empty">None yet.</p>}
            {group.length > 0 && !shown.length && <p className="empty">Nothing matches “{filters[kind]}”.</p>}
            {draft?.kind === kind && editor}
          </section>
        );
      })}
      {message && (
        <p className={message.startsWith("Saved") ? "save-notice" : "form-error"} role="status">
          {message}
        </p>
      )}
    </>
  );
}
