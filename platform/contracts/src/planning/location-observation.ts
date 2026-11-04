import { z } from "zod";
import { geographicPointSchema } from "../integrations/travel.js";

/**
 * One coordinate reading offered to the portal as evidence of where the person is.
 *
 * Two things send these: the phone, over `POST /api/location/ping` with a bearer token, and the
 * browser, over `POST /api/location/observe` from the open tab. The shape is identical because the
 * evidence is identical — what differs is how much authority the portal grants it, which is the
 * policy's business and not the wire format's.
 *
 * Body only, never query parameters: a coordinate in a URL ends up in access logs, proxy logs and
 * browser history, and the whole point of this feature is that where the person is stays inside the
 * database.
 *
 * `observedAt` is the device's own clock rather than the server's arrival time, because a ping can
 * be queued while the phone is out of signal and delivered minutes later; the sustained-presence
 * rule reads it as the moment the fix was taken.
 */
export const locationObservationSchema = geographicPointSchema
  .extend({
    /** Reported horizontal accuracy in metres. Widens the match tolerance; never narrows it. */
    accuracyMeters: z.number().finite().min(0).max(100_000),
    observedAt: z.string().datetime({ offset: true })
  })
  // Strict: a body carrying anything else is a client sending something this endpoint has never
  // agreed to store, and silently dropping it is how a stray field becomes a stray feature.
  .strict();
export type LocationObservation = z.infer<typeof locationObservationSchema>;

/**
 * The shape `POST /api/location/observe` answers with, restated here so the client that calls it
 * shares the same type as the route rather than hand-rolling one that can drift from it. See that
 * route's own doc comment for what each `decision` means.
 */
export const locationObserveResponseSchema = z.object({
  decision: z.enum(["refreshed", "suggest", "ignored"]),
  locationId: z.string().nullable(),
  locationName: z.string().nullable(),
  distanceMeters: z.number().nullable(),
  reason: z.enum(["ambiguous", "no_match", "no_locations"]).nullable()
});
export type LocationObserveResponse = z.infer<typeof locationObserveResponseSchema>;

/**
 * The one question a phone ping may have left standing, as much of it as the portal state exposes.
 * The store keeps a richer shape internally (an ambiguous or unmatched reading raises a question
 * too), but the state document only ever needs the actionable one: a single named place to confirm.
 */
export const pendingLocationSuggestionSchema = z.object({
  locationId: z.string().min(1),
  locationName: z.string().min(1),
  observedAt: z.string().datetime({ offset: true })
});
export type PendingLocationSuggestion = z.infer<typeof pendingLocationSuggestionSchema>;
