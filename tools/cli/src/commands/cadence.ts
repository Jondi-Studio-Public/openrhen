import { recordCadenceCompletionCommandSchema } from "@openrhen/contracts";
import type { CommandContext, CommandSpec } from "../command.js";
import { requirePositional, stringOption } from "../command.js";
import { CliError, EXIT } from "../errors.js";
import { resolveReference } from "../resolve.js";
import { clockParts } from "../when.js";
import { newCommandId, postCommand, printOutcome, versionOf } from "../write.js";

const pad = (value: number): string => String(value).padStart(2, "0");

export const cadenceCommand: CommandSpec = {
  name: "cadence",
  summary: "Record a cadence completion",
  description:
    "`cadence complete <action>` marks one cycle of a cadence action done outside the app. Dated by " +
    "local day (today by default, or --date); the same day recorded twice is one completion, not two.",
  positionals: [
    { name: "subcommand", required: true, description: 'Only "complete" is supported' },
    { name: "action", required: true, description: "The action's id or exact title" }
  ],
  options: {
    date: {
      type: "string",
      placeholder: "YYYY-MM-DD|today",
      description: 'The local day completed; "today" resolves in the portal\'s own timezone'
    },
    minutes: {
      type: "string",
      mcp: { type: "integer", minimum: 0 },
      placeholder: "n",
      description: "Minutes spent, a non-negative integer"
    },
    "dry-run": { type: "boolean", description: "Print the command instead of sending it" }
  },
  mutates: true,
  examples: [
    'cadence complete "Morning stretch"',
    "cadence complete action-stretch --date today --minutes 20",
    "cadence complete action-stretch --date 2026-09-01 --dry-run"
  ],
  async run(context: CommandContext, args) {
    const subcommand = requirePositional(cadenceCommand, args, 0);
    if (subcommand !== "complete")
      throw new CliError(`Unknown cadence subcommand "${subcommand}". Only "complete" is supported.`, EXIT.usage);
    const actionQuery = requirePositional(cadenceCommand, args, 1);

    const state = await context.client.getState();
    const action = resolveReference(state, "actions", actionQuery);
    const actionId = String(action.id);

    const dateOption = stringOption(args.values, "date");
    let localDate: string | undefined;
    if (dateOption === "today") {
      const parts = clockParts(context.now(), state.settings.timezone);
      localDate = `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
    } else if (dateOption !== undefined) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateOption))
        throw new CliError(`--date must be YYYY-MM-DD or "today", got "${dateOption}".`, EXIT.usage);
      localDate = dateOption;
    }

    const minutesOption = stringOption(args.values, "minutes");
    let minutes: number | undefined;
    if (minutesOption !== undefined) {
      if (!/^\d+$/.test(minutesOption))
        throw new CliError(`--minutes must be a non-negative integer, got "${minutesOption}".`, EXIT.usage);
      minutes = Number(minutesOption);
    }

    const payload: Record<string, unknown> = {
      commandId: newCommandId(),
      expectedVersion: versionOf(action),
      type: "record_cadence_completion",
      actionId,
      ...(localDate !== undefined ? { localDate } : {}),
      ...(minutes !== undefined ? { minutes } : {})
    };
    const parsed = recordCadenceCompletionCommandSchema.safeParse(payload);
    if (!parsed.success)
      throw new CliError("This cadence command does not match the contract.", EXIT.validation, parsed.error.issues);

    const result = await postCommand(context, args, {
      path: "/api/commands/cadence-completion",
      payload,
      summary: `record a cadence completion for ${String(action.title ?? actionId)}`
    });
    if (result.state === null) return;
    printOutcome(context, result.state, {
      stateKey: "actions",
      id: actionId,
      fallback: "Cadence completion recorded.",
      timeZone: state.settings.timezone
    });
  }
};
