import { describe, expect, it } from "vitest";
import { takenAtFor } from "./photo-checkin-model";

describe("takenAtFor", () => {
  it("uses the time the phone says the photo was taken", () => {
    expect(takenAtFor({ lastModified: Date.UTC(2026, 9, 2, 3, 0) }, new Date(0))).toBe("2026-10-02T03:00:00.000Z");
  });

  it("falls back to now when the file carries no usable time", () => {
    const now = new Date("2026-10-02T05:00:00.000Z");
    expect(takenAtFor({}, now)).toBe(now.toISOString());
    expect(takenAtFor({ lastModified: 0 }, now)).toBe(now.toISOString());
  });
});
