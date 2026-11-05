import { describe, expect, it } from "vitest";
import type { ImportRecord } from "@openrhen/contracts";
import { unknownConditionReferences } from "./key-resolution";

function action(contextIds: string[], preferences: string[] = []): ImportRecord {
  return {
    entityType: "action",
    fields: {
      requirementPathways: { value: [{ id: "p", contextIds }] },
      preferences: { value: preferences }
    },
    errors: []
  } as unknown as ImportRecord;
}

describe("unknownConditionReferences", () => {
  const known = new Set(["garage", "pete"]);

  it("accepts a tagged requirement on a known contact", () => {
    expect(unknownConditionReferences(action(["garage", "pete@with"]), known)).toEqual([]);
    expect(unknownConditionReferences(action(["pete@remote"]), known)).toEqual([]);
  });

  it("names the unknown contact, as written", () => {
    const [message] = unknownConditionReferences(action(["ghost@with"]), known);
    expect(message).toContain("ghost@with");
  });

  it("lets a defined id that ends in a tag win over the suffix reading", () => {
    expect(unknownConditionReferences(action(["anna@remote"]), new Set(["anna@remote"]))).toEqual([]);
  });

  it("still rejects a bare unknown id", () => {
    expect(unknownConditionReferences(action(["shed"]), known)).toHaveLength(1);
  });
});
