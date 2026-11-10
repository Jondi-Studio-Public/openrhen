import { describe, expect, it } from "vitest";
import { suggestDeadlineAction } from "../../src/scheduling/deadline-suggestions.js";
import type { DeadlineSuggestionInput } from "../../src/scheduling/deadline-suggestions.js";
import type { ForecastIntervention } from "../../src/model/types.js";

const now = new Date("2026-09-05T09:00:00.000Z");
const laterToday = new Date("2026-09-05T12:20:00.000Z");
const tomorrow = new Date("2026-09-06T12:20:00.000Z");
const past = new Date("2026-09-05T07:00:00.000Z");
const deadline = new Date("2026-09-12T09:00:00.000Z");
const extended = new Date("2026-09-14T09:00:00.000Z");

const addTime: ForecastIntervention = { kind: "add_time", actionIds: [], minutes: 90, reason: "x" };
const splitWork: ForecastIntervention = {
  kind: "split_work",
  actionIds: ["a"],
  minutes: 60,
  shape: "whole",
  reason: "x"
};
const clarify: ForecastIntervention = { kind: "clarify_estimate", actionIds: ["a"], minutes: 30, reason: "x" };
const moveDeadline: ForecastIntervention = {
  kind: "move_deadline",
  actionIds: [],
  minutes: 90,
  proposedDeadlineAt: extended,
  reason: "x"
};
const requestExtension: ForecastIntervention = {
  kind: "request_extension",
  actionIds: [],
  minutes: 90,
  proposedDeadlineAt: extended,
  reason: "x"
};

function input(overrides: Partial<DeadlineSuggestionInput> = {}): DeadlineSuggestionInput {
  return {
    verdict: "behind",
    deadlineSource: "internal",
    deadlineAt: deadline,
    slackMinutes: -90,
    latestSafeStart: laterToday,
    interventions: [],
    now,
    timezone: "UTC",
    locale: "en-GB",
    ...overrides
  };
}

describe("suggestDeadlineAction", () => {
  it("says nothing for a project that is on track or has no verdict worth a suggestion", () => {
    expect(suggestDeadlineAction(input({ verdict: "ok" }))).toBeNull();
  });

  it("leads with the latest safe start when it is still ahead, naming the time and the consequence", () => {
    const line = suggestDeadlineAction(input({ verdict: "tight", slackMinutes: 20 }));
    expect(line).toContain("Start by 12:20");
    expect(line).toContain("or this deadline becomes unreachable");
  });

  it("names the day when the latest safe start is not today", () => {
    const line = suggestDeadlineAction(input({ verdict: "tight", slackMinutes: 20, latestSafeStart: tomorrow }));
    expect(line).toMatch(/Start by Sun 6 Sept, 12:20/);
  });

  it("adds the missing minutes to the start-by line when an add_time intervention exists", () => {
    const line = suggestDeadlineAction(input({ interventions: [addTime, moveDeadline] }))!;
    expect(line).toContain("Start by 12:20");
    expect(line).toContain("1h 30m");
    expect(line).toMatch(/set aside|free up/);
  });

  it("does not claim a start rescues a project whose expected work does not fit", () => {
    const line = suggestDeadlineAction(input({ slackMinutes: -90, interventions: [addTime, moveDeadline] }))!;
    expect(line).toContain("Start by 12:20 at the latest");
    expect(line).toContain("free up about 1h 30m more");
    expect(line).toContain("move your own date");
    expect(line).toContain("short by that much");
    expect(line).not.toContain("or this deadline becomes unreachable");
  });

  it("uses the slack as the shortfall and names an extension for an external date when no add_time was measured", () => {
    const line = suggestDeadlineAction(input({ slackMinutes: -45, deadlineSource: "external" }))!;
    expect(line).toContain("free up about 45m more");
    expect(line).toContain("ask for an extension");
    expect(line).not.toContain("or this deadline becomes unreachable");
  });

  it("keeps the unreachable wording when slack is zero, positive or unknown", () => {
    for (const slackMinutes of [0, 15, null])
      expect(suggestDeadlineAction(input({ verdict: "tight", slackMinutes }))).toContain(
        "or this deadline becomes unreachable"
      );
  });

  it("never suggests spending time once the latest safe start has passed", () => {
    const line = suggestDeadlineAction(input({ latestSafeStart: past, interventions: [addTime, requestExtension] }))!;
    expect(line).not.toMatch(/Start by/);
    expect(line).not.toMatch(/1h 30m (more )?(set aside|free)/);
    expect(line).toContain("extension");
  });

  it("never suggests spending time when no latest safe start is known", () => {
    const line = suggestDeadlineAction(input({ latestSafeStart: null, interventions: [addTime, moveDeadline] }))!;
    expect(line).not.toMatch(/Start by/);
    expect(line).toContain("Move");
  });

  it("ranks splitting work, which spends no time, ahead of renegotiating a date", () => {
    const line = suggestDeadlineAction(input({ latestSafeStart: past, interventions: [splitWork, moveDeadline] }))!;
    expect(line).toMatch(/split/i);
    expect(line).not.toMatch(/extension|Move your/);
  });

  it("ranks narrowing the estimate ahead of renegotiating a date", () => {
    const line = suggestDeadlineAction(
      input({ verdict: "tight", slackMinutes: 10, latestSafeStart: null, interventions: [clarify] })
    )!;
    expect(line).toMatch(/estimate/i);
  });

  it("asks for an extension on an external deadline and moves a self-set one", () => {
    const external = suggestDeadlineAction(
      input({ deadlineSource: "external", latestSafeStart: past, interventions: [addTime, requestExtension] })
    )!;
    expect(external).toContain("Ask for an extension to");
    expect(external).toContain("Mon 14 Sept");
    const internal = suggestDeadlineAction(input({ latestSafeStart: past, interventions: [addTime, moveDeadline] }))!;
    expect(internal).toContain("Move your own date to");
  });

  it("says plainly when the work fits nowhere inside the horizon", () => {
    const none: ForecastIntervention = { ...moveDeadline, proposedDeadlineAt: null };
    const line = suggestDeadlineAction(input({ latestSafeStart: past, interventions: [addTime, none] }))!;
    expect(line).toMatch(/reduce the scope/i);
    expect(line).toMatch(/does not fit|no date/i);
  });

  it("for an overdue project uses the earliest feasible date, or says it fits nowhere", () => {
    const withDate = suggestDeadlineAction(
      input({ verdict: "overdue", latestSafeStart: past, earliestFeasibleAt: extended, deadlineSource: "external" })
    )!;
    expect(withDate).toContain("has passed");
    expect(withDate).toContain("Ask for an extension to Mon 14 Sept");
    const nowhere = suggestDeadlineAction(
      input({ verdict: "overdue", latestSafeStart: null, earliestFeasibleAt: null })
    )!;
    expect(nowhere).toContain("has passed");
    expect(nowhere).toMatch(/reduce the scope/i);
  });

  it("is one sentence-ending line, deterministic, and mentions no ISO timestamp", () => {
    const args = input({ interventions: [addTime, moveDeadline] });
    const a = suggestDeadlineAction(args)!;
    expect(suggestDeadlineAction(args)).toBe(a);
    expect(a).not.toMatch(/\d{4}-\d\d-\d\dT/);
    expect(a).not.toContain("\n");
    expect(a.endsWith(".")).toBe(true);
  });

  it("formats in the given timezone", () => {
    const line = suggestDeadlineAction(input({ timezone: "Australia/Sydney", verdict: "tight", slackMinutes: 5 }))!;
    expect(line).toContain("Start by 22:20");
  });
});
