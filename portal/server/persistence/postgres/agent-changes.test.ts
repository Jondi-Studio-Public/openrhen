import { describe, expect, it } from "vitest";
import { formatCursor, ledgerLabel, parseCursor, sortTime } from "./agent-changes";

describe("the Agent changes cursor", () => {
  it("keeps microseconds from a UTC time and pads shorter fractions", () => {
    expect(sortTime("2026-10-28T01:02:03.123456Z")).toBe("2026-10-28T01:02:03.123456Z");
    expect(sortTime("2026-10-28T01:02:03.5Z")).toBe("2026-10-28T01:02:03.500000Z");
    expect(sortTime("2026-10-28T01:02:03Z")).toBe("2026-10-28T01:02:03.000000Z");
    expect(sortTime("2026-10-28T11:02:03.250+10:00")).toBe("2026-10-28T01:02:03.250000Z");
    expect(sortTime("not a time")).toBe("1970-01-01T00:00:00.000000Z");
  });

  it("sorts as text in time order", () => {
    const times = ["2026-10-28T01:02:03.000001Z", "2026-10-28T01:02:03.0009Z", "2026-10-28T01:02:03Z"].map(sortTime);
    expect([...times].sort()).toEqual([times[2], times[0], times[1]]);
  });

  it("round-trips, and refuses what is not <time>|<id>", () => {
    const cursor = { at: "2026-10-28T01:02:03.123456Z", id: "0b1c2d3e-0000-4000-8000-000000000001" };
    expect(parseCursor(formatCursor(cursor))).toEqual(cursor);
    for (const bad of [
      "",
      "x",
      "|abc",
      "2026-10-28T01:02:03Z|",
      "yesterday|abc",
      "2026-10-28T01:02:03Z|a b",
      "2026-10-28T01:02:03Z|a|b"
    ])
      expect(parseCursor(bad), bad).toBeNull();
  });
});

describe("ledgerLabel", () => {
  const base = {
    commandType: "save_action",
    members: null,
    entityType: "action",
    operation: "save",
    rows: 1,
    title: "Call mum"
  };
  it("reads a save as what its images show", () => {
    expect(ledgerLabel({ ...base, beforeType: "null", afterType: "object" })).toBe('create action "Call mum"');
    expect(ledgerLabel({ ...base, beforeType: "object", afterType: "null" })).toBe('delete action "Call mum"');
    expect(ledgerLabel({ ...base, beforeType: "object", afterType: "object" })).toBe('update action "Call mum"');
    expect(ledgerLabel(base)).toBe('save action "Call mum"');
  });
  it("keeps another operation, counts further rows, and falls back to the command type", () => {
    expect(
      ledgerLabel({ ...base, entityType: "commitment_recurrence_rule", operation: "finish", title: null, rows: 3 })
    ).toBe("finish commitment recurrence rule and 2 more");
    expect(ledgerLabel({ ...base, entityType: null, operation: null, rows: 0 })).toBe("save action");
  });
  it("names a changeset by its size", () => {
    expect(ledgerLabel({ ...base, commandType: "changeset", members: 2 })).toBe("changeset of 2 writes");
    expect(ledgerLabel({ ...base, commandType: "changeset", members: 1 })).toBe("changeset of 1 write");
  });
});
