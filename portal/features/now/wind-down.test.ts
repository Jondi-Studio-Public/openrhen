import { describe, expect, it } from "vitest";
import { windDownOffered } from "./wind-down";

const start = "2026-11-03T22:30:00.000Z";

describe("windDownOffered", () => {
  it("is false at 8:38 am for a bedtime that evening", () => {
    expect(windDownOffered("2026-11-03T21:30:00.000Z", new Date("2026-11-03T08:38:00.000Z"))).toBe(false);
  });
  it("is false one minute before the two-hour window opens", () => {
    expect(windDownOffered(start, new Date("2026-11-03T20:29:00.000Z"))).toBe(false);
  });
  it("opens exactly two hours before bedtime", () => {
    expect(windDownOffered(start, new Date("2026-11-03T20:30:00.000Z"))).toBe(true);
  });
  it("stays on after the planned start, with no upper bound", () => {
    expect(windDownOffered(start, new Date("2026-11-04T01:00:00.000Z"))).toBe(true);
  });
  it("hides at 7:59 for a night-shift plan that starts at 10 am, then opens at 8", () => {
    expect(windDownOffered("2026-11-03T10:00:00.000Z", new Date("2026-11-03T07:59:00.000Z"))).toBe(false);
    expect(windDownOffered("2026-11-03T10:00:00.000Z", new Date("2026-11-03T08:00:00.000Z"))).toBe(true);
  });
  it("hides for a plan that starts on the next calendar day", () => {
    expect(windDownOffered("2026-11-05T00:30:00.000Z", new Date("2026-11-03T08:38:00.000Z"))).toBe(false);
  });
  it("is false for an unparseable start", () => {
    expect(windDownOffered("nope", new Date("2026-11-03T08:38:00.000Z"))).toBe(false);
  });
});
