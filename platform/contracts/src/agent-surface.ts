import { formatAgentCall, type AgentCall } from "./agent-error.js";

/**
 * One command, two surfaces. The portal writes its refusals once, naming the CLI command (`rhen span set
 * <span> --end YYYY-MM-DD`), because that is what a shell user runs. An agent on the MCP surface has no shell:
 * the same step is a tool call with arguments. This module turns the first into the second, so the text served
 * over `/mcp` and stdio MCP never asks for a command the agent cannot run.
 */

/** The positional words each command takes, in order, as the tool's argument names. */
const POSITIONALS: Readonly<Record<string, readonly string[]>> = {
  span: ["subcommand", "span"],
  save: ["entityType"],
  list: ["entity"],
  "inbox-act": ["room", "action", "id"],
  recurrence: ["subcommand", "target"],
  deliverable: ["subcommand", "deliverable"],
  archive: ["type", "id", "do"],
  cancel: ["type", "id", "do"],
  wake: [],
  stretch: [],
  undo: [],
  status: []
};

/** Commands the owner runs in their own terminal: an agent relays them to the person, so the text keeps them as written. */
const OWNER_COMMANDS = new Set(["agent-token", "owner-token"]);

/** Commands with no tool on the MCP surface: the owner's own, or local-file ones. */
const NOT_A_TOOL = new Set(["import", "mcp", "help", "schema", ...OWNER_COMMANDS]);

const REPEATABLE = new Set(["set", "answer", "where"]);

function tokens(command: string): string[] {
  return command.match(/"[^"]*"|\S+/g)?.map((token) => token.replace(/^"|"$/g, "")) ?? [];
}

/** The MCP call for one CLI command (`rhen ...`), or null when no tool does it. */
export function cliCommandToMcpCall(command: string): AgentCall | null {
  const [first, name, ...rest] = tokens(command.trim());
  if (first !== "rhen" || name === undefined || NOT_A_TOOL.has(name)) return null;
  const positionals = POSITIONALS[name] ?? [];
  const args: Record<string, unknown> = {};
  let index = 0;
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i] as string;
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = rest[i + 1];
      if (next === undefined || next.startsWith("--")) args[key] = true;
      else {
        i += 1;
        if (REPEATABLE.has(key)) args[key] = [...((args[key] as string[] | undefined) ?? []), next];
        else args[key] = next;
      }
    } else {
      const key = positionals[index];
      index += 1;
      if (key !== undefined) args[key] = key === "entityType" ? token.replace(/-/g, "_") : token;
    }
  }
  return { tool: `rhen_${name.replace(/-/g, "_")}`, arguments: args };
}

/**
 * Message text for an MCP agent: every backticked `rhen ...` command becomes `call openrhen_x {args}`,
 * or, when no tool does it, a plain request to the person. Text without a command is returned as it was.
 */
export function renderCommandsForMcp(text: string): string {
  return renderFlagsForMcp(
    text.replace(/(?:\brun )?`(rhen [^`]+)`/g, (whole, command: string) => {
      if (OWNER_COMMANDS.has(command.split(/\s+/)[1] ?? "")) return whole;
      const call = cliCommandToMcpCall(command);
      return call === null ? "ask the person to do it (there is no tool for it)" : `call ${formatAgentCall(call)}`;
    })
  );
}

/**
 * A CLI flag named in prose (`--create`, `--minutes`) is a tool argument on this surface: `--create` is `"create": true`,
 * any other `--name` is the argument `"name"`. The owner's own terminal commands (`rhen agent-token ...`) keep their flags,
 * since the agent relays those to the person as written.
 */
export function renderFlagsForMcp(text: string): string {
  return text
    .split(/(`rhen (?:agent-token|owner-token)[^`]*`)/)
    .map((part, index) =>
      index % 2 === 1
        ? part
        : part
            .replace(/(?<![\w-])--create\b/g, '"create": true')
            .replace(/(?<![\w-])--([a-z][a-z0-9]*(?:-[a-z0-9]+)*)/g, '"$1"')
    )
    .join("");
}
