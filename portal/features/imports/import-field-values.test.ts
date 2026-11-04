import { describe, expect, it } from "vitest";
import { derivedField, displayFieldValue, importDefault, userField } from "./import-field-values";

describe("userField", () => {
  it("marks a blank entry missing, in need of review, and as a cell the user touched", () => {
    expect(userField("   ", "title")).toEqual({
      value: null,
      basis: "missing",
      confidence: null,
      evidence: [],
      needsReview: true,
      source: "cell"
    });
  });

  it("marks a typed value as coming from a cell, so an absent column the user fills in is written", () => {
    expect(userField("Draft", "title").source).toBe("cell");
  });

  it("converts numeric fields to numbers and keeps text fields as text", () => {
    expect(userField("45", "expectedMinutes").value).toBe(45);
    expect(userField("45", "title").value).toBe("45");
  });

  it("reads splittable as a boolean and contexts as a trimmed list", () => {
    expect(userField("Yes", "splittable").value).toBe(true);
    expect(userField("no", "splittable").value).toBe(false);
    expect(userField(" home | laptop ||", "contexts").value).toEqual(["home", "laptop"]);
  });

  it("reads every list and pathway field the way its column is read from a file", () => {
    expect(userField("home|quiet", "preferences").value).toEqual(["home", "quiet"]);
    expect(userField("in_person|async", "channels").value).toEqual(["in_person", "async"]);
    expect(userField("desktop+online | college", "requirementPathways").value).toEqual([
      { id: "p1", contextIds: ["desktop", "online"] },
      { id: "p2", contextIds: ["college"] }
    ]);
    expect(userField("desktop+online | laptop", "pathways").value).toEqual([["desktop", "online"], ["laptop"]]);
    expect(userField("14", "intervalDays").value).toBe(14);
  });

  it("records that the user entered the value", () => {
    expect(userField("Draft", "title")).toMatchObject({
      basis: "explicit",
      confidence: "high",
      evidence: ["Entered by user during import review"],
      needsReview: false
    });
  });
});

describe("derivedField", () => {
  it("names the saved location it came from, as a cell the user filled in by choosing the place", () => {
    expect(derivedField(15, "Campus")).toEqual({
      value: 15,
      basis: "default",
      confidence: "high",
      evidence: ["Applied from saved location Campus"],
      needsReview: false,
      source: "cell"
    });
  });
});

describe("displayFieldValue", () => {
  it("joins lists, blanks null, and stringifies everything else", () => {
    expect(displayFieldValue(["home", "laptop"])).toBe("home|laptop");
    expect(displayFieldValue(null)).toBe("");
    expect(displayFieldValue(undefined)).toBe("");
    expect(displayFieldValue(3)).toBe("3");
  });

  it("writes pathway routes back in the syntax the sheet uses, so an edit round-trips", () => {
    expect(
      displayFieldValue([
        { id: "p1", contextIds: ["desktop", "online"] },
        { id: "p2", contextIds: ["college"] }
      ])
    ).toBe("desktop+online | college");
    expect(displayFieldValue([["desktop", "online"], ["laptop"]])).toBe("desktop+online | laptop");
    expect(displayFieldValue([])).toBe("");
  });
});

describe("importDefault", () => {
  it("only offers defaults for fields the review screen can safely invent, per entity", () => {
    expect(importDefault("area", "status")).toBe("active");
    expect(importDefault("deliverable", "status")).toBe("needs_breakdown");
    expect(importDefault("area", "title")).toBeUndefined();
  });
});
