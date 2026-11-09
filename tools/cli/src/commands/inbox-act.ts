import {
  calendarSinkConnection,
  captureDraftFromSaved,
  captureDraftIssue,
  intervalCalendarSourceIds,
  planMapBulkConfirmSchema,
  planMapFindingActionSchema,
  planMapLinkActionSchema,
  resolveQuestion,
  unansweredQuestions,
  type CaptureDraftIssue
} from "@openrhen/contracts";
import {
  booleanOption,
  requirePositional,
  stringOption,
  type CommandContext,
  type CommandSpec,
  type ParsedArgs
} from "../command.js";
import { CliError, EXIT, firstIssueMessage } from "../errors.js";
import { toJson } from "../output.js";
import { buildWriteRequest, findEntityType } from "./save.js";
import { newCommandId, parseAssignments, postCommand } from "../write.js";
import { registeredInboxActRooms, registeredInboxRooms } from "../command-modules.js";
import { FACT_ACTIONS, actOnFactRoom } from "./inbox-facts.js";

/**
 * Acts on the Inbox rooms (the mail add-on owns Emails), with the same writes the portal's own buttons send
 *. Captured and Someday & reference reuse the `capture_review` and
 * `capture` entity commands the Captured room builds (portal/features/capture/capture-commands.ts); Plan map
 * calls the routes its room calls, and a room a command module adds (`CommandModule.inboxActRooms`) its own. Each action looks the item up first and refuses
 * when it is missing or in the wrong state, so the portal never has to be the one to say so.
 */

const CORE_ROOMS = ["captured", "kept", "map", "calendar", "facts"] as const;

/**
 * True while a command module provides the Emails room (the mail add-on). The core has no email commands, so it must not
 * point anyone at `email-act` or `email review` unless the module that owns them is loaded.
 */
function mailRoomInstalled(): boolean {
  return registeredInboxRooms().some((room) => room.id === "emails");
}

const ACTIONS: Record<"captured" | "kept" | "map" | "facts", string[]> = {
  captured: ["confirm", "ignore"],
  kept: ["reopen", "drop"],
  map: ["link", "links-bulk", "finding"],
  facts: [...FACT_ACTIONS]
};

/** The rooms that act, in help order: the core's first two, then a module's, then the plan map. */
function actingRooms(): string[] {
  return ["captured", "kept", ...registeredInboxActRooms().map((room) => room.id), "map", "facts"];
}

const PROPOSAL_TYPES = ["outcome", "project", "action", "fixed_commitment", "deliverable", "someday", "reference"];

/** The editor's draft fields (portal/features/capture/proposals.ts `ProposalDraft`). */
const DRAFT_KEYS = [
  "title",
  "areaId",
  "outcomeId",
  "projectId",
  "definitionOfDone",
  "value",
  "internalDeadlineAt",
  "externalDeadlineAt",
  "expectedMinutes",
  "pessimisticMinutes",
  "energy",
  "startsAt",
  "endsAt",
  "location",
  "locationId",
  "notes"
] as const;
const DATE_KEYS = new Set<string>(["internalDeadlineAt", "externalDeadlineAt", "startsAt", "endsAt"]);
const PLACEMENT_KEYS = new Set<string>(["areaId", "outcomeId", "projectId"]);

interface CaptureRow {
  id: string;
  version?: number | null;
  status: string;
  proposalType: string;
  text: string;
  proposedFields: Record<string, unknown>;
  questions?: unknown[];
}

interface Lookup {
  areas?: { id: string; name: string }[];
  outcomes?: { id: string; title: string }[];
  projects?: { id: string; title: string }[];
}

type Draft = Record<string, unknown>;

const isKept = (row: CaptureRow) =>
  row.status === "confirmed" && (row.proposalType === "someday" || row.proposalType === "reference");

const instant = (value: string): string => (value ? new Date(value).toISOString() : "");

function toInstant(value: string, label: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()))
    throw new CliError(
      `${label}: "${value}" is not a date and time. Use ISO 8601 with the owner's UTC offset (status.timezone), e.g. 2026-10-09T15:00:00<offset>.`
    );
  return parsed.toISOString();
}

/** A placement answer may be the record's title; the draft holds its id (mirrors the editor's answer chips). */
function resolveRecord(field: string, answer: string, state: Lookup): string {
  const options =
    field === "areaId"
      ? (state.areas ?? []).map((area) => ({ id: area.id, title: area.name }))
      : field === "outcomeId"
        ? (state.outcomes ?? [])
        : field === "projectId"
          ? (state.projects ?? [])
          : null;
  if (!options) return answer;
  const wanted = answer.trim().toLowerCase();
  const match = options.find((option) => option.id === answer.trim() || option.title.trim().toLowerCase() === wanted);
  return match ? match.id : answer.trim();
}

/** What the editor opens with for a capture (shared with the portal), dates left as stored instants. */
function draftFromCapture(row: CaptureRow, proposalType: string): Draft {
  return { proposalType, ...captureDraftFromSaved(row.proposedFields, row.text) };
}

/** The CLI's wording of the shared refusals, pointing at the `--set` flag that fixes each one. */
const DRAFT_ISSUE_MESSAGES: Record<CaptureDraftIssue, string> = {
  unclassified: "Choose what this item should become.",
  title_missing: "A corrected title is required (--set title=...).",
  value_out_of_range: "Value must be between 1 and 5.",
  outcome_needs_area_and_done:
    "An outcome needs an area and a definition of done (--set areaId=... --set definitionOfDone=...).",
  project_needs_outcome: "A project needs the outcome it supports (--set outcomeId=...).",
  action_needs_project: "An action needs its project (--set projectId=...).",
  deliverable_needs_project: "A deliverable needs its project (--set projectId=...).",
  commitment_needs_times: "A commitment needs start and end times (--set startsAt=... --set endsAt=...).",
  commitment_ends_before_start: "The commitment must end after it starts.",
  internal_after_external: "The internal deadline cannot be after the external deadline.",
  action_estimates_invalid: "Action effort estimates are invalid.",
  area_missing: "The selected area does not exist.",
  outcome_missing: "The selected outcome does not exist.",
  project_missing: "The selected project does not exist."
};

/** The editor's own checks (`captureDraftIssue`, shared with the portal), so the CLI refuses what the editor would. */
function validateDraft(state: Lookup, draft: Draft): string | null {
  const issue = captureDraftIssue(state, draft);
  return issue ? DRAFT_ISSUE_MESSAGES[issue] : null;
}

export function usage(message: string): never {
  throw new CliError(message, EXIT.usage);
}

/** `postCommand` for routes that answer without a portal state: a dry run prints the same preview. */
export async function sendRoute<T>(
  context: CommandContext,
  args: ParsedArgs,
  options: { path: string; payload: Record<string, unknown>; summary: string }
): Promise<T | null> {
  if (booleanOption(args.values, "dry-run")) {
    await postCommand(context, args, options);
    return null;
  }
  context.stderr(`rhen: ${options.summary}`);
  return context.client.post<T>(options.path, options.payload);
}

export function report(context: CommandContext, dryRun: boolean, result: Record<string, unknown>, line: string): void {
  if (dryRun) return;
  context.stdout(context.mode !== "table" ? toJson({ ok: true, ...result }, true) : line);
}

function capturesOf(state: { captures: unknown }): CaptureRow[] {
  return state.captures as CaptureRow[];
}

function requireCapture(captures: CaptureRow[], id: string): CaptureRow {
  const row = captures.find((item) => item.id === id);
  if (!row) throw new CliError(`No capture with id ${id}. Find ids with \`rhen inbox\`.`, EXIT.notFound);
  return row;
}

async function sendCapture(
  context: CommandContext,
  args: ParsedArgs,
  kind: "capture" | "capture_review",
  row: CaptureRow,
  entity: Record<string, unknown>,
  summary: string
): Promise<boolean> {
  const def = findEntityType(kind)!;
  const request = buildWriteRequest(def, entity, newCommandId(), typeof row.version === "number" ? row.version : null);
  // A confirm is snapshotted by the portal for an agent, so the journal can undo it (`rhen undo`).
  const result = await postCommand(context, args, {
    path: request.path,
    payload: request.payload,
    summary,
    ...(kind === "capture_review" ? { reverse: "server" as const } : {})
  });
  return result.state !== null;
}

async function captured(context: CommandContext, args: ParsedArgs, action: string): Promise<void> {
  const id = requirePositional(inboxActCommand, args, 2);
  const state = await context.client.getState();
  const row = requireCapture(capturesOf(state), id);
  const dryRun = booleanOption(args.values, "dry-run");
  if (row.proposalType === "email_change")
    throw new CliError(
      mailRoomInstalled()
        ? `${id} is an email change. Use "rhen email-act ${action} ${id}".`
        : `${id} is an email change, which this build has no command for.`,
      EXIT.usage
    );
  if (row.status !== "pending")
    throw new CliError(`Capture ${id} is ${row.status}, not waiting for review.`, EXIT.validation);

  if (action === "ignore") {
    const done = await sendCapture(
      context,
      args,
      "capture",
      row,
      {
        id: row.id,
        status: "ignored",
        proposalType: row.proposalType,
        proposedFields: row.proposedFields,
        reviewedAt: context.now().toISOString()
      },
      `ignore capture "${row.text}" (${row.id})`
    );
    if (done) report(context, dryRun, { id, outcome: "ignored" }, `rhen: ignored capture ${id}.`);
    return;
  }

  // confirm
  const hint = row.proposalType === "unclassified" && row.proposedFields.suggestedShape === "deliverable";
  const type = stringOption(args.values, "type") ?? (hint ? "deliverable" : row.proposalType);
  if (!PROPOSAL_TYPES.includes(type))
    usage(
      row.proposalType === "unclassified" && stringOption(args.values, "type") === undefined
        ? `Choose what this capture should become with --type (${PROPOSAL_TYPES.join(", ")}).`
        : `--type must be one of ${PROPOSAL_TYPES.join(", ")}.`
    );
  const filing = type === "someday" || type === "reference";
  const tentative = booleanOption(args.values, "tentative");
  if (tentative && type !== "fixed_commitment") usage("--tentative applies only to a fixed_commitment.");

  const draft = draftFromCapture(row, type);
  const sets = parseAssignments(args.values, "set");
  for (const [key, raw] of Object.entries(sets)) {
    if (!(DRAFT_KEYS as readonly string[]).includes(key))
      usage(`--set ${key}: not a draft field. Fields: ${DRAFT_KEYS.join(", ")}.`);
    draft[key] =
      DATE_KEYS.has(key) && typeof raw === "string"
        ? toInstant(raw, `--set ${key}`)
        : PLACEMENT_KEYS.has(key) && typeof raw === "string"
          ? resolveRecord(key, raw, state)
          : raw;
  }

  // Open questions: each must be answered before a non-filing confirm, and an answer fills its draft field.
  const questions = filing ? [] : (row.questions ?? []).map((q) => resolveQuestion(q as never));
  const answersRaw = parseAssignments(args.values, "answer");
  const answers: Record<string, string> = {};
  for (const [field, value] of Object.entries(answersRaw)) {
    const question = questions.find((q) => q.field === field);
    if (!question) {
      if (filing) continue;
      usage(`--answer ${field}: this capture has no open question for that field.`);
    }
    const raw = String(value).trim();
    if (!raw) continue;
    answers[field] =
      question.input === "datetime" ? toInstant(raw, `--answer ${field}`) : resolveRecord(field, raw, state);
    if ((DRAFT_KEYS as readonly string[]).includes(field)) draft[field] = answers[field];
  }
  const open = unansweredQuestions(questions, answers);
  if (open.length)
    throw new CliError(
      `Answer the open question(s) first with --answer field=text: ${open.map((q) => `${q.field} (${q.question})`).join("; ")}.`,
      EXIT.validation
    );
  for (const key of DATE_KEYS) if (typeof draft[key] === "string") draft[key] = instant(draft[key] as string);

  const invalid = validateDraft(state, draft);
  if (invalid) throw new CliError(invalid, EXIT.validation);

  const done = await sendCapture(
    context,
    args,
    "capture_review",
    row,
    {
      id: row.id,
      proposalType: type,
      draft,
      ...(Object.keys(answers).length ? { answers } : {}),
      ...(tentative ? { commitmentStatus: "tentative" } : {})
    },
    `confirm capture "${row.text}" as ${type}${tentative ? " (tentative)" : ""} (${row.id})`
  );
  if (done)
    report(
      context,
      dryRun,
      { id, outcome: "confirmed", proposalType: type, tentative },
      `rhen: confirmed capture ${id} as ${type}${tentative ? " (maybe)" : ""}.`
    );
}

async function kept(context: CommandContext, args: ParsedArgs, action: string): Promise<void> {
  const id = requirePositional(inboxActCommand, args, 2);
  const state = await context.client.getState();
  const row = requireCapture(capturesOf(state), id);
  if (!isKept(row))
    throw new CliError(
      `Capture ${id} is not kept for later (it is ${row.status}, ${row.proposalType}). Only Someday and Reference items can be ${action === "reopen" ? "reopened" : "dropped"}.`,
      EXIT.validation
    );
  const dryRun = booleanOption(args.values, "dry-run");
  const entity =
    action === "reopen"
      ? { id: row.id, status: "pending", proposalType: row.proposalType, proposedFields: row.proposedFields }
      : {
          id: row.id,
          status: "ignored",
          proposalType: row.proposalType,
          proposedFields: row.proposedFields,
          reviewedAt: context.now().toISOString()
        };
  const done = await sendCapture(
    context,
    args,
    "capture",
    row,
    entity,
    `${action === "reopen" ? "send back to review" : "drop"} kept ${row.proposalType} "${row.text}" (${row.id})`
  );
  if (done)
    report(
      context,
      dryRun,
      { id, outcome: action === "reopen" ? "reopened" : "dropped" },
      `rhen: ${action === "reopen" ? "sent" : "dropped"} ${id}${action === "reopen" ? " back to Needs review" : ""}.`
    );
}

interface MapLink {
  id: string;
  status: string;
  kind: string;
  proposer: string;
}
interface MapFinding {
  id: string;
  status: string;
  questions?: unknown[];
}

async function planMap(context: CommandContext, args: ParsedArgs, action: string): Promise<void> {
  const dryRun = booleanOption(args.values, "dry-run");
  const map = await context.client.get<{ links: MapLink[]; findings: MapFinding[] }>("/api/plan-map");

  if (action === "link") {
    const id = requirePositional(inboxActCommand, args, 2);
    const decision = requirePositional(inboxActCommand, args, 3);
    const body = planMapLinkActionSchema.safeParse({ action: decision });
    // `reopen` is the portal's Undo, not something to hand an agent.
    if (!body.success || decision === "reopen") usage("A link decision is confirm, reject or remove.");
    const link = map.links.find((item) => item.id === id);
    if (!link) throw new CliError(`No plan-map link with id ${id}.`, EXIT.notFound);
    if (decision !== "remove" && link.status !== "suggested")
      throw new CliError(`Link ${id} is ${link.status}; only a suggested link can be ${decision}ed.`, EXIT.validation);
    if (decision === "remove" && link.status === "rejected")
      throw new CliError("A rejected link is kept so it is not proposed again.", EXIT.validation);
    const result = await sendRoute(context, args, {
      path: `/api/plan-map/links/${encodeURIComponent(id)}`,
      payload: body.data,
      summary: `${decision} ${link.kind} link (${id})`
    });
    if (result !== null) report(context, dryRun, { id, outcome: decision }, `rhen: ${decision} link ${id}.`);
    return;
  }

  if (action === "links-bulk") {
    const body = planMapBulkConfirmSchema.safeParse({
      proposer: stringOption(args.values, "proposer"),
      kind: stringOption(args.values, "kind")
    });
    if (!body.success) usage(`links-bulk needs --proposer and --kind: ${firstIssueMessage(body.error)}.`);
    const matching = map.links.filter(
      (item) => item.status === "suggested" && item.proposer === body.data.proposer && item.kind === body.data.kind
    );
    if (!matching.length)
      throw new CliError(`No suggested ${body.data.kind} links from ${body.data.proposer} to confirm.`, EXIT.notFound);
    const result = await sendRoute<{ confirmed?: number }>(context, args, {
      path: "/api/plan-map/links/bulk",
      payload: body.data,
      summary: `confirm ${matching.length} suggested ${body.data.kind} link(s) from ${body.data.proposer}`
    });
    if (result)
      report(
        context,
        dryRun,
        { outcome: "confirmed", confirmed: result.confirmed ?? 0 },
        `rhen: confirmed ${result.confirmed ?? 0} link(s).`
      );
    return;
  }

  // finding
  const id = requirePositional(inboxActCommand, args, 2);
  const decision = requirePositional(inboxActCommand, args, 3);
  const answers: Record<string, string> = {};
  for (const [field, value] of Object.entries(parseAssignments(args.values, "answer"))) answers[field] = String(value);
  const body = planMapFindingActionSchema.safeParse({
    action: decision,
    ...(Object.keys(answers).length ? { answers } : {})
  });
  if (!body.success || decision === "reopen") usage("A finding decision is accept or dismiss.");
  const finding = map.findings.find((item) => item.id === id);
  if (!finding) throw new CliError(`No plan-map finding with id ${id}.`, EXIT.notFound);
  if (finding.status !== "open") throw new CliError(`Finding ${id} is already ${finding.status}.`, EXIT.validation);
  if (decision === "accept") {
    const open = unansweredQuestions(
      (finding.questions ?? []).map((q) => resolveQuestion(q as never)),
      answers
    );
    if (open.length)
      throw new CliError(
        `Answer the open question(s) before accepting with --answer field=text: ${open.map((q) => `${q.field} (${q.question})`).join("; ")}.`,
        EXIT.validation
      );
  }
  const result = await sendRoute(context, args, {
    path: `/api/plan-map/findings/${encodeURIComponent(id)}`,
    payload: body.data,
    summary: `${decision} plan-map finding (${id})`
  });
  if (result !== null)
    report(
      context,
      dryRun,
      { id, outcome: decision === "accept" ? "accepted" : "dismissed" },
      `rhen: ${decision === "accept" ? "accepted" : "dismissed"} finding ${id}.`
    );
}

/** The options the command always has; a module's rooms add theirs between the two groups. */
const inboxActCoreOptions = {
  head: {
    type: { type: "string", placeholder: "proposalType", description: "confirm: what the capture becomes" },
    set: {
      type: "string",
      multiple: true,
      placeholder: "field=value",
      description: "confirm: a draft field (title, areaId, projectId, startsAt, ...), repeatable"
    },
    answer: {
      type: "string",
      multiple: true,
      placeholder: "field=text",
      description: "Answer to an open question (captured confirm, map finding accept), repeatable"
    },
    tentative: { type: "boolean", description: "confirm: file a commitment as maybe" }
  },
  tail: {
    proposer: {
      type: "string",
      placeholder: "proposer",
      description: "links-bulk: e.g. owner, tga, reviewer, rule:name"
    },
    kind: { type: "string", placeholder: "kind", description: "links-bulk: the link kind, e.g. about, prepares" },
    "dry-run": { type: "boolean", description: "Print the request instead of sending it" }
  }
} satisfies Record<string, CommandSpec["options"]>;

export const inboxActCommand: CommandSpec = {
  name: "inbox-act",
  // Getters, not literals: a room a command module adds (`inboxActRooms`) writes its own words into the help.
  get summary() {
    return `Act on the Inbox rooms${mailRoomInstalled() ? " other than Emails" : ""}: ${actingRooms().join(", ")}`;
  },
  get description() {
    const rooms = registeredInboxActRooms();
    const confirmNotes = rooms.flatMap((room) => (room.confirmNote ? [room.confirmNote] : []));
    return (
      "Writes through the same paths as the portal's Inbox buttons. captured: `confirm <id> --type <outcome|project|" +
      "action|fixed_commitment|deliverable|someday|reference>` (--set field=value draft fields, --answer field=text " +
      "for each open question, --tentative for a maybe commitment) or `ignore <id>`. kept (Someday & reference): " +
      "`reopen <id>` sends it back to Needs review, `drop <id>` ignores it. " +
      rooms.map((room) => room.description).join("") +
      "map (Plan map): `link <id> confirm|reject|remove`, `links-bulk --proposer X --kind Y`, `finding <id> " +
      "accept|dismiss` (--answer field=text). facts (open mail items): `confirm|done|ignore|redate|reopen <id>` (--set " +
      "days=N or when=<ISO>; done, ignore and redate need --basis stated --evidence with the owner's words). calendar: use `import show|commit|delete` (an import's Apply anyway " +
      "/ Don't add clash decisions are edits to the batch: `import update`). " +
      (mailRoomInstalled() ? "emails: use `email-act`. " : "") +
      "Find ids " +
      "with `inbox --json`. Confirm when the person has said so or it is plainly right: a confirm can be undone with " +
      "`rhen undo` (ignore and the other actions cannot)" +
      (confirmNotes.length ? `, and ${confirmNotes.join(", and ")}` : "") +
      ". --dry-run previews."
    );
  },
  get positionals() {
    const rooms = actingRooms();
    const list = `${rooms.slice(0, -1).join(", ")} or ${rooms[rooms.length - 1]}`;
    const actions = [
      "captured: confirm|ignore",
      "kept: reopen|drop",
      ...registeredInboxActRooms().map((room) => room.actionHelp),
      "map: link|links-bulk|finding",
      "facts: confirm|done|ignore|redate|reopen"
    ].join("; ");
    return [
      {
        name: "room",
        required: true,
        description: `${list} (calendar${mailRoomInstalled() ? " and emails explain" : " explains"} where to go)`
      },
      { name: "action", required: true, description: actions },
      { name: "id", required: false, description: "Item id (capture, submission, link or finding)" },
      { name: "decision", required: false, description: "link: confirm|reject|remove; finding: accept|dismiss" }
    ];
  },
  get options() {
    return {
      ...inboxActCoreOptions.head,
      ...Object.assign({}, ...registeredInboxActRooms().map((room) => room.options ?? {})),
      ...inboxActCoreOptions.tail
    };
  },
  mutates: true,
  outward: true,
  get examples() {
    return [
      "inbox-act captured confirm 6f1e… --type action --set projectId=… --answer deadlineAt=2026-10-09T15:00:00<offset>",
      "inbox-act kept reopen 6f1e…",
      ...registeredInboxActRooms().flatMap((room) => [...(room.examples ?? [])]),
      "inbox-act map link 8d2a… confirm"
    ];
  },
  async run(context: CommandContext, args: ParsedArgs) {
    const room = requirePositional(inboxActCommand, args, 0);
    const added = registeredInboxActRooms().find((candidate) => candidate.id === room);
    if (!(CORE_ROOMS as readonly string[]).includes(room) && !added && !(room === "emails" && mailRoomInstalled()))
      usage(`Unknown room "${room}". Rooms: ${actingRooms().join(", ")}.`);
    if (room === "emails")
      usage('The Emails room is acted on with "rhen email-act confirm|ignore" (see "rhen email review").');
    if (room === "calendar" && context.remote === true)
      usage(
        "Calendar & imports has no actions on this tool: reviewing, committing or deleting an import batch is the owner's, " +
          "in the portal's Inbox > Calendar. Tell the person which batch is waiting (rhen_inbox lists them)."
      );
    if (room === "calendar") {
      const sink = calendarSinkConnection();
      const ids = intervalCalendarSourceIds();
      const syncIds = ids.length > 1 ? `${ids.slice(0, -1).join(", ")} and ${ids.at(-1)}` : (ids[0] ?? "");
      const clash = registeredInboxActRooms()
        .flatMap((candidate) => (candidate.importClash ? [candidate.importClash] : []))
        .join(" and ");
      usage(
        'Calendar & imports has no inbox-act actions. Review a batch with "rhen import show <id>", then ' +
          `"import commit <id> --yes" or "import delete <id> --yes"; edit its records${clash ? ` (including ${clash} Apply anyway / Don't add)` : ""} with ` +
          '"import update <id> --from file.json". The Calendars section\'s Sync now and ' +
          `${sink ? `${sink.label} preview ` : "shared calendar preview "}are not exposed (POST /api/connections/<id>/sync for ${syncIds}` +
          `${sink ? `, POST /api/connections/${sink.id}/import/preview` : ""}).`
      );
    }
    const action = requirePositional(inboxActCommand, args, 1);
    const actions = added ? added.actions : ACTIONS[room as keyof typeof ACTIONS];
    if (!actions.includes(action)) usage(`Unknown ${room} action "${action}". Use ${actions.join(", ")}.`);
    if (added) return added.run(context, args, action);
    if (room === "captured") return captured(context, args, action);
    if (room === "kept") return kept(context, args, action);
    if (room === "facts") return actOnFactRoom(context, args, action);
    return planMap(context, args, action);
  }
};
