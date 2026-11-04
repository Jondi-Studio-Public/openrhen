import { describe, expect, it } from "vitest";
import { PlanSearchInputError, documentText, fuse, noHitNote, parseKinds, wordQueryOf } from "./plan-search";

describe("plan search helpers", () => {
  it("fuses by reciprocal rank, so agreement beats one list's top pick", () => {
    const fused = fuse(["a", "b", "c"], ["b", "d"]);
    expect(fused.map((hit) => hit.key)).toEqual(["b", "a", "d", "c"]);
    expect(fused[0]!.score).toBeCloseTo(1 / 62 + 1 / 61);
    expect(fuse([], [])).toEqual([]);
  });

  it("reads a quoted query as a phrase and anything else as words", () => {
    expect(wordQueryOf('  "network design"  ')).toEqual({ text: "network design", phrase: true });
    expect(wordQueryOf('network "design"')).toEqual({ text: 'network "design"', phrase: false });
  });

  it("takes kinds singular, plural or by alias, and refuses the rest", () => {
    expect(parseKinds("actions, project,routine-steps,places,tasks")).toEqual([
      "action",
      "project",
      "routine-step",
      "condition",
      "action"
    ]);
    expect(() => parseKinds("sessions")).toThrow(PlanSearchInputError);
  });

  it("reads people, contacts and kids as condition records, where contacts live", () => {
    expect(parseKinds("person,people,contacts,kid")).toEqual(["condition", "condition", "condition", "condition"]);
  });

  it("explains an empty result: what was searched, whole-word matching, and the next calls", () => {
    const note = noHitNote({ kinds: ["action"], status: "open" });
    expect(note).toContain("No records matched");
    expect(note).toContain("whole words");
    expect(note).toContain("kinds: action");
    expect(note).toContain('"status": "any"');
    expect(note).toContain("rhen_list");
    expect(noHitNote({ status: "any" })).toContain("every kind");
    expect(noHitNote({ status: "any" })).not.toContain('"status": "any"');
  });

  it("embeds title, path and body, capped", () => {
    expect(documentText({ title: "Book dentist", path: "Health", body: " " })).toBe("Book dentist. Health");
    expect(documentText({ title: "x", path: "", body: "y".repeat(900) })).toHaveLength(500);
  });
});
