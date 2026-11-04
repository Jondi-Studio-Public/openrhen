"use client";

import { useEffect, useState } from "react";
import { Field } from "@/components/field";
import { Sheet } from "@/components/sheet";
import { useGeocodeSearch } from "@/features/locations/use-geocode-search";
import type { CreatePlaceOptions } from "@/features/locations/create-place";
import type { GeocodeMatch } from "@/features/today/components/location-picker";

/**
 * The one-off place search from the commitment editor, reused for a record still under import
 * review — but here a picked match need not stay scoped to this one record. Off, the "permanent"
 * toggle, a match is stored the same quiet way `createOneOffPlace` always has: picking it both
 * creates and confirms in the one click. Toggled on, the sheet grows a name field and a save step,
 * because a place meant to outlast this record needs a name of its own rather than the address it
 * was found by — the same requirement the settings catalogue makes of a new place.
 */
export function ImportLocationPickerSheet({
  open,
  onClose,
  onCreate
}: {
  open: boolean;
  onClose: () => void;
  /** Creates the place and applies it to the record; a rejection is shown in the sheet, not thrown past it. */
  onCreate: (match: GeocodeMatch, options: CreatePlaceOptions) => Promise<void>;
}) {
  const geocode = useGeocodeSearch();
  const [permanent, setPermanent] = useState(false);
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<GeocodeMatch | null>(null);
  const [photo, setPhoto] = useState<File | null>(null);
  const [photosOn, setPhotosOn] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Offered only when photo check-ins are on the person's switch; otherwise there is nowhere to keep it.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    fetch("/api/photo-checkins/mode", { cache: "no-store" })
      .then((response) => (response.ok ? (response.json() as Promise<{ mode?: string }>) : null))
      .then((payload) => {
        if (alive) setPhotosOn(payload?.mode === "shadow" || payload?.mode === "on");
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [open]);

  const closeAndReset = () => {
    setPhoto(null);
    geocode.reset();
    setPermanent(false);
    setName("");
    setSelected(null);
    setSaving(false);
    setError("");
    onClose();
  };

  async function create(match: GeocodeMatch, options: CreatePlaceOptions) {
    setSaving(true);
    setError("");
    try {
      await onCreate(match, options);
      closeAndReset();
    } catch (createError) {
      setSaving(false);
      setError(createError instanceof Error ? createError.message : "The place was not saved.");
    }
  }

  async function choose(match: GeocodeMatch) {
    if (!permanent) return create(match, { oneOff: true });
    setSelected(match);
    setError("");
    if (!name.trim()) setName(match.label);
  }

  return (
    <Sheet open={open} onClose={closeAndReset} title="Custom location" className="import-location-sheet">
      <div className="editor-grid">
        <Field label="Find a place" wide>
          <div className="geocode-row">
            <input
              autoFocus
              value={geocode.query}
              placeholder="Type a place, e.g. City Library"
              onChange={(event) => geocode.setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                void geocode.search();
              }}
            />
            <button
              type="button"
              className="quiet small"
              disabled={geocode.looking || !geocode.query.trim()}
              onClick={() => void geocode.search()}
            >
              {geocode.looking ? "Looking up…" : "Find"}
            </button>
          </div>
          {geocode.matches.length > 0 && (
            <ul className="geocode-matches">
              {geocode.matches.map((match) => (
                <li key={`${match.latitude},${match.longitude}`}>
                  <button
                    type="button"
                    className={`quiet small${selected?.label === match.label ? " selected" : ""}`}
                    disabled={saving}
                    onClick={() => void choose(match)}
                  >
                    {match.label}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {geocode.error && <small className="form-error">{geocode.error}</small>}
        </Field>
        <label className="field">
          <span>Make this a permanent location</span>
          <span className="checkbox-row">
            <input
              type="checkbox"
              checked={permanent}
              onChange={(event) => {
                setPermanent(event.target.checked);
                setSelected(null);
                setError("");
              }}
            />{" "}
            Save it in the catalogue instead of using it once for this record
          </span>
        </label>
        {permanent && (
          <>
            <Field label="Name" wide>
              <input value={name} placeholder="What to call it" onChange={(event) => setName(event.target.value)} />
            </Field>
            {photosOn && (
              <Field label="Reference photo (optional)" wide>
                <input type="file" accept="image/*" onChange={(event) => setPhoto(event.target.files?.[0] ?? null)} />
              </Field>
            )}
            <p className="reason">
              {selected ? `Set to ${selected.label}.` : "Pick a match above, then save it under this name."}
            </p>
            <div className="context-editor-actions">
              <button
                type="button"
                disabled={saving || !selected || !name.trim()}
                onClick={() => selected && void create(selected, { oneOff: false, name, ...(photo ? { photo } : {}) })}
              >
                {saving ? "Saving…" : "Save location"}
              </button>
            </div>
          </>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Sheet>
  );
}
