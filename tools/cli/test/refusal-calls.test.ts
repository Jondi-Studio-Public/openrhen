import { describe, expect, it } from "vitest";
import { SHOW_ENTITIES, REFUSAL_KINDS, listCallFor, mcpManifestTool } from "@openrhen/contracts";
import { findEntity } from "../src/entities.js";

/** The portal's refusals send agents to `rhen_show` and `rhen_list` with an `entity`; the CLI must resolve each. */
describe("the entities the portal's refusals name", () => {
  it("every SHOW_ENTITIES value resolves with the CLI's own findEntity", () => {
    for (const [kind, entity] of Object.entries(SHOW_ENTITIES))
      expect(findEntity(entity), `${kind} -> ${entity}`).toBeDefined();
    expect(SHOW_ENTITIES["recurring commitment"]).toBe("commitment-rule");
    expect(Object.keys(SHOW_ENTITIES)).not.toContain("check-in");
  });

  it("every list a not-found refusal sends the agent to resolves, and is in the tool's enum", () => {
    const list = mcpManifestTool("rhen_list")!;
    const allowed = (list.inputSchema.properties.entity as { enum: string[] }).enum;
    for (const kind of REFUSAL_KINDS) {
      const call = listCallFor(kind);
      if (call?.tool !== "rhen_list") continue;
      const entity = String(call.arguments.entity);
      expect(allowed, kind).toContain(entity);
      expect(findEntity(entity), `${kind} -> ${entity}`).toBeDefined();
    }
  });
});
