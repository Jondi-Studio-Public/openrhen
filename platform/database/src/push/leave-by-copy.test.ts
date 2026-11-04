import { describe, expect, it } from "vitest";
import type { LeaveByLeg } from "@openrhen/contracts";
import {
  assumedOriginCopy,
  dueCopy,
  earlierCopy,
  leaveByDedupeKey,
  leaveByTag,
  reminderCopy
} from "./leave-by-copy.js";

/**
 * Exact rendered text for every push/banner copy builder (the leave by push design note, "The prompt
 * rules" decision table). A fixed IANA time zone, not the runner's own, makes the clock rendering
 * stable wherever these run. Regression coverage for the review finding where `dueCopy` was given
 * `leg.leaveBy` (the time to leave) instead of the commitment's own start (the time to arrive by),
 * which rendered "Arrive by 08:00" — the leave-by time — instead of the real arrival time.
 */

const TIME_ZONE = "Australia/Sydney";

function leg(overrides: Partial<LeaveByLeg> = {}): LeaveByLeg {
  return {
    commitmentId: "c1",
    occurrenceStartsAt: "2026-09-26T08:32:00.000Z", // 18:32 AEST — the commitment's own start
    title: "Dentist",
    leaveBy: new Date("2026-09-26T08:00:00.000Z"), // 18:00 AEST — when to leave
    remindAt: new Date("2026-09-26T07:50:00.000Z"),
    typicalMinutes: 22,
    allowingMinutes: 28,
    originAssumed: false,
    phase: "remind",
    ...overrides
  };
}

describe("reminderCopy", () => {
  it("renders the leave-by time and the typical/allowing minutes line", () => {
    expect(reminderCopy(leg(), TIME_ZONE)).toEqual({
      title: "Leave by 18:00 for Dentist",
      body: "usually 22 min, allowing 28"
    });
  });

  it("collapses the minutes line when typical and allowing agree", () => {
    expect(reminderCopy(leg({ typicalMinutes: 28, allowingMinutes: 28 }), TIME_ZONE)).toEqual({
      title: "Leave by 18:00 for Dentist",
      body: "28 min"
    });
  });
});

describe("assumedOriginCopy", () => {
  it("renders the leave-by time and asks to confirm the assumed place", () => {
    expect(assumedOriginCopy(leg(), "home", TIME_ZONE)).toEqual({
      title: "Leave by 18:00 for Dentist",
      body: "Assuming you’re at home. Tap to confirm."
    });
  });

  it("names the assumed place given", () => {
    expect(assumedOriginCopy(leg(), "the office", TIME_ZONE).body).toBe(
      "Assuming you’re at the office. Tap to confirm."
    );
  });
});

describe("earlierCopy", () => {
  it("renders how many minutes earlier, the new leave-by time, and the minutes line", () => {
    expect(earlierCopy(leg(), 7, TIME_ZONE)).toEqual({
      title: "Leave 7 min earlier, by 18:00 for Dentist",
      body: "usually 22 min, allowing 28"
    });
  });
});

describe("dueCopy", () => {
  it("renders the arrival time it is given, not the leg's own leave-by time", () => {
    // The occurrence starts at 18:32 AEST; the leave-by time is 18:00 AEST. These must render
    // differently — the bug this guards against passed `leg.leaveBy` as the arrival time.
    expect(dueCopy(leg(), new Date(leg().occurrenceStartsAt), TIME_ZONE)).toEqual({
      title: "Time to leave for Dentist",
      body: "Arrive by 18:32"
    });
  });

  it("is a pure function of the arriveBy argument, independent of leg.leaveBy", () => {
    const arriveBy = new Date("2026-09-26T10:15:00.000Z"); // 20:15 AEST
    expect(dueCopy(leg(), arriveBy, TIME_ZONE).body).toBe("Arrive by 20:15");
  });
});

describe("leaveByDedupeKey and leaveByTag", () => {
  it("composes the dedupe key from commitment, occurrence and kind", () => {
    expect(leaveByDedupeKey("c1", "2026-09-26T08:32:00.000Z", "lead")).toBe(
      "leave_by:c1:2026-09-26T08:32:00.000Z:lead"
    );
    expect(leaveByDedupeKey("c1", "2026-09-26T08:32:00.000Z", "earlier")).toBe(
      "leave_by:c1:2026-09-26T08:32:00.000Z:earlier"
    );
    expect(leaveByDedupeKey("c1", "2026-09-26T08:32:00.000Z", "due")).toBe("leave_by:c1:2026-09-26T08:32:00.000Z:due");
  });

  it("composes the notification tag from commitment and occurrence only", () => {
    expect(leaveByTag("c1", "2026-09-26T08:32:00.000Z")).toBe("leave-by:c1:2026-09-26T08:32:00.000Z");
  });
});
