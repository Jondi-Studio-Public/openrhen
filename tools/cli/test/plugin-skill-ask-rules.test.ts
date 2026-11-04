import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// A rule that tells the agent to ask the owner is only half a rule: the agent also has to know which call follows the
// answer. In the sessions skill every rule that says "ask" must name the tool it then calls, and the planned-end rule
// must give the exact call for each answer the owner can give. The plugin is not in the OpenRhen export, so this
// skips where it is absent.
const skillUrl = new URL("../../../integrations/openclaw-plugin/skills/openrhen-sessions/SKILL.md", import.meta.url);
const skill = existsSync(skillUrl) ? readFileSync(skillUrl, "utf8") : undefined;

/** The skill's rules: each top-level list item with its nested items, and each paragraph outside a list. */
function rules(text: string): string[] {
  const body = text.replace(/^---[\s\S]*?---\n/, "");
  return body
    .split(/\n(?=- )|\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block !== "" && !block.startsWith("#"));
}

describe.skipIf(skill === undefined)("openrhen-sessions SKILL.md: asking the owner is followed by a call", () => {
  it("every rule that says to ask names the tool call that follows", () => {
    const missing = rules(skill!).filter((rule) => /\bask\b/i.test(rule) && !/`rhen_[a-z_]+`/.test(rule));
    expect(
      missing,
      `These rules tell the agent to ask the owner but name no rhen_ tool to call afterwards:\n- ${missing.join("\n- ")}`
    ).toEqual([]);
  });

  it("the planned-end rule gives the exact call for finishing, not starting, blocking and continuing", () => {
    const rule = rules(skill!).find((block) => block.startsWith("- At a session's planned end"));
    expect(rule, "the planned-end rule is missing").toBeDefined();
    for (const call of [
      "`rhen_session` `finish`",
      "`outcome`",
      "`remaining`",
      "`rhen_session` `did-not-start`",
      "`block`",
      "`rhen_session` `feedback`",
      "`rhen_session` `continue`",
      "`minutes`"
    ])
      expect(rule, call).toContain(call);
  });
});
