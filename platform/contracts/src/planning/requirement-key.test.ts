import { describe, expect, it } from "vitest";
import {
  baseConditionId,
  formatRequirementKey,
  idUsesReservedSuffix,
  parseRequirementKey,
  REQUIREMENT_TAGS
} from "./requirement-key.js";
import { conditionDefinitionSchema } from "./context-model.js";

describe("parseRequirementKey", () => {
  it("leaves a bare id as it is", () => {
    expect(parseRequirementKey("pete")).toEqual({ id: "pete", tag: null, key: "pete" });
    expect(parseRequirementKey("garage")).toEqual({ id: "garage", tag: null, key: "garage" });
  });

  it("splits only the two closed suffixes", () => {
    expect(REQUIREMENT_TAGS).toEqual(["with", "remote"]);
    expect(parseRequirementKey("pete@with")).toEqual({ id: "pete", tag: "with", key: "pete@with" });
    expect(parseRequirementKey("pete@remote")).toEqual({ id: "pete", tag: "remote", key: "pete@remote" });
    expect(parseRequirementKey("pete@work").tag).toBeNull();
    expect(parseRequirementKey("pete@WITH").tag).toBeNull();
    expect(parseRequirementKey("pete@").tag).toBeNull();
    expect(parseRequirementKey("@with").tag).toBeNull();
  });

  it("splits on the last @ only", () => {
    expect(parseRequirementKey("anna@work@with")).toEqual({ id: "anna@work", tag: "with", key: "anna@work@with" });
    expect(parseRequirementKey("a@with@remote").id).toBe("a@with");
  });

  it("lets a defined id win over the suffix reading", () => {
    const defined = new Set(["anna@remote"]);
    expect(parseRequirementKey("anna@remote", (id) => defined.has(id))).toEqual({
      id: "anna@remote",
      tag: null,
      key: "anna@remote"
    });
    expect(parseRequirementKey("anna@remote@with", (id) => defined.has(id)).id).toBe("anna@remote");
    // Not defined: read as the tag.
    expect(parseRequirementKey("anna@remote", () => false).tag).toBe("remote");
  });

  it("formats and reads back the base id", () => {
    expect(formatRequirementKey("pete", "with")).toBe("pete@with");
    expect(formatRequirementKey("pete", null)).toBe("pete");
    expect(baseConditionId("pete@remote")).toBe("pete");
    expect(baseConditionId("home")).toBe("home");
  });
});

describe("reserved suffixes", () => {
  it("flags ids that end in a reserved suffix", () => {
    expect(idUsesReservedSuffix("pete@with")).toBe(true);
    expect(idUsesReservedSuffix("pete@remote")).toBe(true);
    expect(idUsesReservedSuffix("pete")).toBe(false);
    expect(idUsesReservedSuffix("pete@work")).toBe(false);
  });

  it("refuses a new condition definition whose id ends in a reserved suffix", () => {
    const base = { name: "Pete", kind: "contact" } as const;
    expect(conditionDefinitionSchema.safeParse({ ...base, id: "pete" }).success).toBe(true);
    const bad = conditionDefinitionSchema.safeParse({ ...base, id: "pete@with" });
    expect(bad.success).toBe(false);
    expect(conditionDefinitionSchema.safeParse({ ...base, id: "pete@remote" }).success).toBe(false);
    // Existing rows with some other @ keep parsing.
    expect(conditionDefinitionSchema.safeParse({ ...base, id: "anna@work" }).success).toBe(true);
  });
});
