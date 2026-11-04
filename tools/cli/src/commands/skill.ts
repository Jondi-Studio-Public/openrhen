import { CliError, EXIT } from "../errors.js";
import { booleanOption, stringOption, type CommandSpec } from "../command.js";
import { SKILL_FLAVOURS, skillTextFor, type SkillFlavour } from "../skill-content.js";

export const skillCommand: CommandSpec = {
  name: "skill",
  summary: "Print the agent skill (SKILL.md) for working with OpenRhen",
  description:
    "Prints the agent skill for working with OpenRhen as a SKILL.md document, always matching this build. " +
    "It points an agent at the status command, the guide and the schema before it reads or writes, and states " +
    "the write rules (dry-run first, re-read on conflict, no delete). Save the output as " +
    "<skills folder>/openrhen/SKILL.md to install it. Over MCP it is the rhen_skill tool, so a " +
    "connected agent can fetch the skill itself. Pass --remote for the version for an agent that reaches " +
    "OpenRhen through the portal's remote /mcp, which serves fewer tools (the remote /mcp always prints it). " +
    "--flavour openclaw adds a header for the OpenClaw plugin's copy; the default is claude. Offline and read-only.",
  positionals: [],
  options: {
    remote: {
      type: "boolean",
      description:
        "Print the skill for an agent connected over the portal's remote /mcp (no schema, help, import or deliverable)"
    },
    flavour: {
      type: "string",
      placeholder: "claude|openclaw",
      description: "Which agent the text is for: claude (the default) or openclaw (adds a plugin header line)"
    }
  },
  mutates: false,
  offline: true,
  examples: ["skill", "skill --remote", "skill --remote --flavour openclaw"],
  async run(context, args) {
    const flavour = (stringOption(args.values, "flavour") ?? "claude").trim().toLowerCase();
    if (!(SKILL_FLAVOURS as readonly string[]).includes(flavour))
      throw new CliError(`Unknown flavour "${flavour}". Flavours: ${SKILL_FLAVOURS.join(", ")}.`, EXIT.usage);
    const remote = context.remote === true || booleanOption(args.values, "remote");
    // Raw text in every output mode: over MCP every call carries --json, and an agent saving the
    // result needs the SKILL.md itself, not a JSON string wrapped around it.
    context.stdout(skillTextFor(remote ? "remote" : "stdio", flavour as SkillFlavour));
  }
};
