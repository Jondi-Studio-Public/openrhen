import { describe, expect, it } from "vitest";
import {
  basisText,
  detailIdFor,
  fieldLabel,
  orderedFields,
  planEffectItems,
  planEffectLine,
  readableLabel,
  rowHeading,
  valueText,
  type AgentChange,
  type AgentChangePlanEffect
} from "./agent-change-view";

const TZ = "Australia/Brisbane";
const change: AgentChange = { agent: "a", id: "e1", at: "2026-10-27T05:00:00.000Z", label: "x", status: "applied" };
const plan = (extra: Partial<AgentChangePlanEffect> = {}): AgentChangePlanEffect => ({
  available: true,
  dayKey: "2026-10-27",
  moved: [],
  added: [],
  dropped: [],
  sleepShiftMinutes: 0,
  ...extra
});

describe("detailIdFor", () => {
  it("uses the row's write id, even when it is null", () => {
    expect(detailIdFor({ ...change, writeId: "w1" })).toBe("w1");
    expect(detailIdFor({ ...change, writeId: null, target: { stateKey: "revert", id: "c" } })).toBeNull();
  });

  it("falls back to a server-checked entry's command id, and to nothing otherwise", () => {
    expect(detailIdFor({ ...change, target: { stateKey: "revert", id: "c" } })).toBe("c");
    expect(detailIdFor({ ...change, target: { stateKey: "actions", id: "a1" } })).toBeNull();
    expect(detailIdFor(change)).toBeNull();
  });
});

describe("readableLabel", () => {
  it("drops a bracketed id and names a bare one as a record", () => {
    expect(readableLabel('update commitment "Spin class" (a6c70f15-f1cb-4d57-ba41-af6d5664f003)')).toBe(
      'Update commitment "Spin class"'
    );
    expect(readableLabel('confirm capture as fixed_commitment "Swim"')).toBe('Confirm capture as commitment "Swim"');
    expect(readableLabel("start a session on 52c77b18-1111-4d57-ba41-af6d5664f003")).toBe(
      "Start a session on a record"
    );
  });
});

describe("orderedFields", () => {
  it("puts start before end and keeps the rest in order", () => {
    const fields = ["importance", "ends_at", "notes", "starts_at"].map((field) => ({ field }));
    expect(orderedFields(fields).map((item) => item.field)).toEqual(["starts_at", "ends_at", "importance", "notes"]);
  });
});

describe("fieldLabel and valueText", () => {
  it("words known and unknown columns", () => {
    expect(fieldLabel("starts_at")).toBe("Starts");
    expect(fieldLabel("remaining_minutes")).toBe("Minutes left");
    expect(fieldLabel("energy_level")).toBe("Energy level");
    expect(fieldLabel("sessionBreakMinutes")).toBe("Session break minutes");
  });

  it("shows times in the person's zone and empties as none", () => {
    expect(valueText("2026-10-27T08:30:00.000Z", TZ)).toBe("Tue, 27 Oct at 6:30 pm");
    expect(valueText(null, TZ)).toBe("none");
    expect(valueText(true, TZ)).toBe("yes");
    expect(valueText(["a", "b"], TZ)).toBe("a, b");
    expect(valueText({ title: "x", project_id: "52c77b18-1111-4d57-ba41-af6d5664f003" }, TZ)).toBe("Title x; Project");
    expect(valueText("see 52c77b18-1111-4d57-ba41-af6d5664f003", TZ)).toBe("see a record");
    expect(fieldLabel("project_id")).toBe("Project");
    expect(fieldLabel("areaId")).toBe("Area");
    expect(valueText("in_person", TZ)).toBe("in person");
    expect(valueText("fixed_commitment", TZ)).toBe("commitment");
    expect(valueText({ text: "", areaId: null, title: "Swim", notes: [] }, TZ)).toBe("Title Swim");
    expect(
      valueText(
        { title: "Swim", energy: "low", ends_at: "2026-10-27T08:30:00.000Z", kind: "one_off", area: { id: 1 } },
        TZ
      )
    ).toBe("Title Swim; Energy low; Ends Tue, 27 Oct at 6:30 pm; Kind one-off; and 1 more");
  });
});

describe("rowHeading and basisText", () => {
  it("says what happened to which kind of record", () => {
    expect(rowHeading({ operation: "update", entityType: "commitment" })).toBe("Changed the commitment");
    expect(rowHeading({ operation: "create", entityType: "commitments" })).toBe("Added the commitment");
    expect(rowHeading({ operation: "create", entityType: "sessions" })).toBe("Added the session");
    expect(rowHeading({ operation: "save", entityType: "capture_review" })).toBe("Changed the Inbox decision");
    expect(rowHeading({ operation: "save", entityType: "settings" })).toBe("Changed settings");
    expect(rowHeading({ operation: "save", entityType: "action" })).toBe("Changed the action");
    expect(
      rowHeading({
        operation: "save",
        entityType: "action",
        fields: [{ field: "title", before: null, after: "Read", afterKnown: true }]
      })
    ).toBe("Added the action");
    expect(rowHeading({ operation: "create", entityType: "actions" }, { undone: true })).toBe(
      "Added, then undone: the action"
    );
    expect(rowHeading({ operation: "save", entityType: "settings" }, { undone: true })).toBe(
      "Changed, then undone: settings"
    );
  });

  it("treats a missing basis as a guess", () => {
    expect(basisText("stated").text).toBe("You said so");
    expect(basisText(null)).toEqual({ text: "No basis given, so a guess", tone: "warn" });
  });
});

describe("planEffectLine and planEffectItems", () => {
  it("says when the old plan is gone or nothing moved", () => {
    expect(planEffectLine(plan({ available: false, reason: "pruned" }))).toMatch(/no longer kept/);
    expect(planEffectLine(plan({ available: false, reason: "pending" }))).toBe(
      "The plan hasn't been recalculated since this change yet."
    );
    expect(planEffectLine(plan({ available: false }))).toBe("Its effect on the plan can't be shown.");
    expect(planEffectLine(plan())).toBe("The plan for that day did not change.");
  });

  it("lists what moved, was added or dropped, and a bedtime shift", () => {
    const effect = plan({
      moved: [
        {
          title: "Gym",
          fromStartsAt: "2026-10-27T09:00:00.000Z",
          toStartsAt: "2026-10-27T09:30:00.000Z",
          deltaMinutes: 30
        }
      ],
      added: [{ title: "Read", startsAt: "2026-10-27T10:00:00.000Z" }],
      sleepShiftMinutes: -20
    });
    expect(planEffectLine(effect)).toBe(
      "The plan moved 1 block, added 1 block and moved bedtime 20 min earlier that day."
    );
    expect(planEffectItems(effect, TZ)).toEqual(["Gym: 7:00 pm → 7:30 pm", "Read: added at 8:00 pm"]);
  });
});
