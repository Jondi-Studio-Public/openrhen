import { describe, expect, it } from "vitest";
import { calendarSyncProviderSchema } from "./integrations/google-calendar.js";
import { importBatchSchema, previewImportSchema } from "./imports.js";
import { commitmentSourceSchema } from "./portal/state-schema.js";
import { EXAMPLE_DAILY_SOURCE, EXAMPLE_INTERVAL_SOURCE } from "./connections/example-sources.js";
import { intervalCalendarSourceIds } from "./connections/registry.js";

describe("open provider lists", () => {
  it("keeps the interval-scheduled calendar sources, Google first", () => {
    const ids = intervalCalendarSourceIds();
    expect(ids[0]).toBe("google_calendar");
    expect(ids).toContain(EXAMPLE_INTERVAL_SOURCE);
    expect(ids).not.toContain(EXAMPLE_DAILY_SOURCE);
  });

  it("accepts any stored source id as a commitment source provider, and refuses a malformed one", () => {
    const link = { id: "l1", role: "secondary" as const };
    expect(commitmentSourceSchema.parse({ ...link, provider: "some_new_source" }).provider).toBe("some_new_source");
    expect(commitmentSourceSchema.parse({ ...link, provider: "apple_calendar" }).provider).toBe("apple_calendar");
    expect(() => commitmentSourceSchema.parse({ ...link, provider: "Not An Id" })).toThrow();
  });

  it("parses a batch source type that is a core type or a connection id, and no reserved or malformed value", () => {
    const sourceType = importBatchSchema.shape.sourceType;
    for (const value of [
      "csv",
      "xlsx",
      "ai_text",
      "ai_image",
      "fixture",
      EXAMPLE_DAILY_SOURCE,
      EXAMPLE_INTERVAL_SOURCE,
      "google_calendar",
      "some_new_source"
    ])
      expect(sourceType.parse(value)).toBe(value);
    for (const value of ["email", "status", "Bad Id"]) expect(() => sourceType.parse(value)).toThrow();
  });

  it("limits the calendar sync provider to interval-scheduled calendar sources", () => {
    expect(calendarSyncProviderSchema.parse("google_calendar")).toBe("google_calendar");
    expect(calendarSyncProviderSchema.parse(EXAMPLE_INTERVAL_SOURCE)).toBe(EXAMPLE_INTERVAL_SOURCE);
    for (const value of [EXAMPLE_DAILY_SOURCE, "google", "some_new_source"])
      expect(() => calendarSyncProviderSchema.parse(value)).toThrow();
  });

  it("lets a preview request name only the user-originated source types", () => {
    const request = { inputKind: "calendar_events", timezone: "UTC", templateVersion: "1", records: [] };
    const sourceType = (value: string) => previewImportSchema.safeParse({ ...request, sourceType: value }).success;
    for (const value of [
      "csv",
      "xlsx",
      "ai_text",
      "ai_image",
      EXAMPLE_INTERVAL_SOURCE,
      EXAMPLE_DAILY_SOURCE,
      "google_calendar",
      "fixture"
    ])
      expect(sourceType(value)).toBe(true);
    for (const value of ["evil_x", "email"]) expect(sourceType(value)).toBe(false);
  });
});
