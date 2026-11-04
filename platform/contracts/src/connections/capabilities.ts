import { z } from "zod";

export const capabilityIdSchema = z.enum([
  "calendar_source",
  "calendar_sink",
  "travel_time",
  "geocoding",
  "model_provider",
  "status_publish"
]);

export type CapabilityId = z.infer<typeof capabilityIdSchema>;

export const CAPABILITY_OPS = {
  calendar_source: ["proof", "list_calendars", "read_events"],
  calendar_sink: ["status", "create", "update", "remove", "write_proof"],
  travel_time: ["matrix"],
  geocoding: ["geocode"],
  model_provider: ["extract", "stream", "embed", "probe"],
  status_publish: ["config", "publish"]
} as const satisfies Record<CapabilityId, readonly string[]>;

export type OpId = (typeof CAPABILITY_OPS)[CapabilityId][number];

export const opIdSchema = z.enum([
  "proof",
  "list_calendars",
  "read_events",
  "status",
  "create",
  "update",
  "remove",
  "write_proof",
  "matrix",
  "geocode",
  "extract",
  "stream",
  "embed",
  "probe",
  "config",
  "publish"
]);

/** The host path of one op, e.g. `/capabilities/calendar_source/google_calendar/read_events`. */
export function capabilityPath(capability: CapabilityId, id: string, op: string): string {
  return `/capabilities/${capability}/${id}/${op}`;
}
