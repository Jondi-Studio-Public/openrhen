import { describe, expect, it } from "vitest";
import { cliCommandToMcpCall, renderCommandsForMcp } from "./agent-surface";
import { hardFloorInstead, hardFloorReason } from "./agent-scopes";
import { MCP_TOOL_MANIFEST, mcpManifestTool, validateToolArguments } from "./mcp-manifest";

describe("one command, two surfaces", () => {
  it("turns a CLI command into the exact MCP call", () => {
    expect(cliCommandToMcpCall("rhen span set <span> --end YYYY-MM-DD")).toEqual({
      tool: "rhen_span",
      arguments: { subcommand: "set", span: "<span>", end: "YYYY-MM-DD" }
    });
    expect(cliCommandToMcpCall("rhen save sleep-log-entry --id <id> --set sleepAt=<time> --set wakeAt=<time>")).toEqual(
      {
        tool: "rhen_save",
        arguments: { entityType: "sleep_log_entry", id: "<id>", set: ["sleepAt=<time>", "wakeAt=<time>"] }
      }
    );
    expect(cliCommandToMcpCall("rhen recurrence set --id <rule> --set endDate=YYYY-MM-DD --yes")).toEqual({
      tool: "rhen_recurrence",
      arguments: { subcommand: "set", id: "<rule>", set: ["endDate=YYYY-MM-DD"], yes: true }
    });
    expect(cliCommandToMcpCall("rhen inbox-act captured confirm <id> --type <type>")).toEqual({
      tool: "rhen_inbox_act",
      arguments: { room: "captured", action: "confirm", id: "<id>", type: "<type>" }
    });
  });

  it("has no call for a command that is not served over MCP", () => {
    expect(cliCommandToMcpCall("rhen import update <id> --from <file>")).toBeNull();
    expect(cliCommandToMcpCall("rhen agent-token create --name <agent> --scopes <scopes>")).toBeNull();
  });

  it("renders every command in a message for an MCP agent", () => {
    const text = "to shorten it instead, run `rhen span set <span> --end YYYY-MM-DD`";
    const rendered = renderCommandsForMcp(text);
    expect(rendered).toContain('call rhen_span {"subcommand":"set","span":"<span>","end":"YYYY-MM-DD"}');
    expect(rendered).not.toMatch(/--[a-z]/);
    expect(rendered).not.toContain("`rhen ");
    expect(renderCommandsForMcp("run `rhen import update <id> --from <file>`")).toContain("ask the person to do it");
    expect(renderCommandsForMcp("no commands here")).toBe("no commands here");
    // The owner's own commands are for the person to run, so they stay as written.
    expect(renderCommandsForMcp("with `rhen agent-token create --name <agent> --scopes <scopes>`")).toBe(
      "with `rhen agent-token create --name <agent> --scopes <scopes>`"
    );
  });

  it("every hard-floor reason renders with no shell syntax and a real tool name", () => {
    const tools = new Set(MCP_TOOL_MANIFEST.map((tool) => tool.name));
    const floors = [
      { tool: "span", action: "remove" },
      { tool: "save", entityType: "sleep_log_entry", remove: true },
      { tool: "save", entityType: "action", remove: true },
      { tool: "save", entityType: "capture", remove: true },
      { tool: "import", action: "delete" },
      { tool: "recurrence", action: "end", entityType: "action" },
      { tool: "recurrence", action: "end" },
      { tool: "inbox-act", room: "kept", action: "drop" }
    ] as const;
    for (const floor of floors) {
      const reason = hardFloorReason(floor as never);
      const instead = hardFloorInstead(floor as never);
      expect(reason, JSON.stringify(floor)).not.toBeNull();
      const rendered = renderCommandsForMcp(`${reason}`);
      expect(rendered, JSON.stringify(floor)).not.toMatch(/`rhen |\s--[a-z]/);
      for (const match of rendered.matchAll(/\b(rhen_[a-z_]+)\b/g))
        expect(tools.has(match[1] as string), `${match[1]} in ${rendered}`).toBe(true);
      void instead;
    }
  });

  it("every rendered floor call and positional validates against its tool's manifest schema", () => {
    const instead = [
      "rhen span set <span> --end YYYY-MM-DD",
      "rhen save sleep-log-entry --id <id> --set sleepAt=<time> --set wakeAt=<time>",
      "rhen save action --id <id> --set status=cancelled",
      "rhen inbox-act captured ignore <id>",
      "rhen inbox-act captured confirm <id> --type <type>",
      "rhen inbox-act kept reopen <id>",
      "rhen inbox-act people keep <id>",
      "rhen recurrence set --id <rule> --set endDate=YYYY-MM-DD --yes",
      "rhen recurrence end <action>",
      "rhen save action --id <action> --set recurrence.endDate=YYYY-MM-DD",
      "rhen search",
      "rhen list",
      "rhen proposals"
    ];
    for (const command of instead) {
      const call = cliCommandToMcpCall(command);
      expect(call, command).not.toBeNull();
      const tool = mcpManifestTool(call!.tool);
      expect(tool, `${command}: ${call!.tool} is a tool`).toBeDefined();
      for (const name of Object.keys(call!.arguments))
        expect(Object.hasOwn(tool!.inputSchema.properties, name), `${command}: ${name} is an argument`).toBe(true);
      for (const name of tool!.inputSchema.required ?? [])
        // `search` and `list` are named without their query here; every other command must carry its required args.
        if (!["search", "list"].includes(command.split(" ")[1] as string))
          expect(call!.arguments[name], `${command}: required ${name}`).toBeDefined();
      void validateToolArguments;
    }
    expect(cliCommandToMcpCall("rhen recurrence end <action>")?.arguments).toEqual({
      subcommand: "end",
      target: "<action>"
    });
  });
});
