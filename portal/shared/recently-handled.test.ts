import { describe, expect, it } from "vitest";
import { HANDLED_WINDOW_DAYS, isWithinHandledWindow, newestFirst } from "./recently-handled";

const NOW = Date.parse("2026-08-18T09:00:00.000Z");

describe("isWithinHandledWindow", () => {
  it("keeps the last seven days and nothing older", () => {
    expect(HANDLED_WINDOW_DAYS).toBe(7);
    expect(isWithinHandledWindow("2026-08-11T09:00:00.000Z", NOW)).toBe(true);
    expect(isWithinHandledWindow("2026-08-11T08:59:59.000Z", NOW)).toBe(false);
  });

  it("does not count a missing or unreadable instant", () => {
    expect(isWithinHandledWindow(null, NOW)).toBe(false);
    expect(isWithinHandledWindow("not a date", NOW)).toBe(false);
  });
});

describe("newestFirst", () => {
  it("sorts a copy by instant, newest first", () => {
    const rows = [
      { id: "a", title: "", detail: "", outcome: "", at: "2026-08-01T00:00:00.000Z" },
      { id: "b", title: "", detail: "", outcome: "", at: "2026-08-02T00:00:00.000Z" }
    ];
    expect(newestFirst(rows).map((row) => row.id)).toEqual(["b", "a"]);
    expect(rows[0]!.id).toBe("a");
  });
});
