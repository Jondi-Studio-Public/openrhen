import { describe, expect, it } from "vitest";
import "@/test/example-calendar-sources";
import { KNOWN_PROVIDERS } from "./provider-call-recorder";

describe("KNOWN_PROVIDERS", () => {
  it("includes the core and the stand-in provider telemetry names", () => {
    expect([...KNOWN_PROVIDERS]).toEqual(
      expect.arrayContaining(["google_calendar", "google", "openai", "example_shared", "example_daily"])
    );
  });
});
