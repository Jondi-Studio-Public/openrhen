// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import "@/test/render";
import { dismissPendingLocationSuggestion, useLocationObservation } from "./use-location-observation";

const position = {
  coords: { latitude: -33.86, longitude: 151.21, accuracy: 18 },
  timestamp: Date.parse("2026-08-26T09:00:00.000Z")
} as GeolocationPosition;

function stubGeolocation(behaviour: (success: PositionCallback, error?: PositionErrorCallback) => void) {
  const getCurrentPosition = vi.fn(behaviour);
  Object.defineProperty(window.navigator, "geolocation", {
    value: { getCurrentPosition },
    configurable: true
  });
  return getCurrentPosition;
}

function stubPermissions(state: "granted" | "denied" | "prompt" | null) {
  const query = vi.fn().mockResolvedValue(state === null ? undefined : { state });
  Object.defineProperty(window.navigator, "permissions", {
    value: state === null ? undefined : { query },
    configurable: true
  });
  return query;
}

beforeEach(() => {
  window.localStorage.clear();
  Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          decision: "ignored",
          locationId: null,
          locationName: null,
          distanceMeters: null,
          reason: "no_match"
        })
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useLocationObservation", () => {
  it("takes one reading on load and posts it to /api/location/observe", async () => {
    stubPermissions("granted");
    stubGeolocation((success) => success(position));
    renderHook(() => useLocationObservation({ enabled: true, refreshKey: false }));
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        "/api/location/observe",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            accuracyMeters: position.coords.accuracy,
            observedAt: new Date(position.timestamp).toISOString()
          })
        })
      )
    );
  });

  it("stays silent when the decision is refreshed or ignored", async () => {
    stubPermissions("granted");
    stubGeolocation((success) => success(position));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            decision: "refreshed",
            locationId: "home",
            locationName: "Home",
            distanceMeters: 3,
            reason: null
          })
      })
    );
    const { result } = renderHook(() => useLocationObservation({ enabled: true, refreshKey: false }));
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(result.current.suggestion).toBeNull();

    // "ignored" (the default stub response) behaves the same way once the debounce window is cleared.
    window.localStorage.clear();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            decision: "ignored",
            locationId: null,
            locationName: null,
            distanceMeters: null,
            reason: "no_match"
          })
      })
    );
    const second = renderHook(() => useLocationObservation({ enabled: true, refreshKey: true }));
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(second.result.current.suggestion).toBeNull();
  });

  it("sets a suggestion when the decision is suggest, and dismiss clears it", async () => {
    stubPermissions("granted");
    stubGeolocation((success) => success(position));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            decision: "suggest",
            locationId: "studio",
            locationName: "Studio",
            distanceMeters: 61,
            reason: null
          })
      })
    );
    const { result } = renderHook(() => useLocationObservation({ enabled: true, refreshKey: false }));
    await waitFor(() =>
      expect(result.current.suggestion).toEqual({
        locationId: "studio",
        locationName: "Studio",
        observedAt: new Date(position.timestamp).toISOString()
      })
    );
    act(() => result.current.dismiss());
    expect(result.current.suggestion).toBeNull();
  });

  it("never asks for a fix once the browser has said no, and never re-nags a later render", async () => {
    const query = stubPermissions("denied");
    const getCurrentPosition = stubGeolocation((success) => success(position));
    renderHook(() => useLocationObservation({ enabled: true, refreshKey: false }));
    await waitFor(() => expect(query).toHaveBeenCalled());
    expect(getCurrentPosition).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();

    // A denial remembered in storage short-circuits before even asking Permissions again.
    query.mockClear();
    renderHook(() => useLocationObservation({ enabled: true, refreshKey: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(query).not.toHaveBeenCalled();
    expect(getCurrentPosition).not.toHaveBeenCalled();
  });

  it("does nothing while disabled", async () => {
    const query = stubPermissions("granted");
    const getCurrentPosition = stubGeolocation((success) => success(position));
    renderHook(() => useLocationObservation({ enabled: false, refreshKey: false }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(query).not.toHaveBeenCalled();
    expect(getCurrentPosition).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("dismissPendingLocationSuggestion", () => {
  it("sends the clear request and never throws when it fails", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    await dismissPendingLocationSuggestion();
    expect(fetchMock).toHaveBeenCalledWith("/api/location/suggestion", { method: "DELETE" });

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    await expect(dismissPendingLocationSuggestion()).resolves.toBeUndefined();
  });
});
