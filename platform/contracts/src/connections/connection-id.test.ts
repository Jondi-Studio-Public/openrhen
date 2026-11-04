import { describe, expect, it } from "vitest";
import { RESERVED_ROUTE_WORDS, RESERVED_SOURCE_IDS, connectionIdSchema, sourceIdSchema } from "./connection-id.js";

describe("connection ids", () => {
  it("sourceIdSchema checks format only", () => {
    for (const ok of ["abc", "google_calendar", "csv", "status", "a1"])
      expect(sourceIdSchema.safeParse(ok).success).toBe(true);
    for (const bad of ["", "a", "Google", "1abc", "has-dash", "x".repeat(41)])
      expect(sourceIdSchema.safeParse(bad).success).toBe(false);
  });

  it("holds both reserved lists", () => {
    expect([...RESERVED_ROUTE_WORDS]).toEqual(["status"]);
    expect([...RESERVED_SOURCE_IDS]).toEqual([
      "csv",
      "xlsx",
      "ai_text",
      "ai_image",
      "fixture",
      "manual_capture",
      "own_trip",
      "email",
      "deliverable_text",
      "deliverable_upload"
    ]);
  });

  it("connectionIdSchema rejects every reserved id and accepts today's ids", () => {
    for (const id of [...RESERVED_ROUTE_WORDS, ...RESERVED_SOURCE_IDS])
      expect(connectionIdSchema.safeParse(id).success).toBe(false);
    for (const id of ["google_calendar", "google", "openai", "deepinfra", "pulse"]) {
      expect(connectionIdSchema.safeParse(id).success).toBe(true);
    }
  });
});
