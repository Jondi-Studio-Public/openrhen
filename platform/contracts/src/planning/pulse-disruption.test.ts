import { describe, expect, it } from "vitest";
import {
  disruptionDoingText,
  incompleteDisruptionMessage,
  missingCommandDisruptionFields,
  recordDisruptionCommandSchema
} from "./pulse-disruption.js";

const commandId = "9f1c6f0e-2a37-4a8e-8d52-0e1f4a0c7b11";
const complete = {
  doing: "Hospital visit",
  until: "2026-10-28T07:00:00.000Z",
  locationId: "hospital",
  contexts: ["phone"],
  exclusive: true
};

describe("recordDisruptionCommandSchema", () => {
  it("accepts a complete disruption, free text or a target", () => {
    expect(recordDisruptionCommandSchema.safeParse({ commandId, ...complete }).success).toBe(true);
    expect(
      recordDisruptionCommandSchema.safeParse({
        commandId,
        ...complete,
        doing: { kind: "action", id: "a1", title: "Laundry" }
      }).success
    ).toBe(true);
  });

  it("accepts an incomplete one, so the server can name what is missing, and an end", () => {
    expect(recordDisruptionCommandSchema.safeParse({ commandId }).success).toBe(true);
    expect(recordDisruptionCommandSchema.safeParse({ commandId, end: true }).success).toBe(true);
  });

  it("rejects a malformed field and a stated basis without evidence", () => {
    expect(recordDisruptionCommandSchema.safeParse({ commandId, until: "tomorrow" }).success).toBe(false);
    expect(recordDisruptionCommandSchema.safeParse({ commandId, end: false }).success).toBe(false);
    expect(recordDisruptionCommandSchema.safeParse({ commandId, ...complete, basis: "stated" }).success).toBe(false);
    expect(
      recordDisruptionCommandSchema.safeParse({ commandId, ...complete, basis: "stated", evidence: "he said so" })
        .success
    ).toBe(true);
  });
});

describe("missingCommandDisruptionFields", () => {
  it("is empty for a complete disruption", () => {
    expect(missingCommandDisruptionFields(complete)).toEqual([]);
  });

  it("names every missing field, in the machine's order", () => {
    expect(missingCommandDisruptionFields({})).toEqual(["doing", "until", "locationId", "contexts", "exclusive"]);
    expect(missingCommandDisruptionFields({ ...complete, contexts: [], exclusive: undefined })).toEqual([
      "contexts",
      "exclusive"
    ]);
    expect(missingCommandDisruptionFields({ ...complete, doing: "   " })).toEqual(["doing"]);
  });

  it("treats exclusive false as given", () => {
    expect(missingCommandDisruptionFields({ ...complete, exclusive: false })).toEqual([]);
  });

  it("takes a target's title, else its kind, as what he is doing", () => {
    expect(disruptionDoingText({ kind: "project", id: "p1", title: "Thesis" })).toBe("Thesis");
    expect(disruptionDoingText({ kind: "project", id: "p1" })).toBe("project");
    expect(missingCommandDisruptionFields({ ...complete, doing: { kind: "action", id: "a1" } })).toEqual([]);
  });

  it("makes a message that names each field and says nothing was recorded", () => {
    const message = incompleteDisruptionMessage(["until", "exclusive"]);
    expect(message).toContain("until");
    expect(message).toContain("exclusive");
    expect(message).toContain("Nothing was recorded");
  });
});
