import { checkInCommandSchema, checkInTagMarkSchema } from "@openrhen/contracts";
import type { CommandContext, CommandSpec } from "../command.js";
import { stringOption } from "../command.js";
import { CliError, EXIT } from "../errors.js";
import { toJson } from "../output.js";
import { commandIdOf, newCommandId, postCommand } from "../write.js";

const MARKS: readonly string[] = checkInTagMarkSchema.options;

function list(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

export const checkInTagCommand: CommandSpec = {
  name: "check-in-tag",
  summary: "Add or remove tags on an answered check-in",
  description:
    'Tags the owner\'s words on a check-in he has already answered, for a reader that understood them ("school run" ' +
    "-> family). Tags are short open phrases, not a fixed list. This changes tags only: never the status, the words " +
    "or the pulse. --mark inferred (default) says you took the tag from his words, so he sees it and can remove it; " +
    "--mark stated only when he named it himself. Only an answered check-in takes tags, at most 12. " +
    "`rhen undo` reverses it.",
  positionals: [],
  options: {
    "check-in": { type: "string", placeholder: "id", description: "The answered check-in id (required)" },
    add: {
      type: "string",
      placeholder: "tag,tag",
      description: "Tags to add, comma-separated, up to 40 characters each"
    },
    remove: { type: "string", placeholder: "tag,tag", description: "Tags to remove, comma-separated" },
    mark: {
      type: "string",
      placeholder: "inferred|stated",
      description: "How the added tags were found: inferred (default) from his words, stated if he named them"
    },
    "dry-run": { type: "boolean", description: "Print the command instead of sending it" }
  },
  mutates: true,
  examples: [
    "check-in-tag --check-in <id> --add family,school-run",
    "check-in-tag --check-in <id> --remove family",
    "check-in-tag --check-in <id> --add errand --mark stated"
  ],
  async run(context: CommandContext, args) {
    const checkInId = stringOption(args.values, "check-in");
    if (checkInId === undefined) throw new CliError("--check-in <id> is required.", EXIT.usage);
    const added = list(stringOption(args.values, "add"));
    const removed = list(stringOption(args.values, "remove"));
    if (added.length === 0 && removed.length === 0)
      throw new CliError("Name a tag with --add or --remove.", EXIT.usage);
    const mark = stringOption(args.values, "mark") ?? "inferred";
    if (!MARKS.includes(mark))
      throw new CliError(`Unknown --mark "${mark}". Use one of: ${MARKS.join(", ")}.`, EXIT.usage);

    const payload: Record<string, unknown> = {
      commandId: newCommandId(),
      expectedVersion: null,
      type: "tag_check_in",
      checkInId,
      ...(added.length > 0 ? { add: added.map((tag) => ({ tag, mark })) } : {}),
      ...(removed.length > 0 ? { remove: removed } : {})
    };
    const parsed = checkInCommandSchema.safeParse(payload);
    if (!parsed.success)
      throw new CliError("These tags do not match the contract.", EXIT.validation, parsed.error.issues);

    const result = await postCommand(context, args, {
      path: "/api/commands/check-in",
      payload,
      summary: `tag check-in ${checkInId}`,
      reverse: "server"
    });
    if (result.state === null) return;
    if (context.mode !== "table")
      context.stdout(toJson({ ok: true, applied: true, ...commandIdOf(context), checkInId }, true));
    else context.stdout(`rhen: check-in ${checkInId} tagged.`);
  }
};
