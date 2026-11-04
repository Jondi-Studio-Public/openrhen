import { recordDisruptionCommandSchema } from "@openrhen/contracts";
import { booleanOption, stringOption, type CommandContext, type CommandSpec } from "../command.js";
import { entityItems, findEntity, type AnyRecord } from "../entities.js";
import { CliError, EXIT, firstIssueMessage } from "../errors.js";
import { toJson } from "../output.js";
import { parseWhen } from "../when.js";
import { newCommandId, recordServerChecked, sendCommand, stampCommandId } from "../write.js";

const TARGET_KINDS = ["action", "deliverable", "commitment", "project"] as const;

function conditions(items: AnyRecord[], wantLocation: boolean): { id: string; name: string }[] {
  return items
    .filter((item) => (item.kind === "location") === wantLocation && item.status !== "archived")
    .map((item) => ({ id: String(item.id), name: typeof item.name === "string" ? item.name : String(item.id) }));
}

/** An id, or a name matched exactly (ignoring case), against what the portal lists. */
function resolveNamed(kind: string, query: string, choices: { id: string; name: string }[]): string {
  const byId = choices.find((item) => item.id === query);
  if (byId) return byId.id;
  const wanted = query.trim().toLowerCase();
  const byName = choices.find((item) => item.name.toLowerCase() === wanted);
  if (byName) return byName.id;
  throw new CliError(
    `No ${kind} with id or name "${query}". Choices: ${choices.map((item) => `${item.id} (${item.name})`).join(", ") || "none"}.`,
    EXIT.notFound
  );
}

function parseExclusive(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  const text = raw.trim().toLowerCase();
  if (["true", "yes", "all"].includes(text)) return true;
  if (["false", "no", "some"].includes(text)) return false;
  throw new CliError(`--exclusive must be true or false, got "${raw}".`, EXIT.usage);
}

function parseTarget(raw: string): { kind: (typeof TARGET_KINDS)[number]; id: string } {
  const [kind, ...rest] = raw.split(":");
  if (!(TARGET_KINDS as readonly string[]).includes(kind ?? "") || rest.length === 0 || rest.join(":").trim() === "")
    throw new CliError(`--target must be <kind>:<id> with kind ${TARGET_KINDS.join("|")}, got "${raw}".`, EXIT.usage);
  return { kind: kind as (typeof TARGET_KINDS)[number], id: rest.join(":") };
}

export const disruptCommand: CommandSpec = {
  name: "disrupt",
  summary: "Record what you are doing instead of the plan, so the deviation stays on plan",
  description:
    "A deviation stays on plan only when recorded with all of: --doing (or --target <kind>:<id>), --until (ISO time or " +
    "+90m), --location, --contexts (at least one) and --exclusive true|false (true if it takes all of them). Missing " +
    "fields are named and nothing is recorded: ask the person, do not guess. --end ends it early. No options: shows " +
    "what is in force and the places and contexts you can name. `rhen undo` reverses it.",
  positionals: [],
  options: {
    doing: {
      type: "string",
      placeholder: "text",
      description: "What they are doing instead (up to 300 characters)"
    },
    target: {
      type: "string",
      placeholder: "kind:id",
      description: `A plan item instead of free text: ${TARGET_KINDS.join("|")}:<id>`
    },
    until: { type: "string", placeholder: "time", description: "Roughly when it ends: ISO time or +90m" },
    location: { type: "string", placeholder: "place", description: "Where they are: a saved place's id or name" },
    contexts: {
      type: "string",
      placeholder: "id,id",
      description: "Contexts available meanwhile: ids or names, comma-separated"
    },
    exclusive: {
      type: "string",
      placeholder: "true|false",
      description: "true if it takes all of them, false if not"
    },
    end: { type: "boolean", description: "End the disruption in force" },
    "dry-run": { type: "boolean", description: "Print the command that would be sent instead of sending it" }
  },
  mutates: true,
  examples: [
    "disrupt",
    'disrupt --doing "Hospital visit with Mum" --until +3h --location Hospital --contexts phone --exclusive true --basis stated --evidence "at the hospital till 5"',
    "disrupt --end"
  ],
  async run(context: CommandContext, args) {
    const doing = stringOption(args.values, "doing");
    const target = stringOption(args.values, "target");
    const untilRaw = stringOption(args.values, "until");
    const location = stringOption(args.values, "location");
    const contextsRaw = stringOption(args.values, "contexts");
    const exclusive = parseExclusive(stringOption(args.values, "exclusive"));
    const end = booleanOption(args.values, "end");
    const answering = end || [doing, target, untilRaw, location, contextsRaw, exclusive].some((v) => v !== undefined);

    const state = await context.client.getState();
    const items = entityItems(state, findEntity("conditions")!);
    const places = conditions(items, true);
    const contexts = conditions(items, false);
    if (!answering) {
      const current = (state as { pulse?: { state: string; disruption?: Record<string, unknown> } }).pulse;
      const body = {
        pulse: current ? { state: current.state, disruption: current.disruption ?? null } : null,
        places,
        contexts
      };
      context.stdout(
        context.mode === "table"
          ? [
              current?.disruption ? `In force: ${toJson(current.disruption, false)}` : "No disruption is in force.",
              `Places: ${places.map((p) => `${p.id} (${p.name})`).join(", ") || "none"}.`,
              `Contexts: ${contexts.map((c) => `${c.id} (${c.name})`).join(", ") || "none"}.`
            ].join("\n")
          : toJson(body, true)
      );
      return;
    }

    const timezone = typeof state.settings?.timezone === "string" ? state.settings.timezone : undefined;
    const request: Record<string, unknown> = {
      commandId: newCommandId(),
      ...(end ? { end: true } : {}),
      ...(!end && target !== undefined
        ? { doing: { ...parseTarget(target), ...(doing !== undefined ? { title: doing } : {}) } }
        : !end && doing !== undefined
          ? { doing }
          : {}),
      ...(!end && untilRaw !== undefined ? { until: parseWhen(untilRaw, context.now(), timezone).toISOString() } : {}),
      ...(!end && location !== undefined ? { locationId: resolveNamed("place", location, places) } : {}),
      ...(!end && contextsRaw !== undefined
        ? {
            contexts: contextsRaw
              .split(",")
              .map((entry) => entry.trim())
              .filter((entry) => entry !== "")
              .map((entry) => resolveNamed("context", entry, contexts))
          }
        : {}),
      ...(!end && exclusive !== undefined ? { exclusive } : {}),
      ...(stringOption(args.values, "basis") !== undefined ? { basis: stringOption(args.values, "basis") } : {}),
      ...(stringOption(args.values, "evidence") !== undefined
        ? { evidence: stringOption(args.values, "evidence") }
        : {})
    };
    const checked = recordDisruptionCommandSchema.safeParse(request);
    if (!checked.success)
      throw new CliError(`The disruption is invalid: ${firstIssueMessage(checked.error)}`, EXIT.usage);
    const stamped = stampCommandId(context, args, request);
    context.stderr("rhen: disrupt");
    if (booleanOption(args.values, "dry-run")) {
      context.stdout(toJson({ dryRun: true, path: "/api/commands/pulse-disruption", payload: stamped.payload }, true));
      return;
    }
    // The portal refuses an incomplete one with 422, which `sendCommand` raises as a validation error naming each field.
    const done = await sendCommand<{ result: Record<string, unknown>; revertible?: string }>(
      context.client,
      "/api/commands/pulse-disruption",
      stamped.payload,
      stamped.key
    );
    recordServerChecked(context, done, {
      path: "/api/commands/pulse-disruption",
      sent: stamped.payload,
      summary: end ? "end disruption" : "disrupt"
    });
    const result = done.result;
    if (context.mode !== "table") {
      context.stdout(toJson({ ...result, revertible: done.revertible ?? result.revertible }, true));
      return;
    }
    context.stdout(
      end
        ? "Disruption ended. `rhen undo` reverses this."
        : `Recorded: ${String(result.doing)} until ${String(result.until)}. The deviation stays on plan until then. \`rhen undo\` reverses this.`
    );
  }
};
