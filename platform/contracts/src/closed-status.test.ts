import { describe, expect, it } from "vitest";
import { CLOSED_STATUSES, CLOSED_TABLES, HIDING_STATUS, isClosedStatus } from "./closed-status.js";

describe("closed statuses", () => {
  it("is archived and cancelled only; finished work is not closed", () => {
    expect([...CLOSED_STATUSES].sort()).toEqual(["archived", "cancelled"]);
    for (const open of ["done", "completed", "active", "paused", "planned", "confirmed", "ignored"])
      expect(isClosedStatus(open)).toBe(false);
    expect(isClosedStatus("archived")).toBe(true);
    expect(isClosedStatus("cancelled")).toBe(true);
    expect(isClosedStatus(null)).toBe(false);
    expect(isClosedStatus(undefined)).toBe(false);
  });

  it("lists the per-table closed values and restore defaults", () => {
    expect(CLOSED_TABLES.commitments.closed).toEqual(["cancelled"]);
    expect(CLOSED_TABLES.routine_presets.closed).toEqual(["archived"]);
    expect(CLOSED_TABLES.condition_definitions.closed).toEqual(["archived"]);
    expect(CLOSED_TABLES.actions.restoreDefault).toBe("planned");
    expect(CLOSED_TABLES.deliverables.restoreDefault).toBe("ready");
    expect(CLOSED_TABLES.commitments.restoreDefault).toBe("confirmed");
    for (const rule of Object.values(CLOSED_TABLES)) {
      for (const status of rule.closed) expect(isClosedStatus(status)).toBe(true);
      expect(isClosedStatus(rule.restoreDefault)).toBe(false);
    }
  });

  it("hides every record by a status the table counts as closed (a capture is ignored)", () => {
    for (const [type, status] of Object.entries(HIDING_STATUS)) {
      if (type === "capture") expect(status).toBe("ignored");
      else expect(isClosedStatus(status)).toBe(true);
    }
  });
});
