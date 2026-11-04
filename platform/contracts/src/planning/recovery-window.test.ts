import { describe, expect, it } from "vitest";
import { recoveryOccurrence } from "./recovery-window.js";

// 2026-08-14 is a Friday, 2026-08-15 a Saturday.
const overnight = { startTime: "23:00", endTime: "06:00" };
describe("recoveryOccurrence", () => {
  it("shows the overnight window all evening, as upcoming then running", () => {
    const base = { ...overnight, weekdays: [5], localDate: "2026-08-14" };
    expect(recoveryOccurrence({ ...base, clock: "20:00" })).toEqual({ startDate: "2026-08-14", running: false });
    expect(recoveryOccurrence({ ...base, clock: "23:00" })).toEqual({ startDate: "2026-08-14", running: true });
  });

  it("names yesterday as the start date after midnight, even for a Friday-only window", () => {
    const base = { ...overnight, weekdays: [5], localDate: "2026-08-15" };
    expect(recoveryOccurrence({ ...base, clock: "05:00" })).toEqual({ startDate: "2026-08-14", running: true });
    expect(recoveryOccurrence({ ...base, clock: "06:00" })).toBeNull();
    expect(recoveryOccurrence({ ...base, clock: "23:30" })).toBeNull();
  });

  it("keeps a same-day window to its own day", () => {
    const base = { startTime: "14:00", endTime: "15:00", weekdays: [5], localDate: "2026-08-14" };
    expect(recoveryOccurrence({ ...base, clock: "09:00" })).toEqual({ startDate: "2026-08-14", running: false });
    expect(recoveryOccurrence({ ...base, clock: "14:30" })).toEqual({ startDate: "2026-08-14", running: true });
    expect(recoveryOccurrence({ ...base, clock: "15:00" })).toBeNull();
    expect(recoveryOccurrence({ ...base, clock: "01:00", localDate: "2026-08-15" })).toBeNull();
  });
});
