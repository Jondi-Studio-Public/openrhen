import { describe, expect, it } from "vitest";
import { canSnooze, snoozeOptions, snoozeRefusal, snoozeSubject, startOfLocalDay } from "./snooze";

const tz = "America/New_York";

describe("snoozeOptions", () => {
  it("offers later today, tomorrow and next week, anchored to the plan zone", () => {
    // 10:07 am in New York.
    const options = snoozeOptions(new Date("2026-11-04T15:07:00.000Z"), tz);
    expect(options.map((option) => option.label)).toEqual(["Later today", "Tomorrow", "Next week"]);
    // Three hours on, rounded up to the next quarter hour: 1:15 pm.
    expect(options[0]!.at.toISOString()).toBe("2026-11-04T18:15:00.000Z");
    // The start of Thursday 5 Nov, New York.
    expect(options[1]!.at.toISOString()).toBe("2026-11-05T05:00:00.000Z");
    // The start of Monday 9 Nov.
    expect(options[2]!.at.toISOString()).toBe("2026-11-09T05:00:00.000Z");
  });

  it("drops Later today when it would run past the evening or into tomorrow", () => {
    const late = snoozeOptions(new Date("2026-11-05T01:30:00.000Z"), tz); // 8:30 pm Wednesday
    expect(late.map((option) => option.label)).toEqual(["Tomorrow", "Next week"]);
  });

  it("reads tomorrow in the plan zone, not UTC", () => {
    // 9 pm Tuesday in New York is already Wednesday in UTC; tomorrow is still Wednesday 4 Nov.
    const options = snoozeOptions(new Date("2026-11-04T02:00:00.000Z"), tz);
    expect(options.find((option) => option.label === "Tomorrow")!.at.toISOString()).toBe("2026-11-04T05:00:00.000Z");
  });

  it("makes next week the following Monday, even on a Sunday", () => {
    const options = snoozeOptions(new Date("2026-11-08T15:00:00.000Z"), tz); // Sunday
    expect(options.find((option) => option.label === "Next week")!.at.toISOString()).toBe("2026-11-09T05:00:00.000Z");
  });
});

describe("startOfLocalDay", () => {
  it("is local midnight in the zone for a picked day", () => {
    expect(startOfLocalDay("2026-11-12", tz).toISOString()).toBe("2026-11-12T05:00:00.000Z");
  });
});

describe("snoozeRefusal", () => {
  const at = new Date("2026-11-12T05:00:00.000Z");
  it("allows a date before the latest start and the external deadline", () => {
    expect(snoozeRefusal({ externalDeadlineAt: "2026-11-20T05:00:00.000Z" }, at, tz)).toBeNull();
    expect(snoozeRefusal({}, at, tz)).toBeNull();
  });
  it("refuses a date after the latest safe start", () => {
    expect(snoozeRefusal({ latestStartAt: "2026-11-11T15:00:00.000Z" }, at, tz)).toMatch(/latest safe start/i);
  });
  it("refuses a date after the external deadline", () => {
    expect(snoozeRefusal({ externalDeadlineAt: "2026-11-10T15:00:00.000Z" }, at, tz)).toMatch(/deadline/i);
  });
  it("does not pull an existing later availableFrom earlier", () => {
    expect(snoozeRefusal({ availableFrom: "2026-11-15T05:00:00.000Z" }, at, tz)).toMatch(/already put off/i);
    expect(snoozeRefusal({ availableFrom: "2026-11-12T05:00:00.000Z" }, at, tz)).toBeNull();
  });
});

describe("snoozeSubject", () => {
  const projects = [{ id: "p1", externalDeadlineAt: "2026-11-13T22:00:00.000Z" }, { id: "p2" }];
  const action = { projectId: "p1", deadlineAt: "2026-10-31T22:00:00.000Z", latestStartAt: "2026-11-12T15:00:00.000Z" };
  const at = new Date("2026-11-12T05:00:00.000Z");

  it("guards on the project's external deadline, not the action's own passed target", () => {
    const subject = snoozeSubject(action, projects);
    expect(subject.externalDeadlineAt).toBe("2026-11-13T22:00:00.000Z");
    expect(snoozeRefusal(subject, at, tz)).toBeNull();
  });
  it("refuses a date past the external deadline, even with the own target long gone", () => {
    const subject = snoozeSubject({ ...action, latestStartAt: undefined }, projects);
    expect(snoozeRefusal(subject, new Date("2026-11-14T05:00:00.000Z"), tz)).toMatch(/deadline/i);
  });
  it("has no deadline guard for a project without an external deadline", () => {
    const subject = snoozeSubject({ projectId: "p2" }, projects);
    expect(snoozeRefusal(subject, at, tz)).toBeNull();
  });
});

describe("canSnooze", () => {
  it("is only for one-off actions, since snoozing a series would hold back every later occurrence", () => {
    expect(canSnooze({ schedulingMode: "one_off" })).toBe(true);
    expect(canSnooze({})).toBe(true);
    expect(canSnooze({ schedulingMode: "recurring" })).toBe(false);
    expect(canSnooze({ schedulingMode: "cadence" })).toBe(false);
    expect(canSnooze({ schedulingMode: "one_off", occurrenceId: "o1" })).toBe(false);
  });
});
