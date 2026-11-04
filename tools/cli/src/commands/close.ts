import {
  ARCHIVE_TYPES,
  CANCEL_TYPES,
  CLOSE_TYPES,
  closeEntityCommandSchema,
  type CloseEntityResult,
  type CloseType,
  type CloseVerb
} from "@openrhen/contracts";
import { booleanOption, requirePositional, stringOption, type CommandContext, type CommandSpec } from "../command.js";
import { CliError, EXIT, firstIssueMessage } from "../errors.js";
import { restoreCallText } from "../closed-rows.js";
import { findEntity } from "../entities.js";
import { resolveReference } from "../resolve.js";
import { newCommandId, postCommand } from "../write.js";
import { toJson } from "../output.js";

/** What a person may type for a type, besides the canonical name (a place, a contact and a capability are all conditions). */
const TYPE_ALIASES: Readonly<Record<string, CloseType>> = {
  place: "condition_definition",
  contact: "condition_definition",
  capability: "condition_definition",
  live: "condition_definition",
  condition: "condition_definition",
  preset: "routine_preset",
  routine: "routine_preset"
};

/** The state list each type lives in, for finding the row by id or exact title. */
const ENTITY_OF: Readonly<Record<CloseType, string>> = {
  area: "areas",
  outcome: "outcomes",
  project: "projects",
  action: "actions",
  deliverable: "deliverables",
  commitment: "commitments",
  routine_preset: "routine-presets",
  condition_definition: "conditions"
};

const canonicalType = (text: string): CloseType | undefined => {
  const wanted = text.trim().toLowerCase().replace(/-/g, "_");
  return (CLOSE_TYPES as readonly string[]).includes(wanted) ? (wanted as CloseType) : TYPE_ALIASES[wanted];
};

const otherTool = (verb: CloseVerb) => (verb === "archive" ? "rhen_cancel" : "rhen_archive");

function printResult(context: CommandContext, closed: CloseEntityResult): void {
  if (context.mode !== "table") {
    context.stdout(toJson({ applied: true, closed }, true));
    return;
  }
  const word = closed.do === "restore" ? "Restored" : closed.verb === "archive" ? "Archived" : "Cancelled";
  const lines = [
    `${word} ${closed.type.replace(/_/g, " ")} ${closed.id}: now ${closed.status} (version ${closed.version}).` +
      (closed.restoredTo !== undefined ? ` It went back to ${closed.restoredTo}.` : "")
  ];
  if (closed.cascaded.length > 0)
    lines.push(`Also ${closed.do === "restore" ? "reopened" : "closed"}: ${closed.cascaded.length} item(s) under it.`);
  for (const skipped of closed.skipped)
    lines.push(
      `Left alone: ${skipped.type} ${skipped.id} (${skipped.reason})` +
        (skipped.call ? `; ${restoreCallText(skipped.call, context.mcp === true)}` : "")
    );
  for (const dependent of closed.dependents)
    lines.push(`Still waits on it: ${dependent.type} ${dependent.id} "${dependent.title}".`);
  if (closed.restore) lines.push(`To undo: ${restoreCallText(closed.restore, context.mcp === true)}`);
  for (const line of lines) context.stdout(line);
}

function closeSpec(verb: CloseVerb): CommandSpec {
  const types = verb === "archive" ? ARCHIVE_TYPES : CANCEL_TYPES;
  const spec: CommandSpec = {
    name: verb,
    summary:
      verb === "archive"
        ? "Archive a finished or retired row, or restore a closed one"
        : "Cancel an appointment or a dropped piece of work, or restore a closed one",
    description:
      verb === "archive"
        ? "Archive tidies a row away without losing it: an area, routine preset or place, a finished outcome or project, a done action or deliverable. " +
          "To drop an open outcome, project, action or deliverable, or an appointment, use rhen_cancel. " +
          "do is close or restore; a closed row shows its restore call. Give a reason when you are an agent. " +
          "include-children also closes the open outcomes, projects and actions under an area, outcome or project; a call that reaches more than 20 rows, or would pass 20 closures in a rolling hour (counting this call), or anything the owner must decide (a deadline, a shared appointment), is filed as one proposal. " +
          "A save that sets status archived is refused. Returns the closed row, what was closed with it and the restore call; rhen_undo reverses it."
        : "Cancel drops what will not happen: an appointment, shift or event, an abandoned outcome or project, an open action or deliverable you drop. " +
          "To tidy away something finished, an area, preset or place, use rhen_archive. " +
          "do is close or restore; a closed row shows its restore call. Give a reason when you are an agent. " +
          "include-children also closes the open rows under an outcome or project; a cancelled appointment also closes its preparation steps. A call that reaches more than 20 rows, or would pass 20 closures in a rolling hour (counting this call), or anything the owner must decide, is filed as one proposal. " +
          "A save that sets status cancelled is refused. Returns the closed row, what was closed with it and the restore call; rhen_undo reverses it.",
    positionals: [
      {
        name: "type",
        required: true,
        description: `One of: ${types.join(", ")}`,
        enum: types
      },
      { name: "id", required: true, description: "The row's id or exact title" },
      {
        name: "do",
        required: false,
        mcpRequired: true,
        description: "close, or restore to reopen a closed row",
        enum: ["close", "restore"]
      }
    ],
    options: {
      restore: { type: "boolean", description: "Same as do restore" },
      reason: { type: "string", description: "Why (required for an agent): shown to the owner and kept with the row" },
      "expected-version": {
        type: "string",
        placeholder: "N",
        description: "The version you read; a restore uses the row's current one when you leave it out"
      },
      "include-children": {
        type: "boolean",
        description: "Also close the open rows under an area, outcome or project"
      },
      "dry-run": { type: "boolean", description: "Print the payload instead of sending it" }
    },
    mutates: true,
    destructive: true,
    idempotent: false,
    examples: [
      `${verb} ${verb === "archive" ? "project" : "action"} "Thesis" close --reason "finished"`,
      `${verb} ${verb === "archive" ? "project" : "action"} "Thesis" --restore`
    ],
    async run(context, args) {
      const typed = requirePositional(spec, args, 0);
      const type = canonicalType(typed);
      if (type === undefined)
        throw new CliError(`Unknown type "${typed}". Use one of: ${CLOSE_TYPES.join(", ")}.`, EXIT.usage);
      if (!(types as readonly string[]).includes(type))
        throw new CliError(
          `A ${type.replace(/_/g, " ")} is not ${verb === "archive" ? "archived" : "cancelled"}: use ${otherTool(verb)} for it.`,
          EXIT.usage
        );
      const query = requirePositional(spec, args, 1);
      const named = args.positionals[2];
      const restoring = booleanOption(args.values, "restore");
      if (named !== undefined && named !== "close" && named !== "restore")
        throw new CliError(`do is close or restore, not "${named}".`, EXIT.usage);
      if (restoring && named === "close")
        throw new CliError("--restore and do close contradict each other; say one of them.", EXIT.usage);
      const action = restoring ? "restore" : named;
      if (action === undefined)
        throw new CliError(
          `Say close or restore: ${verb} ${type} <id> close, or ${verb} ${type} <id> --restore.`,
          EXIT.usage
        );
      const state = await context.client.getState();
      const entity = findEntity(ENTITY_OF[type])!;
      const row = resolveReference(state, entity.name, query);
      const versionText = stringOption(args.values, "expected-version");
      const rowVersion = typeof row.version === "number" ? row.version : undefined;
      const version = versionText === undefined ? (action === "restore" ? rowVersion : undefined) : Number(versionText);
      if (versionText !== undefined && !Number.isInteger(version))
        throw new CliError("expected-version must be a whole number.", EXIT.usage);
      if (action === "restore" && version === undefined)
        throw new CliError(
          `This row carries no version to restore against: read it with rhen_show, then repeat with expected-version.`,
          EXIT.validation
        );
      const reason = stringOption(args.values, "reason");
      const parsed = closeEntityCommandSchema.safeParse({
        commandId: newCommandId(),
        type,
        id: String(row.id),
        verb,
        do: action,
        ...(version === undefined ? {} : { expectedVersion: version }),
        ...(reason === undefined ? {} : { reason }),
        ...(booleanOption(args.values, "include-children") ? { includeChildren: true } : {})
      });
      if (!parsed.success) throw new CliError(firstIssueMessage(parsed.error), EXIT.validation, parsed.error.issues);
      const result = await postCommand(context, args, {
        path: "/api/commands/close",
        payload: parsed.data,
        summary: `${action === "restore" ? "restore" : verb} ${type.replace(/_/g, " ")} "${String(row.id)}"`,
        reverse: "server"
      });
      if (result.state === null) return;
      const closed = (result.response as { closed?: CloseEntityResult } | undefined)?.closed;
      if (closed === undefined) {
        context.stdout("Done.");
        return;
      }
      printResult(context, closed);
    }
  };
  return spec;
}

export const archiveCommand: CommandSpec = closeSpec("archive");
export const cancelCommand: CommandSpec = closeSpec("cancel");
