import { connectionManifest, geocodeRequestSchema, travelMatrixRequestSchema } from "@openrhen/contracts";
import type { BoundConnection, OpResult } from "../../host/connection-api.js";
import { computeTravelMatrix, geocodePlace, googleMapsKeyFromEnv } from "./google-routes-client.js";

function manifest() {
  const found = connectionManifest("google");
  if (!found) throw new Error("The google manifest is missing from the registry.");
  return found;
}

const notConfigured = (): OpResult => ({ status: 400, body: { error: "GOOGLE_MAPS_API_KEY is not configured." } });

function failure(error: unknown, fallback: string): OpResult {
  return { status: 502, body: { error: error instanceof Error ? error.message : fallback } };
}

/** Google Maps: Routes (the travel matrix) and Geocoding, both behind `GOOGLE_MAPS_API_KEY`. */
export const googleRoutesConnection: BoundConnection = {
  manifest: manifest(),
  create: () => ({
    travel_time: {
      matrix: {
        kind: "json",
        async run(call) {
          const parsed = travelMatrixRequestSchema.safeParse(call.body);
          if (!parsed.success) return { status: 400, body: { error: "The travel request failed validation." } };
          const apiKey = googleMapsKeyFromEnv(call.env);
          if (!apiKey) return notConfigured();
          try {
            return { status: 200, body: await computeTravelMatrix(parsed.data, apiKey, call.fetch) };
          } catch (error) {
            // A timeout or a gone client aborted the call: the host answers that (504 or nothing).
            if (call.signal.aborted) throw error;
            return failure(error, "The travel lookup failed.");
          }
        }
      }
    },
    geocoding: {
      geocode: {
        kind: "json",
        async run(call) {
          const parsed = geocodeRequestSchema.safeParse(call.body);
          if (!parsed.success) return { status: 400, body: { error: "The geocode request failed validation." } };
          const apiKey = googleMapsKeyFromEnv(call.env);
          if (!apiKey) return notConfigured();
          try {
            return { status: 200, body: await geocodePlace(parsed.data.query, apiKey, call.fetch) };
          } catch (error) {
            if (call.signal.aborted) throw error;
            return failure(error, "Geocoding failed.");
          }
        }
      }
    }
  })
};
