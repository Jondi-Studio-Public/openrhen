import { describe, expect, it } from "vitest";
import { mcpManifestTool, validateToolArguments } from "@openrhen/contracts";
import { reportFiledProposal } from "../src/write.js";
import type { CommandContext } from "../src/command.js";

/** An MCP agent reads the CLI's stderr as "Notes from the CLI" after a successful call, so the hint must be a tool call. */
function hintFor(mcp: boolean): string {
  const lines: string[] = [];
  const context = {
    mode: "json",
    mcp,
    stdout: () => undefined,
    stderr: (text: string) => lines.push(text)
  } as unknown as CommandContext;
  reportFiledProposal(context, { proposal: { id: "p-1" }, filedBecause: "bulk: it waits" } as never);
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
});
