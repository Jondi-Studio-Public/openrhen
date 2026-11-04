import { describe, expect, it } from "vitest";
import { importBasisHint, importBasisLabel, importFieldLabel, plainFieldMessage } from "./import-field-labels";

describe("importFieldLabel", () => {
  it("reads a time column as the event itself", () => {
    expect(importFieldLabel("endsAt")).toBe("Ends");
    expect(importFieldLabel("startsAt")).toBe("Starts");
  });

  it("spells out the buffer columns with their unit", () => {
    expect(importFieldLabel("setupBeforeMinutes")).toBe("Setup time before (min)");
    expect(importFieldLabel("transitionAfterMinutes")).toBe("Wind-down time after (min)");
    expect(importFieldLabel("expectedMinutes")).toBe("Expected (min)");
  });

  it("splits any other camelCase name into words and leaves a plain one alone", () => {
    expect(importFieldLabel("dependsOnActionKey")).toBe("Depends on action key");
    expect(importFieldLabel("title")).toBe("Title");
  });
});

describe("importBasisLabel", () => {
  it("says how a value was reached, without repeating full confidence for a given value", () => {
    expect(importBasisLabel({ basis: "explicit", confidence: "high" })).toBe("as given");
    expect(importBasisLabel({ basis: "default", confidence: "high" })).toBe("default used");
    expect(importBasisLabel({ basis: "inferred", confidence: "high" })).toBe("guessed · high confidence");
    expect(importBasisLabel({ basis: "inferred", confidence: "low" })).toBe("guessed · low confidence");
    expect(importBasisLabel({ basis: "missing", confidence: null })).toBe("blank");
  });

  it("keeps the note for a column the file did not carry", () => {
    expect(importBasisLabel({ basis: "missing", confidence: null, source: "absent" })).toBe("not in file · left as is");
    expect(importBasisHint({ basis: "missing", source: "absent" })).toMatch(/no column/);
  });
});

describe("plainFieldMessage", () => {
  it("swaps quoted camelCase column names for their labels", () => {
    expect(plainFieldMessage("setupBeforeMinutes is required.", ["setupBeforeMinutes", "title"])).toBe(
      "Setup time before (min) is required."
    );
    expect(plainFieldMessage("endsAt must be after startsAt.", ["startsAt", "endsAt"])).toBe(
      "Ends must be after starts."
    );
  });

  it("leaves one-word names and unrelated text alone", () => {
    expect(plainFieldMessage("title is required.", ["title"])).toBe("title is required.");
  });

  it("reads a field name from the file as text, not as a pattern", () => {
    expect(() => plainFieldMessage("aB( is required.", ["aB("])).not.toThrow();
    // Unescaped, the dot would also match the "x" in "aBxc".
    const text = plainFieldMessage("aBxc is not aB.c here.", ["aB.c"]);
    expect(text.startsWith("aBxc is not ")).toBe(true);
    expect(text).not.toContain("aB.c");
  });
});
