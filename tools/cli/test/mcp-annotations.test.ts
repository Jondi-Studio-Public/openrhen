import { describe, expect, it } from "vitest";
import { buildLineContext, handleLine } from "../src/commands/mcp.js";
import { commands } from "../src/registry.js";
import { commandModules } from "../src/command-modules.js";

interface ListedTool {
  name: string;
  description: string;
  inputSchema: { properties: Record<string, { type: string; enum?: string[]; maxLength?: number }> };
  annotations: {
    title: string;
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
}

async function listTools(): Promise<ListedTool[]> {
  const ctx = await buildLineContext();
  const response = JSON.parse(
    (await handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }), ctx)) ?? "{}"
  ) as { result: { tools: ListedTool[] } };
  return response.result.tools;
}

const toolName = (name: string) => `rhen_${name.replace(/-/g, "_")}`;

describe("MCP tool annotations", () => {
  it("are derived from the registry flags for every tool", async () => {
    const tools = await listTools();
    for (const spec of commands) {
      if (spec.name === "mcp" || spec.ownerOnly) continue;
      const tool = tools.find((candidate) => candidate.name === toolName(spec.name));
      expect(tool, spec.name).toBeDefined();
      expect(tool!.annotations, spec.name).toEqual({
        title: spec.summary,
        readOnlyHint: !spec.mutates && spec.localWrite !== true,
        destructiveHint: spec.mutates && spec.destructive === true,
        idempotentHint: !spec.mutates && spec.idempotent !== false,
        openWorldHint: spec.outward === true || spec.untrustedOutput !== undefined
      });
    }
  });

  it("does not call a tool idempotent when a repeat without a command id writes twice", async () => {
    const tools = await listTools();
    expect(tools.find((tool) => tool.name === "rhen_changeset")!.annotations.idempotentHint).toBe(false);
  });

  it("marks reads read-only and writes not", async () => {
    const tools = await listTools();
    const hint = (name: string) => tools.find((tool) => tool.name === name)!.annotations;
    expect(hint("rhen_status").readOnlyHint).toBe(true);
    expect(hint("rhen_list").readOnlyHint).toBe(true);
    expect(hint("rhen_save").readOnlyHint).toBe(false);
    expect(hint("rhen_capture").readOnlyHint).toBe(false);
  });

  it("does not call self_update read-only, since it replaces the CLI bundle", async () => {
    const tools = await listTools();
    expect(tools.find((tool) => tool.name === "rhen_self_update")!.annotations.readOnlyHint).toBe(false);
  });

  it("marks reads idempotent and every write not, since a write without a command-id mints its own key", async () => {
    const tools = await listTools();
    expect(tools.some((tool) => tool.annotations.readOnlyHint)).toBe(true);
    for (const spec of commands) {
      if (spec.name === "mcp" || spec.ownerOnly) continue;
      const tool = tools.find((candidate) => candidate.name === toolName(spec.name))!;
      expect(tool.annotations.idempotentHint, spec.name).toBe(!spec.mutates && spec.idempotent !== false);
    }
    expect(tools.find((tool) => tool.name === "rhen_save")!.annotations.idempotentHint).toBe(false);
    expect(tools.find((tool) => tool.name === "rhen_status")!.annotations.idempotentHint).toBe(true);
  });

  it("flags removals as destructive and nothing read-only as destructive", async () => {
    const tools = await listTools();
    const destructive = tools.filter((tool) => tool.annotations.destructiveHint).map((tool) => tool.name);
    expect(destructive.sort()).toEqual(
      ["rhen_bulk", "rhen_import", "rhen_recurrence", "rhen_span", "rhen_undo"].sort()
    );
    for (const tool of tools) if (tool.annotations.readOnlyHint) expect(tool.annotations.destructiveHint).toBe(false);
  });

  it("flags outward writes and third-party reads as open-world", async () => {
    const tools = await listTools();
    // The commands a command module adds, when it reads someone else's text or writes outward.
    const moduleOpenWorld = commandModules()
      .filter((module) => module.manifestFile !== undefined)
      .flatMap((module) => module.commands)
      .filter((spec) => spec.untrustedOutput !== undefined || spec.outward === true)
      .map((spec) => `rhen_${spec.name.replaceAll("-", "_")}`);
    const open = tools.filter((tool) => tool.annotations.openWorldHint).map((tool) => tool.name);
    expect(open.sort()).toEqual(
      ["rhen_deliverable", "rhen_doctor", "rhen_inbox", "rhen_inbox_act", ...moduleOpenWorld].sort()
    );
  });
});

describe("basis and evidence over MCP", () => {
  it("are inputs of every mutating tool, and of no read tool", async () => {
    const tools = await listTools();
    const mutating = new Set(commands.filter((spec) => spec.mutates).map((spec) => toolName(spec.name)));
    for (const tool of tools) {
      expect("basis" in tool.inputSchema.properties, tool.name).toBe(mutating.has(tool.name));
      // `changes` has its own evidence flag (a boolean), `deliverable` its own evidence note (a string).
      if (tool.name !== "rhen_changes")
        expect("evidence" in tool.inputSchema.properties, tool.name).toBe(mutating.has(tool.name));
    }
    const save = tools.find((tool) => tool.name === "rhen_save")!;
    expect(save.inputSchema.properties.basis?.enum).toEqual(["stated", "inferred", "observed"]);
    expect(save.inputSchema.properties.evidence?.maxLength).toBe(300);
  });

  it("says what stated means once, not in every write tool's description", async () => {
    const tools = await listTools();
    const mutating = new Set(commands.filter((spec) => spec.mutates).map((spec) => toolName(spec.name)));
    for (const tool of tools.filter((candidate) => mutating.has(candidate.name))) {
      if (tool.name === "rhen_propose") {
        expect(tool.description, tool.name).toMatch(/stated \(the person said it/);
      } else {
        expect(tool.description, tool.name).not.toMatch(/stated means/);
        const basis = tool.inputSchema.properties.basis as { description?: string } | undefined;
        expect(basis?.description, tool.name).toMatch(/stated .*inferred .*or observed .*Missing counts as inferred/);
      }
    }
  });
});
