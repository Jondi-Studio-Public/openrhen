import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mcpManifestTool } from "@openrhen/contracts";

/**
 * Every `openrhen_x {json}` call a portal source names to an agent must be a real manifest tool, and every
 * argument in the JSON must be one of that tool's real parameters. An agent that is sent to a call that does not
 * exist, or to one with an invented argument, has to guess.
 */
const ROOTS = [join(__dirname), join(__dirname, "..", "app")];
const SKIP = /\.(test|integration\.test)\.tsx?$|node_modules/;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : sources(path);
    return /\.tsx?$/.test(name) && !SKIP.test(name) ? [path] : [];
  });
}

/** Names that look like tools but are code identifiers or deliberate negatives, not calls sent to an agent. */
const NOT_CALLS = new Set<string>([
  "openrhen_import_draft"
]); /* the import extractor's own model tool, not an MCP tool */

function calls(text: string): { name: string; json?: string | undefined }[] {
  const out: { name: string; json?: string | undefined }[] = [];
  for (const match of text.matchAll(/\brhen_[a-z_]+/g)) {
    const name = match[0];
    let json: string | undefined;
    const after = text.slice(match.index! + name.length);
    if (after.startsWith(" {")) {
      let depth = 0;
      for (let i = 1; i < after.length; i++) {
        if (after[i] === "{") depth++;
        if (after[i] === "}" && --depth === 0) {
          json = after.slice(1, i + 1);
          break;
        }
      }
    }
    out.push({ name, json });
  }
  return out;
}

function parse(json: string): Record<string, unknown> | undefined {
  const text = json.replace(/\\"/g, '"').replace(/\$\{[^}]*\}/g, "x");
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

describe("tool calls named in agent-served portal text", () => {
  const found = ROOTS.flatMap(sources).flatMap((file) =>
    calls(readFileSync(file, "utf8")).map((call) => ({ ...call, file }))
  );

  it("finds the calls to check", () => {
    expect(found.length).toBeGreaterThan(50);
  });

  it("every named tool is in the published manifest", () => {
    const unknown = found.filter((call) => !NOT_CALLS.has(call.name) && !mcpManifestTool(call.name));
    expect(unknown.map((call) => `${call.name} in ${call.file}`)).toEqual([]);
  });

  it("every argument in a named call is a real parameter of that tool", () => {
    const bad: string[] = [];
    let checked = 0;
    for (const call of found) {
      const tool = mcpManifestTool(call.name);
      if (!tool || !call.json) continue;
      const args = parse(call.json);
      if (!args) continue;
      checked++;
      const props = Object.keys(tool.inputSchema.properties ?? {});
      for (const key of Object.keys(args))
        if (!props.includes(key)) bad.push(`${call.name} has no "${key}" (${call.file})`);
    }
    expect(checked).toBeGreaterThan(3);
    expect(bad).toEqual([]);
  });

  const read = (file: string) => readFileSync(join(__dirname, file), "utf8");

  it("a pulse deviation is ended with rhen_disrupt end, not rhen_disruption", () => {
    const text = read("persistence/postgres/pulse-disruption.ts");
    expect(text).not.toContain("rhen_disruption");
    expect(text).toContain('rhen_disrupt {"end":true}');
  });

  it("validValues keys are real argument names", () => {
    const text = read("persistence/postgres/entity-commands.ts");
    expect(text).not.toContain('invalidChoice("stayUpMinutes"');
    expect(text).toContain('invalidChoice("stayUpAnswerMinutes"');
  });

  it("the pulse prompt-count field is not measured in minutes", () => {
    const text = read("persistence/postgres/entity-commands.ts");
    expect(text).not.toMatch(/outOfRange\(label, whole, min, max, "minutes"\)/);
  });

  it("workspace move texts do not name call.name where the CLI subcommand differs", () => {
    expect(read("deliverables/workspace-moves.ts")).not.toContain("${call.name} needs");
  });

  it("every workspace tool maps to a real rhen_deliverable subcommand", async () => {
    const { WORKSPACE_SUBCOMMANDS } = await import("./deliverables/workspace-moves");
    const sub = mcpManifestTool("rhen_deliverable")!.inputSchema.properties.subcommand as { enum: string[] };
    expect(Object.keys(WORKSPACE_SUBCOMMANDS).length).toBe(9);
    for (const [tool, subcommand] of Object.entries(WORKSPACE_SUBCOMMANDS))
      expect(sub.enum, tool).toContain(subcommand);
    expect(WORKSPACE_SUBCOMMANDS["start_carry_out"]).toBe("approve");
    expect(WORKSPACE_SUBCOMMANDS["mark_steps_complete"]).toBe("complete-steps");
    expect(WORKSPACE_SUBCOMMANDS["submit_for_result"]).toBe("submit");
  });
});
