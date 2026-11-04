import { describe, expect, it } from "vitest";
import { describeCadence, monthAnchorOptions, routineProvenance, routineSourceOf } from "./commitment-routine";

const pool = {
  id: "pool",
  name: "Pool",
  kind: "location" as const,
  status: "active" as const,
  pathways: [],
  portability: "fixed" as const,
  grants: [],
  setupBeforeMinutes: 0,
  transitionAfterMinutes: 0,
  channels: [],
  defaultRoutinePresetId: "kit"
};
const presets = [
  {
    id: "kit",
    name: "Pool kit",
    activityName: "Swim",
    status: "active" as const,
    replacesWakeRoutine: false,
    steps: []
  },
  {
    id: "other",
    name: "Court kit",
    activityName: "Tennis",
    status: "active" as const,
    replacesWakeRoutine: false,
    steps: []
  }
];

describe("routine provenance", () => {
  it("treats an absent source as inherit, which is what the column defaults to", () => {
    expect(routineSourceOf({})).toBe("inherit");
    expect(routineSourceOf({ routineSource: "custom" })).toBe("custom");
  });

  it("names the preset and the place an inherited routine comes from", () => {
    const provenance = routineProvenance({ routineSource: "inherit", locationId: "pool" }, [pool], presets);
    expect(provenance.label).toBe("“Pool kit” · from Pool");
    expect(provenance.short).toBe("inherited");
    expect(provenance.presetId).toBe("kit");
  });

  it("says the place has no default rather than implying a routine exists", () => {
    const provenance = routineProvenance(
      { routineSource: "inherit", locationId: "pool" },
      [{ ...pool, defaultRoutinePresetId: undefined }],
      presets
    );
    expect(provenance.label).toBe("No routine (place has no default)");
    expect(provenance.short).toBe("none");
  });

  it("distinguishes having no place at all from having one that sets no default", () => {
    expect(routineProvenance({ routineSource: "inherit" }, [pool], presets).label).toBe("No routine (no place set)");
  });

  it("names a pinned preset, and says so when the pinned one has gone", () => {
    expect(routineProvenance({ routineSource: "preset", routinePresetId: "other" }, [pool], presets).label).toBe(
      "“Court kit” · pinned"
    );
    expect(routineProvenance({ routineSource: "preset", routinePresetId: "gone" }, [pool], presets).short).toBe(
      "pinned"
    );
  });

  it("states the two decisions that resolve to no preset at all", () => {
    expect(routineProvenance({ routineSource: "custom", locationId: "pool" }, [pool], presets).label).toBe(
      "Customized"
    );
    expect(routineProvenance({ routineSource: "none", locationId: "pool" }, [pool], presets).label).toBe(
      "Routine removed"
    );
  });

  it("reads a state with no places or presets loaded as no routine rather than failing", () => {
    expect(routineProvenance({ routineSource: "inherit", locationId: "pool" }).short).toBe("none");
  });
});

describe("cadence wording", () => {
  const start = "2026-08-18";
  it("uses the words a person would, and falls back to days", () => {
    expect(describeCadence({ unit: "days", intervalDays: 1 }, start)).toBe("every day");
    expect(describeCadence({ unit: "days", intervalDays: 7 }, start)).toBe("every week");
    expect(describeCadence({ unit: "days", intervalDays: 14 }, start)).toBe("every fortnight");
    expect(describeCadence({ unit: "days", intervalDays: 10 }, start)).toBe("every 10 days");
  });

  it("describes a weekly rule by its weekdays, Monday first", () => {
    expect(describeCadence({ unit: "weeks", intervalWeeks: 1, weekdays: [2, 4] }, "2026-09-29")).toBe(
      "every week on Tuesday and Thursday"
    );
    expect(describeCadence({ unit: "weeks", intervalWeeks: 2, weekdays: [1, 3, 5] }, "2026-09-28")).toBe(
      "every 2 weeks on Monday, Wednesday and Friday"
    );
    expect(describeCadence({ unit: "weeks", intervalWeeks: 1, weekdays: [3] }, "2026-09-30")).toBe(
      "every week on Wednesday"
    );
    expect(describeCadence({ unit: "weeks", intervalWeeks: 1, weekdays: [0, 6] }, "2026-10-03")).toBe(
      "every week on Saturday and Sunday"
    );
  });

  it("describes a monthly rule by its anchor and count", () => {
    expect(describeCadence({ unit: "months", intervalMonths: 1, anchor: "day_of_month" }, "2026-08-18")).toBe(
      "every month, on the 18th"
    );
    expect(describeCadence({ unit: "months", intervalMonths: 1, anchor: "day_of_month" }, "2026-01-31")).toBe(
      "every month, on the 31st (months without it are skipped)"
    );
    expect(describeCadence({ unit: "months", intervalMonths: 1, anchor: "last_day" }, "2026-01-31")).toBe(
      "every month, on the last day of the month"
    );
    expect(describeCadence({ unit: "months", intervalMonths: 3, anchor: "day_of_month" }, "2026-01-15")).toBe(
      "every 3 months, on the 15th"
    );
  });
});

describe("monthAnchorOptions", () => {
  it("offers only the anchors the start date actually satisfies, each labelled from that date", () => {
    // 2026-01-31 is a Saturday and the 5th one in January, so nth_weekday is excluded (invariant 2).
    const options = monthAnchorOptions("2026-01-31");
    expect(options.map((option) => option.value)).toEqual(["day_of_month", "last_day", "last_weekday"]);
  });

  it("returns nothing for a blank start date", () => {
    expect(monthAnchorOptions("")).toEqual([]);
  });
});
