import { describe, expect, it } from "vitest";
import { findTitleDuplicate, normalizeTitle, titleSimilarity } from "./title-similarity.js";

describe("normalizeTitle", () => {
  it("lowercases and strips punctuation", () => {
    expect(normalizeTitle("Sports Day — Year 3!")).toBe("sports day year 3");
  });
});

describe("titleSimilarity", () => {
  it("scores near-identical titles high despite stop words", () => {
    expect(titleSimilarity("RSVP for the sports day", "Sports day RSVP")).toBe(1);
  });

  it("scores unrelated titles low", () => {
    expect(titleSimilarity("Dentist appointment", "Sports day")).toBe(0);
  });
});

describe("findTitleDuplicate", () => {
  const existing = [
    { id: 1, title: "School sports day", date: "2026-09-04", kind: "event" },
    { id: 2, title: "Renew car registration", date: null, kind: "deadline" }
  ];

  it("flags a same-date similar title", () => {
    expect(findTitleDuplicate({ title: "Sports Day at school", date: "2026-09-04", kind: "event" }, existing)?.id).toBe(
      1
    );
  });

  it("does not flag the same title on a different date", () => {
    expect(findTitleDuplicate({ title: "School sports day", date: "2026-10-01", kind: "event" }, existing)).toBeNull();
  });

  it("matches undated items only within the same kind", () => {
    expect(findTitleDuplicate({ title: "Car registration renewal", date: null, kind: "deadline" }, existing)?.id).toBe(
      2
    );
    expect(findTitleDuplicate({ title: "Car registration renewal", date: null, kind: "action" }, existing)).toBeNull();
  });

  it("matches when one title contains the other", () => {
    expect(
      findTitleDuplicate(
        { title: "School sports day (bring hat and water)", date: "2026-09-04", kind: "event" },
        existing
      )?.id
    ).toBe(1);
  });

  it("returns null for a clearly new item", () => {
    expect(
      findTitleDuplicate({ title: "Dentist appointment", date: "2026-09-04", kind: "event" }, existing)
    ).toBeNull();
  });
});
