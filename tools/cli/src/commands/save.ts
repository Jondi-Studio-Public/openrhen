import {
  assumedFieldsAfterUpdate,
  closestNames,
  entityFieldNames,
  HIDING_STATUS,
  UNDO_VERB,
  type CloseType,
  normalizeAssumedFields,
  normalizeStatus,
  SAVE_ENTITY_KINDS,
  type SaveEntityKind,
  planningEntityCommandSchema,
  saveActionCommandSchema,
  saveProjectCommandSchema,
  spanEntitySchema,
  spanRemoveEntitySchema,
  withActionDefaults
} from "@openrhen/contracts";
import type { PortalState } from "../client.js";
import {
  booleanOption,
  parsePositiveInt,
  requirePositional,
  stringOption,
  type CommandSpec,
  type ParsedArgs
} from "../command.js";
import { CliError, EXIT, firstIssueMessage } from "../errors.js";
import { normalizeForWrite } from "../read-to-write.js";
import { checkPrerequisites } from "../prerequisite-check.js";
import { saveComparison } from "./rank.js";
import { mentionsRecurrence, withRecurrenceIds } from "../recurrence-ids.js";
import {
  alreadyStored,
  emitSaved,
  mergeAssignments,
  newCommandId,
  parseAssignments,
  parseCommandIdKey,
  postCommand,
  printOutcome,
  readJsonFile,
  versionOf,
  type ReverseFromState,
  type ReverseSpec
} from "../write.js";

type Fields = Record<string, unknown>;

export interface EntityTypeDef {
  /** The wire value: matches `planningEntityCommandSchema`'s `entityType` enum, or "project"/"action" for the dedicated routes. */
  canonical: string;
  aliases: string[];
  route: "project" | "action" | "entity" | "comparison";
  /** The `PortalState` array this kind lives in, for lookups and for showing the saved record back. */
  arrayKey?: keyof PortalState;
  /** Set for the two singletons that live at a fixed path instead of an array. */
  singletonKey?: "settings" | "dailyPlan";
}

/**
 * Every entity type `save` (and, for the ones with an `arrayKey`, `bulk`) can write, matched against
 * `bulk`'s entity argument by `arrayKey === listEntity.key` (see `entities.ts`) — that intersection is
 * what makes an entity kind both listable and bulk-updatable, with no separate list to keep in sync.
 */
export const ENTITY_TYPES: EntityTypeDef[] = [
  { canonical: "area", aliases: ["areas"], route: "entity", arrayKey: "areas" },
  { canonical: "outcome", aliases: ["outcomes"], route: "entity", arrayKey: "outcomes" },
  { canonical: "project", aliases: ["projects"], route: "project", arrayKey: "projects" },
  { canonical: "action", aliases: ["actions"], route: "action", arrayKey: "actions" },
  { canonical: "commitment", aliases: ["commitments"], route: "entity", arrayKey: "commitments" },
  { canonical: "capture", aliases: ["captures"], route: "entity", arrayKey: "captures" },
  { canonical: "deliverable", aliases: ["deliverables"], route: "entity", arrayKey: "deliverables" },
  { canonical: "routine_step", aliases: ["routine-step", "routine-steps"], route: "entity", arrayKey: "routineSteps" },
  {
    canonical: "routine_preset",
    aliases: ["routine-preset", "routine-presets"],
    route: "entity",
    arrayKey: "routinePresets"
  },
  { canonical: "sleep_plan", aliases: ["sleep-plan", "sleep-plans"], route: "entity", arrayKey: "sleepPlans" },
  { canonical: "planning_focus", aliases: ["planning-focus"], route: "entity", arrayKey: "planningFocus" },
  { canonical: "span", aliases: ["spans"], route: "entity", arrayKey: "spans" },
  {
    canonical: "condition_definition",
    aliases: ["condition-definition", "condition-definitions", "place", "places"],
    route: "entity",
    arrayKey: "conditionDefinitions"
  },
  { canonical: "settings", aliases: [], route: "entity", singletonKey: "settings" },
  { canonical: "daily_plan", aliases: ["daily-plan"], route: "entity", singletonKey: "dailyPlan" },
  // These four have no id-addressable home in `PortalState`, so there is never an existing record to
  // look up or merge over: every save of one of them sends `expectedVersion: null`.
  { canonical: "current_availability", aliases: ["current-availability"], route: "entity" },
  { canonical: "sleep_log_entry", aliases: ["sleep-log-entry", "sleep-log"], route: "entity" },
  { canonical: "capture_review", aliases: ["capture-review"], route: "entity" },
  { canonical: "deliverable_contract_review", aliases: ["deliverable-contract-review"], route: "entity" },
  // An answer to a group of items to rank (`rhen rank`): an append-only log entry on its own route, with no record to
  // look up or update, so `id`, `create` and `expected-version` do not apply.
  { canonical: "comparison", aliases: ["comparisons"], route: "comparison" }
];

export function findEntityType(name: string): EntityTypeDef | undefined {
  const wanted = name.trim().toLowerCase();
  return ENTITY_TYPES.find((def) => def.canonical === wanted || def.aliases.includes(wanted));
}

/**
 * Fields a record read back carries that are the server's bookkeeping, not something a save sets. An agent that
 * echoes a record it read gets them dropped rather than refused; every other unknown field is refused.
 */
const BOOKKEEPING_FIELDS = new Set(["version", "createdAt", "updatedAt"]);

/** `did you mean "x"` for a refused field: names a typo away, or longer real names that end with it (`deadlineAt` for `internalDeadlineAt`). */
function fieldHint(name: string, known: readonly string[]): string[] {
  const squash = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");
  const wanted = squash(name);
  const ends = wanted.length >= 4 ? known.filter((field) => squash(field).endsWith(wanted)) : [];
  const near = [...new Set([...ends, ...closestNames(name, known)])].slice(0, 3);
  return near.length === 0 ? [] : [`${name}: did you mean ${near.map((field) => `"${field}"`).join(" or ")}? `];
}

/**
 * Refuses a field the kind does not take, naming the ones it does: before this, an unknown or read-only field
 * (a project's `area` name, say) was dropped without a word and the agent believed it saved. Only the caller's own
 * top-level names are checked; a dotted `--set a.b=...` is checked by its first part.
 */
export function withKnownFields(def: EntityTypeDef, provided: Fields): Fields {
  const known = new Set(
    SAVE_ENTITY_KINDS.includes(def.canonical as SaveEntityKind) ? entityFieldNames(def.canonical as SaveEntityKind) : []
  );
  if (known.size === 0) return provided;
  const unknown = Object.keys(provided).filter((name) => !known.has(name) && !BOOKKEEPING_FIELDS.has(name));
  if (unknown.length > 0)
    throw new CliError(
      `A ${humanLabel(def.canonical)} has no field ${unknown.map((name) => `"${name}"`).join(", ")}. ` +
        unknown.flatMap((name) => fieldHint(name, [...known])).join("") +
        `Its fields are: ${[...known].join(", ")}.`,
      EXIT.validation
    );
  return Object.fromEntries(Object.entries(provided).filter(([name]) => known.has(name) || name === "version"));
}

/**
 * The version the caller read the record at, if it gave one: `--expected-version`, or the record's own `version`
 * passed back in `--fields` or `--set`. An update then goes through only while the stored record is still at that
 * version, so a change made since the read is not silently merged over.
 */
function readVersionGiven(args: ParsedArgs, provided: Fields): number | undefined {
  const option = parsePositiveInt(args, "expected-version");
  const raw = provided.version;
  const field = typeof raw === "number" ? raw : typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : undefined;
  if (raw !== undefined && field === undefined)
    throw new CliError(`version must be a whole number, got ${JSON.stringify(raw)}.`, EXIT.validation);
  if (option !== undefined && field !== undefined && option !== field)
    throw new CliError(
      `--expected-version ${option} and the version field ${field} disagree. Give the version you read once.`,
      EXIT.usage
    );
  return option ?? field;
}

/** Maps a status synonym onto the kind's own word (`done` on a routine step is `completed`); refuses one it lacks. */
export function withKnownStatus(def: EntityTypeDef, provided: Fields): Fields {
  if (typeof provided.status !== "string") return provided;
  const result = normalizeStatus(def.canonical, provided.status);
  if (result.ok) return result.status === provided.status ? provided : { ...provided, status: result.status };
  if (result.allowed.length === 0) return provided;
  throw new CliError(
    `"${provided.status}" is not a ${humanLabel(def.canonical)} status. Use one of: ${result.allowed.join(", ")}.`,
    EXIT.validation
  );
}

/** `--fields`: the entity's fields as one JSON object (over MCP, an object argument). */
function fieldsOption(raw: string | undefined): Fields {
  if (raw === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CliError("--fields must be a JSON object.", EXIT.usage);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new CliError("--fields must be a JSON object.", EXIT.usage);
  return parsed as Fields;
}

/**
 * A night the sleep log names by id: tonight's window from state, else the log's own history read (state carries
 * only the last day, or two weeks of hand-logged nights), so an update finds the row and its version.
 */
async function findLoggedNight(
  state: PortalState,
  client: { get<T = unknown>(path: string): Promise<T> },
  id: string
): Promise<Fields | undefined> {
  const inState = arrayItems(state, "sleepPlans").find((item) => item.id === id);
  if (inState) return inState;
  const log = await client.get<{ sleepPlans?: unknown }>("/api/sleep-log?days=90");
  const nights = Array.isArray(log?.sleepPlans) ? (log.sleepPlans as Fields[]) : [];
  return nights.find((item) => item.id === id);
}

/**
 * What a sleep-log update sends: the night's own times, with what the caller gave over them. The portal needs both
 * times on a completed night (and only the start on one under way), so a wake-only correction still saves.
 */
function sleepLogUpdate(existing: Fields, provided: Fields, id: string): Fields {
  const sleepAt = existing.actualStartAt ?? existing.plannedStartAt;
  const wakeAt = existing.status === "completed" ? (existing.actualWakeAt ?? existing.plannedWakeAt) : undefined;
  return {
    id,
    ...(typeof sleepAt === "string" ? { sleepAt } : {}),
    ...(typeof wakeAt === "string" ? { wakeAt } : {}),
    ...provided
  };
}

function arrayItems(state: PortalState, key: keyof PortalState): Fields[] {
  const value = state[key];
  return Array.isArray(value) ? (value as unknown as Fields[]) : [];
}

/**
 * The issues of a record that failed its command schema, with the path an agent sent: the record sits under `action`,
 * `project` or `entity` in the command, but the caller wrote it as `fields`, so `action.deadlineAt` is `fields.deadlineAt`.
 */
function fieldIssues(issues: readonly { path: PropertyKey[] }[]): unknown[] {
  return issues.map((issue) => {
    const [head, ...rest] = issue.path;
    return head === "action" || head === "project" || head === "entity"
      ? { ...issue, path: ["fields", ...rest] }
      : issue;
  });
}

export function humanLabel(canonical: string): string {
  return canonical.replace(/_/g, " ");
}

export function displayText(entity: Fields): string | undefined {
  for (const field of ["title", "name", "text"]) {
    const value = entity[field];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/**
 * Builds the route and validated payload for one entity save — the schema dispatch `save` uses for
 * its single write, factored out so `bulk` can apply the identical validation, route choice, and
 * error messages to each record in a batch instead of re-deriving them. Throws `CliError(EXIT.validation)`
 * on a schema mismatch, exactly as `save`'s own inline version did.
 */
export function buildWriteRequest(
  def: EntityTypeDef,
  entity: Fields,
  commandId: string,
  expectedVersion: number | null
): { path: string; payload: Fields } {
  const label = humanLabel(def.canonical);
  if (def.route === "project") {
    const parsed = saveProjectCommandSchema.safeParse({ commandId, expectedVersion, project: entity });
    if (!parsed.success)
      throw new CliError(
        "The project does not match the command schema.",
        EXIT.validation,
        fieldIssues(parsed.error.issues)
      );
    return { path: "/api/commands/project", payload: parsed.data };
  }
  if (def.route === "action") {
    // A recurring or cadence action needs a recurrence id and, for a recurring one, a window id per
    // window; fill in whatever the caller left out rather than making an AI tool invent them.
    // Why it waits and a note on the change ride beside the action on its command, not inside it.
    const { blockingReason, note, remainingAsserted, ...fields } = entity;
    const actionEntity = withRecurrenceIds(fields);
    const parsed = saveActionCommandSchema.safeParse({
      commandId,
      expectedVersion,
      action: actionEntity,
      ...(blockingReason !== undefined ? { blockingReason } : {}),
      ...(note !== undefined ? { note } : {}),
      ...(remainingAsserted !== undefined ? { remainingAsserted } : {})
    });
    if (!parsed.success)
      throw new CliError(
        "The action does not match the command schema." +
          (mentionsRecurrence(actionEntity) ? ' See "rhen guide recurrence" for the three recurrence kinds.' : ""),
        EXIT.validation,
        fieldIssues(parsed.error.issues)
      );
    return { path: "/api/commands/action", payload: parsed.data };
  }
  if (def.canonical === "span") {
    // The generic entity payload is an open record, so a span's dates and window are checked here, before
    // anything is sent, with the same schema the portal uses.
    const checked = (entity.remove === true ? spanRemoveEntitySchema : spanEntitySchema).safeParse(entity);
    if (!checked.success) throw new CliError(firstIssueMessage(checked.error), EXIT.validation, checked.error.issues);
  }
  const parsed = planningEntityCommandSchema.safeParse({
    commandId,
    type: "save_entity",
    expectedVersion,
    entityType: def.canonical,
    entity
  });
  if (!parsed.success)
    throw new CliError(
      `The ${label} does not match the command schema.`,
      EXIT.validation,
      fieldIssues(parsed.error.issues)
    );
  return { path: "/api/commands/entity", payload: parsed.data };
}

/**
 * A capture create restated with what the insert path defaults (`proposalType`, `proposedFields`), so the
 * same payload also works as the update `redo` sends after the capture was ignored (the update path requires
 * both and would otherwise blank the stored fields). The portal inserts the same values when they are absent.
 */
function completeCapture(entity: Fields): Fields {
  return {
    ...entity,
    proposalType: typeof entity.proposalType === "string" ? entity.proposalType : "unclassified",
    proposedFields: entity.proposedFields ?? { text: entity.text }
  };
}

/** The ids the portal keeps as sent (`stableUuid`): anything else it hashes, which the CLI cannot reproduce. */
const PORTAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The record a create that sent no id made, among the records that appeared in the answer. Only a proven match
 * counts, never "the only new record", because another client's create can land in the same window: a
 * command-keyed type is keyed by its command id, so it is the fresh record with exactly that id (undefined when
 * the command id is one the portal would hash); a capture has no such key, so it is the one fresh capture with
 * the sent text, and two of them cannot be told apart.
 */
function createdWithoutId(
  def: EntityTypeDef,
  entity: Fields,
  sent: Record<string, unknown>,
  fresh: Record<string, unknown>[]
): Record<string, unknown> | undefined {
  if (def.canonical === "capture") {
    const same = fresh.filter((item) => item.text === entity.text);
    return same.length === 1 ? same[0] : undefined;
  }
  const key = sent.commandId;
  if (typeof key !== "string" || !PORTAL_UUID.test(key)) return undefined;
  return fresh.find((item) => typeof item.id === "string" && item.id.toLowerCase() === key.toLowerCase());
}

/**
 * How to undo an update: the stored record, restated at the version the CLI read, so the undo is a
 * version-checked save of what it was. Used by `save` and by each `bulk` row, so both journal an edit the same
 * way. `id` names the row for a kind kept in an array (the daily plan's row is named from the record itself).
 * Undefined when the stored record does not restate cleanly: that write is then simply not undoable.
 */
export function reverseOfUpdate(
  def: EntityTypeDef,
  existing: Fields,
  expectedVersion: number | null,
  id: string | undefined
): ReverseSpec | undefined {
  try {
    const before = buildWriteRequest(def, normalizeForWrite(def.canonical, existing), newCommandId(), expectedVersion);
    const stateKey =
      def.singletonKey === "settings" || def.canonical === "current_availability"
        ? "settings"
        : (def.singletonKey ?? def.arrayKey);
    // The daily plan in state is the latest day's, a different row once a later day has one: name it.
    const rowId =
      def.singletonKey === "dailyPlan" && typeof existing.id === "string"
        ? existing.id
        : def.arrayKey && id !== undefined
          ? id
          : undefined;
    return stateKey ? { undo: before, target: { stateKey, ...(rowId !== undefined ? { id: rowId } : {}) } } : undefined;
  } catch {
    return undefined;
  }
}

/** Only `keys` of `record`, those it has. */
function pickFields(record: Fields, keys: readonly string[]): Fields {
  return Object.fromEntries(keys.filter((key) => key in record).map((key) => [key, record[key]]));
}

/** The two times a sleep plan's override moves together: the portal needs both whenever either is given. */
const SLEEP_TIMES = ["plannedStartAt", "plannedWakeAt"];

/** The fields a partial save sends: those given, and for a sleep plan both times when it names either. */
function partialKeys(def: EntityTypeDef, provided: Fields): string[] {
  const keys = Object.keys(provided);
  return def.canonical === "sleep_plan" && keys.some((key) => SLEEP_TIMES.includes(key))
    ? [...new Set([...keys, ...SLEEP_TIMES])]
    : keys;
}

/**
 * How to undo a sleep plan save, which names only what it changed: the night's stored times when it moved them,
 * or the placement choice it replaced. Undefined when there is nothing the portal would take back (a stay-up
 * decline, or a first placement choice, which has no earlier value to restate).
 */
function reverseOfSleepPlan(
  def: EntityTypeDef,
  existing: Fields,
  provided: Fields,
  expectedVersion: number | null,
  id: string
): ReverseSpec | undefined {
  const keys = Object.keys(provided);
  let before: Fields | undefined;
  if (keys.some((key) => SLEEP_TIMES.includes(key))) before = pickFields(existing, SLEEP_TIMES);
  else if (keys.includes("placementChoice") && typeof existing.placementChoice === "string")
    before = { placementChoice: existing.placementChoice };
  if (!before) return undefined;
  try {
    return {
      undo: buildWriteRequest(def, { id, ...before }, newCommandId(), expectedVersion),
      target: { stateKey: "sleepPlans", id }
    };
  } catch {
    return undefined;
  }
}

/** How to undo a free statement: the opposite statement, version-checked like any other update. */
function reverseOfFree(
  def: EntityTypeDef,
  id: string,
  free: boolean,
  expectedVersion: number | null
): ReverseSpec | undefined {
  try {
    return {
      undo: buildWriteRequest(def, { id, free: !free }, newCommandId(), expectedVersion),
      target: { stateKey: "commitments", id }
    };
  } catch {
    return undefined;
  }
}

/**
 * How to undo a settings save: the fields it named, restated as they were, so the undo names nothing the save
 * did not (an undo of recording when the person woke stays the same direct write). A field that was unset is
 * restated as null. Undefined when the save named no field.
 */
function reverseOfSettings(
  def: EntityTypeDef,
  existing: Fields,
  provided: Fields,
  expectedVersion: number | null
): ReverseSpec | undefined {
  const stored = normalizeForWrite(def.canonical, existing);
  // A field the state leaves out is unset (a home location, routine presets, transport mode), and the handler
  // clears a field sent as null, so it is restated as null rather than dropped.
  const named = Object.keys(provided).filter((field) => field !== "id");
  if (named.length === 0) return undefined;
  const before = Object.fromEntries(named.map((field) => [field, stored[field] ?? null]));
  try {
    return { undo: buildWriteRequest(def, before, newCommandId(), expectedVersion), target: { stateKey: "settings" } };
  } catch {
    return undefined;
  }
}

/**
 * How to undo a create: takes the new record out of the plan, found in the answered state because the portal
 * keys it (a record sent without an id gets its command id; a non-uuid id is hashed). A type with a hiding
 * status is restated with it (a version-checked update, so a later edit makes the undo conflict); a span has
 * none and is removed, which is on the agent hard floor, so an agent's undo is filed as a proposal for the
 * owner. `redo` restates the create against the id the portal gave the record, at the version the undo left.
 * Undefined for a type with neither: its create is not journaled.
 */
export function reverseOfCreate(def: EntityTypeDef, before: PortalState, now: Date): ReverseFromState | undefined {
  const stateKey = def.arrayKey;
  const status = HIDING_STATUS[def.canonical];
  const removes = def.canonical === "span";
  if (!stateKey || (status === undefined && !removes)) return undefined;
  const wrapper = def.route === "project" ? "project" : def.route === "action" ? "action" : "entity";
  return (after, sent) => {
    const sentEntity = sent[wrapper];
    if (sentEntity === null || typeof sentEntity !== "object") return undefined;
    const entity = sentEntity as Fields;
    const known = new Set(arrayItems(before, stateKey).map((item) => item.id));
    const fresh = arrayItems(after, stateKey).filter((item) => typeof item.id === "string" && !known.has(item.id));
    const given = typeof entity.id === "string" ? entity.id : undefined;
    const created =
      given !== undefined
        ? (fresh.find((item) => item.id === given) ?? (fresh.length === 1 ? fresh[0] : undefined))
        : createdWithoutId(def, entity, sent, fresh);
    if (!created || typeof created.id !== "string") return undefined;
    const id = given ?? created.id;
    // A record with a close verb is taken back with the close tool: the portal proves in its write ledger that this
    // very agent made it, a moment ago, and that nobody else has touched it since (`undoOfCommandId`). The redo is a
    // restore of that close, at the version the undo leaves.
    const verb = UNDO_VERB[def.canonical as CloseType];
    const createCommandId = typeof sent.commandId === "string" ? sent.commandId : undefined;
    const createdVersion = typeof created.version === "number" ? created.version : undefined;
    // A record with a close verb is never taken back by a save that sets a closed status: the portal refuses that for an
    // agent. With the version the answer carried the undo is the verified exemption; without it the version is null
    // (the portal then treats the undo as an ordinary close, which an agent must give a reason for, and the owner need not),
    // and with no command id to prove the create by there is nothing to journal.
    if (verb !== undefined) {
      if (createCommandId === undefined) return undefined;
      const close = (payload: Fields) => ({ path: "/api/commands/close", payload });
      const text = displayText(entity);
      return {
        label: `create ${humanLabel(def.canonical)}${text ? ` "${text}"` : ""} (${created.id})`,
        undo: close({
          commandId: newCommandId(),
          type: def.canonical,
          id: created.id,
          verb,
          do: "close",
          expectedVersion: createdVersion ?? null,
          undoOfCommandId: createCommandId
        }),
        target: { stateKey, id: created.id },
        ...(createdVersion === undefined
          ? {}
          : {
              redo: close({
                commandId: newCommandId(),
                type: def.canonical,
                id: created.id,
                verb,
                do: "restore",
                expectedVersion: createdVersion + 1
              })
            })
      };
    }
    const whole = def.canonical === "capture" ? completeCapture({ ...entity, id }) : { ...entity, id };
    const hidden: Fields = removes
      ? { id, remove: true }
      : { ...whole, status, ...(def.canonical === "capture" ? { reviewedAt: now.toISOString() } : {}) };
    const request = (payload: Fields) => ({ path: `/api/commands/${def.route}`, payload });
    // Named by the id the portal stored, which is not the one sent when the portal hashed it.
    const titleText = displayText(entity);
    return {
      label: `create ${humanLabel(def.canonical)}${titleText ? ` "${titleText}"` : ""} (${created.id})`,
      undo: request({ ...sent, [wrapper]: hidden, commandId: newCommandId(), expectedVersion: null }),
      target: { stateKey, id: created.id },
      // A create sent without an id is keyed by its command id, which a redo's new command id would change.
      ...(given === undefined || def.canonical === "capture" ? { redo: request({ ...sent, [wrapper]: whole }) } : {})
    };
  };
}

/**
 * What an action write says about which of its estimate and judgement fields are assumed (`assumedFields`; the
 * list and the rules are in `platform/contracts/src/planning/action-defaults.ts`).
 *
 * - A create: the starting values `withActionDefaults` filled in, plus any the caller itself listed as a guess.
 *   Defaults are always labelled, so listing none does not unlabel them.
 * - An update: the caller's own `assumedFields` when it gave one; otherwise the stored list minus every field the
 *   caller named in this call, even to the value it already had, because naming a field says it.
 *
 * `provided` is the caller's own fields (not merged with the stored record), so the stored `assumedFields` that the
 * merge carries over never counts as the caller's say.
 */
export function actionWithAssumedFields(entity: Fields, existing: Fields | undefined, provided: Fields): Fields {
  const listed = Array.isArray(provided.assumedFields) ? (provided.assumedFields as unknown[]) : undefined;
  if (existing)
    return {
      ...entity,
      assumedFields: listed
        ? normalizeAssumedFields(listed)
        : assumedFieldsAfterUpdate(existing.assumedFields as unknown[] | undefined, Object.keys(provided))
    };
  const filled = withActionDefaults(entity);
  return { ...filled.entity, assumedFields: normalizeAssumedFields([...filled.assumed, ...(listed ?? [])]) };
}

/**
 * `save capture` create default: a new capture is pending, the same status `capture` files it under, so
 * `--set text=...` alone works. (An update merges onto the stored capture and keeps its status.)
 */
function withCaptureDefaults(entity: Fields): Fields {
  return { status: "pending", ...entity };
}

/** `save project` create defaults. */
function withProjectDefaults(entity: Fields): Fields {
  return { status: "active", uncertainty: "some", consequence: 3, ...entity };
}

/** A new action is saved but not yet scheduled: the answer to "when will it get done?" is a later read. */
const NEW_ACTION_PLACEMENT =
  "This action is saved but not placed in the day yet: the plan recalculates after a write. To see where it lands, " +
  "call rhen_recalculate {} now (or wait a minute), then rhen_status {} (its day lists today's blocks) or " +
  'rhen_show {"entity": "action", "id": "<this action\'s id>"} (its occurrences). Until then, do not tell the ' +
  "person when it will be done.";

/**
 * "I'm free" (`free: true|false` on a commitment): a statement about one occurrence, sent as id and free alone so
 * the stored record is not restated, and undone by the opposite statement.
 */
function freeStatement(def: EntityTypeDef, provided: Fields): boolean | undefined {
  if (def.canonical !== "commitment" || provided.free === undefined) return undefined;
  if (typeof provided.free !== "boolean")
    throw new CliError(`free must be true or false, got ${JSON.stringify(provided.free)}.`, EXIT.validation);
  const others = Object.keys(provided).filter((key) => key !== "id" && key !== "free" && key !== "version");
  if (others.length > 0)
    throw new CliError(
      `free is a statement on its own and cannot be sent with ${others.join(", ")}. Send only id and free ` +
        '(rhen_save_commitment {"fields":{"id":"<commitment id>","free":true}}) and make any other change in a separate save.',
      EXIT.validation
    );
  return provided.free;
}

/** What a free write tells the caller beyond the record: what changed, what did not, and the exact next calls. */
function freeAnswer(title: string, id: string, free: boolean, awaiting: boolean): string {
  const undo = `rhen_undo {} (or rhen_save_commitment {"fields":{"id":"${id}","free":${free ? "false" : "true"}}})`;
  const recalculating = awaiting
    ? "The recommendation is still being recalculated (awaitingRecalculation is true), so the Now card and rhen_status " +
      "may keep saying the old thing for a moment. Call rhen_status {} in about a minute, or rhen_recalculate {} to force it, "
    : "Call rhen_status {} ";
  return free
    ? `Freed from "${title}": the planner stops treating the rest of it as taken and offers the next task. Nothing was ended, ` +
        "finished, moved or cancelled, and it stays on the day plan. " +
        `${recalculating}and read recommendation.primary for what to do next. ` +
        `This is not leaving: the trip home and the time after it stay protected until its end. To take it back: ${undo}.`
    : `"${title}" holds its time again until its end. ${recalculating}and read recommendation for what to do now. ` +
        `To free it again: ${undo}.`;
}

export const saveCommand: CommandSpec = {
  name: "save",
  summary: "Create or update one entity through the portal's command routes",
  description:
    "Create or update one entity: <entityType> is area, outcome, project, action, commitment, capture, " +
    "deliverable, routine-step, routine-preset, sleep-plan, planning-focus, span, " +
    "condition-definition, settings, daily-plan, current-availability, sleep-log-entry, " +
    "capture-review, deliverable-contract-review, or comparison (an answer to a group from `rank`: fields groupId and " +
    "rankedIds best first, or tie; plurals and a few aliases accepted). Give the entity's " +
    "fields as one JSON object with --fields, from --from <file.json>, with repeated --set key=value (dotted keys " +
    "nest, values that parse as JSON are taken as JSON), or any mix: --fields applies over --from and --set over " +
    "both. A field the kind does not take is refused, and the error lists the ones it does; `schema save-<kind>` " +
    "prints them with their types. A status synonym is mapped to the kind's own word (done on a routine step is " +
    "completed). Without an id this creates a record. With --id (or an id field) it updates that record, merging " +
    "the given fields over the stored one, and an id that names no record is an error, not a new record: pass " +
    "--create to make one with an id you chose (a record that already has it is updated). Settings sends only the " +
    "fields given (for an agent, plan preferences and lastWokeAt apply directly; timezone, setup and data-flow fields " +
    "go to the person). There is no delete: close a record with rhen_archive or rhen_cancel, not a status set here; " +
    "sleep_log_entry accepts --set remove=true, and span does the same. A new `save action` " +
    "defaults to status planned, a 60-minute estimate (60/60/60, so the project's uncertainty pads it), 60 minutes " +
    "remaining, splittable, no setup, medium energy, a 15-60 minute session range, importance and consequence 3, no " +
    "contexts and no dependencies. Part of the estimate fills in the rest the same way (each missing figure is the " +
    "expected; a lone remaining is the expected), so expectedMinutes=15 alone is valid; what it filled in is listed in " +
    "assumedFields. " +
    "A new `save project` defaults to status active, uncertainty some, consequence 3. A new " +
    "`save capture` defaults to status pending (the same as `capture`).",
  positionals: [
    {
      name: "entityType",
      required: true,
      description: "The kind of entity to save",
      // The aliases too, since the description and the guides name kinds the hyphenated way.
      enum: ENTITY_TYPES.flatMap((type) => [type.canonical, ...type.aliases])
    }
  ],
  options: {
    fields: {
      type: "string",
      placeholder: "json",
      mcp: { type: "object" },
      description: "The entity's fields, as one object (over --from, under --set)"
    },
    from: {
      type: "string",
      placeholder: "file.json",
      localPath: true,
      description: "Read the entity's fields from a JSON file"
    },
    set: { type: "string", placeholder: "key=value", multiple: true, description: "Set one field (repeatable)" },
    id: { type: "string", placeholder: "id", description: "The id of an existing record to update" },
    create: {
      type: "boolean",
      description: "Create the record with the given id when no record has it (one that does is updated)"
    },
    "expected-version": {
      type: "string",
      mcp: { type: "integer", minimum: 1 },
      placeholder: "n",
      description: "The version you read the record at; the update is refused (exit 3) if it has changed since"
    },
    "dry-run": { type: "boolean", description: "Print the command that would be sent instead of sending it" }
  },
  mutates: true,
  examples: [
    'save capture --set "text=Book the dentist follow-up"',
    'save action --fields \'{"title":"Call the bank","projectId":"project-admin","expectedMinutes":20}\'',
    'save commitment --id commitment-gym --set title="Gym session"',
    "save action --from new-action.json --dry-run"
  ],
  async run(context, args) {
    const entityArg = requirePositional(saveCommand, args, 0);
    const def = findEntityType(entityArg);
    if (!def)
      throw new CliError(
        `Unknown entity type "${entityArg}". Accepted: ${ENTITY_TYPES.map((type) => type.canonical).join(", ")}.`,
        EXIT.usage
      );

    const fromPath = stringOption(args.values, "from");
    const fromObject = fromPath ? readJsonFile(fromPath) : {};
    const fieldsText = stringOption(args.values, "fields");
    const fieldsObject = fieldsOption(fieldsText);
    const setObject = parseAssignments(args.values);
    if (fromPath === undefined && fieldsText === undefined && Object.keys(setObject).length === 0)
      throw new CliError("save needs --fields <json>, --from <file.json> or --set key=value.", EXIT.usage);
    const provided = withKnownStatus(
      def,
      withKnownFields(def, mergeAssignments(mergeAssignments(fromObject, fieldsObject), setObject))
    );

    if (def.canonical === "comparison") return saveComparison(context, args, provided);

    const idOption = stringOption(args.values, "id");
    const providedId = typeof provided.id === "string" ? provided.id : undefined;
    const id = idOption ?? providedId;
    const create = booleanOption(args.values, "create");
    if (create && id === undefined) throw new CliError("--create needs the id to create the record with.", EXIT.usage);

    const state = await context.client.getState();
    const timeZone = state.settings.timezone;
    const label = humanLabel(def.canonical);

    let existing: Fields | undefined;
    if (def.singletonKey === "settings") existing = state.settings as unknown as Fields;
    else if (def.singletonKey === "dailyPlan") {
      existing = state.dailyPlan as unknown as Fields | undefined;
      // The state carries only the latest day's plan, one row per day. Naming another day is a new
      // plan for that day: merging onto this row would send its id and version for the wrong date.
      const named = provided.localDate;
      if (
        existing &&
        typeof named === "string" &&
        String(existing.localDate).slice(0, 10) !== named.trim().slice(0, 10)
      )
        existing = undefined;
    } else if (def.arrayKey) {
      const items = arrayItems(state, def.arrayKey);
      existing = id !== undefined ? items.find((item) => item.id === id) : undefined;
    } else if (def.canonical === "sleep_log_entry") {
      existing = id !== undefined ? await findLoggedNight(state, context.client, id) : undefined;
    } else if (def.canonical === "current_availability") {
      // This entity type has no `arrayKey`/`singletonKey` (see the comment above `ENTITY_TYPES`), but
      // unlike the other three entity types that share that shape, it does have a home in
      // `PortalState`: it is spread across `currentEnergy`/`assertedConditions`/`currentSituation`, all
      // stored on the same `user_preferences` row `settings` is. Without this, a location-only
      // `--set currentSituation.locationId=...` would omit `currentEnergy`/`assertedConditions` (the
      // server requires both on every write to this row) and would send `expectedVersion: null` against
      // a row that already exists, which the server refuses as a conflict.
      existing = {
        version: state.settings.version,
        currentEnergy: state.currentEnergy,
        assertedConditions: state.assertedConditions,
        currentSituation: state.currentSituation as unknown as Fields
      };
    }

    // An id names a record to update. One that names nothing used to create a new record, so a mistyped id quietly
    // made a duplicate; now creating with a chosen id is said out loud with --create, which still updates the record
    // when the id is taken (a seed or an import can then be run again).
    const idAddressed = def.arrayKey !== undefined || def.canonical === "sleep_log_entry";
    const readVersion = readVersionGiven(args, provided);
    // A repeat of a keyed write (`--command-id`) whose first try landed finds the record already moved past the
    // version it read (or gone, when the write removed it). Only the portal's receipt can tell that from someone
    // else's edit, so such a write is sent with the version read: the portal replays the stored answer, or refuses
    // it as a conflict.
    const keyedRepeat = parseCommandIdKey(args.values) !== undefined && !booleanOption(args.values, "dry-run");
    let replayCheckedVersion: number | undefined;
    if (readVersion !== undefined && id !== undefined && !existing && keyedRepeat && provided.remove === true)
      replayCheckedVersion = readVersion;
    // An id read at a version that now names nothing was otherwise deleted since the read: recreating it would undo
    // the person's delete, so it is a conflict to check with them, not a usage slip or a plain not-found.
    else if (readVersion !== undefined && id !== undefined && !existing)
      throw new CliError(
        `This ${label} was removed after you read it (at version ${readVersion}). ` +
          `Check with the person before creating it again.`,
        EXIT.conflict
      );
    if (idAddressed && id !== undefined && !existing && !create && replayCheckedVersion === undefined)
      throw new CliError(
        `No ${label} has the id "${id}". Leave the id out to create one, or pass --create to create one with this id.`,
        EXIT.notFound
      );

    if (readVersion !== undefined && replayCheckedVersion === undefined) {
      if (!existing)
        throw new CliError(
          `There is no stored ${label} to check --expected-version against. Leave it out to create one.`,
          EXIT.usage
        );
      const stored = versionOf(existing);
      if (stored !== readVersion && keyedRepeat) replayCheckedVersion = readVersion;
      else if (stored !== readVersion)
        throw new CliError(
          `This ${label} is at version ${stored ?? "unknown"} now, not ${readVersion}: it changed after you read it. ` +
            `Read it again, check your change still holds, and save with --expected-version ${stored ?? "<the new version>"}.`,
          EXIT.conflict
        );
    }

    // Settings are sent as the top-level fields given, each merged with what is stored (so a dotted
    // `--set energyMeanings.high=...` keeps the other meanings); the portal keeps every field not sent. The whole
    // record would name every setting, owner-only ones included: an agent's change would be refused, or filed as
    // a proposal that could never be confirmed, and recording when the person woke (`isWakeSettings`)
    // would not apply directly.
    // A sleep plan likewise: restating its stored times would read as the person moving the night.
    const free = freeStatement(def, provided);
    if (free !== undefined && (!existing || id === undefined))
      throw new CliError(
        `There is no commitment to free${id === undefined ? ": give its id (from rhen_status commitments)" : ` with the id "${id}"`}.`,
        EXIT.notFound
      );
    const partial = def.singletonKey === "settings" || def.canonical === "sleep_plan" || free !== undefined;
    const merged =
      existing && def.canonical === "sleep_log_entry"
        ? sleepLogUpdate(existing, provided, id as string)
        : existing
          ? mergeAssignments(normalizeForWrite(def.canonical, existing), provided)
          : { ...provided };
    let entity: Fields =
      existing && partial
        ? {
            ...pickFields(merged, partialKeys(def, provided)),
            ...(def.arrayKey && id !== undefined ? { id } : {})
          }
        : merged;
    if (!existing && id !== undefined && entity.id === undefined) entity = { ...entity, id };
    if (def.canonical === "action") entity = actionWithAssumedFields(entity, existing, provided);
    if (!existing && def.canonical === "project") entity = withProjectDefaults(entity);
    if (!existing && def.canonical === "capture") entity = withCaptureDefaults(entity);
    // Energy named in this call is said now, even when it matches what is stored, so "still low" dates it
    // afresh (`energySetAt`). Energy carried over from the stored record by a place-only write is not.
    if (def.canonical === "current_availability" && provided.currentEnergy !== undefined)
      entity = { energyAsserted: true, ...entity };
    // The same for the remaining time on an action: naming it in this call confirms it, even at the stored figure
    // ("still about 3 h"), which is how an aged-effort need is answered. A save that only carries it over is not.
    if (def.canonical === "action" && existing && provided.remainingMinutes !== undefined)
      entity = { remainingAsserted: true, ...entity };

    checkPrerequisites(def.canonical, entity, state);
    const commandId = newCommandId();
    // The action and project routes want an id on every write. A create that named none is keyed by its command id,
    // as the portal keys the other kinds, so a repeat with the same `--command-id` finds the same record.
    if (!existing && entity.id === undefined && (def.route === "action" || def.route === "project"))
      entity = { ...entity, id: commandId };
    const expectedVersion = replayCheckedVersion ?? versionOf(existing);

    const { path, payload } = buildWriteRequest(def, entity, commandId, expectedVersion);

    const verb = existing ? "update" : "create";
    const titleText = displayText(entity);
    const summary = `${verb} ${label}${titleText ? ` "${titleText}"` : ""}${id ? ` (${id})` : ""}`;

    // An update can be put back exactly (the stored record, restated); a create is taken out of the plan by
    // `reverseOfCreate`; a removal cannot be put back. Nor can a keyed repeat sent with the version it read: the
    // record read here is already past that version (the first try's own result, when the portal replays it), so
    // restating it would journal an undo that changes nothing.
    let reverse: Parameters<typeof postCommand>[2]["reverse"];
    const restatable = entity.remove !== true && replayCheckedVersion === undefined;
    if (!existing && restatable) reverse = reverseOfCreate(def, state, context.now());
    if (existing && restatable)
      reverse =
        free !== undefined
          ? reverseOfFree(def, id as string, free, expectedVersion)
          : def.singletonKey === "settings"
            ? reverseOfSettings(def, existing, provided, expectedVersion)
            : def.canonical === "sleep_plan"
              ? reverseOfSleepPlan(def, existing, provided, expectedVersion, id as string)
              : reverseOfUpdate(def, existing, expectedVersion, id);
    const result = await postCommand(context, args, { path, payload, summary, ...(reverse ? { reverse } : {}) });
    if (!result.state) return; // --dry-run already printed the payload

    // A record already stored under the command id the caller gave means the portal answered from its receipt: this
    // send applied nothing. A keyed update that read a version the record has moved past is the same case.
    const key = parseCommandIdKey(args.values);
    const replayOf =
      key !== undefined &&
      (replayCheckedVersion !== undefined ||
        (def.arrayKey !== undefined && !existing && alreadyStored(state, def.arrayKey, key)))
        ? key
        : undefined;
    if (def.singletonKey) {
      const record = (def.singletonKey === "settings" ? result.state.settings : result.state.dailyPlan) as
        Fields | undefined;
      emitSaved(context, record, { fallback: `${label} saved.`, timeZone, replayOf });
      return;
    }

    if (!def.arrayKey) {
      printOutcome(context, result.state, { fallback: `${label} saved.`, timeZone, ...(replayOf ? { replayOf } : {}) });
      return;
    }

    let outcomeId = id;
    if (outcomeId === undefined && replayOf !== undefined && !existing) outcomeId = replayOf;
    if (outcomeId === undefined) {
      const before = new Set(arrayItems(state, def.arrayKey).map((item) => item.id));
      const created = arrayItems(result.state, def.arrayKey).find(
        (item) => typeof item.id === "string" && !before.has(item.id)
      );
      outcomeId = typeof created?.id === "string" ? created.id : undefined;
    }
    printOutcome(context, result.state, {
      stateKey: def.arrayKey,
      ...(outcomeId !== undefined ? { id: outcomeId } : {}),
      fallback: `${label} saved.`,
      timeZone,
      ...(replayOf ? { replayOf } : {}),
      ...(def.canonical === "action" && !existing ? { placement: NEW_ACTION_PLACEMENT } : {}),
      ...(free !== undefined && replayOf === undefined
        ? (() => {
            const awaiting = result.state?.planning?.awaitingRecalculation === true;
            return {
              placement: freeAnswer(String(existing?.title ?? "the commitment"), outcomeId ?? "<id>", free, awaiting),
              extra: { awaitingRecalculation: awaiting, nextCall: "rhen_status {}" }
            };
          })()
        : {})
    });
  }
};
