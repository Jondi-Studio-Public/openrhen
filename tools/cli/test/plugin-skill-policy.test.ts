import { existsSync, readFileSync } from "node:fs";
import { agentPolicyBullets, agentPolicyLines } from "@openrhen/contracts";
import { describe, expect, it } from "vitest";

// The OpenClaw plugin's SKILL.md names the owner generically in its policy lines. This test runs in both trees: the
// private one holds the plugin to the policy text with the private extensions registered, and in the export the
// carve edits (scripts/extract/carve-plugin.mjs, `textEdits`) must turn that block into the core-only text.
const pluginSkills = new URL("../../../integrations/openclaw-plugin/skills/", import.meta.url);
const plugin = existsSync(pluginSkills) ? readFileSync(new URL("openrhen/SKILL.md", pluginSkills), "utf8") : undefined;

describe.skipIf(plugin === undefined)("agent policy lines in the plugin SKILL.md", () => {
  it("are in the plugin's SKILL.md", () => {
    const missing = agentPolicyLines("the owner")
      .map((line) => line.full)
      .filter((sentence) => !plugin!.includes(sentence));
    expect(missing, `SKILL.md is missing policy lines from agent-policy-text.ts:\n- ${missing.join("\n- ")}`).toEqual(
      []
    );
  });

  it("are exactly the plugin SKILL.md's policy block, with no stale line left beside them", () => {
    const block = plugin!.split("## Limits and policy\n\n")[1]!.split("\n- If a tool is missing")[0];
    expect(block, 'replace the block under ## Limits and policy with agentPolicyBullets("the owner", "full")').toBe(
      agentPolicyBullets("the owner", "full")
    );
  });
});
