import { existsSync, readdirSync, readFileSync } from "node:fs";
import { AGENT_CONTRACT_VERSION, AGENT_DRIVE_WRITE_SCOPES, MCP_TOOL_MANIFEST } from "@openrhen/contracts";
import { MCP_TOOL_MANIFEST_DATA } from "../../../platform/contracts/src/mcp-manifest-data.js";
import { describe, expect, it } from "vitest";

/**
 * The OpenClaw plugin (integrations/openclaw-plugin) asks for OAuth scopes in its manifest, and the consent page
 * grants exactly what it asks. It must ask for every scope a served tool needs (or OpenClaw cannot call that
 * tool), the broad write scopes that make those writes apply, and nothing more (no admin or act:). `read:files` is there for the deliverable pack, which carries retained source text. The plugin has no
 * build of its own, so the check lives beside the remote manifest it mirrors.
 */
const pluginRoot = new URL("../../../integrations/openclaw-plugin/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("openclaw.plugin.json", pluginRoot), "utf8")) as {
  id: string;
  skills: string[];
  mcpServers: Record<string, { url: string; transport: string; auth: string; oauth: { scope: string } }>;
};

describe("the OpenClaw plugin", () => {
  const server = manifest.mcpServers.openrhen!;

  it("requests exactly the scopes the remote MCP tools need", () => {
    // A served tool lists the scope that lets it propose; these broader ones make its writes apply directly and
    // reach the plan-map Inbox actions (portal/server/mcp-oauth.ts SCOPES_SUPPORTED), which a driving agent needs.
    const apply = [...AGENT_DRIVE_WRITE_SCOPES];
    const needed = [...new Set([...MCP_TOOL_MANIFEST.flatMap((tool) => tool.scopes), ...apply])].sort();
    const requested = server.oauth.scope.split(" ").sort();
    expect(requested, "update oauth.scope in integrations/openclaw-plugin/openclaw.plugin.json").toEqual(needed);
  });

  it("lists exactly the scopes only a private extension's tools need, so the export can drop them", () => {
    // The export serves the core tools only; scripts/extract/carve-plugin.mjs removes `privateScopes` from the carved
    // manifest. A new private scope fails here until it is listed (and the list never holds a core scope).
    const configFile = new URL("../../../scripts/extract/manifest.json", import.meta.url);
    if (!existsSync(configFile)) return; // the export: the carve has already run, nothing is private
    const config = JSON.parse(readFileSync(configFile, "utf8")).transforms.openclawPlugin as {
      privateScopes: string[];
    };
    const core = new Set([...MCP_TOOL_MANIFEST_DATA.flatMap((tool) => tool.scopes), ...AGENT_DRIVE_WRITE_SCOPES]);
    const extra = [...new Set(MCP_TOOL_MANIFEST.flatMap((tool) => tool.scopes))].filter((scope) => !core.has(scope));
    expect(
      [...config.privateScopes].sort(),
      "update transforms.openclawPlugin.privateScopes in scripts/extract/manifest.json"
    ).toEqual(extra.sort());
  });

  it("connects to the remote endpoint over streamable HTTP with OAuth", () => {
    expect(server).toMatchObject({ transport: "streamable-http", auth: "oauth" });
    expect(new URL(server.url).pathname).toBe("/mcp");
    expect(new URL(server.url).protocol).toBe("https:");
  });

  it("names only tools the remote endpoint serves in its skills", () => {
    const served = new Set(MCP_TOOL_MANIFEST.map((tool) => tool.name));
    for (const dir of manifest.skills) {
      const skills = readdirSync(new URL(`${dir}/`, pluginRoot), { recursive: true, encoding: "utf8" }).filter((path) =>
        path.endsWith("SKILL.md")
      );
      expect(skills.length, `no SKILL.md under ${dir}`).toBeGreaterThan(0);
      for (const path of skills) {
        const text = readFileSync(new URL(`${dir}/${path}`, pluginRoot), "utf8");
        const named = [...new Set(text.match(/\brhen_[a-z_]+/g) ?? [])];
        expect(
          named.filter((name) => !served.has(name)),
          `${path} names a tool /mcp does not serve`
        ).toEqual([]);
      }
    }
  });

  it("records the contract version it was written for, so a bump forces an update", () => {
    const text = readFileSync(new URL("skills/openrhen/SKILL.md", pluginRoot), "utf8");
    const written = /written for contract version (\d+)/.exec(text)?.[1];
    expect(Number(written), "SKILL.md says which contract version it was written for").toBe(AGENT_CONTRACT_VERSION);
    expect(text).toContain("rhen_skill");
  });

  it("teaches logging a night, a lone wake, and correcting a night by its id", () => {
    const text = readFileSync(new URL("skills/openrhen-sleep/SKILL.md", pluginRoot), "utf8");
    expect(text).toContain("`sleep-log-entry`");
    expect(text).toContain("`rhen_wake` with `at=<time>`");
    expect(text).toContain("never save a second one");
  });

  it("routes to every deep skill it ships, and each has a name and description matching its folder", () => {
    const root = readFileSync(new URL("skills/openrhen/SKILL.md", pluginRoot), "utf8");
    const dirs = readdirSync(new URL("skills/", pluginRoot)).filter((dir) => dir !== "rhen");
    expect(dirs.length).toBeGreaterThan(0);
    for (const dir of dirs) {
      const text = readFileSync(new URL(`skills/${dir}/SKILL.md`, pluginRoot), "utf8");
      expect(text, `${dir} frontmatter`).toMatch(new RegExp(`^---\nname: ${dir}\ndescription: .{40,}\n`));
      expect(root, `the start skill does not route to ${dir}`).toContain(`\`${dir}\``);
    }
  });

  it("teaches exactly the rhen_deliverable subcommands the remote serves", () => {
    const tool = MCP_TOOL_MANIFEST.find((entry) => entry.name === "rhen_deliverable")!;
    const subcommands = (tool.inputSchema.properties.subcommand as { enum: string[] }).enum;
    const args = Object.keys(tool.inputSchema.properties);
    const text = readFileSync(new URL("skills/openrhen-deliverables/SKILL.md", pluginRoot), "utf8");
    const ticked = [...text.matchAll(/`([a-z]+(?:-[a-z]+)*)`/g)].map((match) => match[1]!);
    for (const name of subcommands) expect(ticked, `the skill never teaches ${name}`).toContain(name);
    expect(text, "the skill never teaches basis on deliverable moves").toContain("`basis`");
    for (const name of ["handoff", "export-sources"]) expect(ticked, `${name} is not on /mcp`).not.toContain(name);
    const hyphenated = [...new Set(ticked.filter((name) => name.includes("-")))];
    expect(
      hyphenated.filter(
        (name) =>
          !subcommands.includes(name) &&
          !args.includes(name) &&
          name !== "sleep-log-entry" &&
          !name.startsWith("openrhen-")
      ),
      "backticks a hyphenated name that is neither a subcommand nor an argument"
    ).toEqual([]);
  });

  it("keeps its version in step with package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("package.json", pluginRoot), "utf8")) as { version: string };
    expect(JSON.parse(readFileSync(new URL("openclaw.plugin.json", pluginRoot), "utf8")).version).toBe(pkg.version);
  });
});
