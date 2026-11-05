import {
  booleanOption,
  requirePositional,
  type CommandContext,
  type CommandSpec,
  type ParsedArgs
} from "../command.js";
import { entityItems, findEntity } from "../entities.js";
import { CliError, EXIT } from "../errors.js";
import { resolveByIdOrPrefix } from "../resolve.js";
import { saveCommand } from "./save.js";

/**
 * `free <commitment>`: the person is free now. A thin shortcut for the commitment save that sends `free` alone
 * (`rhen save commitment --fields '{"id":"<id>","free":true}'`), so it has the same validation, undo and answer.
 */
export const freeCommand: CommandSpec = {
  name: "free",
  summary: "Say you are free now: release the rest of a commitment to the planner",
  description:
    "Use when the person is free during a commitment that is still running (a match they are only partly in, a " +
    "meeting that ended for them) and the planner still says it is in progress. From now to the commitment's end " +
    "the next task is offered at once. Nothing is ended, finished, moved, cancelled or edited, the commitment " +
    "stays on the day plan, and the shared calendar event is not touched; the time to travel there and back " +
    "stays protected, and this does not mean leaving. <commitment> is its id (from `status`) or exact title. " +
    "Refused before it starts, after it ends, or when it is not confirmed. --undo takes it back, as does `undo`. " +
    "The plan then recalculates: read `status` for the next task. An agent's call on a commitment shared with the " +
    "family calendar is filed for the owner to confirm, like any other change to it.",
  positionals: [{ name: "commitment", required: true, description: "The commitment's id or exact title" }],
  options: {
    undo: { type: "boolean", description: "Take it back: the commitment holds its time again" },
    "dry-run": { type: "boolean", description: "Print the command that would be sent instead of sending it" }
  },
  mutates: true,
  examples: ["free commitment-soccer", 'free "Soccer" --undo'],
  async run(context: CommandContext, args: ParsedArgs) {
    const query = requirePositional(freeCommand, args, 0);
    const entity = findEntity("commitments");
    if (!entity) throw new CliError('Unknown entity "commitments".', EXIT.usage);
    const state = await context.client.getState();
    const commitment = resolveByIdOrPrefix(entityItems(state, entity), query, "commitment");
    const fields = JSON.stringify({ id: String(commitment.id), free: !booleanOption(args.values, "undo") });
    const { undo: _undo, ...rest } = args.values;
    await saveCommand.run(context, { positionals: ["commitment"], values: { ...rest, fields } });
  }
};
