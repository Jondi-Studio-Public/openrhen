"use client";

import { useRef, useState } from "react";
import type { GeocodeMatch } from "@/features/today/components/location-picker";

/**
 * The one geocoder search, behind whichever place picker is asking: type a query, get back matches
 * to choose from. Held here once because the search-box-with-results shape is the same wherever a
 * place is looked up from a typed address — the commitment editor, the settings catalogue, and now
 * an imported record — and copying the fetch three times would drift the moment one of them handled
 * an error differently.
 *
 * A stale response is dropped rather than shown: `search` tags every request with a token, and a
 * response that returns after a newer search (or after `reset`) started is simply ignored.
 */
export function useGeocodeSearch() {
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<GeocodeMatch[]>([]);
  const [looking, setLooking] = useState(false);
  const [error, setError] = useState("");
  const token = useRef(0);

  /** Back to nothing typed, nothing found — used on close, and before a picked match is acted on. */
  const reset = () => {
    token.current += 1;
    setQuery("");
    setMatches([]);
    setError("");
    setLooking(false);
  };

  async function search() {
    const id = ++token.current;
    setLooking(true);
    setError("");
    setMatches([]);
    try {
      const response = await fetch("/api/travel/geocode", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: query.trim() })
      });
      const payload = (await response.json()) as { matches?: GeocodeMatch[]; error?: string };
      if (token.current !== id) return;
      if (!response.ok) throw new Error(payload.error ?? "The lookup failed.");
      setMatches(payload.matches ?? []);
      if (!payload.matches?.length) setError("Nothing matched that. Try including the town.");
    } catch (lookupError) {
      if (token.current !== id) return;
      setError(lookupError instanceof Error ? lookupError.message : "The lookup failed.");
    } finally {
      if (token.current === id) setLooking(false);
    }
  }

  return { query, setQuery, matches, setMatches, looking, setLooking, error, setError, search, reset };
}

export type GeocodeSearch = ReturnType<typeof useGeocodeSearch>;
