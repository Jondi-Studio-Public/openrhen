import {
  planningEntityCommandSchema,
  spanEntitySchema,
  spanRemoveEntitySchema,
  type SpanWindow
} from "@openrhen/contracts";
import type { PortalState } from "../client.js";
import { requirePositional, stringOption, type CommandContext, type CommandSpec, type ParsedArgs } from "../command.js";
import type { AnyRecord } from "../entities.js";
import { CliError, EXIT, firstIssueMessage } from "../errors.js";
import { emitRows } from "../output.js";
import { resolveReference } from "../resolve.js";
import {
  alreadyStored,
  emitSaved,
  newCommandId,
  parseCommandIdKey,
  postCommand,
  usedCommandKey,
  versionOf
} from "../write.js";

const SUBCOMMANDS = ["add", "list", "set", "remove"] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A `--start`/`--end`/`--from`/`--to` value: a real calendar day, `YYYY-MM-DD`, nothing looser. */
function parseDay(value: string | undefined, flag: string): string | undefined {
  if (value === undefined) return undefined;
  const real =
    DAY.test(value) &&
    !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
    new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);
  if (!real) throw new CliError(`--${flag} must be a calendar day written YYYY-MM-DD, got "${value}".`, EXIT.usage);
  return value;
}

/** `--window 09:00-17:30` into the span's clock window. */
function parseWindow(value: string): SpanWindow {
  const match = /^(\d{2}:\d{2})-(\d{2}:\d{2})$/.exec(value.trim());
  if (!match) throw new CliError(`--window must be a clock window written HH:MM-HH:MM, got "${value}".`, EXIT.usage);
  return { localStartTime: match[1]!, localEndTime: match[2]! };
}

const isNone = (value: string) => ["none", "null", ""].includes(value.trim().toLowerCase());

function isSubcommand(value: string): value is Subcommand {
  return (SUBCOMMANDS as readonly string[]).includes(value);
}

function describe(entity: AnyRecord): string {
  const window = entity.window as SpanWindow | undefined;
  return `"${String(entity.title)}" ${String(entity.startDate)} to ${String(entity.endDate)}${
    window ? ` ${window.localStartTime}-${window.localEndTime} daily` : ""
  }`;
}

/** Builds the entity a span write carries from the stored span (when editing) and the options given. */
function buildEntity(args: ParsedArgs, state: PortalState, existing: AnyRecord | undefined): AnyRecord {
  const entity: AnyRecord = existing
    ? {
        id: existing.id,
        title: existing.title,
        startDate: existing.startDate,
        endDate: existing.endDate,
        ...(existing.window ? { window: existing.window } : {}),
        ...(existing.projectId ? { projectId: existing.projectId } : {})
      }
    : {};
  const title = stringOption(args.values, "title");
  if (title !== undefined) entity.title = title;
  const start = parseDay(stringOption(args.values, "start"), "start");
  if (start !== undefined) entity.startDate = start;
  const end = parseDay(stringOption(args.values, "end"), "end");
  if (end !== undefined) entity.endDate = end;
  // A one-day span needs only a start.
  if (!existing && entity.endDate === undefined && entity.startDate !== undefined) entity.endDate = entity.startDate;
  const window = stringOption(args.values, "window");
  if (window !== undefined) {
    if (isNone(window)) delete entity.window;
    else entity.window = parseWindow(window);
  }
  const project = stringOption(args.values, "project");
  if (project !== undefined) {
    if (isNone(project)) delete entity.projectId;
    else entity.projectId = resolveReference(state, "projects", project).id;
  }
  return entity;
}

function runList(context: CommandContext, args: ParsedArgs, state: PortalState): void {
  const from = parseDay(stringOption(args.values, "from"), "from");
  const to = parseDay(stringOption(args.values, "to"), "to");
  const rows = (state.spans as unknown as AnyRecord[]).filter(
    (span) => (from === undefined || String(span.endDate) >= from) && (to === undefined || String(span.startDate) <= to)
  );
  emitRows({ mode: context.mode, stdout: context.stdout }, rows, [
    "id",
    "title",
    "startDate",
    "endDate",
    "window.localStartTime",
    "window.localEndTime",
    "projectId"
  ]);
}

export const spanCommand: CommandSpec = {
  name: "span",
  summary: "Add, list, change, or remove a labelled block of days (a trip, a sick spell)",
  description:
    "A span is a block of calendar days shown as a band on the History calendar, such as a trip or days off sick. " +
    "It is display only: it never blocks time, moves work, or pauses a requirement, so anything that must block " +
    "time is a commitment, and anything you worked on is a session. add needs --title and --start (--end defaults " +
    "to the start, so a one-day span is one date); --window HH:MM-HH:MM repeats a clock window on every day, " +
    "and --project <id|title> links one project. set <id|title> changes only the options given (--window none " +
    "or --project none clears it); remove <id|title> deletes the span. Dates are YYYY-MM-DD. list shows spans " +
    "overlapping an optional --from/--to range; under --read-only use `list spans` instead. The portal carries " +
    "spans from a year before to a year after today. Writes are validated locally and by the portal.",
  positionals: [
    { name: "subcommand", required: true, description: `One of: ${SUBCOMMANDS.join(", ")}` },
    { name: "span", required: false, description: "The span's id or exact title (set, remove)" }
  ],
  options: {
    title: { type: "string", placeholder: "text", description: "The span's title (add, set)" },
    start: { type: "string", placeholder: "YYYY-MM-DD", description: "First day (add, set)" },
    end: { type: "string", placeholder: "YYYY-MM-DD", description: "Last day, inclusive (add, set)" },
    window: {
      type: "string",
      placeholder: "HH:MM-HH:MM|none",
      description: "A clock window repeated on every day (add, set)"
    },
    project: { type: "string", placeholder: "id|title|none", description: "The project to link (add, set)" },
    from: { type: "string", placeholder: "YYYY-MM-DD", description: "list: only spans ending on or after this day" },
    to: { type: "string", placeholder: "YYYY-MM-DD", description: "list: only spans starting on or before this day" },
    "dry-run": { type: "boolean", description: "Print the payload instead of sending it" }
  },
  mutates: true,
  destructive: true,
  examples: [
    'span add --title "Trip 1" --start 2026-09-27 --end 2026-09-29',
    'span add --title "Conference" --start 2026-11-03 --window 09:00-17:00 --project "Paper"',
    "span list --from 2026-09-01 --to 2026-09-30",
    'span set "Trip 1" --end 2026-09-30',
    'span remove "Trip 1"'
  ],
  async run(context, args) {
    const subcommand = requirePositional(spanCommand, args, 0);
    if (!isSubcommand(subcommand))
      throw new CliError(`Unknown span subcommand "${subcommand}". Use one of: ${SUBCOMMANDS.join(", ")}.`, EXIT.usage);
    const state = await context.client.getState();
    if (subcommand === "list") return runList(context, args, state);

    const commandId = newCommandId();
    let entity: AnyRecord;
    let existing: AnyRecord | undefined;
    let summary: string;
    let id: string | undefined;
    if (subcommand === "add") {
      if (stringOption(args.values, "title") === undefined || stringOption(args.values, "start") === undefined)
        throw new CliError("span add needs --title and --start.", EXIT.usage);
      entity = buildEntity(args, state, undefined);
      id = commandId; // the portal keys a new span by its command id when none is given
      summary = `add span ${describe(entity)}`;
    } else {
      const query = requirePositional(spanCommand, args, 1);
      existing = resolveReference(state, "spans", query);
      id = String(existing.id);
      if (subcommand === "remove") {
        entity = { id, remove: true };
        summary = `remove span ${describe(existing)}`;
      } else {
        const touched = ["title", "start", "end", "window", "project"].some(
          (name) => stringOption(args.values, name) !== undefined
        );
        if (!touched)
          throw new CliError(
            "span set needs at least one of --title, --start, --end, --window, --project.",
            EXIT.usage
          );
        entity = buildEntity(args, state, existing);
        summary = `change span to ${describe(entity)}`;
      }
    }
    const checked = (subcommand === "remove" ? spanRemoveEntitySchema : spanEntitySchema).safeParse(entity);
    if (!checked.success) throw new CliError(firstIssueMessage(checked.error), EXIT.validation, checked.error.issues);
    const payload = {
      commandId,
      type: "save_entity" as const,
      expectedVersion: versionOf(existing),
      entityType: "span" as const,
      entity: subcommand === "add" ? { ...entity, id } : entity
    };
    const parsed = planningEntityCommandSchema.safeParse(payload);
    if (!parsed.success) throw new CliError(firstIssueMessage(parsed.error), EXIT.validation, parsed.error.issues);

    // An add is undone by removing it, a change by restating the span as it was; a removal is not recorded.
    let reverse: Parameters<typeof postCommand>[2]["reverse"];
    if (id !== undefined && subcommand !== "remove") {
      const stored: AnyRecord | undefined = existing && {
        id: existing.id,
        title: existing.title,
        startDate: existing.startDate,
        endDate: existing.endDate,
        ...(existing.window ? { window: existing.window } : {}),
        ...(existing.projectId ? { projectId: existing.projectId } : {})
      };
      const entityBack = stored
        ? spanEntitySchema.safeParse(stored).success
          ? stored
          : undefined
        : { id, remove: true };
      if (entityBack)
        reverse = {
          undo: {
            path: "/api/commands/entity",
            payload: { ...parsed.data, commandId: newCommandId(), expectedVersion: null, entity: entityBack }
          },
          target: { stateKey: "spans", id }
        };
    }
    const result = await postCommand(context, args, {
      path: "/api/commands/entity",
      payload: parsed.data,
      summary,
      ...(reverse ? { reverse } : {})
    });
    if (result.state === null) return;
    if (subcommand === "remove") {
      if (context.mode !== "table") context.stdout(JSON.stringify({ ok: true, removed: id }, null, 2));
      else context.stdout(`Span removed (${id}).`);
      return;
    }
    // The span as it now stands. The answer's state can leave a span out (it carries spans from a year before to a
    // year after today), so an add falls back to what was sent: version 1 is what a new record is stored at.
    const key = parseCommandIdKey(args.values);
    const replayOf = subcommand === "add" && alreadyStored(state, "spans", key) ? key : undefined;
    // A new span is stored under the command id the write was sent with, which is not the id built before sending.
    const savedId = subcommand === "add" ? (usedCommandKey(context) ?? id) : id;
    const answered = (result.state.spans as unknown as AnyRecord[] | undefined)?.find((span) => span.id === savedId);
    const sent = parsed.data.entity as unknown as AnyRecord;
    const record: AnyRecord | undefined =
      answered ??
      (subcommand === "add"
        ? {
            id: savedId,
            version: 1,
            title: sent.title,
            startDate: sent.startDate,
            endDate: sent.endDate,
            ...(sent.window ? { window: sent.window } : {}),
            ...(sent.projectId ? { projectId: sent.projectId } : {})
          }
        : undefined);
    emitSaved(context, record, { fallback: "Span saved.", timeZone: result.state.settings.timezone, replayOf });
  }
};
