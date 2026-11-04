import { describe, expect, it } from "vitest";
import { CAPABILITY_OPS, capabilityIdSchema, capabilityPath, opIdSchema } from "./capabilities.js";

describe("capabilities", () => {
  it("lists the six capabilities with their ops", () => {
    expect(capabilityIdSchema.options).toEqual([
      "calendar_source",
      "calendar_sink",
      "travel_time",
      "geocoding",
      "model_provider",
      "status_publish"
    ]);
    expect(CAPABILITY_OPS.calendar_source).toEqual(["proof", "list_calendars", "read_events"]);
    expect(CAPABILITY_OPS.calendar_sink).toEqual(["status", "create", "update", "remove", "write_proof"]);
    expect(CAPABILITY_OPS.model_provider).toEqual(["extract", "stream", "embed", "probe"]);
  });

  it("opIdSchema covers every op of every capability", () => {
    for (const ops of Object.values(CAPABILITY_OPS))
      for (const op of ops) expect(opIdSchema.safeParse(op).success).toBe(true);
  });

  it("builds the host path", () => {
    expect(capabilityPath("calendar_source", "google_calendar", "read_events")).toBe(
      "/capabilities/calendar_source/google_calendar/read_events"
    );
  });
});
