import { describe, expect, it } from "vitest";
import { planningEntityCommandSchema } from "./commands.js";
import { spanEntitySchema, spanRemoveEntitySchema, spanWireSchema, spanWindowSchema } from "./span.js";

const base = { title: "Trip 1", startDate: "2026-09-27", endDate: "2026-09-29" };

describe("spanEntitySchema", () => {
  it("accepts a block of days with no window and no project", () => {
    expect(spanEntitySchema.parse(base)).toEqual(base);
  });

  it("accepts a one-day span, a clock window and a project link", () => {
    const parsed = spanEntitySchema.parse({
      ...base,
      endDate: "2026-09-27",
      window: { localStartTime: "09:00", localEndTime: "17:30" },
      projectId: "project-1"
    });
    expect(parsed.window).toEqual({ localStartTime: "09:00", localEndTime: "17:30" });
  });

  it("refuses an end date before the start date", () => {
    const result = spanEntitySchema.safeParse({ ...base, endDate: "2026-09-26" });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["endDate"]);
  });

  it("refuses dates that are not real calendar days", () => {
    expect(spanEntitySchema.safeParse({ ...base, startDate: "2026-09-31" }).success).toBe(false);
    expect(spanEntitySchema.safeParse({ ...base, startDate: "27/09/2026" }).success).toBe(false);
    expect(spanEntitySchema.safeParse({ ...base, endDate: "2026-09-29T10:00:00Z" }).success).toBe(false);
  });

  it("refuses a blank title", () => {
    expect(spanEntitySchema.safeParse({ ...base, title: "   " }).success).toBe(false);
  });
});

describe("spanWindowSchema", () => {
  it("refuses anchors other than a clock time, including wake and sleep_start", () => {
    for (const anchor of ["wake", "sleep_start", "local_time"])
      expect(spanWindowSchema.safeParse({ anchor, localStartTime: "09:00", localEndTime: "10:00" }).success).toBe(
        false
      );
    expect(spanWindowSchema.safeParse({ startOffsetMinutes: 0, endOffsetMinutes: 60 }).success).toBe(false);
  });

  it("refuses malformed or non-increasing times", () => {
    expect(spanWindowSchema.safeParse({ localStartTime: "9:00", localEndTime: "10:00" }).success).toBe(false);
    expect(spanWindowSchema.safeParse({ localStartTime: "09:00", localEndTime: "24:00" }).success).toBe(false);
    expect(spanWindowSchema.safeParse({ localStartTime: "10:00", localEndTime: "10:00" }).success).toBe(false);
    expect(spanWindowSchema.safeParse({ localStartTime: "11:00", localEndTime: "10:00" }).success).toBe(false);
  });
});

describe("span as a save_entity command", () => {
  it("is a valid entity type", () => {
    const command = {
      commandId: "11111111-1111-4111-8111-111111111111",
      expectedVersion: null,
      type: "save_entity",
      entityType: "span",
      entity: base
    };
    expect(planningEntityCommandSchema.safeParse(command).success).toBe(true);
  });

  it("removes by id", () => {
    expect(spanRemoveEntitySchema.safeParse({ id: "abc", remove: true }).success).toBe(true);
    expect(spanRemoveEntitySchema.safeParse({ id: "abc" }).success).toBe(false);
  });
});

describe("spanWireSchema", () => {
  it("carries version and an optional window", () => {
    expect(spanWireSchema.parse({ id: "s", version: 2, ...base }).version).toBe(2);
    expect(spanWireSchema.safeParse({ id: "s", ...base, endDate: "2026-09-01" }).success).toBe(false);
  });
});
