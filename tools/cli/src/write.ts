import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { UNLABELED_OWNER } from "./agent.js";
import type { PortalClient, PortalState } from "./client.js";
import { booleanOption, stringOption, type CommandContext, type OptionValues, type ParsedArgs } from "./command.js";
import { CliError, EXIT, NetworkError, ServerError } from "./errors.js";
import { getPath, renderRecord, toJson } from "./output.js";
import {
  committedVersion,
  recordWrite,
  serverCheckedReverse,
  type JournalTarget,
  type ReverseRequest
} from "./undo-journal.js";

export const newCommandId = (): string => randomUUID();

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `--command-id` must be a uuid because the portal's `writes.id` column is one. Returns it lower-cased. */
export function parseCommandIdKey(values: OptionValues): string | undefined {
  const raw = stringOption(values, "command-id");
  if (raw === undefined) return undefined;
  if (!UUID_PATTERN.test(raw))
    throw new CliError(`--command-id must be a uuid (like ${randomUUID()}), got "${raw}".`, EXIT.usage);
  return raw.toLowerCase();
}

/** A name-based (v5) uuid: the same key and name always give the same id, so a repeated write re-derives it. */
export function deriveCommandId(key: string, name: string): string {
  const hash = createHash("sha1")
    .update(Buffer.from(key.replace(/-/g, ""), "hex"))
    .update(name)
    .digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** Per-invocation write state: the idempotency key and how many keyed writes have been made. */
const invocations = new WeakMap<CommandContext, { key: string; writes: number }>();

/** True once a write in this invocation took its commandId from the key; cli.ts warns when `--command-id` was never used. */
export function commandKeyUsed(context: CommandContext): boolean {
  return invocations.has(context);
}

/** The key this invocation's keyed writes used, if any did: the id a doubtful write must be repeated with. */
export function usedCommandKey(context: CommandContext): string | undefined {
  return invocations.get(context)?.key;
}

function invocationState(context: CommandContext, args: ParsedArgs): { key: string; writes: number } {
  let state = invocations.get(context);
  if (!state) {
    state = { key: parseCommandIdKey(args.values) ?? randomUUID(), writes: 0 };
    invocations.set(context, state);
  }
  return state;
}

/**
 * A stable id for something a command creates alongside its writes (a new entity's id): derived from the
 * invocation's key, so a repeat with the same `--command-id` targets the same record instead of a new one.
 */
export function derivedEntityId(context: CommandContext, args: ParsedArgs, name: string): string {
  return deriveCommandId(invocationState(context, args).key, name);
}

/**
 * Gives a write's payload its commandId from the invocation's key: `--command-id` when given, otherwise a
 * key minted once per invocation. The first write uses the key itself, later ones derive from it
 * (`suffix` when the caller has a stable name for the write, else their position), so repeating the
 * command with `--command-id <key>` re-sends exactly the ids it sent before and the portal's
 * `writes` apply each write at most once. Payloads without a commandId are left alone.
 */
export function stampCommandId(
  context: CommandContext,
  args: ParsedArgs,
  payload: Record<string, unknown>,
  suffix?: string
): { payload: Record<string, unknown>; key: string | undefined } {
  if (typeof payload.commandId !== "string") return { payload, key: undefined };
  const state = invocationState(context, args);
  const position = state.writes;
  state.writes += 1;
  const commandId =
    suffix !== undefined
      ? deriveCommandId(state.key, suffix)
      : position === 0
        ? state.key
        : deriveCommandId(state.key, `write-${position}`);
  // A new record the caller left to the portal is keyed by its command id (see `span add`, `save`); keep that link.
  const keyedBy = RECORD_KEYS.find((key) => idOf(payload[key]) === payload.commandId);
  return {
    payload: {
      ...payload,
      commandId,
      ...(keyedBy ? { [keyedBy]: { ...(payload[keyedBy] as object), id: commandId } } : {})
    },
    key: state.key
  };
}

/** Where a command carries its record: `entity` for the generic route, the record's own name on the action and project routes. */
const RECORD_KEYS = ["entity", "action", "project"] as const;

function idOf(record: unknown): unknown {
  return typeof record === "object" && record !== null ? (record as { id?: unknown }).id : undefined;
}

/**
 * A new record the caller left to the portal is keyed by its command id, and stamping replaces that id. The
 * reversal and the record's address were built with the old one, so point them at the id that was sent: else
 * `undo` would remove a record that never existed and could not find the one that did.
 */
function rekeyed<T extends { undo: ReverseRequest; target: JournalTarget }>(
  reverse: T,
  before: Record<string, unknown>,
  sent: Record<string, unknown>
): T {
  for (const key of RECORD_KEYS) {
    const was = idOf(before[key]);
    const now = idOf(sent[key]);
    if (typeof was !== "string" || typeof now !== "string" || was === now) continue;
    const undoRecord = reverse.undo.payload[key] as { id?: unknown } | undefined;
    return {
      ...reverse,
      target: reverse.target.id === was ? { ...reverse.target, id: now } : reverse.target,
      undo:
        undoRecord?.id === was
          ? { ...reverse.undo, payload: { ...reverse.undo.payload, [key]: { ...undoRecord, id: now } } }
          : reverse.undo
    };
  }
  return reverse;
}

/** True when the portal's 5xx body says the write was saved (`committed: true`) and only the answer failed. */
function isCommitted(error: CliError): boolean {
  const body = error.details;
  return typeof body === "object" && body !== null && (body as { committed?: unknown }).committed === true;
}

/**
 * POSTs a command. A request that gets no HTTP answer (timeout, dropped connection) may or may not have
 * landed, so a payload carrying a commandId is sent once more with the same body: the portal's receipt
 * for that id makes the second send a no-op if the first landed. A 5xx answer may also follow a write that
 * landed (the portal saves, then reads the plan back to answer), so it is reported the same way, with the
 * command id to repeat. Any other answer is final; every failure carries the command id it used (in the
 * error's `commandId` field, and in the table-mode line, see cli.ts).
 */
export async function sendCommand<T>(
  client: PortalClient,
  path: string,
  payload: Record<string, unknown>,
  key: string | undefined = typeof payload.commandId === "string" ? payload.commandId : undefined
): Promise<T> {
  if (typeof payload.commandId !== "string") return client.post<T>(path, payload);
  const mayHaveLanded = (error: CliError) =>
    new CliError(
      isCommitted(error)
        ? // The portal says it saved the write and only the answer failed: not a doubt, a repeat just reads it back.
          `${error.message} The write was saved (command id ${key}); repeat with --command-id ${key} to read the result.`
        : `${error.message} The write may have landed (command id ${key}); repeat with --command-id ${key} to apply it at most once.`,
      EXIT.unavailable,
      error.details,
      {
        ...error.agent,
        ...(key === undefined ? {} : { commandId: key }),
        retry: isCommitted(error) ? "committed" : "doubtful",
        plainMessage: error.message
      }
    );
  const named = (error: unknown) =>
    error instanceof CliError
      ? new CliError(error.message, error.exitCode, error.details, {
          ...error.agent,
          ...(key === undefined ? {} : { commandId: key })
        })
      : error;
  try {
    return await client.post<T>(path, payload);
  } catch (first) {
    if (first instanceof ServerError) throw mayHaveLanded(first);
    if (!(first instanceof NetworkError)) throw named(first);
  }
  try {
    return await client.post<T>(path, payload);
  } catch (second) {
    if (second instanceof NetworkError || second instanceof ServerError) throw mayHaveLanded(second);
    throw named(second);
  }
}

/** The portal's create/update discriminator: null creates, the stored version updates. */
export function versionOf(item: Record<string, unknown> | undefined): number | null {
  const version = item?.version;
  return typeof version === "number" ? version : null;
}

/** Reads a `--from` JSON file whose top level must be an object. */
export function readJsonFile(path: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new CliError(`Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`, EXIT.usage);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new CliError(
      `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      EXIT.usage
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new CliError(`${path} must hold one JSON object.`, EXIT.usage);
  return parsed as Record<string, unknown>;
}

/**
 * `--set key=value` assignments: dotted keys make nested objects, values that parse as JSON are
 * taken as JSON (numbers, booleans, null, arrays, quoted strings), anything else stays a string.
 */
export function parseAssignments(values: OptionValues, name = "set"): Record<string, unknown> {
  const raw = values[name];
  const entries = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  const result: Record<string, unknown> = {};
  for (const entry of entries) {
    const text = String(entry);
    const separator = text.indexOf("=");
    if (separator <= 0) throw new CliError(`--${name} needs key=value, got "${text}".`, EXIT.usage);
    const key = text.slice(0, separator).trim();
    const valueText = text.slice(separator + 1);
    let value: unknown = valueText;
    try {
      value = JSON.parse(valueText);
    } catch {
      /* a plain string */
    }
    let cursor = result;
    const segments = key.split(".");
    for (let index = 0; index < segments.length - 1; index += 1) {
      const segment = segments[index] ?? "";
      const next = cursor[segment];
      if (!next || typeof next !== "object" || Array.isArray(next)) cursor[segment] = {};
      cursor = cursor[segment] as Record<string, unknown>;
    }
    cursor[segments.at(-1) ?? key] = value;
  }
  return result;
}

/** Deep-merges assignments over an existing record; arrays and scalars replace, objects merge. */
export function mergeAssignments(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const existing = merged[key];
    merged[key] =
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      existing &&
      typeof existing === "object" &&
      !Array.isArray(existing)
        ? mergeAssignments(existing as Record<string, unknown>, value as Record<string, unknown>)
        : value;
  }
  return merged;
}

/** What the portal answers with when a token agent's write is held for the owner (HTTP 202). */
export interface FiledProposal {
  proposal: { id: string; status?: string; summary?: string; shadow?: boolean };
  filedBecause?: string;
}

/** True when a write's answer is a filed proposal rather than the fresh state. */
export function isFiledProposal(response: unknown): response is FiledProposal {
  const proposal = (response as { proposal?: { id?: unknown } } | null | undefined)?.proposal;
  return typeof proposal === "object" && proposal !== null && typeof proposal.id === "string";
}

/** Table mode prints these on stdout, where the portal's agentNote is not shown; JSON and stderr stay unchanged. */
const CORRECTION_LINES =
  "You cannot take a proposal back. To correct it, repeat the same save with the same record id and the corrected " +
  "values (a new command id, or none): while the card is pending, that replaces it. If the correction is applied " +
  "instead, or the write has no record id (settings, delete), a second call files a second card: ask the owner to " +
  "reject the first in Inbox > Captured > From agents. A corrected `rhen save` that reuses the first call's " +
  "command id returns the old card unchanged.";

/** Tells the caller a write was filed as a proposal. Not a failure: the command still exits 0. */
export function reportFiledProposal(
  context: CommandContext,
  response: FiledProposal,
  /** True only for a plain save (agentNote's case): bulk and undo have no record id to correct by and say nothing here. */
  options: { correction?: boolean } = {}
): void {
  const message = `Filed as proposal ${response.proposal.id}, waiting for the owner`;
  const reason = response.filedBecause ? ` (${response.filedBecause})` : "";
  if (context.mode === "table")
    context.stdout(`${message}${reason}.` + (options.correction === true ? `\n${CORRECTION_LINES}` : ""));
  else
    context.stdout(
      toJson({ filedAsProposal: true, applied: false, proposalId: response.proposal.id, message, ...response }, true)
    );
  context.stderr(
    context.mcp === true
      ? `rhen: ${message}${reason}. Nothing was changed yet; call rhen_proposals with no arguments to read the outcome (your proposals, newest first, each with its status).`
      : `rhen: ${message}${reason}. Nothing was changed yet; read \`rhen proposals\` for the outcome.`
  );
}

/** How to put a write back: the request that does it, where the record lives, and (for a create) the redo to send. */
export interface ReverseSpec {
  label?: string;
  undo: ReverseRequest;
  target: JournalTarget;
  /** The request `redo` sends instead of the write as it was sent: a create restated against the id the portal gave the record. */
  redo?: ReverseRequest;
  /** The portal reverts this write from rows it saved (see `recordServerChecked`): no record version is kept. */
  serverChecked?: true;
}

/**
 * Builds a write's reversal from the state the portal answered with, for a write whose record is only known
 * afterwards (a create the portal keyed). Undefined records nothing.
 */
export type ReverseFromState = (state: PortalState, sent: Record<string, unknown>) => ReverseSpec | undefined;

const UNDO_HINT = "rhen: undo with `rhen undo` (redo: `rhen undo --redo`).";

/**
 * The write's command id when the portal says it kept the rows the write touched so it can put them back
 * (`revertible` in the answer, sent for an agent's write that changed plan data).
 */
export function revertibleOf(response: unknown): string | undefined {
  const revertible = (response as { revertible?: unknown } | null | undefined)?.revertible;
  return typeof revertible === "string" && revertible !== "" ? revertible : undefined;
}

/**
 * Journals a write the portal can revert itself, so `rhen undo` sends it to `/api/commands/revert`. A no-op
 * without a journal or when the answer names nothing revertible. True when an entry was recorded.
 */
export function recordServerChecked(
  context: CommandContext,
  response: unknown,
  write: { path: string; sent: Record<string, unknown>; summary: string; label?: string; quiet?: boolean }
): boolean {
  const revertible = revertibleOf(response);
  if (!context.journal || revertible === undefined) return false;
  // A retried command is answered from its receipt with the same write: it already has its entry.
  const reverse = serverCheckedReverse(revertible);
  const recorded = context.journal
    .read()
    .some((entry) => entry.target.stateKey === reverse.target.stateKey && entry.target.id === reverse.target.id);
  if (recorded) return true;
  journalWrite(context, {
    ...write,
    state: undefined,
    reverse: { ...reverse, ...(write.label !== undefined ? { label: write.label } : {}), serverChecked: true }
  });
  if (write.quiet !== true) context.stderr(UNDO_HINT);
  return true;
}

/**
 * Records an applied write in the undo journal. The answer carries the state the write produced, so the
 * record's new version is read from it; undo sends that version, and any later edit makes the undo conflict
 * rather than overwrite. Only a version that is provably this write's own is kept (see `committedVersion`).
 * Shared by `postCommand` and by `bulk`, which sends its rows itself but journals each exactly as `save` would.
 * Does nothing when the context has no journal, or when it keeps only server-checked entries and this one restates
 * the record (`Journal.serverCheckedOnly`). True when an entry was recorded.
 */
export function journalWrite(
  context: CommandContext,
  write: {
    /** The state the portal answered with; absent for a server-checked write, which keeps no version. */
    state: PortalState | undefined;
    /** The body that was sent (its commandId stamped): what `redo` sends again and what the version is checked against. */
    sent: Record<string, unknown>;
    path: string;
    summary: string;
    reverse: ReverseSpec;
  }
): boolean {
  if (!context.journal) return false;
  const { reverse } = write;
  if (reverse.serverChecked !== true && context.journal.serverCheckedOnly === true) return false;
  const version = reverse.serverChecked ? undefined : committedVersion(write.state, reverse.target, write.sent);
  recordWrite(context.journal, {
    id: randomUUID(),
    at: context.now().toISOString(),
    label: reverse.label ?? write.summary,
    undo: reverse.undo,
    redo: reverse.redo ?? { path: write.path, payload: write.sent },
    target: reverse.target,
    owner: context.owner ?? UNLABELED_OWNER,
    ...(version !== undefined ? { version } : {}),
    ...(reverse.serverChecked ? { serverChecked: true as const } : {})
  });
  return true;
}

/** A write a command built while its writes are collected rather than sent (`CommandContext.collect`). */
export interface CollectedWrite {
  path: string;
  payload: Record<string, unknown>;
  summary: string;
}

/**
 * What a dry run did and did not check, printed beside every preview. A dry run builds the payload and checks it locally and
 * sends nothing to the portal, so a clean one is not a promise the real write applies: ids, duplicates, versions, evidence and
 * scopes are the portal's to check, and only the real write does.
 */
export const DRY_RUN_NOTICE = {
  validated:
    "Only this tool's own argument check: the payload below was built from your arguments and checked locally for field names, types and formats. Nothing was sent to the portal.",
  notValidated: [
    "that the ids it names (project, action, place and so on) exist",
    "duplicates of an existing record",
    "the record's current version",
    "evidence for a stated basis",
    "your token's scopes and the owner's guarded settings"
  ],
  next: "A clean dry run does not mean the write will apply. Repeat the same call without dry-run to make the change; the portal checks the rest then and says exactly what to fix."
} as const;

export interface WriteResult {
  /** Null when --dry-run stopped before the POST. */
  state: PortalState | null;
  /** The portal's whole answer, for a command whose route says more than the state (`wake`); absent on --dry-run. */
  response?: unknown;
}

/**
 * The one write path every mutating command uses. Echoes a one-line summary of the change to
 * stderr, prints the exact payload and stops when `--dry-run`, otherwise POSTs and returns the
 * portal's fresh state. A multi-entity change passes `needsYes` and is refused without `--yes`.
 */
export async function postCommand(
  context: CommandContext,
  args: ParsedArgs,
  options: {
    path: string;
    payload: Record<string, unknown>;
    summary: string;
    needsYes?: string;
    /** Shown beside the payload on --dry-run: what the write would change, when the payload alone doesn't say. */
    preview?: unknown;
    /** A stable name for this write within the command (e.g. the row id), used instead of its position to derive its commandId from `--command-id`. */
    idName?: string;
    /**
     * How to put this write back: the request that restores the record as it was, and where the record
     * lives (so `undo` can read its current version). Recorded for `undo`/`redo` once the write lands.
     * `"server"`: the write touches several rows no restating command can put back, so the portal keeps them
     * and says so in its answer (`revertible`); the entry then sends the portal's revert route, and nothing is
     * recorded when the answer lacks it (the portal did not snapshot the write).
     */
    reverse?: ReverseSpec | ReverseFromState | "server";
  }
): Promise<WriteResult> {
  // A preview changes nothing, so it never needs the confirmation the real write does.
  if (options.needsYes && !booleanOption(args.values, "yes") && !booleanOption(args.values, "dry-run"))
    throw new CliError(`${options.needsYes} Pass --yes to proceed.`, EXIT.usage);
  const stamped = stampCommandId(context, args, options.payload, options.idName);
  const payload = stamped.payload;
  // A changeset builds its writes with the tools that own them and sends them together (commands/changeset.ts).
  if (context.collect) {
    context.collect({ path: options.path, payload, summary: options.summary });
    return { state: null };
  }
  if (booleanOption(args.values, "dry-run")) {
    context.stderr(`rhen: ${options.summary}`);
    context.stdout(
      toJson(
        {
          dryRun: true,
          ...DRY_RUN_NOTICE,
          path: options.path,
          payload,
          ...(options.preview !== undefined ? { preview: options.preview } : {})
        },
        true
      )
    );
    return { state: null };
  }
  const response = await sendCommand<{ state?: PortalState } | FiledProposal>(
    context.client,
    options.path,
    payload,
    stamped.key
  );
  // After the answer, not before: a refusal then prints as the first line of stderr instead of being
  // buried under a summary of what was attempted, so `2>&1 | head` still shows why it failed.
  context.stderr(`rhen: ${options.summary}`);
  if (isFiledProposal(response)) {
    // Held for the owner: nothing changed, so there is no state to show and nothing to undo.
    reportFiledProposal(context, response, { correction: true });
    return { state: null };
  }
  const state = response?.state;
  if (!state || typeof state !== "object")
    throw new CliError("The portal accepted the command but returned no state.", EXIT.unavailable);
  if (options.reverse === "server" || revertibleOf(response) !== undefined) {
    // The portal kept the rows this write touched, so it puts them back itself (the whole before-row, and an
    // inserted row is deleted); that beats restating the record from the state read before the write.
    // The restating reversal still names the record best (a create's label carries the id it was stored under).
    const named =
      typeof options.reverse === "function"
        ? options.reverse(state, payload)
        : options.reverse && options.reverse !== "server"
          ? rekeyed(options.reverse, options.payload, payload)
          : undefined;
    recordServerChecked(context, response, {
      path: options.path,
      sent: payload,
      summary: options.summary,
      ...(named?.label !== undefined ? { label: named.label } : {})
    });
  } else if (options.reverse && context.journal) {
    // The reversal is built from the state the write produced; a create's is only known from it.
    const reverse =
      typeof options.reverse === "function"
        ? options.reverse(state, payload)
        : rekeyed(options.reverse, options.payload, payload);
    if (reverse) {
      if (journalWrite(context, { state, sent: payload, path: options.path, summary: options.summary, reverse }))
        context.stderr(UNDO_HINT);
    }
  }
  return { state, response };
}

/**
 * After a write, show what the entity now looks like from the returned state: the whole record in
 * JSON mode, a readable record otherwise. Falls back to a confirmation line when it cannot be found
 * (some commands change things no single record shows).
 */
export function printOutcome(
  context: CommandContext,
  state: PortalState,
  options: {
    stateKey?: string;
    id?: string;
    fallback: string;
    timeZone?: string;
    replayOf?: string;
    placement?: string;
  }
): void {
  const items = options.stateKey ? getPath(state, options.stateKey) : undefined;
  const found =
    Array.isArray(items) && options.id !== undefined
      ? (items as Record<string, unknown>[]).find((item) => item.id === options.id)
      : undefined;
  emitSaved(context, found, options);
}

/** True when the state already holds a record keyed by `key`: a write sent again under that command id. */
export function alreadyStored(state: PortalState, stateKey: string, key: string | undefined): boolean {
  if (key === undefined) return false;
  const items = getPath(state, stateKey);
  return Array.isArray(items) && (items as Record<string, unknown>[]).some((item) => item.id === key);
}

/**
 * Says what a write that went through did, so an agent never infers it: `applied: true` for a fresh write; for a
 * command id the portal had already applied (`replayOf`), `replayed: true`, `applied: false` and a sentence saying
 * nothing was written again, beside the original record. A write filed for the owner says so in `reportFiledProposal`.
 */
export function emitSaved(
  context: CommandContext,
  record: Record<string, unknown> | undefined,
  options: {
    fallback: string;
    timeZone?: string | undefined;
    replayOf?: string | undefined;
    /** For a new action: it is not on the day plan yet, and which calls show where it lands. */
    placement?: string | undefined;
  }
): void {
  const replay = options.replayOf !== undefined;
  const message = replay
    ? `Replay: command id ${options.replayOf} was already applied earlier, so nothing was written again. This is the record as it now stands.`
    : undefined;
  if (context.mode !== "table") {
    const flags = replay
      ? { applied: false, replayed: true, message }
      : { applied: true, ...(options.placement ? { placement: options.placement } : {}) };
    context.stdout(
      toJson(record ? { ...flags, ...record } : { ok: true, ...flags, message: message ?? options.fallback }, true)
    );
    return;
  }
  if (message) context.stdout(message);
  if (record) context.stdout(renderRecord(record, { timeZone: options.timeZone }));
  else if (!message) context.stdout(options.fallback);
  if (!replay && options.placement) context.stdout(options.placement);
}
