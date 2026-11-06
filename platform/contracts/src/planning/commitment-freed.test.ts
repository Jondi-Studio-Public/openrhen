import { describe, expect, it } from "vitest";
import { commitmentFreedAt } from "./commitment-freed.js";

const NOW = new Date("2026-11-05T02:00:00.000Z");
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

describe("commitmentFreedAt", () => {
  it("is false when the person never said they were free", () => {
    expect(commitmentFreedAt({ now: NOW, effectiveEndsAt: at(60) })).toBe(false);
    expect(commitmentFreedAt({ now: NOW, freedFrom: null, effectiveEndsAt: at(60) })).toBe(false);
  });

  it("holds from the statement until the effective end, and lapses by itself after", () => {
    expect(commitmentFreedAt({ now: NOW, freedFrom: at(-1), effectiveEndsAt: at(60) })).toBe(true);
    expect(commitmentFreedAt({ now: NOW, freedFrom: NOW, effectiveEndsAt: at(60) })).toBe(true);
    expect(commitmentFreedAt({ now: NOW, freedFrom: at(-90), effectiveEndsAt: NOW })).toBe(false);
    expect(commitmentFreedAt({ now: at(1), freedFrom: at(-90), effectiveEndsAt: NOW })).toBe(false);
  });

  it("is not yet in force before the statement", () => {
    expect(commitmentFreedAt({ now: NOW, freedFrom: at(5), effectiveEndsAt: at(60) })).toBe(false);
  });

  it("accepts ISO strings", () => {
    expect(
      commitmentFreedAt({
        now: NOW.toISOString(),
        freedFrom: at(-1).toISOString(),
        effectiveEndsAt: at(60).toISOString()
      })
    ).toBe(true);
  });
});
