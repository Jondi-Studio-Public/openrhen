import { MAX_PLANNED_SESSION_MINUTES, activityCommandSchema } from "@openrhen/contracts";
import type { PortalState } from "../client.js";
import {
  parseMinutes,
  requirePositional,
  stringOption,
  validateIsoDateTime,
  type CommandContext,
  type CommandSpec,
  type ParsedArgs
} from "../command.js";
import type { AnyRecord } from "../entities.js";
import { CliError, EXIT, firstIssueMessage } from "../errors.js";
import { renderRecord, toJson } from "../output.js";
import { resolveReference } from "../resolve.js";
import { newCommandId, postCommand, printOutcome, versionOf } from "../write.js";

const SUBCOMMANDS = ["start", "switch-step", "pause", "resume", "finish", "skip-step", "unskip-step"] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

const TARGET_TYPES = ["routine_step", "sleep", "fixed_commitment", "deliverable"] as const;
type TargetType = (typeof TARGET_TYPES)[number];

interface Built {
  payload: Record<string, unknown>;
  summary: string;
  /** True only for `start`, which creates the new active session shown back to the caller. */
  showsSession: boolean;
  fallback: string;
  /** The write that puts this one back, for `undo`; a skip, a pause and their opposites have one. */
  reverse?: { payload: Record<string, unknown>; target: { stateKey: string; id?: string } };
}

function isSubcommand(value: string): value is Subcommand {
  return (SUBCOMMANDS as readonly string[]).includes(value);
}

function isTargetType(value: string): value is TargetType {
  return (TARGET_TYPES as readonly string[]).includes(value);
}

function requireActiveSession(state: PortalState): NonNullable<PortalState["activeSession"]> {
  if (!state.activeSession) throw new CliError("No session is running.", EXIT.notFound);
  return state.activeSession;
}

/** Finds the target named by `--target` in the state array its type lives in, by id for routine/sleep targets and by id-or-title for commitments and deliverables. */
function resolveTarget(state: PortalState, targetType: TargetType, targetArg: string): AnyRecord {
  switch (targetType) {
    case "fixed_commitment":
      return resolveReference(state, "commitments", targetArg);
    case "deliverable":
      return resolveReference(state, "deliverables", targetArg);
    case "routine_step": {
      // one table for either anchor now — a commitment's own preparation step and a
      // bedtime/wake step are both rows here, so no separate "routine instance" target type remains.
      const match = state.routineSteps.find((step) => step.id === targetArg) as AnyRecord | undefined;
      if (!match) throw new CliError(`No routine step with id "${targetArg}".`, EXIT.notFound);
      return match;
    }
    case "sleep": {
      const match = state.sleepPlans.find((plan) => plan.id === targetArg) as AnyRecord | undefined;
      if (!match) throw new CliError(`No sleep plan with id "${targetArg}".`, EXIT.notFound);
      return match;
    }
  }
}

function buildStart(args: ParsedArgs, state: PortalState): Built {
  const targetTypeArg = stringOption(args.values, "type");
  if (targetTypeArg === undefined) throw new CliError("--type is required.", EXIT.usage);
  if (!isTargetType(targetTypeArg))
    throw new CliError(`Unknown --type "${targetTypeArg}". Use one of: ${TARGET_TYPES.join(", ")}.`, EXIT.usage);

  const targetArg = stringOption(args.values, "target");
  if (targetArg === undefined) throw new CliError("--target is required.", EXIT.usage);
  const plannedMinutes = parseMinutes(args, "minutes", true, "rhen_activity call");
  const stepId = stringOption(args.values, "step");
  const phase = stringOption(args.values, "phase");
  const startedAtRaw = stringOption(args.values, "started-at");
  const startedAt = startedAtRaw !== undefined ? validateIsoDateTime(startedAtRaw, "started-at") : undefined;

  const target = resolveTarget(state, targetTypeArg, targetArg);
  const targetId = target.id as string;

  const payload = {
    commandId: newCommandId(),
    expectedVersion: versionOf(target),
    type: "start_activity",
    targetType: targetTypeArg,
    targetId,
    ...(stepId !== undefined ? { stepId } : {}),
    plannedMinutes,
    ...(phase !== undefined ? { phase } : {}),
    ...(startedAt !== undefined ? { startedAt } : {})
  };
  return {
    payload,
    summary: `start ${targetTypeArg} ${targetId} for ${plannedMinutes} min${startedAt !== undefined ? `, started at ${startedAt}` : ""}`,
    showsSession: true,
    fallback: "Activity started."
  };
}

function buildSwitchStep(args: ParsedArgs, state: PortalState): Built {
  const session = requireActiveSession(state);
  const stepId = stringOption(args.values, "step");
  if (stepId === undefined) throw new CliError("--step is required.", EXIT.usage);
  return {
    payload: {
      commandId: newCommandId(),
      expectedVersion: versionOf(session as unknown as AnyRecord),
      type: "switch_deliverable_step",
      sessionId: session.id,
      stepId
    },
    summary: `switch to step ${stepId}`,
    showsSession: false,
    fallback: "Switched to the next step."
  };
}

function buildPauseOrResume(type: "pause_activity" | "resume_activity", args: ParsedArgs, state: PortalState): Built {
  const session = requireActiveSession(state);
  // Resuming has no note field on the contract — a pause reason belongs to the pause it explains,
  // not to whatever ends the interruption.
  const note = type === "pause_activity" ? stringOption(args.values, "note") : undefined;
  return {
    payload: {
      commandId: newCommandId(),
      expectedVersion: versionOf(session as unknown as AnyRecord),
      type,
      sessionId: session.id,
      ...(note !== undefined ? { note } : {})
    },
    reverse: {
      payload: { type: type === "pause_activity" ? "resume_activity" : "pause_activity", sessionId: session.id },
      // The open session is a different row for each session: name it, so a later session is not mistaken for it.
      target: { stateKey: "activeSession", id: session.id }
    },
    summary: type === "pause_activity" ? "pause the running activity" : "resume the paused activity",
    showsSession: false,
    fallback: type === "pause_activity" ? "Activity paused." : "Activity resumed."
  };
}

function buildFinish(args: ParsedArgs, state: PortalState): Built {
  const session = requireActiveSession(state);
  const outcome = stringOption(args.values, "outcome") ?? "completed";
  const note = stringOption(args.values, "note");
  const endedAtRaw = stringOption(args.values, "ended-at");
  const endedAt = endedAtRaw !== undefined ? validateIsoDateTime(endedAtRaw, "ended-at") : undefined;

  const summaryParts = [`finish the activity (${outcome})`];
  if (endedAt !== undefined) {
    const segmentStartedAt = session.segmentStartedAt;
    if (segmentStartedAt) {
      summaryParts.push(`ended at ${endedAt} (floor: ${segmentStartedAt})`);
    } else {
      summaryParts.push(`ended at ${endedAt}`);
    }
  }

  return {
    payload: {
      commandId: newCommandId(),
      expectedVersion: versionOf(session as unknown as AnyRecord),
      type: "finish_activity",
      sessionId: session.id,
      outcome,
      ...(note !== undefined ? { note } : {}),
      ...(endedAt !== undefined ? { endedAt } : {})
    },
    summary: summaryParts.join(", "),
    showsSession: false,
    fallback: `Activity finished (${outcome}).`
  };
}

function buildSkipStep(args: ParsedArgs, state: PortalState): Built {
  const stepId = stringOption(args.values, "step");
  if (stepId === undefined) throw new CliError("--step is required.", EXIT.usage);
  // the routine step row is the record this mutates directly, for either anchor — no
  // instance id, and its own version is what the server compares against.
  const step = state.routineSteps.find((item) => item.id === stepId) as AnyRecord | undefined;
  if (!step) throw new CliError(`No routine step with id "${stepId}".`, EXIT.notFound);
  return {
    payload: {
      commandId: newCommandId(),
      expectedVersion: versionOf(step),
      type: "skip_routine_step",
      stepId
    },
    reverse: { payload: { type: "reopen_routine_step", stepId }, target: { stateKey: "routineSteps", id: stepId } },
    summary: `skip step ${stepId} (${String(step.title ?? "untitled")})`,
    showsSession: false,
    fallback: `Step skipped: ${String(step.title ?? stepId)}. Undo with: activity unskip-step --step ${stepId}`
  };
}

function buildUnskipStep(args: ParsedArgs, state: PortalState): Built {
  const stepId = stringOption(args.values, "step");
  if (stepId === undefined) throw new CliError("--step is required.", EXIT.usage);
  const step = state.routineSteps.find((item) => item.id === stepId) as AnyRecord | undefined;
  if (!step) throw new CliError(`No routine step with id "${stepId}".`, EXIT.notFound);
  if (step.status !== "skipped")
    throw new CliError(
      `Step ${stepId} is ${String(step.status)}, not skipped, so there is nothing to undo.`,
      EXIT.usage
    );
  return {
    payload: {
      commandId: newCommandId(),
      expectedVersion: versionOf(step),
      type: "reopen_routine_step",
      stepId
    },
    reverse: { payload: { type: "skip_routine_step", stepId }, target: { stateKey: "routineSteps", id: stepId } },
    summary: `reopen skipped step ${stepId} (${String(step.title ?? "untitled")})`,
    showsSession: false,
    fallback: "Step reopened."
  };
}

function build(subcommand: Subcommand, args: ParsedArgs, state: PortalState): Built {
  switch (subcommand) {
    case "start":
      return buildStart(args, state);
    case "switch-step":
      return buildSwitchStep(args, state);
    case "pause":
      return buildPauseOrResume("pause_activity", args, state);
    case "resume":
      return buildPauseOrResume("resume_activity", args, state);
    case "finish":
      return buildFinish(args, state);
    case "skip-step":
      return buildSkipStep(args, state);
    case "unskip-step":
      return buildUnskipStep(args, state);
  }
}

/**
 * A start the portal refuses because the plan is not tracking that target says only that; the caller then has to
 * guess what it may start. Adds where the valid targets are listed, and the one thing that decides it: the plan only
 * lets you start what it is tracking right now.
 */
function withValidTargets(error: unknown): unknown {
  if (!(error instanceof CliError)) return error;
  if (!/not present in the current Plan|is not the one running now/.test(error.message)) return error;
  const guidance =
    " The plan only lets you start what it is tracking right now, never something scheduled for later. Call " +
    "`status` to see the one routine step, sleep plan or commitment (and its phase) it lets you start now; `list " +
    "routine-steps`, `list sleep-plans` and `list commitments` give the ids. If `status` names none of them, there " +
    "is nothing of this kind to start yet: wait, or ask the owner.";
  return new CliError(`${error.message}${guidance}`, error.exitCode, error.details, {
    ...error.agent,
    ...(error.agent.plainMessage === undefined ? {} : { plainMessage: `${error.agent.plainMessage}${guidance}` }),
    ...(error.agent.nextCall === undefined
      ? { nextCall: { tool: "rhen_status", arguments: {}, note: "Shows what the plan lets you start now." } }
      : {})
  });
}

function printSessionRecord(context: CommandContext, state: PortalState): void {
  const session = state.activeSession;
  if (context.mode !== "table") {
    context.stdout(toJson(session ?? { ok: true, message: "Activity started." }, true));
    return;
  }
  context.stdout(session ? renderRecord(session, { timeZone: state.settings.timezone }) : "Activity started.");
}

export const activityCommand: CommandSpec = {
  name: "activity",
  summary: "Start, pause, resume, or finish an activity session",
  description:
    "Drives the lifecycle of a session against a non-action target: a routine step (a commitment's own " +
    "preparation, or a bedtime/wake step), sleep, a fixed commitment's phase, or a deliverable step. Start, " +
    "switch which deliverable step is being timed, pause and resume, finish with an outcome, skip a routine " +
    "step outright, or unskip one skipped by mistake (either anchor). Every write is validated locally against the command contract before it reaches the portal.",
  positionals: [
    {
      name: "subcommand",
      required: true,
      description: `One of: ${SUBCOMMANDS.join(", ")}`
    }
  ],
  options: {
    type: { type: "string", placeholder: "type", description: "Target type: " + TARGET_TYPES.join(", ") + " (start)" },
    target: { type: "string", placeholder: "id|title", description: "The target to start (start)" },
    step: { type: "string", placeholder: "id", description: "A step id (start/switch-step/skip-step/unskip-step)" },
    minutes: {
      type: "string",
      mcp: { type: "integer", minimum: 1, maximum: MAX_PLANNED_SESSION_MINUTES },
      placeholder: "n",
      description:
        "Planned minutes, required for start (whole minutes, 1 to 1440; for a routine step, sleep plan or deliverable step exactly the minutes the plan gives it)"
    },
    phase: {
      type: "string",
      placeholder: "phase",
      description: "setup|travel|arrival|active|transition|return (start, fixed_commitment only)"
    },
    outcome: {
      type: "string",
      placeholder: "outcome",
      description: "completed|stopped|blocked|did_not_start|skipped (finish)"
    },
    note: { type: "string", placeholder: "text", description: "A short note (pause, finish)" },
    "started-at": {
      type: "string",
      placeholder: "iso",
      description: "ISO 8601 past start time, within 24 hours (start)"
    },
    "ended-at": {
      type: "string",
      placeholder: "iso",
      description:
        "ISO 8601 end time (finish), on a running session or one awaiting feedback. For a paused session omit it: its end is the pause already recorded"
    },
    "dry-run": { type: "boolean", description: "Print the payload instead of sending it" }
  },
  mutates: true,
  examples: [
    "activity start --type fixed_commitment --target 'Gym session' --minutes 60 --phase setup",
    "activity start --type deliverable --target 'Chapter 3 draft' --step step-write --minutes 45",
    "activity start --type deliverable --target 'Chapter 3 draft' --minutes 45 --started-at 2026-09-03T09:00:00+10:00",
    "activity switch-step --step step-outline",
    "activity pause --note 'Kid needs help with homework'",
    "activity finish --outcome completed --note 'All done'",
    "activity skip-step --step step-pack",
    "activity unskip-step --step step-pack"
  ],
  async run(context, args) {
    const subcommandArg = requirePositional(activityCommand, args, 0);
    if (!isSubcommand(subcommandArg))
      throw new CliError(
        `Unknown activity subcommand "${subcommandArg}". Use one of: ${SUBCOMMANDS.join(", ")}.`,
        EXIT.usage
      );

    const state = await context.client.getState();
    const { payload, summary, showsSession, fallback, reverse } = build(subcommandArg, args, state);

    const parsed = activityCommandSchema.safeParse(payload);
    if (!parsed.success) throw new CliError(firstIssueMessage(parsed.error), EXIT.validation, parsed.error.issues);

    const result = await postCommand(context, args, {
      path: "/api/commands/activity",
      payload: parsed.data as unknown as Record<string, unknown>,
      summary,
      ...(reverse
        ? {
            reverse: {
              undo: {
                path: "/api/commands/activity",
                payload: { commandId: newCommandId(), expectedVersion: null, ...reverse.payload }
              },
              target: reverse.target
            }
          }
        : {})
    }).catch((error: unknown) => {
      throw subcommandArg === "start" ? withValidTargets(error) : error;
    });
    if (result.state === null) return;

    if (showsSession) {
      printSessionRecord(context, result.state);
    } else printOutcome(context, result.state, { fallback });
  }
};
