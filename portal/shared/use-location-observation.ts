"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { LocationObserveResponse } from "@openrhen/contracts";

/**
 * A place the browser's own reading pointed at, for the Now page to raise as its own question.
 * Nothing here was written anywhere — `/api/location/observe` never moves the assertion — so this is
 * held only for the length of the session that produced it.
 */
export interface BrowserLocationSuggestion {
  locationId: string;
  locationName: string;
  observedAt: string;
}

/** How long a taken reading (or a denial, or a "nothing to conclude") holds off the next one. */
export const LOCATION_OBSERVATION_DEBOUNCE_MINUTES = 5;
/** `getCurrentPosition`'s own timeout: long enough for a cold GPS fix, short enough not to hang the page on it. */
const GEOLOCATION_TIMEOUT_MS = 10_000;
/** A fix this fresh is accepted as-is rather than forcing a new one, which costs battery for nothing here cares about. */
const GEOLOCATION_MAX_AGE_MS = 5 * 60_000;

const LAST_ATTEMPT_STORAGE_KEY = "openrhen.location-observation.last-attempt-at";
const DENIED_STORAGE_KEY = "openrhen.location-observation.denied";

function readStorage(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // A browser that refuses storage just gets asked again sooner; nothing here is unsafe to repeat.
  }
}

/** Whether the last attempt was recent enough that a fresh page load should not fire another one. */
export function withinDebounce(now: number, lastAttemptAt: number | null): boolean {
  return lastAttemptAt !== null && now - lastAttemptAt < LOCATION_OBSERVATION_DEBOUNCE_MINUTES * 60_000;
}

function markAttempt(now = Date.now()): void {
  writeStorage(LAST_ATTEMPT_STORAGE_KEY, String(now));
}

function lastAttemptAt(): number | null {
  const raw = readStorage(LAST_ATTEMPT_STORAGE_KEY);
  const value = raw ? Number(raw) : NaN;
  return Number.isFinite(value) ? value : null;
}

function wasDenied(): boolean {
  return readStorage(DENIED_STORAGE_KEY) === "1";
}

/** Remembered once, the way the app remembers its view mode: this browser never asks again. */
function rememberDenial(): void {
  writeStorage(DENIED_STORAGE_KEY, "1");
}

/**
 * Whether this page may ask for a fix at all: a secure context (the API is simply absent otherwise),
 * geolocation support, and no standing denial. `navigator.permissions` is consulted where available
 * so a denial recorded outside this app — in the browser's own site settings — is honoured without
 * ever calling `getCurrentPosition` and re-triggering the browser's own prompt.
 */
async function permitted(): Promise<boolean> {
  if (typeof window === "undefined" || !window.isSecureContext) return false;
  if (typeof navigator === "undefined" || !navigator.geolocation) return false;
  if (wasDenied()) return false;
  if (!navigator.permissions?.query) return true;
  try {
    const status = await navigator.permissions.query({ name: "geolocation" as PermissionName });
    if (status.state === "denied") {
      rememberDenial();
      return false;
    }
    return true;
  } catch {
    // A browser that cannot answer the question is treated as not having refused it.
    return true;
  }
}

function takeReading(): Promise<GeolocationPosition | null> {
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (position) => resolve(position),
      (error) => {
        if (error.code === error.PERMISSION_DENIED) rememberDenial();
        resolve(null);
      },
      { timeout: GEOLOCATION_TIMEOUT_MS, maximumAge: GEOLOCATION_MAX_AGE_MS }
    );
  });
}

async function observe(position: GeolocationPosition): Promise<LocationObserveResponse | null> {
  try {
    const response = await fetch("/api/location/observe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracyMeters: Math.round(position.coords.accuracy),
        observedAt: new Date(position.timestamp).toISOString()
      })
    });
    // Never an error the user has to see: a convenience signal that failed is silence, not a banner.
    if (!response.ok) return null;
    return (await response.json()) as LocationObserveResponse;
  } catch {
    return null;
  }
}

/**
 * Takes at most one geolocation reading — on mount, and again whenever `refreshKey` changes while
 * `enabled` stays true — and reports what `/api/location/observe` made of it.
 *
 * This never asserts anything itself. `refreshed` and `ignored` are handled silently in here — the
 * caller sees nothing — and only `suggest` produces a value, for the caller to put a prompt on.
 * `dismiss` clears that value for the rest of the session; a later reading is what would bring one
 * back, not this hook re-asking on its own.
 */
export function useLocationObservation(args: { enabled: boolean; refreshKey: unknown }): {
  suggestion: BrowserLocationSuggestion | null;
  dismiss: () => void;
} {
  const { enabled, refreshKey } = args;
  const [suggestion, setSuggestion] = useState<BrowserLocationSuggestion | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    if (!enabled || inFlight.current) return;
    if (withinDebounce(Date.now(), lastAttemptAt())) return;
    let cancelled = false;
    inFlight.current = true;
    markAttempt();
    void (async () => {
      if (!(await permitted())) {
        if (!cancelled) inFlight.current = false;
        return;
      }
      const position = await takeReading();
      if (cancelled) {
        inFlight.current = false;
        return;
      }
      if (!position) {
        inFlight.current = false;
        return;
      }
      const result = await observe(position);
      inFlight.current = false;
      if (cancelled || !result) return;
      if (result.decision === "suggest" && result.locationId && result.locationName)
        setSuggestion({
          locationId: result.locationId,
          locationName: result.locationName,
          observedAt: new Date(position.timestamp).toISOString()
        });
      else if (result.decision === "refreshed")
        // The server's own suggestion column was cleared by an agreeing reading; a suggestion held
        // from an earlier, now-superseded one would otherwise outlive the disagreement that raised it.
        setSuggestion(null);
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, refreshKey]);

  const dismiss = useCallback(() => setSuggestion(null), []);
  return { suggestion, dismiss };
}

/**
 * Clears whatever pending location suggestion is standing server-side — the one a phone ping left,
 * exposed read-only as `state.pendingLocationSuggestion`. This is what the prompt's Dismiss sends
 * when the suggestion it is showing came from the phone rather than from this hook's own reading.
 */
export async function dismissPendingLocationSuggestion(): Promise<void> {
  try {
    await fetch("/api/location/suggestion", { method: "DELETE" });
  } catch {
    // Same convenience-signal contract as the rest of this module: a failed dismiss is silent, not
    // an error the person has to see. The next reading, or the next open of this page, tries again.
  }
}
