import { describe, expect, it } from "vitest";
import type { DeliverableProjection } from "@openrhen/contracts";
import { formatDate, formatTime, localiseTimes } from "../../src/recommendation/format.js";
import { prerequisiteReason } from "../../src/scheduling/deliverables.js";

const at = new Date("2026-08-07T09:00:00.000Z");

describe("display locale", () => {
  it("formats times in the given locale and defaults to en", () => {
    expect(formatTime(at, "UTC", "en-US")).toBe("9:00 AM");
    expect(formatTime(at, "UTC", "en-AU")).toBe("9:00 am");
    expect(formatTime(at, "UTC")).toBe("9:00 AM");
  });

  it("formats dates in the given locale and defaults to en", () => {
    expect(formatDate(at, "UTC", "en-US")).toMatch(/\bFri\b.*\b9:00 AM\b/);
    expect(formatDate(at, "UTC", "en-AU")).toMatch(/\bFri\b.*\b9:00 am\b/);
    expect(formatDate(at, "UTC", "en-US")).not.toBe(formatDate(at, "UTC", "en-AU"));
  });

  it("threads the locale through rewritten ISO timestamps", () => {
    expect(localiseTimes("at 2026-08-07T09:00:00Z", "UTC", "en-US")).toMatch(/9:00 AM/);
    expect(localiseTimes("at 2026-08-07T09:00:00Z", "UTC", "en-AU")).toMatch(/9:00 am/);
  });

  it("still throws on an unknown zone, repeatedly", () => {
    expect(() => formatTime(at, "Not/AZone")).toThrow();
    expect(() => formatTime(at, "Not/AZone")).toThrow();
  });

  it("joins prerequisite names by locale", () => {
    const projection = {
      title: "Report",
      incompletePrerequisites: [{ title: "a" }, { title: "b" }, { title: "c" }]
    } as unknown as DeliverableProjection;
    expect(prerequisiteReason(projection, "en-US")).toContain("a, b, and c");
    expect(prerequisiteReason(projection, "en-AU")).toContain("a, b and c");
    expect(prerequisiteReason(projection)).toContain("a, b, and c");
  });
});
