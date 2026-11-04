import { AGENT_CONTRACT_VERSION, MCP_TOOL_MANIFEST } from "@openrhen/contracts";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { EXIT } from "../src/errors.js";
import { guideTopics } from "../src/guide-content.js";
import { commands } from "../src/registry.js";

// Rendered after the command modules have registered (the skill text lists the rooms they add).
const skillText = skillTextFor("stdio");
import { skillTextFor } from "../src/skill-content.js";

async function runSkill(argv: readonly string[]): Promise<{ exitCode: number; stdout: string }> {
  const stdout: string[] = [];
  const throwingFetch: typeof fetch = () => {
    throw new Error("skill must never call fetch");
  };
  const exitCode = await runCli(argv, {
    stdout: (text) => stdout.push(text),
    stderr: () => undefined,
    env: {},
    readConfigFile: () => null,
    fetchImpl: throwingFetch
  });
  return { exitCode, stdout: stdout.join("\n") };
}

describe("skill", () => {
  it("prints a SKILL.md with frontmatter, offline", async () => {
    const { exitCode, stdout } = await runSkill(["skill"]);
    expect(exitCode).toBe(EXIT.ok);
    expect(stdout).toBe(skillText);
    expect(stdout.startsWith("---\nname: openrhen\ndescription: ")).toBe(true);
    expect(stdout.indexOf("\n---\n", 4)).toBeGreaterThan(0);
  });

  it("prints the raw document even with --json, which every MCP call adds", async () => {
    const { exitCode, stdout } = await runSkill(["skill", "--json"]);
    expect(exitCode).toBe(EXIT.ok);
    expect(stdout).toBe(skillText);
  });

  it("is read-only, so a read-only MCP server still lists it", () => {
    expect(commands.find((command) => command.name === "skill")?.mutates).toBe(false);
  });

  it("only names guide topics and tools that exist, and never an install command", () => {
    for (const topic of guideTopics) expect(skillText).toContain(topic.name);
    // A stdio tool per command, plus the remote endpoint's typed save tools.
    const tools = [
      ...commands.map((command) => `rhen_${command.name.replace(/-/g, "_")}`),
      ...MCP_TOOL_MANIFEST.map((tool) => tool.name)
    ];
    for (const tool of skillText.match(/rhen_[a-z_]+/g) ?? []) expect(tools).toContain(tool);
    expect(skillText).not.toMatch(/rhen skill|SKILL\.md|install/i);
  });

  it("states the contract version near the top, on both surfaces", () => {
    for (const text of [skillTextFor("stdio"), skillTextFor("remote")])
      expect(text.split("\n").slice(0, 12)).toContain(`Contract version: ${AGENT_CONTRACT_VERSION}`);
  });

  it("differs by flavour only in the openclaw header line", async () => {
    const claude = skillTextFor("remote", "claude");
    const openclaw = skillTextFor("remote", "openclaw");
    expect(claude).toBe(skillTextFor("remote"));
    const extra = openclaw.split("\n").filter((line) => !claude.split("\n").includes(line));
    expect(extra).toHaveLength(1);
    expect(extra[0]).toMatch(/^Flavour: openclaw\./);
    expect(openclaw.replace(`${extra[0]}\n`, "")).toBe(claude);
    expect((await runSkill(["skill", "--remote", "--flavour", "openclaw"])).stdout).toBe(openclaw);
    const bad = await runSkill(["skill", "--flavour", "gemini"]);
    expect(bad.exitCode).toBe(EXIT.usage);
  });
});
