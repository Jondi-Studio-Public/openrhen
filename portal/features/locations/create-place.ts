import type { PlanningEntityCommand } from "@openrhen/contracts";
import { uploadPlaceReferencePhoto } from "@/features/photo-checkins/photo-checkin-client";
import { createClientId } from "@/shared/client-id";
import type { GeocodeMatch } from "@/features/today/components/location-picker";

export interface CreatePlaceOptions {
  /** A one-off belongs to whatever record made it and never enters the general place pickers. */
  oneOff: boolean;
  /** Ignored for a one-off, which is simply called by the address it was found at. Required otherwise. */
  name?: string;
  /** An optional reference photo of a permanent place, filed for the photo check-ins place gallery. */
  photo?: File;
}

/**
 * Turns a geocoder match into a stored `condition_definition` of kind `location` — the one place a
 * search result becomes a real place, whichever picker asked for it. A one-off is keyed by a fresh
 * client id and takes the match's own label as its name, so it never collides with anything; a
 * permanent place is keyed by a slug of the name it was given, the same id a hand-typed entry in
 * Settings would get, so it can be found and edited there afterwards.
 */
export async function createPlace(
  match: GeocodeMatch,
  saveEntityCommand: (command: PlanningEntityCommand) => Promise<void>,
  options: CreatePlaceOptions
): Promise<{ id: string; name: string }> {
  const name = options.oneOff ? match.label : (options.name ?? "").trim() || match.label;
  const id = options.oneOff
    ? createClientId()
    : name
        .toLocaleLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") || createClientId();
  await saveEntityCommand({
    commandId: createClientId(),
    expectedVersion: null,
    type: "save_entity",
    entityType: "condition_definition",
    entity: {
      id,
      name,
      kind: "location",
      status: "active",
      oneOff: options.oneOff,
      latitude: match.latitude,
      longitude: match.longitude,
      address: match.label
    }
  });
  // Best effort: the place is already saved, and a photo that cannot be stored (the feature is off, the
  // folder is not set up) must not make the person think the place was not.
  if (options.photo && !options.oneOff) await uploadPlaceReferencePhoto(id, options.photo).catch(() => undefined);
  return { id, name };
}
