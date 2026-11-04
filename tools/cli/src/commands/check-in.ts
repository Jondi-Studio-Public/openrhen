import { checkInCommandSchema, deviationCategorySchema } from "@openrhen/contracts";
import type { CommandContext, CommandSpec } from "../command.js";
import { requirePositional, stringOption } from "../command.js";
import { CliError, EXIT } from "../errors.js";
import { toJson } from "../output.js";
import { newCommandId, postCommand } from "../write.js";

const STATUS_BY_POSITIONAL: Record<string, "on_track" | "deviated" | "unknown"> = {
  "on-track": "on_track",
  deviated: "deviated",
  unknown: "unknown"
};

const DEVIATION_CATEGORIES: readonly string[] = deviationCategorySchema.options;
const NOTE_MAX_CHARS = 1000;

/**
 * The action a deviation names. The portal's sheet offers the person's actions as "a different planned
 * task", so that is the kind of id accepted here; an exact title is taken too, like every other CLI
 * reference, and sent as the id. Anything else would be stored as a dangling label.
 */
async function resolveDeviationTarget(context: CommandContext, target: string): Promise<string> {
  const state = await context.client.getState();
  const byId = state.actions.find((action) => action.id === target);
  if (byId) return byId.id;
  const wanted = target.trim().toLowerCase();
  const byTitle = state.actions.filter((action) => action.title.toLowerCase() === wanted);
  if (byTitle.length === 1) return byTitle[0]!.id;
  throw new CliError(
    byTitle.length > 1
      ? `--target "${target}" names several actions (${byTitle.map((action) => action.id).join(", ")}); pass one id.`
      : `--target "${target}" is not the id of any action. Use an action id (see \`list actions\`).`,
    EXIT.usage
  );
}

interface PendingCheckIn {
  id: string;
  version: number | null;
}

/** The pending row from `GET /api/check-ins/current`; the server sends camelCase, but this reads snake_case too. */
function readPendingCheckIn(row: Record<string, unknown>): PendingCheckIn {
  const id = row.id ?? row.checkInId ?? row.check_in_id;
  if (typeof id !== "string") throw new CliError("The pending check-in has no id.", EXIT.unavailable);
  const versionRaw = row.version ?? row.checkInVersion;
  return { id, version: typeof versionRaw === "number" ? versionRaw : null };
}

export const checkInCommand: CommandSpec = {
  name: "check-in",
  summary: "Answer or record a check-in",
  description:
    "Answers the one pending check-in slot, the same way the check-in sheet does; with none waiting it records a voluntary one for what the plan believes now. A deviated answer requires " +
    "--category; --category, --note and --target belong to a deviated answer and are refused on on-track or " +
    "unknown. --target is the id of the action that was actually being worked on (an exact title also works); " +
    "it is checked against your actions, and nothing is started or switched.",
  positionals: [{ name: "status", required: true, description: "on-track, deviated, or unknown" }],
  options: {
    category: {
      type: "string",
      placeholder: "work|family|life_admin|other",
      description: "Deviation category; required when status is deviated, refused otherwise"
    },
    note: { type: "string", placeholder: "text", description: "Deviation note, up to 1000 characters; deviated only" },
    target: {
      type: "string",
      placeholder: "id",
      description: "Id of the action actually being worked on instead; deviated only, recorded and never started"
    },
    "dry-run": { type: "boolean", description: "Print the command instead of sending it" }
  },
  mutates: true,
  examples: [
    "check-in on-track",
    'check-in deviated --category work --note "Fixed a production incident"',
    "check-in unknown --dry-run"
  ],
  async run(context: CommandContext, args) {
    const positional = requirePositional(checkInCommand, args, 0);
    const status = STATUS_BY_POSITIONAL[positional];
    if (!status)
      throw new CliError(`Unknown check-in status "${positional}". Use on-track, deviated, or unknown.`, EXIT.usage);

    const category = stringOption(args.values, "category");
    const note = stringOption(args.values, "note");
    const target = stringOption(args.values, "target");

    // Every check on the CLI's own arguments comes first, so a bad value is reported as itself rather
    // than as "No check-in is pending.".
    if (status !== "deviated") {
      const stray = [
        category !== undefined ? "--category" : undefined,
        note !== undefined ? "--note" : undefined,
        target !== undefined ? "--target" : undefined
      ].filter((flag): flag is string => flag !== undefined);
      if (stray.length > 0)
        throw new CliError(
          `${stray.join(", ")} ${stray.length === 1 ? "only applies" : "only apply"} to a deviated answer; ` +
            `this one is ${positional}. Drop ${stray.length === 1 ? "it" : "them"}, or answer with \`check-in deviated\`.`,
          EXIT.usage
        );
    }
    if (status === "deviated") {
      if (category === undefined) throw new CliError("A deviated check-in needs --category.", EXIT.usage);
      if (!DEVIATION_CATEGORIES.includes(category))
        throw new CliError(
          `Unknown --category "${category}". Use one of: ${DEVIATION_CATEGORIES.join(", ")}.`,
          EXIT.usage
        );
      if (note !== undefined && note.trim().length > NOTE_MAX_CHARS)
        throw new CliError(`--note is limited to ${NOTE_MAX_CHARS} characters.`, EXIT.usage);
    }
    const targetId = target === undefined ? undefined : await resolveDeviationTarget(context, target);

    const response = await context.client.get<{ checkIn: Record<string, unknown> | null }>("/api/check-ins/current");
    const row = response?.checkIn ?? null;
    // None waiting: record a voluntary check-in; the server refuses it with the next call if the plan has nothing current.
    const pending = row ? readPendingCheckIn(row) : null;
    const id = pending?.id ?? null;

    const payload: Record<string, unknown> = {
      commandId: newCommandId(),
      expectedVersion: pending?.version ?? null,
      type: pending ? "answer_check_in" : "voluntary_check_in",
      ...(pending ? { checkInId: pending.id } : {}),
      status,
      ...(status === "deviated" && category !== undefined ? { deviationCategory: category } : {}),
      ...(status === "deviated" && note !== undefined ? { deviationNote: note } : {}),
      ...(status === "deviated" && targetId !== undefined ? { deviationTargetId: targetId } : {}),
      answerSource: "sheet"
    };
    const parsed = checkInCommandSchema.safeParse(payload);
    if (!parsed.success)
      throw new CliError("This check-in answer does not match the contract.", EXIT.validation, parsed.error.issues);

    const result = await postCommand(context, args, {
      path: "/api/commands/check-in",
      payload,
      summary: id ? `answer check-in ${id} as ${status}` : `record a voluntary check-in as ${status}`,
      reverse: "server"
    });
    if (result.state === null) return;

    if (context.mode !== "table")
      context.stdout(toJson({ ok: true, checkInId: id, status, voluntary: id === null }, true));
    else
      context.stdout(
        id ? `rhen: check-in ${id} answered as ${status}.` : `rhen: voluntary check-in recorded as ${status}.`
      );
  }
};
