import { describe, expect, it } from "vitest";
import {
  EMPTY_DISRUPTION_DRAFT,
  buildDisruptionBody,
  missingDisruption,
  missingSentence,
  toggleDisruptionContext,
  untilInstant,
  type DisruptionDraft
} from "./disruption-model";

const ZONE = "Australia/Sydney";
const now = new Date("2026-10-29T03:00:00.000Z");
const complete: DisruptionDraft = {
  doing: "Dentist run-over",
  targetId: "",
  untilChoice: "60",
  untilCustom: "",
  locationId: "home",
  contexts: ["cap-phone"],
  exclusive: true
};

describe("missingDisruption", () => {
  it("names every field of an empty draft, as the server does", () => {
    expect(missingDisruption(EMPTY_DISRUPTION_DRAFT, now, ZONE)).toEqual([
      "doing",
      "until",
      "locationId",
      "contexts",
      "exclusive"
    ]);
  });
  it("accepts a complete draft, and a named task in place of words", () => {
    expect(missingDisruption(complete, now, ZONE)).toEqual([]);
    expect(missingDisruption({ ...complete, doing: "", targetId: "a1" }, now, ZONE)).toEqual([]);
  });
  it("treats an answered 'no' for exclusive as answered", () => {
    expect(missingDisruption({ ...complete, exclusive: false }, now, ZONE)).toEqual([]);
  });
  it("refuses a custom time in the past or past the longest disruption", () => {
    expect(
      missingDisruption(
        { ...complete, untilChoice: "custom", untilCustom: "2026-10-29T02:00" },
        new Date("2026-10-29T12:00:00Z"),
        ZONE
      )
    ).toEqual(["until"]);
    expect(
      missingDisruption({ ...complete, untilChoice: "custom", untilCustom: "2027-01-01T00:00" }, now, ZONE)
    ).toEqual(["until"]);
    expect(missingDisruption({ ...complete, untilChoice: "custom", untilCustom: "" }, now, ZONE)).toEqual(["until"]);
  });
});

describe("custom times", () => {
  it("are read in the planning zone, whatever the browser's zone is", () => {
    const custom = { ...complete, untilChoice: "custom", untilCustom: "2026-10-29T15:00" };
    // 15:00 in the seed zone (UTC+11 in October) is 04:00Z; in New York (UTC-4) the same wall time is 19:00Z.
    expect(untilInstant(custom, now, "Australia/Sydney")?.toISOString()).toBe("2026-10-29T04:00:00.000Z");
    expect(untilInstant(custom, now, "America/New_York")?.toISOString()).toBe("2026-10-29T19:00:00.000Z");
    expect(buildDisruptionBody(custom, now, "Australia/Sydney", "c")).toMatchObject({
      until: "2026-10-29T04:00:00.000Z"
    });
  });
});

describe("building", () => {
  it("reads presets from now, and builds the body", () => {
    expect(untilInstant(complete, now, ZONE)?.toISOString()).toBe("2026-10-29T04:00:00.000Z");
    expect(buildDisruptionBody(complete, now, ZONE, "c-1")).toMatchObject({
      commandId: "c-1",
      doing: "Dentist run-over",
      until: "2026-10-29T04:00:00.000Z",
      locationId: "home",
      contexts: ["cap-phone"],
      exclusive: true,
      basis: "stated"
    });
  });
  it("sends a named task as a target with its title", () => {
    const body = buildDisruptionBody({ ...complete, doing: "", targetId: "a1" }, now, ZONE, "c", "Write report");
    expect(body.doing).toEqual({ kind: "action", id: "a1", title: "Write report" });
  });
  it("toggles contexts and words what is missing", () => {
    expect(toggleDisruptionContext(toggleDisruptionContext(complete, "x"), "x").contexts).toEqual(["cap-phone"]);
    expect(missingSentence(["until", "contexts"])).toBe(
      "Still needed: until when, what you have available (at least one)."
    );
  });
});
