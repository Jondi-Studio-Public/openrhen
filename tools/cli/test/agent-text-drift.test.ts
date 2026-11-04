import { existsSync, readFileSync, readdirSync } from "node:fs";
import {
  AGENT_CONTRACT_VERSION,
  MCP_SERVER_INSTRUCTIONS,
  MCP_TOOL_MANIFEST,
  agentPolicyLines
} from "@openrhen/contracts";
import { describe, expect, it } from "vitest";
import { guideOverviewFor, guideTopicsFor } from "../src/guide-content.js";
import { skillTextFor } from "../src/skill-content.js";
import { runCli } from "../src/cli.js";
import { serveMcp, toolName } from "../src/commands/mcp.js";
import { commands } from "../src/registry.js";

/**
 * The prose agents are taught from has four hand-written homes (the MCP instructions, the CLI guide, the CLI skill and
 * the OpenClaw plugin's SKILL.md) and no compiler to keep them honest. This is that compiler: every text a remote
 * agent can read may name only the tools and commands the remote `/mcp` serves, and every text carries the policy
 * lines rendered from `agent-policy-text.ts`. When the first group fails, a text names something the remote does not
 * serve (rewrite it, or fence it in a `<stdio>` block); when the second fails, copy the lines the message prints.
 */
// The OpenClaw plugin is not part of the OpenRhen export, so its skill texts are checked only where it exists.
const pluginSkills = new URL("../../../integrations/openclaw-plugin/skills/", import.meta.url);
const pluginSkill = existsSync(pluginSkills)
  ? readFileSync(new URL("openrhen/SKILL.md", pluginSkills), "utf8")
  : undefined;

const pluginDeepSkills = existsSync(pluginSkills)
  ? readdirSync(pluginSkills)
      .filter((dir) => dir !== "rhen")
      .map((dir) => ({
        name: `plugin skill ${dir}`,
        text: readFileSync(new URL(`${dir}/SKILL.md`, pluginSkills), "utf8")
      }))
  : [];

const servedTools = new Set(MCP_TOOL_MANIFEST.map((tool) => tool.name));
const servedCommands = new Set(MCP_TOOL_MANIFEST.map((tool) => tool.command));
const servedArguments = new Set(MCP_TOOL_MANIFEST.flatMap((tool) => Object.keys(tool.inputSchema.properties)));
/** Options the CLI layer adds to every call and a tool schema does not list. */
const OUTPUT_FLAGS = new Set(["json", "pretty"]);

function descriptions(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(descriptions);
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, item]) =>
    key === "description" && typeof item === "string" ? [item] : descriptions(item)
  );
}

const remoteTexts: { name: string; text: string }[] = [
  { name: "MCP_SERVER_INSTRUCTIONS", text: MCP_SERVER_INSTRUCTIONS },
  { name: "remote guide overview", text: guideOverviewFor("remote") },
  ...guideTopicsFor("remote").flatMap((topic) => [
    { name: `remote guide topic ${topic.name}`, text: topic.text },
    { name: `remote guide summary ${topic.name}`, text: topic.summary }
  ]),
  { name: "remote skill", text: skillTextFor("remote") },
  ...(pluginSkill === undefined ? [] : [{ name: "plugin SKILL.md", text: pluginSkill }]),
  ...pluginDeepSkills,
  ...MCP_TOOL_MANIFEST.map((tool) => ({
    name: `tool ${tool.name}`,
    text: [tool.description, ...descriptions(tool.inputSchema)].join("\n")
  }))
];

describe("text served to a remote agent", () => {
  it.each(remoteTexts)("$name names only served tools, commands and options", ({ text }) => {
    const tools = [...new Set(text.match(/\brhen_[a-z][a-z0-9_]*/g) ?? [])];
    expect(
      tools.filter((name) => !servedTools.has(name)),
      "names a tool /mcp does not serve"
    ).toEqual([]);
    const spoken = [...new Set([...text.matchAll(/\bopenrhen ([a-z][a-z-]*)/g)].map((match) => match[1]!))];
    expect(
      spoken.filter((name) => !servedCommands.has(name)),
      "names a command /mcp does not serve"
    ).toEqual([]);
    const flags = [...new Set([...text.matchAll(/(?<![\w-])--([a-z][a-z-]*)/g)].map((match) => match[1]!))];
    expect(
      flags.filter((name) => !servedArguments.has(name) && !OUTPUT_FLAGS.has(name)),
      "names an option no served tool takes"
    ).toEqual([]);
  });

  it("serves a guide without the topics that need unserved commands", () => {
    const names = guideTopicsFor("remote").map((topic) => topic.name);
    expect(names).toContain("limits");
    expect(names).toContain("coordinating");
    expect(guideTopicsFor("stdio").map((topic) => topic.name)).toContain("coordinating");
    for (const topic of guideTopicsFor("remote")) expect(topic.text).not.toMatch(/<\/?(stdio|remote)>/);
    for (const topic of guideTopicsFor("stdio")) expect(topic.text).not.toMatch(/<\/?(stdio|remote)>/);
  });

  it("lists in the instructions and SKILL.md only guide topics the remote guide serves", () => {
    const served = guideTopicsFor("remote").map((topic) => topic.name);
    for (const text of [
      MCP_SERVER_INSTRUCTIONS,
      ...(pluginSkill === undefined ? [] : [pluginSkill]),
      skillTextFor("remote")
    ]) {
      for (const name of served) expect(text, `does not mention the ${name} guide topic`).toContain(name);
    }
  });
});

/** Local-only options: the remote never takes them, so no remote text may name them even as another tool's. */
const LOCAL_ONLY_FLAGS = ["force", "any-owner", "state-file"];
/** Command names that are also field names, so a backticked one is usually the field (`version`). */
const FIELD_WORDS = new Set(["version"]);
const commandNames = new Set(commands.map((spec) => spec.name).filter((name) => !FIELD_WORDS.has(name)));

describe("each remote tool's own description", () => {
  it.each(MCP_TOOL_MANIFEST.map((tool) => ({ name: tool.name, tool })))(
    "$name names none of its command's options the remote leaves out",
    ({ tool }) => {
      const spec = commands.find((command) => command.name === tool.command)!;
      const own = new Set(Object.keys(tool.inputSchema.properties));
      const text = [tool.description, ...descriptions(tool.inputSchema)].join("\n");
      const flags = [...new Set([...text.matchAll(/(?<![\w-])--([a-z][a-z-]*)/g)].map((match) => match[1]!))];
      expect(
        flags.filter((flag) => flag in spec.options && !own.has(flag)),
        "names an option this tool does not take over /mcp"
      ).toEqual([]);
    }
  );
});

describe("remote text, beyond tool names", () => {
  it.each(remoteTexts)("$name names no local-only option", ({ text }) => {
    for (const flag of LOCAL_ONLY_FLAGS) expect(text).not.toMatch(new RegExp(`(?<![\\w-])--${flag}\\b`));
  });

  it("never tells an agent to end a series by status, which the hard floor refuses", () => {
    const texts = [
      ...remoteTexts,
      { name: "stdio skill", text: skillTextFor("stdio") },
      ...guideTopicsFor("stdio").map((topic) => ({ name: `stdio guide topic ${topic.name}`, text: topic.text }))
    ];
    for (const { name, text } of texts)
      expect(text, `${name} ends a series with status=ended`).not.toMatch(/recurrence set[^\n]*status=ended/);
  });

  it.each(remoteTexts)("$name backticks only commands the remote serves", ({ text }) => {
    const spoken = [...text.matchAll(/`(?:rhen )?([a-z][a-z-]*)[ `]/g)].map((match) => match[1]!);
    expect(
      [...new Set(spoken)].filter((name) => commandNames.has(name) && !servedCommands.has(name)),
      "backticks a command /mcp does not serve"
    ).toEqual([]);
  });
});

describe("text served over stdio", () => {
  const stdioTools = new Set(commands.map((spec) => toolName(spec)));

  async function stdioInstructions(): Promise<string> {
    const written: string[] = [];
    await serveMcp({
      input: [JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })],
      write: (line) => written.push(line),
      runner: (argv, capture) => runCli(argv, { ...capture, env: {}, readConfigFile: () => null })
    });
    return (JSON.parse(written[0]!) as { result: { instructions: string } }).result.instructions;
  }

  it("names only tools the stdio server lists", async () => {
    const texts = [
      { name: "stdio instructions", text: await stdioInstructions() },
      { name: "stdio guide overview", text: guideOverviewFor("stdio") },
      ...guideTopicsFor("stdio").map((topic) => ({ name: `stdio guide topic ${topic.name}`, text: topic.text })),
      { name: "stdio skill", text: skillTextFor("stdio") }
    ];
    for (const { name, text } of texts) {
      const tools = [...new Set(text.match(/\brhen_[a-z][a-z0-9_]*/g) ?? [])];
      expect(
        tools.filter((tool) => !stdioTools.has(tool)),
        `${name} names a tool the stdio server does not list`
      ).toEqual([]);
    }
  });
});

describe("the guide and skill commands on each surface", () => {
  async function run(argv: string[], remote: boolean) {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(argv, {
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
      env: {},
      readConfigFile: () => null,
      remote
    });
    return { code, stdout: out.join("\n"), stderr: err.join("\n") };
  }

  it("serves the remote guide without the stdio-only topic and lines", async () => {
    const overview = await run(["guide"], true);
    expect(overview.stdout).toContain("limits");
    expect(overview.stdout).toContain("coordinating");
    expect(overview.stdout).not.toContain("rhen help");
    const remote = await run(["guide", "coordinating"], true);
    expect(remote.code).toBe(0);
    // The remote rendering names the tool's arguments, never the CLI command line or a file.
    expect(remote.stdout).toContain('rhen_deliverable {subcommand:"pick-up"');
    expect(remote.stdout).not.toMatch(/rhen deliverable|--from|export-sources|handoff/);
    const stdio = await run(["guide", "coordinating"], false);
    expect(stdio.code).toBe(0);
    expect((await run(["guide", "workflows"], false)).stdout).toContain("rhen import preview");
    expect((await run(["guide", "workflows"], true)).stdout).not.toContain("rhen import");
  });

  it("prints the remote skill with --remote", async () => {
    expect((await run(["skill", "--remote"], false)).stdout).toBe(skillTextFor("remote"));
    expect((await run(["skill"], false)).stdout).toBe(skillTextFor("stdio"));
    expect(skillTextFor("remote")).not.toContain("rhen_schema");
    expect(skillTextFor("stdio")).toContain("rhen_schema");
  });
});

describe("agent policy lines", () => {
  const expectLines = (name: string, text: string, owner: string, detail: "full" | "brief") => {
    const missing = agentPolicyLines(owner)
      .map((line) => line[detail])
      .filter((sentence) => !text.includes(sentence));
    expect(missing, `${name} is missing policy lines from agent-policy-text.ts:\n- ${missing.join("\n- ")}`).toEqual(
      []
    );
  };

  it("are in the remote instructions", () =>
    expectLines("MCP_SERVER_INSTRUCTIONS", MCP_SERVER_INSTRUCTIONS, "the person", "brief"));

  it("are in the stdio server's instructions", async () => {
    const written: string[] = [];
    await serveMcp({
      input: [JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })],
      write: (line) => written.push(line),
      runner: (argv, capture) => runCli(argv, { ...capture, env: {}, readConfigFile: () => null })
    });
    const instructions = (JSON.parse(written[0]!) as { result: { instructions: string } }).result.instructions;
    expectLines("serverInstructions()", instructions, "the person", "brief");
  });

  it("are in the guide's limits topic", () => {
    for (const surface of ["stdio", "remote"] as const) {
      const limits = guideTopicsFor(surface).find((topic) => topic.name === "limits");
      expectLines(`${surface} guide limits`, limits?.text ?? "", "the person", "full");
    }
  });

  it("are in the skill, on both surfaces", () => {
    for (const surface of ["stdio", "remote"] as const)
      expectLines(`${surface} skill`, skillTextFor(surface), "the person", "full");
  });

  it("keep the instructions short", () => {
    expect(Buffer.byteLength(MCP_SERVER_INSTRUCTIONS)).toBeLessThan(4600);
  });

  it("do not leave the retired claims anywhere", () => {
    const retired = [
      /is his job/,
      /settings[^.\n]* are his/i,
      /Writes carry the version/,
      /For more than a handful use `rhen_bulk`/,
      /finished sessions and imports are not recorded/
    ];
    const texts = [
      ...remoteTexts.map((entry) => entry.text),
      skillTextFor("stdio"),
      ...guideTopicsFor("stdio").map((topic) => topic.text)
    ];
    for (const text of texts) for (const claim of retired) expect(text).not.toMatch(claim);
  });
});

describe("the contract version", () => {
  it("starts the guide overview on both surfaces", () => {
    for (const surface of ["stdio", "remote"] as const)
      expect(guideOverviewFor(surface).startsWith(`Contract version: ${AGENT_CONTRACT_VERSION}\n`)).toBe(true);
  });

  it("is in the stdio server's initialize result", async () => {
    const written: string[] = [];
    await serveMcp({
      input: [JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })],
      write: (line) => written.push(line),
      runner: (argv, capture) => runCli(argv, { ...capture, env: {}, readConfigFile: () => null })
    });
    const info = (JSON.parse(written[0]!) as { result: { serverInfo: Record<string, unknown> } }).result.serverInfo;
    expect(info.contractVersion).toBe(AGENT_CONTRACT_VERSION);
    expect(typeof info.version).toBe("string");
  });
});
