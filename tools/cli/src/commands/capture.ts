import { requirePositional, stringOption, type CommandSpec } from "../command.js";
import { CliError, EXIT } from "../errors.js";
import { toJson } from "../output.js";
import { resolveReference } from "../resolve.js";
import { alreadyStored, emitSaved, newCommandId, parseCommandIdKey, postCommand } from "../write.js";
import { buildWriteRequest, findEntityType, reverseOfCreate } from "./save.js";

const CAPTURE_MAX_CHARS = 2000;

export const captureCommand: CommandSpec = {
  name: "capture",
  summary: "Drop one line into the inbox",
  description:
    "The cheapest write: files <text> as a new pending capture in the inbox, where it changes nothing in the " +
    "plan until it is reviewed and confirmed. Use it for anything heard as 'remember to ...' instead of " +
    "building a full `save` payload. --area (an id or exact name) is stored on the capture as a hint for " +
    "whoever reviews it (proposedFields.areaId); it does not file the capture under the area by itself.",
  positionals: [{ name: "text", required: true, description: "What to remember, as one line" }],
  options: {
    area: { type: "string", placeholder: "id|name", description: "Area this probably belongs to (a review hint)" },
    "dry-run": { type: "boolean", description: "Print the command that would be sent instead of sending it" }
  },
  mutates: true,
  examples: ['capture "Book the dentist follow-up"', 'capture "Ask Sam about the lease" --area Home'],
  async run(context, args) {
    requirePositional(captureCommand, args, 0);
    // An unquoted `capture Buy milk and eggs` arrives as four words; keep all of them.
    const text = args.positionals.join(" ").trim();
    if (text === "") throw new CliError("capture needs some text.", EXIT.usage);
    if (text.length > CAPTURE_MAX_CHARS)
      throw new CliError(`capture text is limited to ${CAPTURE_MAX_CHARS} characters.`, EXIT.usage);

    const state = await context.client.getState();
    const areaQuery = stringOption(args.values, "area");
    const areaId = areaQuery === undefined ? undefined : String(resolveReference(state, "areas", areaQuery).id);

    const def = findEntityType("capture");
    if (!def) throw new CliError("The capture entity type is missing.", EXIT.usage);
    const entity = {
      text,
      status: "pending",
      ...(areaId !== undefined ? { proposedFields: { text, areaId } } : {})
    };
    const { path, payload } = buildWriteRequest(def, entity, newCommandId(), null);

    const reverse = reverseOfCreate(def, state, context.now());
    const result = await postCommand(context, args, {
      path,
      payload,
      summary: `capture "${text}"`,
      ...(reverse ? { reverse } : {})
    });
    if (!result.state) return; // --dry-run already printed the payload

    // The portal keys a new capture by its command id, so a capture already stored under the id the caller gave means
    // this send was a replay of an earlier one: the portal answered from its receipt and applied nothing.
    const key = parseCommandIdKey(args.values);
    const replayOf = alreadyStored(state, "captures", key) ? key : undefined;
    // Otherwise the saved capture has no id on the wire here, so find it as the newest pending one with this text.
    const captures = result.state.captures as unknown as Record<string, unknown>[];
    const record =
      replayOf !== undefined
        ? captures.find((capture) => capture.id === replayOf)
        : [...captures].reverse().find((capture) => capture.text === text);
    // Not on the list after an explicit --command-id means the portal replayed an earlier command with
    // that id: it applies each id once, so a different text sent under it is never stored.
    if (record === undefined && key !== undefined) {
      const message =
        "Nothing new was saved: no capture with this text exists, so this --command-id was probably used before and the earlier command was kept. Use a new id to capture this text.";
      if (context.mode !== "table") context.stdout(toJson({ ok: true, applied: false, replayed: true, message }, true));
      else context.stdout(message);
      return;
    }
    emitSaved(context, record, { fallback: "Captured.", timeZone: state.settings.timezone, replayOf });
  }
};
