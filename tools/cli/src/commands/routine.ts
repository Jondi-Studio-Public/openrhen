import { planningEntityCommandSchema } from "@openrhen/contracts";
import { requirePositional, stringOption, type CommandContext, type CommandSpec } from "../command.js";
import { CliError, EXIT } from "../errors.js";
import { resolveReference } from "../resolve.js";
import { derivedEntityId, newCommandId, postCommand, printOutcome } from "../write.js";

/** Keep an after-only or empty preset from producing a commitment shorter than the portal allows. */
const MIN_RUN_MINUTES = 5;

interface PresetStep {
  durationMinutes: number;
  phase?: string;
}

export const routineCommand: CommandSpec = {
  name: "routine",
  summary: "Run a routine preset now, outside any planned commitment or sleep",
  description:
    "`run <preset>` fires a routine preset on demand — for a disruption, a missed routine, or anything the " +
    "calendar did not plan. A routine only ever hangs off a commitment or a night's sleep, so this saves a " +
    "one-off commitment titled for the preset (override with --title) with the preset pinned " +
    "(routineSource=preset): its before-steps are scheduled to finish exactly as the commitment starts, so it " +
    "starts after the before-steps' total minutes from now, and runs as long as its after-steps (at least " +
    `${MIN_RUN_MINUTES} minutes). The engine then materialises the steps like any other commitment's; run ` +
    "`recalculate` and read `status` to see the first one. Step the routine with `activity start/finish/" +
    "skip-step`, add or change steps with `save routine-step`, and edit the template itself with " +
    "`save routine-preset`.",
  positionals: [
    { name: "subcommand", required: true, description: "Only: run" },
    { name: "preset", required: true, description: "The routine preset's id or name" }
  ],
  options: {
    title: {
      type: "string",
      placeholder: "text",
      description: "Title for the one-off commitment (default: preset name)"
    },
    "dry-run": { type: "boolean", description: "Print the command instead of sending it" }
  },
  mutates: true,
  examples: [
    'routine run "Gym prep"',
    'routine run preset-morning --title "Late start routine"',
    "routine run preset-gym --dry-run"
  ],
  async run(context: CommandContext, args) {
    const subcommand = requirePositional(routineCommand, args, 0);
    if (subcommand !== "run") throw new CliError(`Unknown routine subcommand "${subcommand}". Use: run.`, EXIT.usage);
    const state = await context.client.getState();
    const now = context.now();

    const preset = resolveReference(state, "routine-presets", requirePositional(routineCommand, args, 1));
    if (preset.status === "archived")
      throw new CliError(`Routine "${String(preset.name)}" is archived; restore it first.`, EXIT.usage);
    const steps = ((preset.steps as PresetStep[] | undefined) ?? []).filter((step) => step.durationMinutes >= 0);
    if (steps.length === 0) throw new CliError(`Routine "${String(preset.name)}" has no steps.`, EXIT.usage);

    const total = (phase: string) =>
      steps.filter((step) => (step.phase ?? "before") === phase).reduce((sum, step) => sum + step.durationMinutes, 0);
    const lead = Math.ceil(total("before"));
    const startsAt = new Date(now.getTime() + lead * 60_000);
    const endsAt = new Date(startsAt.getTime() + Math.max(MIN_RUN_MINUTES, total("after")) * 60_000);
    const title = stringOption(args.values, "title")?.trim() || String(preset.name);
    const id = derivedEntityId(context, args, "routine-run-entity");

    const payload = {
      commandId: newCommandId(),
      type: "save_entity",
      expectedVersion: null,
      entityType: "commitment",
      entity: {
        id,
        title,
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        status: "confirmed",
        setupBeforeMinutes: 0,
        transitionAfterMinutes: 0,
        presence: "blocking",
        routineSource: "preset",
        routinePresetId: preset.id
      }
    };
    const parsed = planningEntityCommandSchema.safeParse(payload);
    if (!parsed.success)
      throw new CliError("This routine command does not match the contract.", EXIT.validation, parsed.error.issues);

    const result = await postCommand(context, args, {
      path: "/api/commands/entity",
      payload: parsed.data,
      summary: `run routine "${String(preset.name)}" now (${lead} min of steps before it starts)`
    });
    if (result.state === null) return;
    printOutcome(context, result.state, {
      stateKey: "commitments",
      id,
      fallback: "Routine started.",
      timeZone: state.settings.timezone
    });
  }
};
