import { proposeAgentChangeSchema, AGENT_BASES } from "@openrhen/contracts";
import { booleanOption, requirePositional, stringOption, type CommandSpec } from "../command.js";
import { CliError, EXIT, firstIssueMessage } from "../errors.js";
import { toJson } from "../output.js";
import { readJsonFile, sendCommand, stampCommandId, newCommandId } from "../write.js";

function payloadFrom(args: Parameters<CommandSpec["run"]>[1]): Record<string, unknown> {
  const inline = stringOption(args.values, "payload-json");
  const fromPath = stringOption(args.values, "from");
  if (inline !== undefined && fromPath !== undefined)
    throw new CliError("Give the payload with --payload-json or --from, not both.", EXIT.usage);
  if (fromPath !== undefined) return readJsonFile(fromPath);
  if (inline === undefined)
    throw new CliError("propose needs --payload-json '<json>' or --from <file.json>.", EXIT.usage);
  let parsed: unknown;
  try {
    parsed = JSON.parse(inline);
  } catch (error) {
    throw new CliError(
      `--payload-json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      EXIT.usage
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new CliError("--payload-json must be one JSON object.", EXIT.usage);
  return parsed as Record<string, unknown>;
}

export const proposeCommand: CommandSpec = {
  name: "propose",
  summary: "Propose a change for the person to confirm",
  description:
    "Files a proposal instead of writing: nothing changes in the plan until the person confirms it in the " +
    "portal's Inbox (Captured, From agents). <kind> names what confirming does; `entity_command` replays a " +
    'stored save, with --payload-json \'{"command":"save_entity","body":{...}}\' (or save_project / save_action; ' +
    "the body is that command's usual payload, including expectedVersion). The portal writes the line the " +
    "person reads from the payload itself (--summary is accepted and ignored). --basis says where the claim comes from: stated (the person said it; put their words in " +
    "--evidence), inferred (default) or observed (read from mail, a page, a file). Proposals with the same " +
    "--coalesce-key replace each other while pending; an identical pending payload is not stored twice. " +
    "There is no withdraw: to retract one, or one for a new record, tell the owner to reject it (only the owner " +
    "can reject or confirm). " +
    "An agent may hold 50 pending proposals; past that the write is refused. Needs a named agent (--agent or " +
    "OPENRHEN_AGENT). See the outcome later with `proposals`.",
  positionals: [{ name: "kind", required: true, description: "What confirming does, such as entity_command" }],
  options: {
    summary: {
      type: "string",
      placeholder: "text",
      description: "Ignored: the portal describes the change from the payload"
    },
    "payload-json": {
      type: "string",
      mcp: { type: "object" },
      placeholder: "json",
      description: "The command to replay, as one JSON object"
    },
    from: {
      type: "string",
      placeholder: "file.json",
      localPath: true,
      description: "Read the payload from a JSON file"
    },
    basis: {
      type: "string",
      placeholder: AGENT_BASES.join("|"),
      description: "Where the claim comes from (default inferred)"
    },
    evidence: {
      type: "string",
      placeholder: "text",
      description: "The person's own words, for a stated basis (at most 300 characters)"
    },
    "coalesce-key": {
      type: "string",
      placeholder: "key",
      description: "A pending proposal from you with this key is replaced by this one"
    },
    "dry-run": { type: "boolean", description: "Print the proposal that would be sent instead of sending it" }
  },
  mutates: true,
  examples: [
    `propose entity_command --payload-json '{"command":"save_entity","body":{...}}' --basis stated --evidence "can we do Friday instead"`,
    "propose entity_command --from change.json --coalesce-key thesis-block"
  ],
  async run(context, args) {
    const kind = requirePositional(proposeCommand, args, 0);
    const summary = stringOption(args.values, "summary");
    const payload = payloadFrom(args);
    const request: Record<string, unknown> = {
      commandId: newCommandId(),
      kind,
      ...(summary !== undefined ? { summary } : {}),
      payload,
      ...(stringOption(args.values, "basis") !== undefined ? { basis: stringOption(args.values, "basis") } : {}),
      ...(stringOption(args.values, "evidence") !== undefined
        ? { evidence: stringOption(args.values, "evidence") }
        : {}),
      ...(stringOption(args.values, "coalesce-key") !== undefined
        ? { coalesceKey: stringOption(args.values, "coalesce-key") }
        : {})
    };
    const checked = proposeAgentChangeSchema.safeParse(request);
    if (!checked.success) throw new CliError(`Proposal is invalid: ${firstIssueMessage(checked.error)}`, EXIT.usage);

    const stamped = stampCommandId(context, args, request);
    context.stderr(`rhen: propose ${kind}`);
    if (booleanOption(args.values, "dry-run")) {
      context.stdout(toJson({ dryRun: true, path: "/api/agent-proposals", payload: stamped.payload }, true));
      return;
    }
    const result = await sendCommand<{ proposal: { id: string; status: string; summary: string }; outcome: string }>(
      context.client,
      "/api/agent-proposals",
      stamped.payload,
      stamped.key
    );
    if (context.mode !== "table") {
      context.stdout(toJson(result, true));
      return;
    }
    const verb =
      result.outcome === "coalesced"
        ? "Replaced your pending proposal"
        : result.outcome === "existing"
          ? "Already proposed"
          : "Proposed";
    context.stdout(`${verb} ${result.proposal.id}: waiting for the person to confirm. See \`rhen proposals\`.`);
  }
};
