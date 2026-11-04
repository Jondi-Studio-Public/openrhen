import { globalOptions, type CommandSpec, type OptionSpec } from "../command.js";
import { toJson } from "../output.js";

const OVERVIEW_INTRO = [
  "rhen: command line for the OpenRhen portal, for people and AI tools alike.",
  "",
  "Usage: rhen <command> [options]",
  ""
];

function optionLines(options: Record<string, OptionSpec>): string[] {
  const entries = Object.entries(options).map(([name, option]) => {
    const flag = `${option.short ? `-${option.short}, ` : ""}--${name}${option.placeholder ? ` <${option.placeholder}>` : ""}`;
    return [flag, option.description] as const;
  });
  const width = Math.max(0, ...entries.map(([flag]) => flag.length));
  return entries.map(([flag, description]) => `  ${flag.padEnd(width)}  ${description}`);
}

export function renderOverview(commands: readonly CommandSpec[]): string {
  const width = Math.max(0, ...commands.map((command) => command.name.length));
  return [
    ...OVERVIEW_INTRO,
    "Commands:",
    ...commands.map((command) => `  ${command.name.padEnd(width)}  ${command.summary}`),
    "",
    "Global options:",
    ...optionLines(globalOptions),
    "",
    'Run "rhen help <command>" for its arguments and examples, or "rhen help --json" for the',
    "whole command table as JSON. Every id a command prints is accepted by every other command."
  ].join("\n");
}

export function renderCommandHelp(spec: CommandSpec): string {
  const usage = [
    "rhen",
    spec.name,
    ...spec.positionals.map((positional) => (positional.required ? `<${positional.name}>` : `[${positional.name}]`)),
    "[options]"
  ].join(" ");
  const lines = [`Usage: ${usage}`, "", spec.description];
  if (spec.positionals.length) {
    const width = Math.max(...spec.positionals.map((positional) => positional.name.length));
    lines.push(
      "",
      "Arguments:",
      ...spec.positionals.map((positional) => `  ${positional.name.padEnd(width)}  ${positional.description}`)
    );
  }
  if (Object.keys(spec.options).length) lines.push("", "Options:", ...optionLines(spec.options));
  lines.push("", "Global options:", ...optionLines(globalOptions));
  if (spec.examples.length) lines.push("", "Examples:", ...spec.examples.map((example) => `  rhen ${example}`));
  lines.push("", spec.mutates ? "This command changes portal state." : "This command is read-only.");
  return lines.join("\n");
}

/** The machine-readable command table: what an AI tool reads once to learn the whole CLI. */
export function describeCommand(spec: CommandSpec) {
  return {
    name: spec.name,
    summary: spec.summary,
    description: spec.description,
    mutates: spec.mutates,
    offline: spec.offline ?? false,
    positionals: spec.positionals,
    options: Object.entries(spec.options).map(([name, option]) => ({ name, ...option })),
    globalOptions: Object.entries(globalOptions).map(([name, option]) => ({ name, ...option })),
    examples: spec.examples.map((example) => `rhen ${example}`)
  };
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const above = row[j]!;
      row[j] = Math.min(above + 1, row[j - 1]! + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length]!;
}

/** The unknown-command error: names the closest command and the exact next call, for a CLI user or an agent. */
export function unknownCommandMessage(name: string, names: readonly string[]): string {
  const close = names
    .map((candidate) => ({ candidate, distance: editDistance(name.toLowerCase(), candidate) }))
    .filter(({ distance }) => distance <= 2)
    .sort((left, right) => left.distance - right.distance)[0]?.candidate;
  return (
    `Unknown command "${name}".${close ? ` Did you mean "${close}"?` : ""} Commands: ${names.join(", ")}. ` +
    `Call rhen_help with {"command": "<one of those names>"} for one command's options, or rhen_help ` +
    `with {} for every command (about 256 KB, so prefer one). From a shell: rhen help <command>.`
  );
}

export const helpCommand: CommandSpec = {
  name: "help",
  summary: "Show usage for the CLI or one command",
  description:
    "Prints the command table, or the arguments, options, and examples of one command. With --json it prints " +
    "one command's entry as structured data when a command is given, or the whole table (about 256 KB) when not; " +
    'over MCP call rhen_help with {"command": "<name>"} for one command.',
  positionals: [{ name: "command", required: false, description: "A command name; omit for the overview" }],
  options: {},
  mutates: false,
  offline: true,
  examples: ["help", "help list", "help --json"],
  async run(context, args) {
    // Imported lazily: the registry lists this command, so a static import would be a cycle.
    const { commands, findCommand } = await import("../registry.js");
    const name = args.positionals[0];
    if (name === undefined) {
      if (context.mode !== "table") context.stdout(toJson(commands.map(describeCommand), true));
      else context.stdout(renderOverview(commands));
      return;
    }
    const spec = findCommand(name);
    if (!spec) {
      const { CliError } = await import("../errors.js");
      throw new CliError(
        unknownCommandMessage(
          name,
          commands.map((command) => command.name)
        )
      );
    }
    if (context.mode !== "table") {
      // One command only: the whole table is ~256 KB and floods an agent's context.
      context.stdout(toJson(describeCommand(spec), true));
      return;
    }
    context.stdout(renderCommandHelp(spec));
  }
};
