import { AGENT_ENTITY_TYPES, AGENT_WRITE_TOOLS, requiredScopes } from "@openrhen/contracts";
import { describe, expect, it } from "vitest";
import { ENTITY_TYPES } from "../src/commands/save.js";
import { commands } from "../src/registry.js";

/**
 * The scope table lives in `platform/contracts`, which cannot
 * import this package. This test is the other half of its exhaustiveness check: a new write tool, or a new
 * `save` entity type, fails here until the contracts table covers it.
 */
describe("the contracts scope table covers the CLI", () => {
  const writeTools = commands
    .filter((spec) => spec.mutates && spec.name !== "mcp" && !spec.ownerOnly)
    .map((spec) => spec.name);

  it("lists every mutating registry command", () => {
    expect(writeTools.length).toBeGreaterThan(15);
    expect([...AGENT_WRITE_TOOLS].sort()).toEqual([...writeTools].sort());
  });

  it("resolves a scope for every write tool", () => {
    for (const tool of writeTools) {
      if (tool === "save" || tool === "bulk") continue;
      expect(requiredScopes({ tool }).length, tool).toBeGreaterThan(0);
    }
  });

  it("resolves a scope for every entity type `save` and `bulk` accept", () => {
    for (const def of ENTITY_TYPES) {
      expect(AGENT_ENTITY_TYPES, def.canonical).toContain(def.canonical);
      for (const tool of ["save", "bulk"])
        expect(requiredScopes({ tool, entityType: def.canonical }), `${tool} ${def.canonical}`).toHaveLength(1);
    }
    expect(AGENT_ENTITY_TYPES.length).toBe(ENTITY_TYPES.length);
  });
});
