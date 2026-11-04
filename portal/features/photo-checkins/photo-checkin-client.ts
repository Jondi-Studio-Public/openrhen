import type { PhotoCheckinMode, PhotoCheckinWire } from "@openrhen/contracts";

/**
 * Typed calls to `/api/photo-checkins`. Each turns the route's `{ error }` envelope into a thrown message,
 * so a caller decides only what to show, never how a response is shaped.
 */

async function readJson<T>(response: Response, fallback: string): Promise<T> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // An empty or non-JSON body falls through to the fallback message.
  }
  if (!response.ok) {
    const message = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
    throw new Error(typeof message === "string" && message ? message : fallback);
  }
  return body as T;
}

export interface PhotoCheckinTrail {
  mode: PhotoCheckinMode;
  photos: PhotoCheckinWire[];
}

export async function fetchPhotoCheckins(): Promise<PhotoCheckinTrail> {
  const response = await fetch("/api/photo-checkins?limit=50", { cache: "no-store" });
  return readJson<PhotoCheckinTrail>(response, "The photo check-ins could not be loaded.");
}

export async function setPhotoCheckinMode(mode: PhotoCheckinMode): Promise<void> {
  const response = await fetch("/api/photo-checkins/mode", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode })
  });
  await readJson<unknown>(response, "The setting was not saved.");
}

/** Adds one reference photo to a saved place. */
export async function uploadPlaceReferencePhoto(placeId: string, photo: File): Promise<void> {
  const form = new FormData();
  form.set("placeId", placeId);
  form.set("photo", photo);
  const response = await fetch("/api/place-photos", { method: "POST", body: form });
  await readJson<unknown>(response, "The place photo was not saved.");
}

/** Sends one photo and what was said about it. `takenAt` is an ISO timestamp. */
export async function uploadPhotoCheckin(input: {
  photo: File;
  transcript: string;
  takenAt: string;
  checkInId?: string;
}): Promise<{ photo: PhotoCheckinWire; duplicate: boolean }> {
  const form = new FormData();
  form.set("photo", input.photo);
  form.set("takenAt", input.takenAt);
  form.set("transcript", input.transcript);
  if (input.checkInId) form.set("checkInId", input.checkInId);
  const response = await fetch("/api/photo-checkins", { method: "POST", body: form });
  return readJson(response, "The photo was not saved.");
}

export async function editPhotoDescription(
  id: string,
  description: string,
  expectedVersion: number
): Promise<PhotoCheckinWire> {
  const response = await fetch(`/api/photo-checkins/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ description, expectedVersion })
  });
  return (await readJson<{ photo: PhotoCheckinWire }>(response, "The description was not saved.")).photo;
}
