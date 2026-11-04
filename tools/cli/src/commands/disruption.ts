import { PARTS_LOCALE, activityCommandSchema, planningEntityCommandSchema } from "@openrhen/contracts";
import type { PortalState } from "../client.js";
import {
  booleanOption,
  requirePositional,
  stringOption,
  type CommandContext,
  type CommandSpec,
  type ParsedArgs
} from "../command.js";
import type { AnyRecord } from "../entities.js";
import { CliError, EXIT } from "../errors.js";
import { renderRecord, toJson } from "../output.js";
import { resolveReference } from "../resolve.js";
import { derivedEntityId, newCommandId, postCommand, printOutcome, versionOf } from "../write.js";

const SUBCOMMANDS = ["start", "extend", "finish", "status"] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

const DISRUPTION_SOURCES = ["work", "family", "life_admin", "other"] as const;
type DisruptionSource = (typeof DISRUPTION_SOURCES)[number];

/** A commitment must end after it starts (the same rule the portal's write path enforces). */
const MIN_DURATION_MS = 60_000;
const WALL_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

function isSubcommand(value: string): value is Subcommand {
  return (SUBCOMMANDS as readonly string[]).includes(value);
}

// --- Local wall-clock math -------------------------------------------------------------------
// The portal derives disruption windows in the planning timezone (portal/features/today/local-datetime.ts,
// portal/features/disruptions/disruption-draft.ts). The CLI has no dependency on the portal package, so
// the same zone arithmetic — a calendar day and a wall-clock time turned into an instant, entirely by
// Intl.DateTimeFormat round-tripping — is reproduced here rather than imported.

function zonedParts(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat(PARTS_LOCALE, {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour") % 24,
    minute: value("minute"),
    second: value("second")
  };
}

function localDayKey(date: Date, timezone: string): string {
  const { year, month, day } = zonedParts(date, timezone);
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function zonedDateTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timezone: string
): Date {
  const desired = Date.UTC(year, month - 1, day, hour, minute);
  let timestamp = desired;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const actual = zonedParts(new Date(timestamp), timezone);
    const actualAsUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
    if (actualAsUtc === desired) break;
    timestamp += desired - actualAsUtc;
  }
  return new Date(timestamp);
}

/** A wall-clock time (`HH:MM`) placed on a particular local day, in `timezone`. */
function zonedWallTimeOnDay(dayKey: string, wallTime: string, timezone: string): Date {
  const [year = 0, month = 1, day = 1] = dayKey.split("-").map(Number);
  const [hour = 0, minute = 0] = wallTime.split(":").map(Number);
  return zonedDateTimeToUtc(year, month, day, hour, minute, timezone);
}

// --- Preset resolution -------------------------------------------------------------------------
// Mirrors portal/features/disruptions/disruption-draft.ts, generalised so the CLI can take a preset id,
// a preset label, or a literal value an AI tool computed itself.

interface WhenPreset {
  id: string;
  label: string;
  delayMinutes: number;
}
interface DurationPreset {
  id: string;
  label: string;
  kind: "minutes" | "rest_of_day" | "unknown";
  minutes?: number | undefined;
}

interface ResolvedWhen {
  startsAt: Date;
  /** True for an explicit past/absolute time (HH:MM or ISO) — the structural "earlier" case, as
   * opposed to an offset-from-now preset. Only this case can make an "unknown" duration retro rather
   * than open-ended (disruption-draft.ts's `draft.when !== EARLIER_WHEN` check). */
  earlierLike: boolean;
}

function resolveWhen(value: string, presets: readonly WhenPreset[], now: Date, timezone: string): ResolvedWhen {
  const byId = presets.find((preset) => preset.id === value);
  if (byId) return { startsAt: new Date(now.getTime() + byId.delayMinutes * 60_000), earlierLike: false };
  const wanted = value.trim().toLowerCase();
  const byLabel = presets.find((preset) => preset.label.toLowerCase() === wanted);
  if (byLabel) return { startsAt: new Date(now.getTime() + byLabel.delayMinutes * 60_000), earlierLike: false };
  if (wanted === "now") return { startsAt: new Date(now.getTime()), earlierLike: false };
  if (WALL_TIME.test(value)) {
    const startsAt = zonedWallTimeOnDay(localDayKey(now, timezone), value, timezone);
    if (startsAt.getTime() > now.getTime())
      throw new CliError('That time has not come round yet. Use "now" or a delay preset such as "+15m".', EXIT.usage);
    return { startsAt, earlierLike: true };
  }
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) {
    if (parsed.getTime() > now.getTime())
      throw new CliError('That time has not come round yet. Use "now" or a delay preset such as "+15m".', EXIT.usage);
    return { startsAt: parsed, earlierLike: true };
  }
  throw new CliError(
    `Cannot read "${value}" as --when. Use a disruption-when preset's id or label, "now", HH:MM, or an ISO date-time. ` +
      `For something that started earlier, give the clock time it began, such as 08:10 (not "-30m").`,
    EXIT.usage
  );
}

/** The longest a disruption may run: the same ceiling as the retro fallback setting (`disruptionRetroFallbackMinutes`). */
const MAX_DURATION_MINUTES = 1440;

/** The refusal for a duration that is not a usable length: names the field, the accepted forms and the call to repeat. */
function durationRefusal(value: string, why: string, mcp: boolean): CliError {
  const forms =
    "a disruption-duration preset's id or label from settings, whole minutes from 1 to " +
    `${MAX_DURATION_MINUTES} (for example 30), "rest_of_day", or "unknown"`;
  const repeat = mcp
    ? 'Call rhen_disruption again with the same arguments and "duration" set to one of those.'
    : "Repeat the command with --duration set to one of those.";
  return new CliError(
    `${mcp ? '"duration"' : "--duration"} ${JSON.stringify(value)} ${why}. Accepted: ${forms}. ${repeat}`,
    EXIT.usage
  );
}

function checkedMinutes(minutes: number, value: string, mcp: boolean): number {
  if (!Number.isInteger(minutes) || minutes < 1)
    throw durationRefusal(value, "is not a length of time: a disruption must last at least 1 minute", mcp);
  if (minutes > MAX_DURATION_MINUTES)
    throw durationRefusal(
      value,
      `is longer than a disruption can run (${MAX_DURATION_MINUTES} minutes, 24 hours)`,
      mcp
    );
  return minutes;
}

function resolveDuration(
  value: string,
  presets: readonly DurationPreset[],
  mcp = false
): { kind: DurationPreset["kind"]; minutes?: number } {
  const fromPreset = (preset: DurationPreset): { kind: DurationPreset["kind"]; minutes?: number } =>
    preset.kind === "minutes" && preset.minutes !== undefined
      ? { kind: preset.kind, minutes: checkedMinutes(preset.minutes, value, mcp) }
      : { kind: preset.kind, ...(preset.minutes !== undefined ? { minutes: preset.minutes } : {}) };
  const byId = presets.find((preset) => preset.id === value);
  if (byId) return fromPreset(byId);
  const wanted = value.trim().toLowerCase();
  const byLabel = presets.find((preset) => preset.label.toLowerCase() === wanted);
  if (byLabel) return fromPreset(byLabel);
  if (wanted === "rest_of_day" || wanted === "rest-of-day") return { kind: "rest_of_day" };
  if (wanted === "unknown") return { kind: "unknown" };
  if (/^\d+$/.test(wanted)) return { kind: "minutes", minutes: checkedMinutes(Number(wanted), value, mcp) };
  throw durationRefusal(value, "is not a duration this command can read", mcp);
}

/**
 * When an open-ended disruption is guessed to end: the next planned/sleeping sleep plan after it
 * starts, or the preferred bedtime on the day it starts when no plan reaches past it. Mirrors
 * disruption-draft.ts's `pessimisticEndAt`.
 */
function pessimisticEndAt(startsAt: Date, state: PortalState, timezone: string): Date {
  const upcoming = state.sleepPlans
    .filter((plan) => plan.status === "planned" || plan.status === "sleeping")
    .map((plan) => new Date(plan.plannedStartAt))
    .filter((at) => at.getTime() > startsAt.getTime())
    .sort((a, b) => a.getTime() - b.getTime())[0];
  const bedtime =
    upcoming ?? zonedWallTimeOnDay(localDayKey(startsAt, timezone), state.settings.preferredBedtime, timezone);
  return new Date(Math.max(bedtime.getTime(), startsAt.getTime() + MIN_DURATION_MS));
}

/** The block a disruption takes and whether its end is a pessimistic guess. Mirrors `disruptionWindow`. */
function computeWindow(
  startsAt: Date,
  earlierLike: boolean,
  duration: { kind: DurationPreset["kind"]; minutes?: number },
  state: PortalState,
  timezone: string
): { endsAt: Date; openEnded: boolean } {
  if (duration.kind === "rest_of_day" || (duration.kind === "unknown" && !earlierLike))
    return { endsAt: pessimisticEndAt(startsAt, state, timezone), openEnded: duration.kind === "unknown" };
  const minutes =
    duration.kind === "unknown"
      ? state.settings.disruptionRetroFallbackMinutes
      : (duration.minutes ?? state.settings.disruptionRetroFallbackMinutes);
  return { endsAt: new Date(startsAt.getTime() + minutes * 60_000), openEnded: false };
}

// --- Command builders ----------------------------------------------------------------------------

interface Built {
  payload: Record<string, unknown>;
  summary: string;
  entityId: string;
  fallback: string;
  /**
   * Present only for `start`, and only when the disruption's window is live right now: the
   * follow-on `start_activity` command to send once the save lands, so a disruption logged as
   * happening is actually tracked rather than merely holding the clock (the
   * copy fix alone did not answer "which is it?" when the honest answer was "neither, start it").
   */
  track?: { targetId: string; plannedMinutes: number; summary: string };
}

/** What names the session for a refusal message — the target it was started against, however that got recorded. */
function describeRunningSession(session: NonNullable<PortalState["activeSession"]>): string {
  return session.targetTitle ?? `${session.targetType ?? "activity"} ${session.actionId}`;
}

function buildStart(args: ParsedArgs, state: PortalState, now: Date, id: string, mcp: boolean): Built {
  const titleRaw = stringOption(args.values, "title");
  if (!titleRaw || !titleRaw.trim()) throw new CliError("A disruption needs a name (--title).", EXIT.usage);
  const title = titleRaw.trim();

  const sourceRaw = stringOption(args.values, "source") ?? "other";
  if (!(DISRUPTION_SOURCES as readonly string[]).includes(sourceRaw))
    throw new CliError(
      `source "${sourceRaw}" is not valid: it must be one of ${DISRUPTION_SOURCES.join(", ")}, in lower case. ` +
        "A visitor, a school call or a neighbour is family or other. " +
        "Repeat the same rhen_disruption call with source set to one of those.",
      EXIT.usage,
      undefined,
      { validValues: { source: [...DISRUPTION_SOURCES] } }
    );
  const source = sourceRaw as DisruptionSource;

  const timezone = state.settings.timezone;
  const whenRaw = stringOption(args.values, "when") ?? "now";
  const resolved = resolveWhen(whenRaw, state.settings.disruptionWhenPresets, now, timezone);
  const { earlierLike } = resolved;

  // `--routine`: pin a routine preset (the leaving-the-house steps for a trip to the shops, say) to the
  // disruption. Its before-steps must finish as the disruption begins, so a disruption that would
  // begin sooner than that starts that many minutes from now (`routine run` makes the same shift) — and the
  // steps, not the disruption, are what is tracked first. A retro-logged disruption keeps its time.
  const routineArg = stringOption(args.values, "routine");
  const preset = routineArg !== undefined ? resolveReference(state, "routine-presets", routineArg) : undefined;
  if (preset?.status === "archived")
    throw new CliError(`Routine "${String(preset.name)}" is archived; restore it first.`, EXIT.usage);
  const leadMinutes = preset
    ? Math.ceil(
        ((preset.steps as { durationMinutes: number; phase?: string }[] | undefined) ?? [])
          .filter((step) => (step.phase ?? "before") === "before")
          .reduce((sum, step) => sum + step.durationMinutes, 0)
      )
    : 0;
  const startsAt = earlierLike
    ? resolved.startsAt
    : new Date(Math.max(resolved.startsAt.getTime(), now.getTime() + leadMinutes * 60_000));

  const durationRaw =
    stringOption(args.values, "duration") ?? state.settings.disruptionDurationPresets[0]?.id ?? "unknown";
  const duration = resolveDuration(durationRaw, state.settings.disruptionDurationPresets, mcp);
  const { endsAt, openEnded } = computeWindow(startsAt, earlierLike, duration, state, timezone);

  const locationId = stringOption(args.values, "location-id");
  const location = stringOption(args.values, "location");

  const entity: Record<string, unknown> = {
    id,
    title,
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    status: "confirmed",
    setupBeforeMinutes: 0,
    transitionAfterMinutes: 0,
    presence: "blocking",
    origin: "disruption",
    disruptionSource: source,
    disruptionOpenEnded: openEnded,
    landedAt: now.toISOString(),
    ...(location ? { location } : {}),
    ...(locationId ? { locationId } : {}),
    ...(preset ? { routineSource: "preset", routinePresetId: preset.id } : {})
  };

  // A disruption logged as happening now reads as running, so unless told otherwise
  // it should actually be tracked, not just hold the clock. "Live" is purely the window test — earlier
  // logged but still inside its (possibly retro-fallback) window counts too; already ended or not yet
  // started does not, matching the "retro-logged" and "future" cases that get no session.
  const noTrack = booleanOption(args.values, "no-track");
  const live = startsAt.getTime() <= now.getTime() && now.getTime() < endsAt.getTime();
  let track: Built["track"];
  if (live && !noTrack) {
    if (state.activeSession)
      throw new CliError(
        `A session is already running on "${describeRunningSession(state.activeSession)}". Finish it first ` +
          '("activity finish") or pass --no-track to log this disruption without starting tracking.',
        EXIT.usage
      );
    track = {
      targetId: id,
      plannedMinutes: Math.max(1, Math.round((endsAt.getTime() - now.getTime()) / 60_000)),
      summary: `start tracking time on "${title}"`
    };
  }

  return {
    payload: {
      commandId: newCommandId(),
      type: "save_entity",
      expectedVersion: null,
      entityType: "commitment",
      entity
    },
    summary: `log a disruption "${title}"`,
    entityId: id,
    fallback: "Disruption logged.",
    ...(track ? { track } : {})
  };
}

function requireDisruption(commitment: AnyRecord, args: ParsedArgs): void {
  if (commitment.origin === "disruption") return;
  if (booleanOption(args.values, "force")) return;
  throw new CliError(
    `"${String(commitment.title ?? commitment.id)}" is not a disruption (origin=${String(commitment.origin ?? "planned")}). ` +
      "Pass --force to act on it anyway.",
    EXIT.usage
  );
}

/**
 * The edit payload for both extend and finish: the whole stored commitment, so the required fields the
 * portal's write path re-checks on every save (title, startsAt, status, buffers) and the ones it
 * overwrites unconditionally (location, locationId) all survive — a sparse `{ id, endsAt }` payload
 * would blank them (see entity-commands.ts's UPDATE for `commitments`). Only `endsAt` and
 * `disruptionOpenEnded` change; `origin`/`disruptionSource`/`landedAt` are left out of this object only
 * in the sense that they ride along unchanged inside the spread.
 */
function editedEntity(commitment: AnyRecord, endsAt: Date, openEnded: boolean): Record<string, unknown> {
  return { ...commitment, id: commitment.id, endsAt: endsAt.toISOString(), disruptionOpenEnded: openEnded };
}

function buildExtend(idArg: string, args: ParsedArgs, state: PortalState): Built {
  const commitment = resolveReference(state, "commitments", idArg);
  requireDisruption(commitment, args);

  const minutesRaw = stringOption(args.values, "minutes");
  if (minutesRaw === undefined) throw new CliError("--minutes is required.", EXIT.usage);
  if (!/^[+-]?\d+$/.test(minutesRaw))
    throw new CliError(`--minutes must be a whole number, got "${minutesRaw}".`, EXIT.usage);
  const minutes = Number(minutesRaw);

  const floor = new Date(commitment.startsAt as string).getTime() + MIN_DURATION_MS;
  const endsAt = new Date(Math.max(new Date(commitment.endsAt as string).getTime() + minutes * 60_000, floor));
  const openEnded = commitment.disruptionOpenEnded === true;

  return {
    payload: {
      commandId: newCommandId(),
      type: "save_entity",
      expectedVersion: typeof commitment.version === "number" ? commitment.version : null,
      entityType: "commitment",
      entity: editedEntity(commitment, endsAt, openEnded)
    },
    summary: `extend the disruption by ${minutes} min`,
    entityId: commitment.id as string,
    fallback: "Disruption extended."
  };
}

function buildFinish(idArg: string, args: ParsedArgs, state: PortalState, now: Date): Built {
  const commitment = resolveReference(state, "commitments", idArg);
  requireDisruption(commitment, args);

  const floor = new Date(commitment.startsAt as string).getTime() + MIN_DURATION_MS;
  const endsAt = new Date(Math.max(now.getTime(), floor));

  return {
    payload: {
      commandId: newCommandId(),
      type: "save_entity",
      expectedVersion: typeof commitment.version === "number" ? commitment.version : null,
      entityType: "commitment",
      entity: editedEntity(commitment, endsAt, false)
    },
    summary: "finish the disruption",
    entityId: commitment.id as string,
    fallback: "Disruption finished."
  };
}

// --- status ----------------------------------------------------------------------------------------

interface DisruptionStatus {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  openEnded: boolean;
  liveNow: boolean;
}

/**
 * The disruption to report on: the one still live, or failing that the most recently landed one that
 * landed today. Mirrors portal/features/disruptions/disruption-summary.ts's `activeDisruption`.
 */
function activeDisruption(state: PortalState, now: Date, timezone: string): AnyRecord | null {
  const today = localDayKey(now, timezone);
  const landedToday = (state.commitments as unknown as AnyRecord[]).filter(
    (commitment) =>
      commitment.origin === "disruption" &&
      commitment.status !== "cancelled" &&
      typeof commitment.landedAt === "string" &&
      localDayKey(new Date(commitment.landedAt as string), timezone) === today
  );
  if (landedToday.length === 0) return null;
  const live = landedToday.find(
    (commitment) =>
      new Date(commitment.startsAt as string).getTime() <= now.getTime() &&
      now.getTime() < new Date(commitment.endsAt as string).getTime()
  );
  if (live) return live;
  return (
    [...landedToday].sort(
      (a, b) => new Date(b.landedAt as string).getTime() - new Date(a.landedAt as string).getTime()
    )[0] ?? null
  );
}

function buildStatus(state: PortalState, now: Date): DisruptionStatus | null {
  const disruption = activeDisruption(state, now, state.settings.timezone);
  if (!disruption) return null;
  return {
    id: disruption.id as string,
    title: disruption.title as string,
    startsAt: disruption.startsAt as string,
    endsAt: disruption.endsAt as string,
    openEnded: disruption.disruptionOpenEnded === true,
    liveNow:
      new Date(disruption.startsAt as string).getTime() <= now.getTime() &&
      now.getTime() < new Date(disruption.endsAt as string).getTime()
  };
}

// --- command ----------------------------------------------------------------------------------------

export const disruptionCommand: CommandSpec = {
  name: "disruption",
  summary: "Log, extend, finish, or check the day's disruption",
  description:
    "Drives the disruption lifecycle: a disruption is an ordinary commitment with origin=disruption plus a " +
    "landedAt timestamp, saved and edited through the same save_entity route `save commitment` uses — this " +
    "command only computes the right fields for you. `start` logs one happening now (or earlier today, or " +
    "about to start), picking start/end times from the settings-edited disruption presets exactly as the " +
    "portal's capture sheet does, including the pessimistic open-ended guess when the duration is unknown. " +
    "When the window it computes is live right now, `start` also starts tracking time on it (a second " +
    "start_activity command, active phase, planned minutes to the window's end) — a disruption logged as " +
    "happening is actually running, not just holding the clock; pass --no-track to log it without tracking. " +
    "A retro-logged disruption whose window has already ended, or one that starts in the future, gets no " +
    "session either way. To start tracking later on any commitment, use `activity start --type " +
    "fixed_commitment --phase active`. `extend`/`finish` correct the end-time guess once the truth is " +
    "known, preserving every other field on the record (a sparse edit would blank the location and " +
    "buffers). `status` reports the disruption worth mentioning today, if any.",
  positionals: [
    { name: "subcommand", required: true, description: "One of: start, extend, finish, status" },
    { name: "id", required: false, description: "The disruption commitment's id or title (extend/finish)" }
  ],
  options: {
    title: { type: "string", placeholder: "text", description: "The disruption's name (start, required)" },
    source: {
      type: "string",
      placeholder: "work|family|life_admin|other",
      description: "Which part of life interrupted (start, default other); a visitor is family or other"
    },
    when: {
      type: "string",
      placeholder: "preset-id|label|HH:MM|ISO",
      description: 'When it started (start, default "now"): a disruption-when preset, HH:MM, or an ISO date-time'
    },
    duration: {
      type: "string",
      placeholder: "preset-id|label|minutes|rest_of_day|unknown",
      description: "How long it runs (start, default the first duration preset); a bare number is minutes, 1 to 1440"
    },
    routine: {
      type: "string",
      placeholder: "preset-id|name",
      description:
        "Attach a routine preset, e.g. the leave-the-house steps (start). Its before-steps finish as the disruption begins, so it starts that many minutes later"
    },
    "location-id": { type: "string", placeholder: "id", description: "The place it happens at (start)" },
    location: { type: "string", placeholder: "text", description: "A free-text place label (start)" },
    minutes: {
      type: "string",
      mcp: { type: "integer" },
      placeholder: "±n",
      description: "Minutes to extend the end by, may be negative (extend)"
    },
    force: { type: "boolean", description: "Act on a commitment whose origin is not already disruption" },
    "no-track": {
      type: "boolean",
      description: "Log a live disruption without starting a tracked session on it (start)"
    },
    "dry-run": { type: "boolean", description: "Print the command(s) instead of sending them" }
  },
  mutates: true,
  examples: [
    'disruption start --title "Car trouble"',
    'disruption start --title "School called" --source family --when now --duration unknown',
    'disruption start --title "Late meeting" --when 14:30 --duration 1h',
    'disruption start --title "Neighbour dropped by" --no-track',
    'disruption start --title "Milk from the shops" --duration 30 --routine "Gym prep"',
    "disruption extend commitment-car-trouble --minutes 30",
    "disruption finish commitment-car-trouble",
    "disruption status"
  ],
  async run(context: CommandContext, args) {
    const subcommandArg = requirePositional(disruptionCommand, args, 0);
    if (!isSubcommand(subcommandArg))
      throw new CliError(
        `Unknown disruption subcommand "${subcommandArg}". Use one of: ${SUBCOMMANDS.join(", ")}.`,
        EXIT.usage
      );

    const state = await context.client.getState();
    const now = context.now();

    if (subcommandArg === "status") {
      const status = buildStatus(state, now);
      if (context.mode !== "table") {
        context.stdout(toJson(status, true));
        return;
      }
      context.stdout(
        status
          ? renderRecord(status as unknown as AnyRecord, { timeZone: state.settings.timezone })
          : "No disruption logged today."
      );
      return;
    }

    const built =
      subcommandArg === "start"
        ? buildStart(args, state, now, derivedEntityId(context, args, "disruption-entity"), context.mcp === true)
        : subcommandArg === "extend"
          ? buildExtend(requirePositional(disruptionCommand, args, 1), args, state)
          : buildFinish(requirePositional(disruptionCommand, args, 1), args, state, now);

    const parsed = planningEntityCommandSchema.safeParse(built.payload);
    if (!parsed.success)
      throw new CliError("This disruption command does not match the contract.", EXIT.validation, parsed.error.issues);

    const result = await postCommand(context, args, {
      path: "/api/commands/entity",
      payload: parsed.data,
      summary: built.summary
    });

    if (built.track) {
      // A dry run has no real created entity to read a version from — a fresh create always lands
      // on version 1 (the commitments schema default), which is what start_activity's own
      // version check will compare against once this really runs.
      const created =
        result.state && (result.state.commitments as unknown as AnyRecord[]).find((item) => item.id === built.entityId);
      const trackPayload = {
        commandId: newCommandId(),
        expectedVersion: created ? versionOf(created) : 1,
        type: "start_activity",
        targetType: "fixed_commitment",
        targetId: built.track.targetId,
        phase: "active",
        plannedMinutes: built.track.plannedMinutes
      };
      const parsedTrack = activityCommandSchema.safeParse(trackPayload);
      if (!parsedTrack.success)
        throw new CliError(
          "The follow-on tracking command does not match the contract.",
          EXIT.validation,
          parsedTrack.error.issues
        );

      const trackResult = await postCommand(context, args, {
        path: "/api/commands/activity",
        payload: parsedTrack.data as unknown as Record<string, unknown>,
        summary: built.track.summary
      });
      // --dry-run: both commands are printed above (postCommand handles that itself for each), and
      // neither is sent — the save's own dry-run response is null too, so this covers both.
      if (result.state === null || trackResult.state === null) return;

      const commitment = (trackResult.state.commitments as unknown as AnyRecord[]).find(
        (item) => item.id === built.entityId
      );
      const session = trackResult.state.activeSession;
      if (context.mode !== "table") {
        context.stdout(
          toJson({ ...(commitment ?? { ok: true, message: built.fallback }), session: session ?? null }, true)
        );
        return;
      }
      context.stdout(commitment ? renderRecord(commitment, { timeZone: state.settings.timezone }) : built.fallback);
      context.stdout(session ? "Tracking started." : "Disruption logged; tracking did not start.");
      return;
    }

    if (result.state === null) return;

    printOutcome(context, result.state, {
      stateKey: "commitments",
      id: built.entityId,
      fallback: built.fallback,
      timeZone: state.settings.timezone
    });
  }
};
