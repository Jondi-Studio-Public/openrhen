import { describe, expect, it } from "vitest";
import { mcpManifestTool, validateToolArguments } from "@openrhen/contracts";
import { reportFiledProposal } from "../src/write.js";
import type { CommandContext } from "../src/command.js";

/** An MCP agent reads the CLI's stderr as "Notes from the CLI" after a successful call, so the hint must be a tool call. */
function hintFor(mcp: boolean, mode = "json", out: string[] = [], correction = false): string {
  const lines: string[] = [];
  const context = {
    mode,
    mcp,
    stdout: (text: string) => out.push(text),
    stderr: (text: string) => lines.push(text)
  } as unknown as CommandContext;
  reportFiledProposal(context, { proposal: { id: "p-1" }, filedBecause: "bulk: it waits" } as never, { correction });
  return lines.join("\n");
}

describe("the hint after a write is filed as a proposal", () => {
  it("names rhen_proposals, not shell syntax, when an MCP agent runs it", () => {
    const hint = hintFor(true);
    expect(hint).toContain("rhen_proposals");
    expect(hint).not.toMatch(/`rhen |--[a-z]/);
    const tool = mcpManifestTool("rhen_proposals")!;
    expect(validateToolArguments(tool.inputSchema, {}, tool.name).ok).toBe(true);
  });

  it("keeps the shell command for the CLI", () => {
    expect(hintFor(false)).toContain("`rhen proposals`");
  });

  it("tells a table-mode reader (stdout, where agentNote is not printed) that a proposal cannot be taken back", () => {
    const out: string[] = [];
    hintFor(false, "table", out, true);
    expect(out.join("\n")).toContain("You cannot take a proposal back");
    expect(out.join("\n")).toContain("`rhen save`");
  });

  it("says nothing of the kind for bulk and undo, which pass no correction option", () => {
    const out: string[] = [];
    hintFor(false, "table", out);
    expect(out.join("\n")).not.toContain("cannot take a proposal back");
  });

  it("leaves the JSON answer and the stderr hint alone, so nothing is said twice", () => {
    const out: string[] = [];
    const hint = hintFor(false, "json", out);
    expect(out.join("\n")).not.toContain("cannot take a proposal back");
    expect(hint).not.toContain("cannot take a proposal back");
  });
});
