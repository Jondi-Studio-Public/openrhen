import { z } from "zod";
import { transportModeSchema } from "../planning/context-model.js";

/**
 * The wire shape between the portal and the sidecar that owns the routing provider.
 *
 * The portal does not call the provider itself: `GOOGLE_MAPS_API_KEY` lives only in the sidecar,
 * so the one container published on the LAN never holds a third-party credential — the same
 * reason the calendar and OpenAI calls live there.
 */
export const geographicPointSchema = z.object({
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180)
});
export type GeographicPoint = z.infer<typeof geographicPointSchema>;

export const travelMatrixRequestSchema = z.object({
  origin: geographicPointSchema,
  /** Each destination keyed by the location it belongs to, so results come back already attributed. */
  destinations: z
    .array(z.object({ locationId: z.string().min(1) }).and(geographicPointSchema))
    .min(1)
    .max(25),
  /** Only these are asked for. An empty list is rejected rather than silently costing nothing. */
  modes: z.array(transportModeSchema).min(1),
  /**
   * When set, car requests route with live traffic as of this time (Routes API's
   * `routingPreference: TRAFFIC_AWARE` plus `departureTime`). Bike and walk never use traffic-aware
   * routing, since traffic does not change them.
   */
  departureAt: z.string().datetime({ offset: true }).optional()
});
export type TravelMatrixRequest = z.infer<typeof travelMatrixRequestSchema>;

export const travelMatrixResultSchema = z.object({
  /** The quickest mode per destination. Places the provider could not route to are simply absent. */
  estimates: z.array(
    z.object({
      locationId: z.string().min(1),
      minutes: z.number().finite().min(0),
      mode: transportModeSchema
    })
  ),
  /** Every routed mode per destination, not just the quickest — additive alongside `estimates`. */
  measurements: z
    .array(
      z.object({
        locationId: z.string().min(1),
        mode: transportModeSchema,
        minutes: z.number().finite().min(0)
      })
    )
    .default([]),
  /** Named so a partial result is visibly partial rather than looking like an unreachable place. */
  unroutable: z.array(z.string().min(1)).default([])
});
export type TravelMatrixResult = z.infer<typeof travelMatrixResultSchema>;

export const geocodeRequestSchema = z.object({ query: z.string().trim().min(1).max(200) });
export type GeocodeRequest = z.infer<typeof geocodeRequestSchema>;

export const geocodeResultSchema = z.object({
  matches: z.array(z.object({ label: z.string().min(1) }).and(geographicPointSchema)).default([])
});
export type GeocodeResult = z.infer<typeof geocodeResultSchema>;
