import { MAX_PLANNED_SESSION_MINUTES, sessionCommandSchema, type CurrentDirective } from "@openrhen/contracts";
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
import { occurrenceWithTemplate, resolveStartTarget } from "../resolve.js";
import { newCommandId, postCommand, printOutcome, versionOf } from "../write.js";

const SUBCOMMANDS = [
  "start",
  "alternative",
  "pause",
  "resume",
  "continue",
  "finish",
  "block",
  "did-not-start",
  "feedback",
  "set-start"
] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

interface Built {
  payload: Record<string, unknown>;
  summary: string;
  /** True for the two commands that create/replace the active session; the rest report a fallback line. */
  showsSession: boolean;
  fallback: string;
}

function isSubcommand(value: string): value is Subcommand {
  return (SUBCOMMANDS as readonly string[]).includes(value);
}

function requireActiveSession(state: PortalState): NonNullable<PortalState["activeSession"]> {
  if (!state.activeSession)
    throw new CliError(
      "No session is running, so there is nothing to change. Call rhen_status {} to see whether a session or activity is open " +
        'and what the plan lets you start. To start work on an action call rhen_session {"subcommand":"start"}; ' +
        'to start a routine step, sleep or a fixed commitment call rhen_activity {"subcommand":"start","type":"routine_step","target":"<id or title>","minutes":<n>}.',
      EXIT.notFound,
      undefined,
      {
        nextCall: {
          tool: "rhen_status",
          arguments: {},
          note: "shows whether a session or activity is open and what can be started"
        }
      }
    );
  return state.activeSession;
}

/** The `rhen_activity finish` outcome that matches what an action session's command would have recorded. */
const ACTIVITY_OUTCOME_FOR: Record<string, string> = {
  completed: "completed",
  stopped: "stopped",
  progress: "stopped",
  unsure: "stopped",
  block: "blocked",
  skipped: "skipped",
  did_not_start: "did_not_start"
};

/**
 * `rhen_session` drives work on an ACTION only. When the open session is on anything else (a routine step,
 * sleep, a fixed commitment, a deliverable step) the portal would refuse the command with a UI-only hint, so name
 * the `rhen_activity` call that does the same thing instead.
 */
function refuseNonActionSession(
  type: string,
  args: ParsedArgs,
  session: NonNullable<PortalState["activeSession"]>
): void {
  if (!["finish", "block", "did_not_start", "request_feedback"].includes(type)) return;
  const target = session.targetType;
  if (target === undefined || target === null || target === "action") return;
  const kind = target.replace(/_/g, " ");
  const requested = type === "finish" ? (stringOption(args.values, "outcome") ?? "completed") : type;
  const outcome = ACTIVITY_OUTCOME_FOR[type === "finish" ? requested : type === "block" ? "block" : type] ?? "stopped";
  const call = { subcommand: "finish", outcome: type === "request_feedback" ? "completed" : outcome };
  if (type === "request_feedback")
    throw new CliError(
      `The open session (id ${session.id}) is on a ${kind}, which has no feedback step; feedback is only collected for action sessions. ` +
        `Nothing was changed. To end it call rhen_activity ${JSON.stringify(call)} (outcome stopped if the work is not done), ` +
        'or to pause it call rhen_activity {"subcommand":"pause"}.',
      EXIT.usage,
      undefined,
      { nextCall: { tool: "rhen_activity", arguments: call, note: `ends the open ${kind} session; or pause it` } }
    );
  throw new CliError(
    `The open session (id ${session.id}) is on a ${kind}, not an action, and rhen_session only drives actions. ` +
      `Nothing was changed. Call rhen_activity ${JSON.stringify(call)} to end it` +
      (outcome === "stopped" ? " (use outcome completed if the work is done)" : "") +
      "; rhen_activity also has pause and resume.",
    EXIT.usage,
    undefined,
    {
      nextCall: {
        tool: "rhen_activity",
        arguments: call,
        note: `ends the open ${kind} session; use outcome completed if it is done`
      }
    }
  );
}

function describeDirective(directive: CurrentDirective | undefined): string {
  if (!directive) return "unavailable";
  return `a ${directive.kind}${directive.title ? ` ("${directive.title}")` : ""}`;
}

function buildStart(args: ParsedArgs, state: PortalState, now: Date): Built {
  const actionArg = stringOption(args.values, "action");
  const startedAtRaw = stringOption(args.values, "started-at");
  const startedAt = startedAtRaw !== undefined ? validateIsoDateTime(startedAtRaw, "started-at") : undefined;
  let actionId: string;
  let template: AnyRecord | undefined;
  let plannedMinutes: number;
  let recommendationId: string | null | undefined;

  if (actionArg === undefined) {
    const directive = state.planning?.result?.currentDirective;
    if (!directive || directive.kind !== "action")
      throw new CliError(
        `--action was not given and the current directive is ${describeDirective(directive)}, not an action, so there is no action to start by default. ` +
          (directive &&
          "targetId" in directive &&
          ["routine_step", "sleep", "deliverable"].includes(directive.kind) &&
          typeof directive.recommendedMinutes === "number"
            ? `A ${directive.kind.replace(/_/g, " ")} is started with rhen_activity ${JSON.stringify({ subcommand: "start", type: directive.kind, target: directive.targetId, minutes: directive.recommendedMinutes })}; `
            : "Call rhen_status {} to see what the plan says to do now; ") +
          'to work on an action instead, call rhen_session {"subcommand":"start","action":"<action id>","minutes":<n>}.',
        EXIT.usage,
        undefined,
        {
          nextCall: {
            tool: "rhen_status",
            arguments: {},
            note: "shows the current directive and what can be started"
          }
        }
      );
    // The directive names an occurrence for a recurring series; its version is the series' own record.
    actionId = directive.targetId;
    template =
      occurrenceWithTemplate(state, actionId)?.template ??
      (state.actions.find((action) => action.id === actionId) as AnyRecord | undefined);
    plannedMinutes = parseMinutes(args, "minutes", false, "rhen_session call") ?? directive.recommendedMinutes;
    recommendationId = state.currentRecommendationId ?? null;
    // A backfilled start works the occurrence open at `--started-at`. When the directive's occurrence is not
    // that one, resolve the series the way `--action` does; the recommendation names the directive's
    // occurrence, so it is not sent for another.
    const named = occurrenceWithTemplate(state, actionId);
    if (
      named &&
      startedAt !== undefined &&
      !(
        Date.parse(String(named.occurrence.windowStartsAt)) <= Date.parse(startedAt) &&
        Date.parse(startedAt) < Date.parse(String(named.occurrence.windowEndsAt))
      )
    ) {
      const target = resolveStartTarget(state, String(named.occurrence.actionId), new Date(startedAt));
      actionId = target.actionId;
      template = target.template;
      recommendationId = undefined;
    }
  } else {
    // A backfilled start works the occurrence open at that time, not the one open now.
    const target = resolveStartTarget(state, actionArg, startedAt !== undefined ? new Date(startedAt) : now);
    actionId = target.actionId;
    template = target.template;
    plannedMinutes = parseMinutes(args, "minutes", true, "rhen_session call");
  }

  const payload = {
    commandId: newCommandId(),
    expectedVersion: versionOf(template),
    type: "start",
    actionId,
    plannedMinutes,
    ...(recommendationId !== undefined ? { recommendationId } : {}),
    ...(startedAt !== undefined ? { startedAt } : {})
  };
  return {
    payload,
    summary: `start a session on ${actionId} for ${plannedMinutes} min${startedAt !== undefined ? `, started at ${startedAt}` : ""}`,
    showsSession: true,
    fallback: "Session started."
  };
}

function buildAlternative(args: ParsedArgs, state: PortalState, now: Date): Built {
  const actionArg = stringOption(args.values, "action");
  if (actionArg === undefined) throw new CliError("--action is required.", EXIT.usage);
  const startedAtRaw = stringOption(args.values, "started-at");
  const startedAt = startedAtRaw !== undefined ? validateIsoDateTime(startedAtRaw, "started-at") : undefined;
  // A backfilled start works the occurrence open at that time, not the one open now.
  const target = resolveStartTarget(state, actionArg, startedAt !== undefined ? new Date(startedAt) : now);
  // The server only accepts an alternative that is a candidate of the current recommendation, and those name
  // the occurrences open now. A past occurrence can only be backfilled as a plain start.
  if (
    target.occurrence &&
    startedAt !== undefined &&
    !(
      Date.parse(String(target.occurrence.windowStartsAt)) <= now.getTime() &&
      now.getTime() < Date.parse(String(target.occurrence.windowEndsAt))
    )
  )
    throw new CliError(
      `"${target.actionId}" is an occurrence whose window has passed, so it is not a current alternative. ` +
        "To record work on it, use `session start --action <occurrence id> --started-at <iso>` instead.",
      EXIT.usage
    );
  const match = target.template;
  const plannedMinutes = parseMinutes(args, "minutes", true, "rhen_session call");
  const reason = stringOption(args.values, "reason");
  if (reason === undefined) throw new CliError("--reason is required.", EXIT.usage);
  const note = stringOption(args.values, "note");

  const payload = {
    commandId: newCommandId(),
    expectedVersion: versionOf(match),
    type: "select_alternative",
    actionId: target.actionId,
    plannedMinutes,
    recommendationId: state.currentRecommendationId ?? null,
    reason,
    ...(note !== undefined ? { note } : {}),
    ...(startedAt !== undefined ? { startedAt } : {})
  };
  return {
    payload,
    summary: `start ${String(match.title ?? match.id)} instead of the recommendation`,
    showsSession: true,
    fallback: "Session started."
  };
}

function buildSetStart(args: ParsedArgs, state: PortalState): Built {
  const session = requireActiveSession(state);
  const startedAtRaw = stringOption(args.values, "started-at");
  if (startedAtRaw === undefined) throw new CliError("--started-at is required.", EXIT.usage);
  const startedAt = validateIsoDateTime(startedAtRaw, "started-at");
  return {
    payload: {
      commandId: newCommandId(),
      expectedVersion: versionOf(session as unknown as AnyRecord),
      type: "correct_start",
      sessionId: session.id,
      startedAt
    },
    summary: `move the running session's start to ${startedAt}`,
    showsSession: true,
    fallback: "Session start corrected."
  };
}

function buildSessionAddressed(
  type: "pause" | "resume" | "request_feedback" | "continue" | "finish" | "block" | "did_not_start",
  args: ParsedArgs,
  state: PortalState
): Built {
  const session = requireActiveSession(state);
  refuseNonActionSession(type, args, session);
  const base = {
    commandId: newCommandId(),
    expectedVersion: versionOf(session as unknown as AnyRecord),
    type,
    sessionId: session.id
  };

  switch (type) {
    case "pause":
      return { payload: base, summary: "pause the running session", showsSession: false, fallback: "Session paused." };
    case "resume":
      return { payload: base, summary: "resume the paused session", showsSession: false, fallback: "Session resumed." };
    case "request_feedback":
      return {
        payload: base,
        summary: "request feedback on the running session",
        showsSession: false,
        fallback: "Feedback requested."
      };
    case "continue": {
      const requestedMinutes = parseMinutes(args, "minutes", true, "rhen_session call");
      return {
        payload: { ...base, requestedMinutes },
        summary: `extend the session by ${requestedMinutes} min`,
        showsSession: false,
        fallback: "Session extended."
      };
    }
    case "finish": {
      const outcome = stringOption(args.values, "outcome") ?? "completed";
      const remainingRaw = stringOption(args.values, "remaining");
      // The portal reads the estimate only for progress (completed leaves nothing, unsure keeps the old one),
      // so on any other outcome it would be dropped without a word.
      if (remainingRaw !== undefined && outcome !== "progress")
        throw new CliError(
          `--remaining only applies with --outcome progress (it sets the effort left after partial work); this finish is --outcome ${outcome}.`,
          EXIT.usage
        );
      if (outcome === "progress" && remainingRaw === undefined)
        throw new CliError(
          "--outcome progress needs --remaining <minutes>: the whole minutes of effort left after this work (0 or more). " +
            "Send it with the finish, or finish with --outcome completed if nothing is left.",
          EXIT.validation
        );
      const remainingMinutes = remainingRaw === undefined ? undefined : Number(remainingRaw);
      const note = stringOption(args.values, "note");
      const endedAtRaw = stringOption(args.values, "ended-at");
      const endedAt = endedAtRaw !== undefined ? validateIsoDateTime(endedAtRaw, "ended-at") : undefined;
      return {
        payload: {
          ...base,
          outcome,
          ...(remainingMinutes !== undefined ? { remainingMinutes } : {}),
          ...(note !== undefined ? { note } : {}),
          ...(endedAt !== undefined ? { endedAt } : {})
        },
        summary: `finish the session (${outcome})${endedAt !== undefined ? `, ended at ${endedAt}` : ""}`,
        showsSession: false,
        fallback: `Session finished (${outcome}).`
      };
    }
    case "block": {
      const reason = stringOption(args.values, "reason");
      if (reason === undefined) throw new CliError("--reason is required.", EXIT.usage);
      const actionStatus = stringOption(args.values, "status") ?? "blocked";
      const note = stringOption(args.values, "note");
      return {
        payload: { ...base, reason, actionStatus, ...(note !== undefined ? { note } : {}) },
        summary: `block the session (${reason})`,
        showsSession: false,
        fallback: `Session blocked (${actionStatus}).`
      };
    }
    case "did_not_start": {
      const note = stringOption(args.values, "note");
      return {
        payload: { ...base, ...(note !== undefined ? { note } : {}) },
        summary: "mark the session as not started",
        showsSession: false,
        fallback: "Session marked as not started."
      };
    }
  }
}

function build(subcommand: Subcommand, args: ParsedArgs, state: PortalState, now: Date): Built {
  switch (subcommand) {
    case "start":
      return buildStart(args, state, now);
    case "alternative":
      return buildAlternative(args, state, now);
    case "pause":
      return buildSessionAddressed("pause", args, state);
    case "resume":
      return buildSessionAddressed("resume", args, state);
    case "feedback":
      return buildSessionAddressed("request_feedback", args, state);
    case "continue":
      return buildSessionAddressed("continue", args, state);
    case "finish":
      return buildSessionAddressed("finish", args, state);
    case "block":
      return buildSessionAddressed("block", args, state);
    case "did-not-start":
      return buildSessionAddressed("did_not_start", args, state);
    case "set-start":
      return buildSetStart(args, state);
  }
}

function printSessionRecord(context: CommandContext, state: PortalState): void {
  const session = state.activeSession;
  if (context.mode !== "table") {
    context.stdout(toJson(session ?? { ok: true, message: "Session started." }, true));
    return;
  }
  context.stdout(session ? renderRecord(session, { timeZone: state.settings.timezone }) : "Session started.");
}

export const sessionCommand: CommandSpec = {
  name: "session",
  summary: "Start, pause, resume, finish, or block a work session",
  description:
    "Drives the lifecycle of a work session against an action: start the recommended action or a named one, " +
    "take a deliberate alternative instead of the recommendation, pause and resume, extend, request feedback, " +
    "finish with an outcome, mark it blocked or waiting, or record that it never started. Every write is " +
    "validated locally against the command contract before it reaches the portal.",
  positionals: [
    {
      name: "subcommand",
      required: true,
      description: `One of: ${SUBCOMMANDS.join(", ")}`
    }
  ],
  options: {
    action: {
      type: "string",
      placeholder: "id|title",
      description:
        "The action or recurring occurrence to start (default: the current recommendation). A recurring action's title or id picks its current occurrence; pass an occurrence id to be exact"
    },
    minutes: {
      type: "string",
      mcp: { type: "integer", minimum: 1, maximum: MAX_PLANNED_SESSION_MINUTES },
      placeholder: "n",
      description: "Planned minutes (start/alternative/continue)"
    },
    reason: { type: "string", placeholder: "reason", description: "Why (alternative/block)" },
    note: { type: "string", placeholder: "text", description: "A short note" },
    status: {
      type: "string",
      placeholder: "waiting|blocked",
      description: "The action's status after block (default: blocked)"
    },
    remaining: {
      type: "string",
      mcp: { type: "integer", minimum: 0 },
      placeholder: "n",
      description: "Remaining minutes (finish --outcome progress)"
    },
    outcome: {
      type: "string",
      placeholder: "outcome",
      description: "completed|progress|unsure (finish, default: completed)"
    },
    "started-at": {
      type: "string",
      placeholder: "iso",
      description:
        "ISO 8601 past start time, within 24 hours (start/alternative, or set-start to correct the session already running)"
    },
    "ended-at": {
      type: "string",
      placeholder: "iso",
      description:
        "ISO 8601 past end time for finish, on a running session or one awaiting feedback: after the start of the segment it ends and no later than now. For a paused session omit it: its end is the pause already recorded"
    },
    "dry-run": { type: "boolean", description: "Print the payload instead of sending it" }
  },
  mutates: true,
  examples: [
    "session start",
    'session start --action "Fix citations" --minutes 30',
    'session start --action "Fix citations" --minutes 30 --started-at 2026-09-03T09:00:00+10:00',
    'session alternative --action "Weed the beds" --minutes 20 --reason lower_energy',
    "session set-start --started-at 2026-09-03T09:00:00+10:00",
    "session pause",
    "session continue --minutes 15",
    "session finish --outcome progress --remaining 30",
    "session finish --outcome completed --ended-at 2026-09-03T09:45:00+10:00",
    'session block --reason waiting_on_someone --status waiting --note "Waiting on supervisor"'
  ],
  async run(context, args) {
    const subcommandArg = requirePositional(sessionCommand, args, 0);
    if (!isSubcommand(subcommandArg))
      throw new CliError(
        `Unknown session subcommand "${subcommandArg}". Use one of: ${SUBCOMMANDS.join(", ")}.`,
        EXIT.usage
      );

    const state = await context.client.getState();
    const { payload, summary, showsSession, fallback } = build(subcommandArg, args, state, context.now());

    const parsed = sessionCommandSchema.safeParse(payload);
    if (!parsed.success) throw new CliError(firstIssueMessage(parsed.error), EXIT.validation, parsed.error.issues);

    const result = await postCommand(context, args, {
      path: "/api/commands/session",
      payload: parsed.data as unknown as Record<string, unknown>,
      summary,
      reverse: "server"
    });
    if (result.state === null) return;

    if (showsSession) {
      printSessionRecord(context, result.state);
    } else printOutcome(context, result.state, { fallback });
  }
};
