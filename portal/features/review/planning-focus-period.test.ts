import { describe, expect, it } from "vitest";
import { focusSelection, periodFor, periodLabel } from "@/features/review/planning-focus-period";

describe("planning focus period", () => {
  it("labels a week and a month in words, not ISO dates", () => {
    const now = new Date("2026-10-27T01:00:00.000Z");
    expect(periodLabel("weekly", periodFor("weekly", now, "Australia/Sydney"))).toBe("26 Oct – 1 Nov 2026");
    expect(periodLabel("monthly", periodFor("monthly", now, "Australia/Sydney"))).toBe("October 2026");
  });

  it("keeps only active undated projects in a stored selection", () => {
    const projects = [
      { id: "open", status: "active" },
      { id: "dated", status: "active", internalDeadlineAt: "2026-11-01T00:00:00.000Z" },
      { id: "external", status: "active", externalDeadlineAt: "2026-11-01T00:00:00.000Z" },
      { id: "done", status: "completed" }
    ];
    expect(focusSelection(["open", "dated", "external", "done", "deleted"], projects)).toEqual(["open"]);
  });
});
