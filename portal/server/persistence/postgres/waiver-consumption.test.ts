import { describe, expect, it } from "vitest";
import { consumedWaiverIds } from "./waiver-consumption";

const waiver = { people: ["pete"], setAt: "2026-11-02T01:00:00.000Z", until: "2026-11-09T01:00:00.000Z" };

describe("consumedWaiverIds", () => {
  it("keeps a waiver until the work is completed after it was said", () => {
    const waivers = { a: waiver };
    expect(consumedWaiverIds(waivers, new Map())).toEqual([]);
    expect(consumedWaiverIds(waivers, new Map([["a", { lastCompletedAt: null }]]))).toEqual([]);
    expect(consumedWaiverIds(waivers, new Map([["a", { lastCompletedAt: "2026-11-01T00:00:00.000Z" }]]))).toEqual([]);
  });

  it("is used up by a completion after it, so the next occurrence is held again", () => {
    const completions = new Map([["a", { lastCompletedAt: "2026-11-02T05:00:00.000Z" }]]);
    expect(consumedWaiverIds({ a: waiver, b: waiver }, completions)).toEqual(["a"]);
  });
});
