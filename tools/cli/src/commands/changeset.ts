import { createHash } from "node:crypto";
import {
  AGENT_BASES,
  AGENT_PROPOSAL_EVIDENCE_MAX,
  CHANGESET_MAX_ITEMS,
  CHANGESET_QUESTION_MAX,
  CHANGESET_ROUTES,
  entityFieldNames,
  SAVE_ENTITY_KINDS,
  type ChangesetDuplicate,
  type ChangesetItem,
  type ChangesetItemResult,
  type ChangesetResult,
  type ChangesetRoute,
  type SaveEntityKind
} from "@openrhen/contracts";
import { z } from "zod";
import type { PortalClient, PortalState } from "../client.js";
import { stringOption, type CommandContext, type CommandSpec, type ParsedArgs } from "../command.js";
import { CliError, EXIT } from "../errors.js";
import { toJson } from "../output.js";
import { normalizeForWrite } from "../read-to-write.js";
import {
  deriveCommandId,
  mergeAssignments,
  recordServerChecked,
  sendCommand,
  stampCommandId,
  type CollectedWrite
} from "../write.js";
import { resolveLocation } from "./arrive.js";
import { recurrenceCommand } from "./recurrence.js";
import { findEntityType, humanLabel, saveCommand, type EntityTypeDef } from "./save.js";
import { sessionCommand } from "./session.js";
import { statusCommand } from "./status.js";

/**
 * `changeset`: one message of facts as one write. Each intent is built by the tool
 * that owns it (`save`, `session finish`, `recurrence set`), run with its writes collected instead of sent, and the
 * collected commands go to the portal together: `preview` runs them and keeps nothing, `apply` keeps all of them or
 * none, then answers with the plan they made.
 */

type Fields = Record<string, unknown>;

const OPS = ["create", "update", "complete", "observe"] as const;
/** What an observe records, and the fields each takes. */
const OBSERVE_FIELDS = {
  sleep: ["sleepAt", "wakeAt", "remove"],
  place: ["place"],
  session: ["outcome", "remaining", "note", "endedAt"],
  energy: ["energy"]
} as const;
type ObserveKind = keyof typeof OBSERVE_FIELDS;
const RULE_KINDS = ["commitment_rule", "commitment-rule", "commitment-rules", "recurrence-rule"];
/** How far either side of a night's own times a reported sleep still finds it, so a correction updates that night. */
const NIGHT_SLACK_MS = 3 * 60 * 60_000;
/** How long the answer to an apply waits for the plan it made, by default. */
const DEFAULT_WAIT_SECONDS = 15;
const POLL_MS = 1000;

export const intentSchema = z
  .object({
    op: z.enum(OPS),
    kind: z.string().min(1),
    ref: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/, "a ref is letters, digits, - and _ (up to 64)")
      .optional(),
    id: z.string().min(1).optional(),
    fields: z.record(z.string(), z.unknown()).optional(),
    at: z.string().min(1).optional(),
    basis: z.enum(AGENT_BASES).optional(),
    evidence: z.string().trim().min(1).max(AGENT_PROPOSAL_EVIDENCE_MAX).optional(),
    question: z.string().trim().min(1).max(CHANGESET_QUESTION_MAX).optional()
  })
  .strict();
type Intent = z.infer<typeof intentSchema>;

/** The plan-search kind a save kind is found under, for the duplicate check. */
const SEARCH_KIND: Record<string, string> = {
  area: "area",
  outcome: "outcome",
  project: "project",
  deliverable: "deliverable",
  action: "action",
  commitment: "commitment",
  capture: "capture",
  routine_step: "routine-step",
  condition_definition: "condition",
  span: "span"
};

function parseIntents(raw: string | undefined): Intent[] {
  if (raw === undefined) throw new CliError("changeset needs --changes <json list of intents>.", EXIT.usage);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CliError("--changes must be a JSON list of intents.", EXIT.usage);
  }
  if (!Array.isArray(parsed) || parsed.length === 0)
    throw new CliError("--changes must be a non-empty JSON list of intents.", EXIT.usage);
  if (parsed.length > CHANGESET_MAX_ITEMS)
    throw new CliError(
      `A changeset takes at most ${CHANGESET_MAX_ITEMS} intents; send the rest in another.`,
      EXIT.usage
    );
  return parsed.map((entry, index) => {
    const checked = intentSchema.safeParse(entry);
    if (!checked.success) {
      const issue = checked.error.issues[0];
      throw new CliError(
        `Intent ${index}: ${issue ? `${issue.path.map(String).join(".") || "(intent)"} ${issue.message}` : "is not an intent"}.`,
        EXIT.validation,
        checked.error.issues
      );
    }
    return checked.data;
  });
}

/** Swaps every `@ref` string (a whole value, anywhere in the fields) for the id that ref's create is stored under. */
function resolveRefs(value: unknown, refs: ReadonlyMap<string, string>, where: string): unknown {
  if (typeof value === "string" && value.startsWith("@")) {
    const id = refs.get(value.slice(1));
    if (id === undefined)
      throw new CliError(`${where} names ${value}, which no create in this changeset has as its ref.`, EXIT.validation);
    return id;
  }
  if (Array.isArray(value)) return value.map((entry) => resolveRefs(entry, refs, where));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, resolveRefs(entry, refs, where)]));
  return value;
}

/** The tool that builds a planned write. */
type Tool = "save" | "session" | "recurrence";

/** One record's intents after folding: what its tool is asked to do for it. */
interface Planned {
  intents: number[];
  op: "create" | "update" | "observe";
  tool: Tool;
  /** The save kind, `commitment_rule`, or for an observe what it records (sleep, place, session, energy). */
  kind: string;
  /** For `save`: its entity type. */
  def?: EntityTypeDef;
  id: string | undefined;
  fields: Fields;
  /** What an observe changes from, where the record is not one `stored` finds. */
  before?: Fields;
  basis?: Intent["basis"];
  evidence?: string;
  question?: string;
  /** Its `completedAt` is the clock's, not the agent's: left out of the preview hash. */
  clockedAt?: boolean;
}

/** A logged night's own window: when it began and ended, actual over planned. */
function nightWindow(night: Fields): { sleepAt?: string; wakeAt?: string } {
  const sleepAt = night.actualStartAt ?? night.plannedStartAt;
  const wakeAt = night.actualWakeAt ?? night.plannedWakeAt;
  return {
    ...(typeof sleepAt === "string" ? { sleepAt } : {}),
    ...(typeof wakeAt === "string" ? { wakeAt } : {})
  };
}

/**
 * The logged night a reported sleep is about: the one whose window, widened by a few hours, overlaps the report the
 * most. A night already there is corrected in place rather than logged twice.
 */
function matchNight(nights: readonly Fields[], fields: Fields): Fields | undefined {
  const given = [fields.sleepAt, fields.wakeAt].flatMap((value) =>
    typeof value === "string" && Number.isFinite(Date.parse(value)) ? [Date.parse(value)] : []
  );
  if (given.length === 0) return undefined;
  const [start, end] = [Math.min(...given), Math.max(...given)];
  let best: { night: Fields; overlap: number } | undefined;
  for (const night of nights) {
    if (night.status === "cancelled") continue;
    const window = nightWindow(night);
    const from = window.sleepAt === undefined ? undefined : Date.parse(window.sleepAt);
    if (from === undefined || !Number.isFinite(from)) continue;
    const to = window.wakeAt === undefined ? from : Date.parse(window.wakeAt);
    const overlap = Math.min(end, to + NIGHT_SLACK_MS) - Math.max(start, from - NIGHT_SLACK_MS);
    if (overlap >= 0 && (!best || overlap > best.overlap)) best = { night, overlap };
  }
  return best?.night;
}

/** What one observe records, as the write its tool makes. */
function planObserve(
  intent: Intent,
  index: number,
  fields: Fields,
  state: PortalState,
  nights: readonly Fields[]
): Omit<Planned, "intents" | "basis" | "evidence" | "question"> {
  const where = `Intent ${index}`;
  const kind = intent.kind as ObserveKind;
  const allowed: readonly string[] | undefined = OBSERVE_FIELDS[kind];
  if (!allowed)
    throw new CliError(
      `${where}: observe records ${Object.keys(OBSERVE_FIELDS).join(", ")}, not "${intent.kind}".`,
      EXIT.validation
    );
  const unknown = Object.keys(fields).filter((field) => !allowed.includes(field));
  if (unknown.length > 0)
    throw new CliError(
      `${where}: observe ${kind} takes ${allowed.join(", ")}, not ${unknown.join(", ")}.`,
      EXIT.validation
    );
  if (intent.at !== undefined && kind !== "session")
    throw new CliError(`${where}: only a complete or an observed session takes "at".`, EXIT.validation);
  if (intent.id !== undefined && kind !== "sleep")
    throw new CliError(`${where}: observe ${kind} names no id.`, EXIT.validation);
  switch (kind) {
    case "sleep": {
      if (intent.id === undefined && fields.sleepAt === undefined && fields.wakeAt === undefined)
        throw new CliError(`${where}: observe sleep needs sleepAt, wakeAt, or both.`, EXIT.validation);
      if (fields.remove === true && intent.id === undefined)
        throw new CliError(`${where}: removing a night needs its id.`, EXIT.validation);
      const night =
        intent.id !== undefined
          ? nights.find((entry) => entry.id === intent.id)
          : fields.remove === true
            ? undefined
            : matchNight(nights, fields);
      if (intent.id !== undefined && !night)
        throw new CliError(`${where}: no logged night has the id "${intent.id}".`, EXIT.validation);
      return {
        op: "observe",
        tool: "save",
        kind,
        def: findEntityType("sleep_log_entry")!,
        id: typeof night?.id === "string" ? night.id : undefined,
        fields,
        ...(night ? { before: nightWindow(night) } : {})
      };
    }
    case "place": {
      if (typeof fields.place !== "string" || fields.place.trim() === "")
        throw new CliError(`${where}: observe place needs place, a saved place's id or name.`, EXIT.validation);
      // Resolved when it is built, against the plan as the intents before it leave it, so a place created by ref
      // resolves and one not saved refuses this intent alone.
      return {
        op: "observe",
        tool: "save",
        kind,
        def: findEntityType("current_availability")!,
        id: undefined,
        fields: { place: fields.place },
        before: { currentSituation: { locationId: state.currentSituation.locationId ?? null } }
      };
    }
    case "energy":
      if (fields.energy === undefined)
        throw new CliError(`${where}: observe energy needs energy (low, medium or high).`, EXIT.validation);
      return {
        op: "observe",
        tool: "save",
        kind,
        def: findEntityType("current_availability")!,
        id: undefined,
        fields: { currentEnergy: fields.energy },
        before: { currentEnergy: state.currentEnergy }
      };
    case "session": {
      const endedAt = intent.at ?? fields.endedAt;
      const { endedAt: _given, ...rest } = fields;
      return {
        op: "observe",
        tool: "session",
        kind,
        id: undefined,
        fields: { ...rest, ...(endedAt !== undefined ? { endedAt } : {}) }
      };
    }
  }
}

/** A write to the preferences row (settings, where he is), whose version a sleep log or a session moves. */
function onPreferencesRow(entry: Planned): boolean {
  return entry.def?.canonical === "current_availability" || entry.def?.singletonKey === "settings";
}

/**
 * Turns the intents into one write per record: refs become ids, a complete becomes the kind's done status (and
 * `completedAt` where the kind keeps one), an observe becomes the write that records it, and intents on the same
 * record fold into the first, later fields winning, so a create and an update of its ref are one create.
 */
function plan(intents: Intent[], key: string, now: Date, state: PortalState, nights: readonly Fields[]): Planned[] {
  const refs = new Map<string, string>();
  intents.forEach((intent, index) => {
    if (intent.ref === undefined) return;
    if (intent.op !== "create") throw new CliError(`Intent ${index}: only a create takes a ref.`, EXIT.validation);
    if (refs.has(intent.ref))
      throw new CliError(`Intent ${index}: the ref "${intent.ref}" is used twice.`, EXIT.validation);
    refs.set(intent.ref, deriveCommandId(key, `ref:${intent.ref}`));
  });
  const planned: Planned[] = [];
  intents.forEach((intent, index) => {
    const where = `Intent ${index}`;
    const fields = resolveRefs(intent.fields ?? {}, refs, `${where}'s fields`) as Fields;
    let id = intent.id === undefined ? undefined : (resolveRefs(intent.id, refs, `${where}'s id`) as string);
    let entry: Omit<Planned, "intents" | "basis" | "evidence" | "question">;
    if (intent.op === "observe")
      entry = planObserve({ ...intent, ...(id ? { id } : {}) }, index, fields, state, nights);
    else if (RULE_KINDS.includes(intent.kind)) {
      if (intent.op === "complete")
        throw new CliError(
          `${where}: a commitment rule is not completed; update it with an endDate, or status "ended".`,
          EXIT.validation
        );
      if (intent.at !== undefined) throw new CliError(`${where}: only a complete takes "at".`, EXIT.validation);
      if (intent.op === "create") {
        if (id !== undefined)
          throw new CliError(`${where}: a create names no id; give it a ref instead.`, EXIT.validation);
        id = intent.ref ? refs.get(intent.ref)! : deriveCommandId(key, `create:${index}`);
      } else {
        if (id === undefined)
          throw new CliError(`${where}: update needs the id (or @ref) of the rule.`, EXIT.validation);
        const ruleId = id;
        const known =
          state.commitmentRecurrenceRules.some((rule) => rule.id === ruleId) ||
          planned.some((other) => other.kind === "commitment_rule" && other.id === ruleId);
        if (!known) throw new CliError(`${where}: no commitment rule has the id "${id}".`, EXIT.validation);
      }
      entry = { op: intent.op, tool: "recurrence", kind: "commitment_rule", id, fields };
    } else {
      const def = findEntityType(intent.kind);
      if (!def) throw new CliError(`${where}: unknown kind "${intent.kind}".`, EXIT.validation);
      if (def.route === "comparison")
        throw new CliError(
          `${where}: a comparison answers one group on its own route, so it is not part of a changeset. Send it with rhen_save (entityType comparison, fields groupId and rankedIds).`,
          EXIT.validation
        );
      if (intent.op === "create") {
        if (id !== undefined)
          throw new CliError(`${where}: a create names no id; give it a ref instead.`, EXIT.validation);
        // Every create of a listed kind gets its id here, so a preview and its apply name the same record and the
        // duplicate check can find it.
        if (def.arrayKey) id = intent.ref ? refs.get(intent.ref)! : deriveCommandId(key, `create:${index}`);
      } else if (id === undefined && def.arrayKey)
        throw new CliError(`${where}: ${intent.op} needs the id (or @ref) of the record.`, EXIT.validation);
      let clockedAt = false;
      if (intent.op === "complete") {
        fields.status = "done";
        if (
          SAVE_ENTITY_KINDS.includes(def.canonical as SaveEntityKind) &&
          entityFieldNames(def.canonical as SaveEntityKind).includes("completedAt")
        )
          fields.completedAt = intent.at ?? now.toISOString();
        // A completion time taken from the clock differs between a preview and its apply; the hash leaves it out.
        if (intent.at === undefined) clockedAt = true;
      } else if (intent.at !== undefined) throw new CliError(`${where}: only a complete takes "at".`, EXIT.validation);
      if (def.route === "action") withDerivedRecurrenceIds(fields, stored(state, def, id), key, index);
      entry = {
        op: intent.op === "create" ? "create" : "update",
        tool: "save",
        kind: def.canonical,
        def,
        id,
        fields,
        ...(clockedAt ? { clockedAt } : {})
      };
    }
    // Writes to one record fold into one: by id, or by kind for a record there is one of (settings, where he is;
    // a place and an energy are one write to where he is). A day plan is one per day, so its date is part of it.
    const single = entry.def?.singletonKey !== undefined || entry.def?.canonical === "current_availability";
    const sameRecord = (other: Planned) =>
      other.tool === entry.tool &&
      (single
        ? other.def?.canonical === entry.def?.canonical &&
          (entry.def?.canonical !== "daily_plan" || other.fields.localDate === entry.fields.localDate)
        : entry.tool === "session" || (entry.id !== undefined && other.kind === entry.kind && other.id === entry.id));
    const same = planned.find(sameRecord);
    if (same) {
      same.intents.push(index);
      // Nested fields merge as one save's would, so a second intent's other field in the same object keeps the first's.
      same.fields = mergeAssignments(same.fields, entry.fields) as Fields;
      if (entry.before) same.before = { ...same.before, ...entry.before };
      if (entry.clockedAt) same.clockedAt = true;
      if (intent.question) same.question = same.question ? `${same.question} ${intent.question}` : intent.question;
      return;
    }
    planned.push({
      intents: [index],
      ...entry,
      ...(intent.basis ? { basis: intent.basis } : {}),
      ...(intent.evidence ? { evidence: intent.evidence } : {}),
      ...(intent.question ? { question: intent.question } : {})
    });
  });
  const settingsRow = planned.filter(onPreferencesRow);
  if (settingsRow.length > 1)
    throw new CliError(
      "Settings and where he is (place, energy, current availability) are one stored record: send the settings change in its own changeset.",
      EXIT.validation
    );
  // A sleep log moves the preferences row's version, which a later write to that row would then miss, so a sleep log
  // before it moves to just after it. Sessions go last. Nothing else moves: a place an arrival names by ref is created
  // before it.
  const prefs = planned.findIndex(onPreferencesRow);
  let ordered = planned;
  if (prefs >= 0) {
    const before = planned.slice(0, prefs);
    const sleep = before.filter((entry) => entry.def?.canonical === "sleep_log_entry");
    ordered = [
      ...before.filter((entry) => !sleep.includes(entry)),
      planned[prefs]!,
      ...sleep,
      ...planned.slice(prefs + 1)
    ];
  }
  return [
    ...ordered.filter((entry) => entry.tool !== "session"),
    ...ordered.filter((entry) => entry.tool === "session")
  ];
}

/**
 * Gives a recurring or cadence action's new recurrence, and each new window, an id derived from the changeset, so
 * `save` does not make up a fresh one each time it is built and a preview and its apply send the same thing. An id
 * already given, or the stored recurrence's own, is kept.
 */
function withDerivedRecurrenceIds(fields: Fields, existing: Fields | undefined, key: string, index: number): void {
  const recurrence = fields.recurrence;
  if (recurrence === null || typeof recurrence !== "object" || Array.isArray(recurrence)) return;
  const given = recurrence as Fields;
  const storedRecurrence = existing?.recurrence as Fields | null | undefined;
  if (typeof given.id !== "string" && typeof storedRecurrence?.id !== "string")
    given.id = deriveCommandId(key, `recurrence:${index}`);
  if (Array.isArray(given.windows))
    given.windows = given.windows.map((window: unknown, position: number) =>
      window !== null &&
      typeof window === "object" &&
      !Array.isArray(window) &&
      typeof (window as Fields).id !== "string"
        ? { ...(window as Fields), id: deriveCommandId(key, `recurrence:${index}:window:${position}`) }
        : window
    );
}

/** A client that answers `getState` from one read, so building twenty saves reads the plan once. */
function readOnce(client: PortalClient, state: PortalState): PortalClient {
  return new Proxy(client, {
    get: (target, property, receiver) =>
      property === "getState" ? () => Promise.resolve(state) : Reflect.get(target, property, receiver)
  });
}

/** The record a save updates, as the state holds it. */
function stored(state: PortalState, def: EntityTypeDef, id: string | undefined): Fields | undefined {
  if (def.singletonKey === "settings") return state.settings as unknown as Fields;
  if (!def.arrayKey || id === undefined) return undefined;
  const items = state[def.arrayKey];
  return Array.isArray(items) ? (items as unknown as Fields[]).find((item) => item.id === id) : undefined;
}

/** Where each route's command carries its record. */
const WRAPPERS = ["entity", "action", "project", "rule"];

/** The entity a built command carries, whichever route it goes to. */
function entityOf(payload: Fields): Fields {
  const entity = WRAPPERS.map((key) => payload[key]).find((value) => value !== undefined);
  return entity !== null && typeof entity === "object" ? (entity as Fields) : {};
}

/**
 * Fields a create carries that the agent did not give: a default filled them in. Shown as assumed so an invented
 * number is seen before it lands. (One place, so the contracts helper that names defaulted fields can replace it.)
 */
export function assumedFields(given: Fields, built: Fields): Fields {
  // `assumedFields` is the list of these, not a value a default filled in.
  return Object.fromEntries(
    Object.entries(built).filter(([field]) => field !== "id" && field !== "assumedFields" && !(field in given))
  );
}

/** Two stored values are the same: equal, or two spellings of one instant. */
function same(a: unknown, b: unknown): boolean {
  if (JSON.stringify(a ?? null) === JSON.stringify(b ?? null)) return true;
  if (typeof a !== "string" || typeof b !== "string" || !a.includes("T") || !b.includes("T")) return false;
  const [left, right] = [Date.parse(a), Date.parse(b)];
  return Number.isFinite(left) && left === right;
}

/** What an update changes: each field the command sends that differs from the stored record. */
function differences(before: Fields, after: Fields): Record<string, { before: unknown; after: unknown }> {
  const changes: Record<string, { before: unknown; after: unknown }> = {};
  for (const [field, value] of Object.entries(after)) {
    if (field === "id" || field === "version") continue;
    if (!same(before[field], value)) changes[field] = { before: before[field] ?? null, after: value };
  }
  return changes;
}

/** How the answer names what an entry writes. */
function kindLabel(entry: Planned): string {
  if (entry.op === "observe") return entry.kind;
  if (entry.tool === "recurrence") return "commitment rule";
  return humanLabel(entry.def!.canonical);
}

/** What the answer shows an entry changes: a create's fields and what defaults filled, else the before and after. */
function changeOf(entry: Built, state: PortalState): Fields {
  const { planned, write } = entry;
  if (!write) return {};
  if (planned.tool === "session") {
    const { commandId: _command, expectedVersion: _version, type: _type, ...observed } = write.payload;
    return { observed };
  }
  const sent = entityOf(write.payload);
  if (planned.op === "observe")
    return planned.before ? { changes: differences(planned.before, planned.fields) } : { fields: sent };
  if (planned.op === "create") return { fields: sent, assumed: assumedFields(planned.fields, sent) };
  const before =
    planned.tool === "recurrence"
      ? (state.commitmentRecurrenceRules.find((rule) => rule.id === planned.id) as unknown as Fields | undefined)
      : stored(state, planned.def!, planned.id);
  return {
    changes: before ? differences(planned.def ? normalizeForWrite(planned.def.canonical, before) : before, sent) : sent
  };
}

/**
 * A new commitment rule's likely duplicates: a stored rule with the same title. Rules are not in plan search, so the
 * portal's own check cannot see them.
 */
function ruleDuplicates(state: PortalState, built: Built[]): Map<number, ChangesetDuplicate[]> {
  const found = new Map<number, ChangesetDuplicate[]>();
  for (const entry of built) {
    if (entry.planned.tool !== "recurrence" || entry.planned.op !== "create") continue;
    const title = entry.planned.fields.title;
    if (typeof title !== "string") continue;
    const hits = state.commitmentRecurrenceRules.filter(
      (rule) => rule.title.trim().toLowerCase() === title.trim().toLowerCase()
    );
    if (hits.length)
      found.set(
        entry.planned.intents[0]!,
        hits.map((rule) => ({ kind: "commitment-rule", id: rule.id, title: rule.title, status: rule.status }))
      );
  }
  return found;
}

/** The logged nights a reported sleep may correct: tonight's from state, and the log's last fortnight. */
async function loggedNights(context: CommandContext, state: PortalState, intents: Intent[]): Promise<Fields[]> {
  if (!intents.some((intent) => intent.op === "observe" && intent.kind === "sleep")) return [];
  const nights = new Map<string, Fields>();
  for (const night of state.sleepPlans as unknown as Fields[]) nights.set(String(night.id), night);
  const log = await context.client.get<{ sleepPlans?: unknown }>("/api/sleep-log?days=14");
  if (Array.isArray(log?.sleepPlans))
    for (const night of log.sleepPlans as Fields[]) nights.set(String(night.id), night);
  return [...nights.values()];
}

function waitSeconds(raw: string | undefined): number {
  const seconds = raw === undefined ? DEFAULT_WAIT_SECONDS : Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0)
    throw new CliError("--wait must be a number of seconds, 0 or more.", EXIT.usage);
  return seconds;
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * What Now says once the plan has taken the changeset in: `status --brief`, read again while the plan is still being
 * recalculated, for up to `wait` seconds. A failed read leaves it out; the writes have landed either way.
 */
async function planAfter(context: CommandContext, wait: number): Promise<unknown> {
  const deadline = Date.now() + wait * 1000;
  for (;;) {
    let text = "";
    const sub: CommandContext = {
      ...context,
      mode: "json",
      stdout: (chunk) => void (text += chunk),
      stderr: () => undefined,
      collect: undefined
    };
    let brief: { plan?: unknown };
    try {
      await statusCommand.run(sub, { positionals: [], values: { brief: true } });
      brief = JSON.parse(text) as { plan?: unknown };
    } catch {
      return undefined;
    }
    if (brief.plan !== "pending" || Date.now() >= deadline) return brief;
    await pause(POLL_MS);
  }
}

/** A tool's refusal, with the first schema issue it carries so the agent sees which field. */
function refusal(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const issues = error instanceof CliError && Array.isArray(error.details) ? error.details : [];
  const first = issues[0] as { path?: unknown[]; message?: unknown } | undefined;
  if (!first || typeof first.message !== "string") return error.message;
  const path = Array.isArray(first.path) ? first.path.map(String).join(".") : "";
  return `${error.message} ${path ? `${path}: ` : ""}${first.message}`;
}

interface Built {
  planned: Planned;
  write?: CollectedWrite;
  error?: string;
}

/**
 * The plan as it will stand once a built write lands: its record added to (or merged into) its list, so a later
 * intent's checks, such as a prerequisite on a record an earlier create makes, see it. Versions stay as stored.
 */
function project(state: PortalState, def: EntityTypeDef, write: CollectedWrite): void {
  if (!def.arrayKey) return;
  const entity = entityOf(write.payload);
  if (typeof entity.id !== "string") return;
  const items = state[def.arrayKey] as unknown as Fields[];
  const at = items.findIndex((item) => item.id === entity.id);
  if (at >= 0) items[at] = { ...items[at], ...entity };
  else items.push(entity);
}

/**
 * A place observe with its place resolved to a saved place's id. Naming a place, or an energy, says it now even when
 * it matches what is stored, so it is always written: that is what dates it afresh.
 */
function withPlace(entry: Planned, state: PortalState): Planned {
  if (typeof entry.fields.place !== "string") return entry;
  const { place, ...fields } = entry.fields;
  const location = resolveLocation(state, place);
  return { ...entry, fields: { ...fields, currentSituation: { locationId: String(location.id) } } };
}

/** The tool call that builds a planned write, as an agent would make it by hand. */
function invocation(entry: Planned, commandId: string): { spec: CommandSpec; args: ParsedArgs } {
  switch (entry.tool) {
    case "session": {
      const { outcome, remaining, note, endedAt } = entry.fields;
      const text = (value: unknown) => (typeof value === "number" ? String(value) : value);
      return {
        spec: sessionCommand,
        args: {
          positionals: ["finish"],
          values: {
            "command-id": commandId,
            ...(outcome !== undefined ? { outcome: text(outcome) as string } : {}),
            ...(remaining !== undefined ? { remaining: text(remaining) as string } : {}),
            ...(note !== undefined ? { note: text(note) as string } : {}),
            ...(endedAt !== undefined ? { "ended-at": text(endedAt) as string } : {})
          }
        }
      };
    }
    case "recurrence":
      return {
        spec: recurrenceCommand,
        args: {
          positionals: ["set"],
          values: {
            "command-id": commandId,
            id: entry.id!,
            set: Object.entries(entry.fields).map(([field, value]) => `${field}=${JSON.stringify(value)}`),
            // Rewriting a series' future occurrences is what the agent asked for, and the preview shows it.
            yes: true
          }
        }
      };
    case "save":
      return {
        spec: saveCommand,
        args: {
          positionals: [entry.def!.canonical],
          values: {
            fields: JSON.stringify(entry.fields),
            "command-id": commandId,
            ...(entry.id !== undefined ? { id: entry.id } : {}),
            ...(entry.op === "create" && entry.id !== undefined ? { create: true } : {})
          }
        }
      };
  }
}

/** Runs each planned record's tool with its write collected, never sent. */
async function build(context: CommandContext, state: PortalState, planned: Planned[], key: string): Promise<Built[]> {
  const built: Built[] = [];
  const projected = structuredClone(state);
  const client = readOnce(context.client, projected);
  for (const entry of planned) {
    const writes: CollectedWrite[] = [];
    const sub: CommandContext = {
      ...context,
      client,
      journal: undefined,
      stdout: () => undefined,
      stderr: () => undefined,
      collect: (write) => void writes.push(write)
    };
    const commandId = deriveCommandId(key, `intent:${entry.intents[0]}`);
    let ready = entry;
    try {
      ready = withPlace(entry, projected);
      const { spec, args } = invocation(ready, commandId);
      await spec.run(sub, args);
      if (writes.length !== 1) throw new CliError(`it built ${writes.length} writes, not one`, EXIT.unavailable);
    } catch (error) {
      built.push({ planned: entry, error: refusal(error) });
      continue;
    }
    // Outside the try, so an intent is pushed once: built, or refused, never both.
    built.push({ planned: ready, write: writes[0]! });
    if (entry.def) project(projected, entry.def, writes[0]!);
  }
  return built;
}

/**
 * A hash of what would be sent, without the per-run command ids or a completion time read from the clock: the same
 * plan against the same records hashes the same.
 */
function hashOf(items: ChangesetItem[], clocked: ReadonlySet<number>): string {
  const strip = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(strip)
      : value !== null && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .filter(([field]) => field !== "commandId")
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([field, entry]) => [field, strip(entry)])
          )
        : value;
  return createHash("sha256")
    .update(
      JSON.stringify(
        items.map((item) => {
          if (!clocked.has(item.intent)) return strip({ path: item.path, payload: item.payload });
          const payload = Object.fromEntries(
            Object.entries(item.payload).map(([key, value]) => {
              if (!WRAPPERS.includes(key) || value === null || typeof value !== "object") return [key, value];
              const { completedAt: _clock, ...entity } = value as Fields;
              return [key, entity];
            })
          );
          return strip({ path: item.path, payload });
        })
      )
    )
    .digest("hex")
    .slice(0, 16);
}

/**
 * A hash of what the agent submitted (its intents, keys sorted), not of the commands built from them: those are
 * rebuilt against the plan on a retry and differ, the intents do not. The portal keeps it on the receipt, so the
 * same command id with other intents is refused while an honest retry replays.
 */
function inputHashOf(intents: readonly Intent[]): string {
  const sorted = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(sorted)
      : value !== null && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([field, entry]) => [field, sorted(entry)])
          )
        : value;
  return createHash("sha256")
    .update(JSON.stringify(sorted(intents)))
    .digest("hex");
}

/** The undo list's line for a changeset: what its first writes do, and how many more. */
function changesetLabel(built: Built[]): string {
  const summaries = built.flatMap((entry) => (entry.write ? [entry.write.summary] : []));
  const more = summaries.length > 3 ? `; and ${summaries.length - 3} more` : "";
  return `changeset: ${summaries.slice(0, 3).join("; ")}${more}`;
}

/** True when the undo journal already holds this changeset (a retried apply answers with the same one). */
function journaled(context: CommandContext, changesetId: string): boolean {
  return (context.journal?.read() ?? []).some(
    (entry) => (entry.undo.payload as { target?: unknown } | undefined)?.target === changesetId
  );
}

/** What an apply under this command id already kept, journaled if it was not; undefined when none landed. */
async function replay(context: CommandContext, key: string, label: string): Promise<ChangesetResult | undefined> {
  const payload = { commandId: key, mode: "apply" as const, replay: true, items: [] };
  let response: { result: ChangesetResult };
  try {
    response = await sendCommand<{ result: ChangesetResult }>(context.client, "/api/commands/changeset", payload, key);
  } catch (error) {
    if (error instanceof CliError && error.exitCode === EXIT.notFound) return undefined;
    throw error;
  }
  if (response.result.ok && !journaled(context, key))
    recordServerChecked(context, response, { path: "/api/commands/changeset", sent: payload, summary: label });
  return response.result;
}

export const changesetCommand: CommandSpec = {
  name: "changeset",
  summary: "Preview, then apply, one message's facts as one write",
  description:
    "One message's facts as one list of intents, not a save per fact. Each intent is " +
    "{op, kind, ...}: create (fields; a ref to point at it later), update (id, changed fields) or complete (id; " +
    "optional at) on any save kind, or commitment_rule (recurrence set's fields: title, timezone, startDate, repeat, " +
    "localStartTime, localEndTime, ...); observe records what happened: sleep (sleepAt and/or wakeAt; corrects the " +
    "night they overlap or logs one), place (fields.place, a saved place's id or name), session (finishes the running " +
    "one: outcome, remaining, note; at is when it ended) or energy. @<ref> in a later id or field is that create's " +
    "record; intents on one record fold into one write. Each may carry basis, evidence and question (your doubt). " +
    "preview (default) runs every write against the real plan and keeps nothing: per intent, applies, filed for the " +
    "person (and what instead), conflict or refused, with the change, assumed fields, likely duplicates and undoable; " +
    "checkWithOwner says when to ask first. apply keeps all or none; undo reverses its undoable writes as one. Apply with the " +
    "preview's command-id and expect. An apply answers with now (status --brief, waiting up to --wait seconds).",
  positionals: [
    { name: "mode", required: false, description: "preview (the default) or apply", enum: ["preview", "apply"] }
  ],
  options: {
    changes: {
      type: "string",
      placeholder: "json",
      mcp: { type: "array", items: "object" },
      description: "The intents, as a list of {op, kind, ref?, id?, fields?, at?, basis?, evidence?, question?}"
    },
    wait: {
      type: "string",
      placeholder: "seconds",
      description: `apply: seconds to wait for the plan to take the changes in (default ${DEFAULT_WAIT_SECONDS})`
    },
    expect: {
      type: "string",
      placeholder: "hash",
      description: "The previewHash a preview printed: apply refuses if what it would send has changed since"
    }
  },
  mutates: true,
  // An apply with no --command-id mints its own key, so a retried call would apply the set again.
  idempotent: false,
  examples: [
    'changeset preview --changes \'[{"op":"complete","kind":"action","id":"action-bill","at":"2026-10-26"},{"op":"create","kind":"action","ref":"mum","fields":{"title":"Call mum","projectId":"project-family"}}]\'',
    'changeset preview --changes \'[{"op":"observe","kind":"sleep","fields":{"sleepAt":"2026-10-27T23:40:00<offset>","wakeAt":"2026-10-28T07:30:00<offset>"}},{"op":"observe","kind":"place","fields":{"place":"Home"}}]\'',
    "changeset apply --changes '[...]' --command-id <id the preview printed> --expect <previewHash>"
  ],
  async run(context, args) {
    const modeArg = args.positionals[0] ?? "preview";
    if (modeArg !== "preview" && modeArg !== "apply")
      throw new CliError(`Unknown mode "${modeArg}". Use preview or apply.`, EXIT.usage);
    const mode: "preview" | "apply" = modeArg;
    const intents = parseIntents(stringOption(args.values, "changes"));
    const wait = waitSeconds(stringOption(args.values, "wait"));
    // The invocation's key (`--command-id`, else a fresh one) is the changeset's own id; refs and commands derive from it.
    const key = stampCommandId(context, args, { commandId: "" }).key!;
    const state = await context.client.getState();
    const planned = plan(intents, key, context.now(), state, await loggedNights(context, state, intents));
    const built = await build(context, state, planned, key);

    const items: ChangesetItem[] = [];
    for (const entry of built) {
      if (!entry.write) continue;
      const path = entry.write.path as ChangesetRoute;
      if (!(CHANGESET_ROUTES as readonly string[]).includes(path)) {
        entry.error = `a changeset cannot carry a write to ${path}`;
        delete entry.write;
        continue;
      }
      const searchKind = SEARCH_KIND[entry.planned.kind];
      items.push({
        intent: entry.planned.intents[0]!,
        path,
        payload: entry.write.payload,
        ...(entry.planned.op === "create" && entry.planned.id !== undefined && searchKind
          ? { creates: { kind: searchKind, id: entry.planned.id } }
          : {}),
        ...(entry.planned.basis ? { basis: entry.planned.basis } : {}),
        ...(entry.planned.evidence ? { evidence: entry.planned.evidence } : {}),
        ...(entry.planned.question ? { question: entry.planned.question } : {})
      });
    }
    const previewHash = hashOf(
      items,
      new Set(built.flatMap((entry) => (entry.planned.clockedAt ? [entry.planned.intents[0]!] : [])))
    );
    const refused = built.filter((entry) => entry.error !== undefined);
    const expect = stringOption(args.values, "expect");

    let result: ChangesetResult | undefined;
    let response: unknown;
    // An apply that landed but whose answer was lost, sent again: rebuilt against the plan it changed, its commands
    // now differ from the preview, so before refusing, ask whether this command id already applied.
    if (mode === "apply" && (refused.length > 0 || (expect !== undefined && expect !== previewHash))) {
      const replayed = await replay(context, key, changesetLabel(built));
      if (replayed) {
        context.stdout(
          toJson(
            {
              mode,
              ok: replayed.ok,
              ...(replayed.changesetId ? { changesetId: replayed.changesetId } : {}),
              replayed: true,
              intents: replayed.items
            },
            true
          )
        );
        if (!replayed.ok) context.setExitCode(EXIT.conflict);
        return;
      }
    }
    if (mode === "apply" && refused.length > 0)
      throw new CliError(
        `Nothing was applied: ${refused.map((entry) => `intent ${entry.planned.intents.join("+")}: ${entry.error}`).join("; ")}.`,
        EXIT.validation
      );
    if (mode === "apply" && expect !== undefined && expect !== previewHash)
      throw new CliError(
        `Nothing was applied: the writes these changes build now (hash ${previewHash.slice(0, 12)}) are not the writes the preview showed ` +
          `(you sent expect ${expect.slice(0, 12)}). The hash covers every intent's route, fields, ids and refs and the record versions ` +
          "read from the plan, so it differs when any intent or field is not identical to the one previewed, or when a record the " +
          "changes name was changed (by anyone, or by the planner) after the preview. Preview again with the changes you mean " +
          "to apply, check the new checkWithOwner reasons, then apply with the new preview's previewHash and command-id.",
        EXIT.conflict,
        undefined,
        { nextCall: { tool: "rhen_changeset", arguments: { mode: "preview", changes: "<the same changes>" } } }
      );
    if (items.length > 0) {
      const payload = { commandId: key, mode, inputHash: inputHashOf(intents), items };
      response = await sendCommand<{ result: ChangesetResult }>(
        context.client,
        "/api/commands/changeset",
        payload,
        key
      );
      result = (response as { result: ChangesetResult }).result;
      if (mode === "apply" && result.ok && !journaled(context, key))
        recordServerChecked(context, response, {
          path: "/api/commands/changeset",
          sent: payload,
          summary: changesetLabel(built)
        });
    }

    const outcomes = new Map<number, ChangesetItemResult>((result?.items ?? []).map((item) => [item.intent, item]));
    const duplicateRules = ruleDuplicates(state, built);
    const report = built.map((entry) => {
      const first = entry.planned.intents[0]!;
      const outcome = outcomes.get(first);
      const duplicates = [...(outcome?.likelyDuplicates ?? []), ...(duplicateRules.get(first) ?? [])];
      return {
        intents: entry.planned.intents,
        op: entry.planned.op,
        kind: kindLabel(entry.planned),
        ...(entry.planned.id !== undefined ? { id: entry.planned.id } : {}),
        ...(entry.write ? { summary: entry.write.summary } : {}),
        outcome: entry.error !== undefined ? "invalid" : (outcome?.outcome ?? "invalid"),
        ...(entry.error !== undefined ? { message: entry.error } : {}),
        ...(outcome?.message ? { message: outcome.message } : {}),
        ...(outcome?.reason ? { filedBecause: outcome.reason } : {}),
        ...(outcome?.instead ? { instead: outcome.instead } : {}),
        ...(outcome?.proposalId ? { proposalId: outcome.proposalId } : {}),
        ...changeOf(entry, state),
        ...(duplicates.length ? { likelyDuplicates: duplicates } : {}),
        ...(outcome?.undoable !== undefined ? { undoable: outcome.undoable } : {}),
        ...(entry.planned.question ? { question: entry.planned.question } : {})
      };
    });

    const why = report.flatMap((entry) => {
      const name = `intent ${entry.intents.join("+")}`;
      const reasons: string[] = [];
      if (entry.question) reasons.push(`${name} has a question: ${entry.question}`);
      if ("likelyDuplicates" in entry) reasons.push(`${name} may duplicate an existing record`);
      if (entry.outcome === "conflict") reasons.push(`${name}'s record changed since it was read`);
      if (entry.outcome === "invalid") reasons.push(`${name} was refused`);
      if (entry.outcome === "proposal") reasons.push(`${name} goes to the person as a proposal`);
      return reasons;
    });
    const ok = refused.length === 0 && (result?.ok ?? items.length === 0);
    const answer = {
      mode,
      ok,
      ...(result?.changesetId ? { changesetId: result.changesetId } : {}),
      intents: report,
      checkWithOwner: { needed: why.length > 0, why },
      ...(mode === "preview" ? { previewHash, apply: { "command-id": key, expect: previewHash } } : {}),
      ...(mode === "apply" && ok && items.length > 0 ? { now: await planAfter(context, wait) } : {})
    };
    context.stdout(toJson(answer, true));
    if (!ok) context.setExitCode(mode === "apply" ? EXIT.conflict : EXIT.ok);
  }
};
