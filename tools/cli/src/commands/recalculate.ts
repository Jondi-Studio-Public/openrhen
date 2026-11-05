import { recalculateCommandSchema } from "@openrhen/contracts";
import type { CommandContext, CommandSpec } from "../command.js";
import { stringOption } from "../command.js";
import { CliError, EXIT } from "../errors.js";
import { localiseInstants, toJson } from "../output.js";
import { formatWhen } from "../when.js";
import { commandIdOf, newCommandId, postCommand } from "../write.js";

export const recalculateCommand: CommandSpec = {
  name: "recalculate",
  summary: "Ask the engine to recalculate the plan",
  description:
    "Sends a recalculate command stamped with the current time, so the engine replans from now rather than " +
    "from whenever it last ran. --conditions overrides the asserted conditions for this run only; omit it to " +
    "plan with whatever the portal already has on file.",
  positionals: [],
  options: {
    conditions: { type: "string", placeholder: "a,b", description: "Comma-separated asserted conditions to plan with" },
    "dry-run": { type: "boolean", description: "Print the command instead of sending it" }
  },
  mutates: true,
  examples: ["recalculate", "recalculate --conditions home,laptop", "recalculate --dry-run"],
  async run(context: CommandContext, args) {
    const now = context.now().toISOString();
    const conditionsRaw = stringOption(args.values, "conditions");
    const assertedConditions = conditionsRaw
      ?.split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);

    const payload: Record<string, unknown> = {
      commandId: newCommandId(),
      type: "recalculate",
      now,
      ...(assertedConditions && assertedConditions.length > 0 ? { assertedConditions } : {})
    };
    const parsed = recalculateCommandSchema.safeParse(payload);
    if (!parsed.success)
      throw new CliError("This recalculate command does not match the contract.", EXIT.validation, parsed.error.issues);

    const result = await postCommand(context, args, {
      path: "/api/commands/recalculate",
      payload,
      summary: "recalculate the plan"
    });
    if (result.state === null) return;

    const planning = result.state.planning;
    const timeZone = result.state.settings.timezone;
    if (context.mode !== "table") {
      const summary = planning
        ? {
            applied: true,
            ...commandIdOf(context),
            status: planning.status,
            awaitingRecalculation: planning.awaitingRecalculation === true,
            lastSuccessfulAt: planning.lastSuccessfulAt ?? null
          }
        : { applied: true, ...commandIdOf(context), message: "Recalculation queued." };
      context.stdout(toJson(localiseInstants(summary, timeZone), true));
      return;
    }
    context.stdout(
      planning
        ? `rhen: ${planning.awaitingRecalculation === true ? "recalculation queued, awaiting the engine; plan " : "plan "}${planning.status}${
            planning.lastSuccessfulAt
              ? ` (last successful ${formatWhen(planning.lastSuccessfulAt, timeZone, context.now())})`
              : ""
          }.`
        : "rhen: Recalculation queued."
    );
  }
};
