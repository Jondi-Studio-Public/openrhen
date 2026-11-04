import { ASSUMABLE_ACTION_FIELDS } from "@openrhen/contracts";
import { describe, expect, it } from "vitest";
import {
  assumableColumn,
  assumableValuesOfRow,
  nextAssumedFields,
  pgNameArray,
  type AssumableValues
} from "./assumed-fields";

const values: AssumableValues = {
  optimisticMinutes: 30,
  expectedMinutes: 60,
  pessimisticMinutes: 90,
  remainingMinutes: 60,
  energy: "medium",
  minimumSessionMinutes: 15,
  maximumSessionMinutes: 60,
  importance: 3,
  consequence: 3,
  splittable: true,
  setupMinutes: 0
};

describe("assumableColumn and assumableValuesOfRow", () => {
  it("map each wire name onto its snake_case column", () => {
    expect(ASSUMABLE_ACTION_FIELDS.map(assumableColumn)).toEqual([
      "optimistic_minutes",
      "expected_minutes",
      "pessimistic_minutes",
      "remaining_minutes",
      "energy",
      "minimum_session_minutes",
      "maximum_session_minutes",
      "importance",
      "consequence",
      "splittable",
      "setup_minutes"
    ]);
  });

  it("reads a row's values under the wire names", () => {
    const row = {
      optimistic_minutes: 30,
      expected_minutes: 60,
      pessimistic_minutes: 90,
      remaining_minutes: 60,
      energy: "medium",
      minimum_session_minutes: 15,
      maximum_session_minutes: 60,
      importance: 3,
      consequence: 3,
      splittable: true,
      setup_minutes: 0,
      title: "ignored"
    };
    expect(assumableValuesOfRow(row)).toEqual(values);
  });
});

describe("nextAssumedFields", () => {
  const stored = (assumed: string[], overrides: Partial<AssumableValues> = {}) => ({
    assumed,
    values: { ...values, ...overrides }
  });

  it("stores what the save says, assumable names only, once each, in the canonical order", () => {
    expect(
      nextAssumedFields({
        sent: ["energy", "status", "expectedMinutes", "energy"],
        stored: stored(["importance"]),
        next: values
      })
    ).toEqual(["expectedMinutes", "energy"]);
    expect(nextAssumedFields({ sent: [], stored: stored(["energy"]), next: values })).toEqual([]);
  });

  it("starts a create that says nothing with none assumed", () => {
    expect(nextAssumedFields({ sent: undefined, stored: undefined, next: values })).toEqual([]);
  });

  it("keeps a stored field while its value is unchanged when the save says nothing", () => {
    expect(nextAssumedFields({ sent: undefined, stored: stored(["expectedMinutes", "energy"]), next: values })).toEqual(
      ["expectedMinutes", "energy"]
    );
  });

  it("drops a stored field whose value changed, and only that one", () => {
    expect(
      nextAssumedFields({
        sent: undefined,
        stored: stored(["expectedMinutes", "energy", "splittable"]),
        next: { ...values, expectedMinutes: 45, splittable: false }
      })
    ).toEqual(["energy"]);
  });

  it("does not make an unlisted field assumed because it changed", () => {
    expect(nextAssumedFields({ sent: undefined, stored: stored([]), next: { ...values, importance: 5 } })).toEqual([]);
  });

  it("ignores a stored name that is not an assumable field", () => {
    expect(nextAssumedFields({ sent: undefined, stored: stored(["status", "energy"]), next: values })).toEqual([
      "energy"
    ]);
  });
});

describe("pgNameArray", () => {
  it("writes the assumable names as an array literal, once each in the canonical order, and nothing else", () => {
    expect(pgNameArray(["energy", "expectedMinutes", "energy", "status", "x,y}"])).toBe("{expectedMinutes,energy}");
    expect(pgNameArray([])).toBe("{}");
    expect(pgNameArray(undefined)).toBe("{}");
  });
});
