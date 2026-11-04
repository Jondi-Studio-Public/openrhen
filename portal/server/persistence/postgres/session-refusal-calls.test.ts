import { describe, expect, it } from "vitest";
import { mcpManifestTool, validateToolArguments } from "@openrhen/contracts";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./session-commands.ts", import.meta.url), "utf8");

/** The `rhen_activity {...}` calls the session refusals print must be calls the manifest accepts as they stand. */
describe("session refusals on a non-action session name a call that exists (F3-02)", () => {
  it("every printed rhen_activity call parses and passes the tool's schema", () => {
    const printed = [...source.matchAll(/rhen_activity (\{[^}]*\})/g)].map((match) => match[1]!);
    expect(printed.length).toBeGreaterThanOrEqual(3);
    const tool = mcpManifestTool("rhen_activity")!;
    expect(tool).toBeDefined();
    for (const text of printed) {
      const args = JSON.parse(text) as Record<string, unknown>;
      expect(validateToolArguments(tool.inputSchema, args, tool.name).ok, text).toBe(true);
    }
  });

  it("no refusal sends the agent to a workspace", () => {
    expect(source).not.toContain("its own workspace");
  });
});
