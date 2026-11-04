import { describe, expect, it } from "vitest";
import { saveActionCommandSchema } from "./planning/commands.js";
import { offsetDateTimeMessage } from "./iso-datetime.js";
import { renderFlagsForMcp, renderCommandsForMcp } from "./agent-surface.js";

describe("date-time and estimate messages an agent reads (F1, F5)", () => {
  const action = {
    id: "a1",
    projectId: "p1",
    title: "x",
    status: "planned",
    optimisticMinutes: 30,
    expectedMinutes: 45,
    pessimisticMinutes: 60,
    remainingMinutes: 30,
    energy: "medium",
    minimumSessionMinutes: 15,
    maximumSessionMinutes: 60,
    splittable: true,
    setupMinutes: 0,
    importance: 3,
    consequence: 3,
    contexts: [],
    dependencyIds: []
  };
  const issues = (patch: Record<string, unknown>) =>
    saveActionCommandSchema.safeParse({ expectedVersion: null, action: { ...action, ...patch } }).error?.issues ?? [];

  it("F1: names the value, the format with an example, status.now and asking when ambiguous, with no regex", () => {
    const [issue] = issues({ deadlineAt: "next Friday" });
    expect(issue?.path).toEqual(["action", "deadlineAt"]);
    expect(issue?.message).toBe(offsetDateTimeMessage("next Friday"));
    expect(issue?.message).toContain('"next Friday"');
    expect(issue?.message).toContain("ISO 8601 date-time with the owner's UTC offset");
    expect(issue?.message).toContain("2026-11-13T17:00:00-05:00");
    expect(issue?.message).toContain("status.now");
    expect(issue?.message).toContain("ask the owner which");
    expect(issue?.message).not.toMatch(/\^|\\d/);
  });

  it("F1: a valid offset date-time passes", () => {
    expect(issues({ deadlineAt: "2026-11-13T17:00:00-05:00" })).toEqual([]);
  });

  it("F5: out-of-order estimates name expectedMinutes, all three values, and say to send the three together", () => {
    const [issue] = issues({ expectedMinutes: 90, pessimisticMinutes: 60 });
    expect(issue?.path).toEqual(["action", "expectedMinutes"]);
    expect(issue?.message).toContain("optimisticMinutes 30, expectedMinutes 90 and pessimisticMinutes 60");
    expect(issue?.message).toContain("send optimisticMinutes, expectedMinutes and pessimisticMinutes together");
    expect(issue?.message).toContain("for example 30, 60, 90");
  });
});

describe("renderFlagsForMcp (F7)", () => {
  it("turns --create into create: true and any other flag into the argument name", () => {
    expect(renderFlagsForMcp("or pass --create to create one, with --minutes 5 and --expected-version 2")).toBe(
      'or pass "create": true to create one, with "minutes" 5 and "expected-version" 2'
    );
  });

  it("leaves the owner's own terminal commands as written", () => {
    const text = "run `rhen agent-token create --name bot --scopes read:plan` then pass --create";
    expect(renderFlagsForMcp(text)).toBe(
      'run `rhen agent-token create --name bot --scopes read:plan` then pass "create": true'
    );
  });

  it("leaves a dash inside a word alone", () => {
    expect(renderFlagsForMcp("a re--entry and x--y")).toBe("a re--entry and x--y");
  });

  it("renders a quoted shell hint as a call: list places", () => {
    expect(renderCommandsForMcp("To list saved places, run `rhen list places`.")).toBe(
      'To list saved places, call rhen_list {"entity":"places"}.'
    );
  });
});
