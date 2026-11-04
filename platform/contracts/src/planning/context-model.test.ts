import { describe, expect, it } from "vitest";
import { currentSituationSchema, stretchStateSchema } from "./context-model.js";

describe("currentSituationSchema stretch", () => {
  const record = {
    actionId: "a1",
    title: "Unit 3",
    acceptedAt: "2026-08-18T10:00:00.000Z",
    until: "2026-08-18T10:40:00.000Z",
    minutes: 40,
    by: "person"
  };

  it("parses a situation with and without stretch", () => {
    expect(currentSituationSchema.parse({}).stretch).toBeUndefined();
    expect(currentSituationSchema.parse({ stretch: {} }).stretch).toEqual({ accepted: [], declined: [] });
    expect(currentSituationSchema.parse({ stretch: { accepted: [record] } }).stretch?.accepted).toEqual([record]);
  });

  it("rejects bad records and over-long lists", () => {
    expect(stretchStateSchema.safeParse({ accepted: [{ ...record, minutes: 0 }] }).success).toBe(false);
    expect(stretchStateSchema.safeParse({ accepted: [{ ...record, by: "robot" }] }).success).toBe(false);
    expect(stretchStateSchema.safeParse({ accepted: Array(31).fill(record) }).success).toBe(false);
    expect(
      stretchStateSchema.safeParse({ declined: Array(51).fill({ actionId: "a", at: record.acceptedAt }) }).success
    ).toBe(false);
  });
});
