import { STRETCH_CHOICES, stretchCommandSchema, type StretchResult } from "@openrhen/contracts";
import { booleanOption, stringOption, type CommandSpec } from "../command.js";
import { CliError, EXIT, firstIssueMessage } from "../errors.js";
import { toJson } from "../output.js";
import { DRY_RUN_NOTICE, newCommandId, recordServerChecked, sendCommand, stampCommandId } from "../write.js";

export const stretchCommand: CommandSpec = {
  name: "stretch",
  summary: "Answer a stretch offer: work on a cut action for a bounded time, or decline",
  description:
    "Answers the stretch offer that `status` shows (stretchOffer): --choice accept starts the stretch for --action " +
    "(the server rechecks the offer and sets its end), decline skips that action until tomorrow, decline_all means no " +
    "stretches tonight. Tell the person the offer's sentence first. Only the person answers: send --basis stated and " +
    "--evidence (their own words) with accept or decline; decline_all may be inferred. Never raise declared energy " +
    "to get around the cut. `undo` reverses it.",
  positionals: [],
  options: {
    choice: {
      type: "string",
      placeholder: STRETCH_CHOICES.join("|"),
      description: "The person's answer to the offer"
    },
    action: {
      type: "string",
      placeholder: "id",
      description: "The offered action's id (stretchOffer.actionId in status); not for decline_all"
    },
    "dry-run": { type: "boolean", description: "Print the command instead of sending it" }
  },
  mutates: true,
  examples: [
    'stretch --choice accept --action action-draft --basis stated --evidence "Yes, give me the 45 minutes"',
    'stretch --choice decline --action action-draft --basis stated --evidence "No, I\'ll rest"',
    "stretch --choice decline_all"
  ],
  async run(context, args) {
    const choice = stringOption(args.values, "choice");
    if (choice === undefined || !(STRETCH_CHOICES as readonly string[]).includes(choice))
      throw new CliError(
        `--choice must be one of ${STRETCH_CHOICES.join(", ")}: the person's answer to the offer \`status\` shows (stretchOffer).`,
        EXIT.usage
      );
    const action = stringOption(args.values, "action");
    const basis = stringOption(args.values, "basis");
    const evidence = stringOption(args.values, "evidence");
    const request: Record<string, unknown> = {
      commandId: newCommandId(),
      choice,
      ...(action !== undefined ? { actionId: action } : {}),
      ...(basis !== undefined ? { basis } : {}),
      ...(evidence !== undefined ? { evidence } : {})
    };
    const checked = stretchCommandSchema.safeParse(request);
    if (!checked.success) throw new CliError(firstIssueMessage(checked.error), EXIT.usage);
    const stamped = stampCommandId(context, args, request);
    context.stderr("rhen: stretch");
    if (booleanOption(args.values, "dry-run")) {
      context.stdout(
        toJson(
          {
            dryRun: true,
            applied: false,
            commandId: stamped.payload.commandId,
            ...DRY_RUN_NOTICE,
            path: "/api/commands/stretch",
            payload: stamped.payload
          },
          true
        )
      );
      return;
    }
    // The portal refuses with the exact next call; `sendCommand` raises that as the error text.
    const done = await sendCommand<{ result: StretchResult; revertible?: string }>(
      context.client,
      "/api/commands/stretch",
      stamped.payload,
      stamped.key
    );
    recordServerChecked(context, done, { path: "/api/commands/stretch", sent: stamped.payload, summary: "stretch" });
    const result = done.result;
    if (context.mode !== "table") {
      context.stdout(
        toJson(
          {
            applied: true,
            commandId: stamped.payload.commandId,
            ...result,
            revertible: done.revertible ?? result.revertible
          },
          true
        )
      );
      return;
    }
    context.stdout(result.next);
  }
};
