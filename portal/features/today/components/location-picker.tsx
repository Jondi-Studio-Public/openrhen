"use client";

import { useRef, useState } from "react";
import { Field } from "@/components/field";
import { placeOptions, placeTravelNote, type ConditionDefinition } from "@/features/settings/context-summary";
import { useGeocodeSearch } from "@/features/locations/use-geocode-search";

export interface GeocodeMatch {
  label: string;
  latitude: number;
  longitude: number;
}

/**
 * The one place control: a picker over the saved places, with a search behind it for the places
 * worth no permanent entry — a dentist, an interview. A saved place is simply chosen; a search
 * result is turned into a quiet one-off place by the caller and then chosen the same way. There is
 * deliberately no free-text field: every commitment location is a real place the planner can reason
 * about, and the display label is the chosen place's name.
 */
export function LocationPicker({
  definitions,
  locationId,
  onSelect,
  onCreateFromSearch
}: {
  /** Context definitions; the picker offers the active, non-one-off locations among them. */
  definitions: ConditionDefinition[];
  locationId: string;
  /** Called with the chosen place and its display label, or twice-empty for “— none —”. */
  onSelect: (locationId: string, label: string) => void;
  /** Turns a picked search result into a stored one-off place; resolves to what to select. */
  onCreateFromSearch: (match: GeocodeMatch) => Promise<{ id: string; name: string }>;
}) {
  const places = placeOptions(definitions, locationId);
  const travelNote = placeTravelNote(places, locationId);
  const [searching, setSearching] = useState(false);
  const geocode = useGeocodeSearch();
  const pickRun = useRef(0);
  const closeSearch = () => {
    pickRun.current += 1;
    setSearching(false);
    geocode.reset();
  };
  async function pick(match: GeocodeMatch) {
    const run = ++pickRun.current;
    geocode.setLooking(true);
    geocode.setError("");
    try {
      const created = await onCreateFromSearch(match);
      onSelect(created.id, created.name);
      closeSearch();
    } catch (createError) {
      if (pickRun.current !== run) return;
      geocode.setLooking(false);
      geocode.setError(createError instanceof Error ? createError.message : "The place was not saved.");
    }
  }
  return (
    <Field label="Place" group>
      <select
        aria-label="Place"
        value={locationId}
        onChange={(event) => {
          const id = event.target.value;
          onSelect(id, places.find((place) => place.id === id)?.name ?? "");
        }}
      >
        <option value="">— none —</option>
        {places.map((place) => (
          <option key={place.id} value={place.id}>
            {place.name}
          </option>
        ))}
      </select>
      <small>{travelNote || "Which saved place this happens at, so travel can be planned to it."}</small>
      {searching ? (
        <>
          <div className="geocode-row">
            <input
              aria-label="Search for a place"
              value={geocode.query}
              placeholder="Type a place, e.g. City Library"
              onChange={(event) => geocode.setQuery(event.target.value)}
            />
            <button
              type="button"
              className="quiet small"
              disabled={geocode.looking || !geocode.query.trim()}
              onClick={() => void geocode.search()}
            >
              {geocode.looking ? "Looking up…" : "Find"}
            </button>
            <button type="button" className="quiet small" onClick={closeSearch}>
              Close
            </button>
          </div>
          {geocode.matches.length > 0 && (
            <ul className="geocode-matches">
              {geocode.matches.map((match) => (
                <li key={`${match.latitude},${match.longitude}`}>
                  <button
                    type="button"
                    className="quiet small"
                    disabled={geocode.looking}
                    onClick={() => void pick(match)}
                  >
                    {match.label}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {geocode.error && <small className="form-error">{geocode.error}</small>}
        </>
      ) : (
        <button type="button" className="quiet small" onClick={() => setSearching(true)}>
          Search for a place…
        </button>
      )}
    </Field>
  );
}
