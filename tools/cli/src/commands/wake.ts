import {
  WAKE_MAX_BACK_HOURS,
  wakeCommandSchema,
  wakeResultSchema,
  type PulseReentryView,
  type WakeResult
} from "@openrhen/contracts";
import {
  stringOption,
  validateIsoDateTime,
  type CommandContext,
  type CommandSpec,
  type ParsedArgs
} from "../command.js";
import { CliError, EXIT, firstIssueMessage } from "../errors.js";
import { localiseInstants, toJson } from "../output.js";
import { formatWhen } from "../when.js";
import { newCommandId, postCommand } from "../write.js";

/** The portal accepts a time this far after its own clock, for the skew between machines. */
const FUTURE_GRACE_MS = 5 * 60_000;
const OFFSET = /(?:Z|[+-]\d{2}:\d{2})$/i;

/** A `--at` / `--slept-at` value: ISO 8601 with an offset, in the past, no more than a day back. */
function pastMoment(args: ParsedArgs, name: string, now: Date): Date | undefined {
  const raw = stringOption(args.values, name);
  if (raw === undefined) return undefined;
  validateIsoDateTime(raw, name);
  if (!OFFSET.test(raw))
    throw new CliError(
      `--${name} needs an offset, the owner's UTC offset (status.timezone), like 2026-10-28T07:00:00<offset>, got "${raw}".`,
      EXIT.usage
    );
  const moment = new Date(raw);
  if (moment.getTime() > now.getTime() + FUTURE_GRACE_MS)
    throw new CliError(`--${name} must be in the past, got "${raw}".`, EXIT.usage);
  if (moment.getTime() < now.getTime() - WAKE_MAX_BACK_HOURS * 3_600_000)
    throw new CliError(
      `--${name} must be within the last ${WAKE_MAX_BACK_HOURS} hours, got "${raw}". Log an older night with ` +
        "`save sleep-log-entry` (sleepAt and wakeAt).",
      EXIT.usage
    );
  return moment;
}

function hoursMinutes(from: string, to: string): string {
  const minutes = Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 60_000));
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
}

function readResult(response: unknown): WakeResult | undefined {
  const parsed = wakeResultSchema.safeParse((response as { wake?: unknown } | null | undefined)?.wake);
  return parsed.success ? parsed.data : undefined;
}

/** One line saying what the wake did, and the night it left. */
function describe(wake: WakeResult, timeZone: string, now: Date): string {
  if (wake.outcome === "recorded_wake")
    return `Recorded the wake at ${formatWhen(wake.wokeAt, timeZone, now)}. No night was logged: give --slept-at to log one.`;
  const started = formatWhen(wake.sleptAt, timeZone, now);
  const woke = formatWhen(wake.wokeAt, timeZone, now);
  const did =
    wake.outcome === "finished_session"
      ? "Finished the running sleep"
      : wake.outcome === "completed_plan"
        ? "Completed last night's planned sleep"
        : "Logged last night";
  const assumed = wake.startAssumed
    ? ` The start is the plan's, not told: correct it with \`save sleep-log-entry --id ${wake.sleepPlanId} --set sleepAt=<time> --set wakeAt=<time>\`.`
    : "";
  return (
    `${did}: slept ${started}${wake.startAssumed ? " (assumed)" : ""}, woke ${woke} ` +
    `(${hoursMinutes(wake.sleptAt, wake.wokeAt)}).${assumed}`
  );
}

export const wakeCommand: CommandSpec = {
  name: "wake",
  summary: "Record when the person woke and settle last night's sleep",
  description:
    "Records when the person woke and settles last night in one write: a running sleep finishes at the wake; else " +
    "last night's planned sleep is completed, from --slept-at or the planned start (the answer says startAssumed); " +
    "else --slept-at logs the night, and without it only the wake is recorded. Hours already recorded as a night " +
    "are refused: correct that night with save sleep-log-entry --id. Use this, not settings lastWokeAt.",
  positionals: [],
  options: {
    at: {
      type: "string",
      placeholder: "iso",
      description: `ISO 8601 time the person woke, with an offset, in the past and within ${WAKE_MAX_BACK_HOURS} hours (default: now)`
    },
    "slept-at": {
      type: "string",
      placeholder: "iso",
      description: `ISO 8601 time the person went to sleep, with an offset, before the wake and within ${WAKE_MAX_BACK_HOURS} hours`
    },
    "dry-run": { type: "boolean", description: "Print the payload instead of sending it" }
  },
  mutates: true,
  examples: [
    "wake",
    "wake --at 2026-10-28T07:00:00<offset>",
    "wake --at 2026-10-28T07:00:00<offset> --slept-at 2026-10-27T23:15:00<offset>",
    "wake --slept-at 2026-10-27T23:15:00<offset> --dry-run"
  ],
  async run(context: CommandContext, args) {
    const now = context.now();
    const at = pastMoment(args, "at", now);
    const sleptAt = pastMoment(args, "slept-at", now);
    if (sleptAt && sleptAt.getTime() >= (at ?? now).getTime())
      throw new CliError("--slept-at must be before the wake (--at, which defaults to now).", EXIT.usage);

    const payload = {
      commandId: newCommandId(),
      type: "wake",
      ...(at ? { at: stringOption(args.values, "at") } : {}),
      ...(sleptAt ? { sleptAt: stringOption(args.values, "slept-at") } : {})
    };
    const parsed = wakeCommandSchema.safeParse(payload);
    if (!parsed.success) throw new CliError(firstIssueMessage(parsed.error), EXIT.validation, parsed.error.issues);

    const result = await postCommand(context, args, {
      path: "/api/commands/wake",
      payload: parsed.data as unknown as Record<string, unknown>,
      summary: `wake${at ? ` at ${at.toISOString()}` : ""}${sleptAt ? `, asleep from ${sleptAt.toISOString()}` : ""}`,
      // The portal keeps the rows a wake changes (the plan, the session, the last wake) and says so in its answer;
      // one `undo` puts them all back.
      reverse: "server"
    });
    if (result.state === null) return;

    const timeZone = result.state.settings.timezone;
    const wake = readResult(result.response);
    // The pulse after the wake, as `status` shows it; context for the answer, so a failed read does not fail the wake.
    let pulse: PulseReentryView | undefined;
    try {
      pulse =
        (await context.client.get<{ pulse?: PulseReentryView | null }>("/api/pulse/reentry?brief=1"))?.pulse ??
        undefined;
    } catch {
      pulse = undefined;
    }
    if (context.mode !== "table") {
      context.stdout(
        toJson(
          localiseInstants(
            wake
              ? { ok: true, ...wake, lastWokeAt: result.state.settings.lastWokeAt ?? null, ...(pulse ? { pulse } : {}) }
              : { ok: true, message: "This wake was already applied.", ...(pulse ? { pulse } : {}) },
            timeZone
          ),
          true
        )
      );
      return;
    }
    const line = wake ? describe(wake, timeZone, now) : "This wake was already applied.";
    context.stdout(
      pulse?.reentry.due
        ? `${line}\nThe pulse is lapsed: run \`rhen reenter\` (${pulse.reentry.missing.join("; ")}).`
        : line
    );
  }
};
