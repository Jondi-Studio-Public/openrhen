import { locationObservationSchema } from "@openrhen/contracts";
import { withLocationObservationStore } from "@/server/location/location-observation-store";
import { StaleLocationReadingError } from "@/server/location/observation-policy";
import { withRoute } from "@/server/logging";

/**
 * Where the open tab says the device is.
 *
 * Same-origin and unauthenticated, like every other portal route: this one cannot move the location
 * assertion, so there is nothing here for an outsider to take. The most it does is push the
 * staleness clock forward on a place the person already said they were at.
 *
 * ## Request
 *
 * `POST /api/location/observe`, `content-type: application/json`, body only — coordinates never go
 * in the query string:
 *
 * ```json
 * { "latitude": -33.86, "longitude": 151.21, "accuracyMeters": 18, "observedAt": "2026-08-26T09:12:03.000Z" }
 * ```
 *
 * `observedAt` is an ISO 8601 timestamp with an offset (`Date.toISOString()` from the browser's
 * `Geolocation` callback is exactly right). `accuracyMeters` is the reading's own
 * `coords.accuracy`; it widens the match tolerance and never narrows it.
 *
 * ## Response
 *
 * `200` with exactly one of these three shapes. Every key is always present; unused ones are `null`.
 *
 * ```json
 * { "decision": "refreshed", "locationId": "home", "locationName": "Home", "distanceMeters": 24, "reason": null }
 * { "decision": "suggest",   "locationId": "studio", "locationName": "Studio", "distanceMeters": 61, "reason": null }
 * { "decision": "ignored",   "locationId": null, "locationName": null, "distanceMeters": null, "reason": "ambiguous" }
 * ```
 *
 * - **`refreshed`** — the reading agrees with the current assertion and that assertion was not
 *   stale. Its staleness clock has been pushed forward server-side. Nothing to ask; the client may
 *   refetch state to pick up the new `locationSetAt`, or ignore the answer entirely.
 * - **`suggest`** — the reading points at a saved place that is not the current assertion, *or* the
 *   assertion had gone stale (in which case `locationId` may equal the one already held, and the
 *   honest prompt is "still at Home?" rather than "moved to Home?"). **Nothing was written.** The
 *   client should offer the named place and, if the person accepts, assert it the ordinary way —
 *   the `save_entity` / `current_availability` command that the Settings situation panel already
 *   sends. This endpoint deliberately has no "accept" of its own.
 * - **`ignored`** — nothing could be concluded, `reason` says why:
 *   `"ambiguous"` (two or more saved places sit within tolerance of the reading),
 *   `"no_match"` (no saved place is within tolerance),
 *   `"no_locations"` (no saved place has coordinates at all — offer to add one).
 *
 * `400 { "error": string, "issues": [...] }` when the body fails validation. `500 { "error": string }`
 * for anything else, per the portal's usual route wrapper.
 */
export const POST = withRoute("/api/location/observe", async (request, _context, log) => {
  const parsed = locationObservationSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return Response.json(
      { error: "The location reading failed validation.", issues: parsed.error.issues.slice(0, 20) },
      { status: 400 }
    );
  log.setCommandType("location_observe");
  // The decision word is the only thing about this request that is ever logged. Coordinates are not
  // written to the log at any level, and the store keeps the match rather than the reading.
  try {
    return Response.json(await withLocationObservationStore((store) => store.recordBrowserObservation(parsed.data)));
  } catch (error) {
    if (error instanceof StaleLocationReadingError)
      return Response.json({ error: "The reading's observedAt is too far from the server's clock." }, { status: 400 });
    throw error;
  }
});
