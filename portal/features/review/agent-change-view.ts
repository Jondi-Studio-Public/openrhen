import { dateTimeFormat, displayLocale } from "@/shared/locale";
import { formatZonedDateTime } from "@/shared/date-format";

/**
 * How one agent write reads in Plan > Review > Agent changes (agent trust review, lane D item 3): the
 * words for its fields, values, basis and plan effect. Pure, so the panel and its tests share them.
 */

/** A journaled agent write as `GET /api/agent-changes` returns it. */
export interface AgentChange {
  agent: string;
  id: string;
  at: string;
  label: string;
  status: "applied" | "undone" | "superseded";
  /** The ledger write behind the row (`writes.id`); null on an old entry that kept no images. */
  writeId?: string | null;
  target?: { stateKey: string; id?: string };
}

/** One field of one record, as the write left it. `afterKnown` is false when only the old value was kept. */
export interface AgentChangeField {
  field: string;
  before: unknown;
  after: unknown;
  afterKnown: boolean;
}

export interface AgentChangeRow {
  entityType: string;
  entityId: string | null;
  title: string | null;
  operation: string;
  fields: AgentChangeField[];
  basis: string | null;
  statedEvidence: string | null;
}

export interface AgentChangePlanEffect {
  available: boolean;
  /** Why no effect is shown: the plan has not recalculated since the write yet, the run before it was pruned, or neither is known. */
  reason?: "pending" | "pruned" | "unknown" | null;
  dayKey: string | null;
  moved: { title: string; fromStartsAt: string; toStartsAt: string; deltaMinutes: number }[];
  added: { title: string; startsAt: string }[];
  dropped: { title: string; startsAt: string }[];
  sleepShiftMinutes: number;
}

/** `GET /api/agent-changes/[writeId]`: what one agent write did, record by record, and what it did to the plan. */
export interface AgentChangeDetail {
  writeId: string;
  actor: string | null;
  commandType: string;
  at: string;
  state: "applied" | "undone" | null;
  rows: AgentChangeRow[];
  plan: AgentChangePlanEffect;
}

/**
 * The ledger write a row can be explained from: its own `writeId`, or, on an entry written before the
 * list carried one, the command id a server-checked entry targets. Null means no detail was kept.
 */
export function detailIdFor(change: AgentChange): string | null {
  if (change.writeId !== undefined) return change.writeId;
  return change.target?.stateKey === "revert" && change.target.id ? change.target.id : null;
}

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/** A stored word such as `fixed_commitment` or `in_person`, as it appears in labels and enum values. */
const SNAKE_WORD = /\b[a-z]+(?:_[a-z]+)+\b/g;

/** Stored words people say differently; any other `snake_word` just loses its underscores. */
const VALUE_WORDS: Record<string, string> = {
  fixed_commitment: "commitment",
  in_person: "in person",
  one_off: "one-off",
  capture_review: "Inbox decision",
  routine_step: "routine step",
  sleep_plan: "sleep plan",
  sleep_log_entry: "sleep log",
  daily_plan: "day plan",
  check_in: "check-in"
};

const wordFor = (word: string) => VALUE_WORDS[word] ?? word.replace(/_/g, " ");

/** What one record is, as a singular noun: the ledger's entity type or, for an image-only row, its table. */
const NOUNS: Record<string, string> = {
  fixed_commitment: "commitment",
  commitments: "commitment",
  commitment: "commitment",
  actions: "action",
  projects: "project",
  outcomes: "outcome",
  deliverables: "deliverable",
  areas: "area",
  sessions: "session",
  check_in: "check-in",
  check_ins: "check-in",
  capture: "capture",
  captures: "capture",
  capture_review: "Inbox decision",
  sleep_plans: "sleep plan",
  sleep_log_entries: "sleep log",
  routine_steps: "routine step",
  spans: "span",
  daily_plans: "day plan",
  daily_plan: "day plan",
  user_preferences: "settings",
  settings: "settings"
};

/** "commitment", "action", "Inbox decision": the record kind in words, singular. */
export function nounFor(entityType: string): string {
  const known = NOUNS[entityType];
  if (known) return known;
  const words = wordFor(entityType.toLowerCase());
  return words.endsWith("s") && !words.endsWith("ss") ? words.slice(0, -1) : words;
}

/**
 * The list label without record ids: `update commitment "Spin class" (a6c7…)` reads as
 * `update commitment "Spin class"`, and a label that is only an id ("start a session on 52c7…") keeps
 * its words and says "a record" where the id was. The sheet names the record.
 */
export function readableLabel(label: string): string {
  const cleaned = label
    .replace(/\s*\(\s*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\s*\)/gi, "")
    .replace(UUID, "a record")
    .replace(SNAKE_WORD, wordFor)
    .trim();
  return cleaned ? cleaned.charAt(0).toUpperCase() + cleaned.slice(1) : label;
}

const FIELD_WORDS: Record<string, string> = {
  starts_at: "Starts",
  ends_at: "Ends",
  start_at: "Starts",
  end_at: "Ends",
  due_at: "Due",
  due_date: "Due",
  remaining_minutes: "Minutes left",
  planned_minutes: "Planned minutes",
  sleep_at: "Asleep",
  wake_at: "Awake",
  location_id: "Place",
  home_location_id: "Home place",
  preferred_location_id: "Preferred place",
  contact_id: "Contact",
  project_id: "Project",
  outcome_id: "Outcome",
  action_id: "Action",
  area_id: "Area",
  deliverable_id: "Deliverable",
  prep_for_commitment_id: "Getting ready for",
  proposed_fields: "Proposed"
};

/** A stored column as a person reads it: `remaining_minutes` → "Minutes left", `importance` → "Importance". */
export function fieldLabel(field: string): string {
  const known = FIELD_WORDS[field.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase()];
  if (known) return known;
  const words = field
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .trim()
    .toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : field;
}

/** Columns that read best first, in this order; the rest keep the order the server gave. */
const FIELD_ORDER = ["title", "name", "status", "starts_at", "start_at", "ends_at", "end_at", "due_at", "due_date"];

/** A record's fields with the ones a person looks for first (title, status, start, end) at the top. */
export function orderedFields<F extends { field: string }>(fields: readonly F[]): F[] {
  const rank = (field: string) => {
    const index = FIELD_ORDER.indexOf(field);
    return index === -1 ? FIELD_ORDER.length : index;
  };
  return fields
    .map((field, index) => ({ field, index }))
    .sort((a, b) => rank(a.field.field) - rank(b.field.field) || a.index - b.index)
    .map(({ field }) => field);
}

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/** A stored value in words: times in the person's zone, empty as "none", lists and objects briefly. */
export function valueText(value: unknown, timezone: string): string {
  if (value === null || value === undefined || value === "") return "none";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") {
    if (ISO_TIME.test(value) && !Number.isNaN(Date.parse(value))) return formatZonedDateTime(value, timezone);
    if (/^[a-z]+(?:_[a-z]+)+$/.test(value)) return wordFor(value);
    const text = value.replace(UUID, "a record");
    return text.length > 120 ? `${text.slice(0, 117)}…` : text;
  }
  if (Array.isArray(value))
    return value.length === 0 ? "none" : value.map((item) => valueText(item, timezone)).join(", ");
  // A JSON column (a capture's proposed fields, say) reads as its filled fields and their plain values, never as
  // raw JSON: a record id or a nested object shows only its field's name.
  const parts = Object.entries(value as object)
    .filter(([, item]) => !isEmpty(item))
    .map(([key, item]) => {
      const label = fieldLabel(key);
      if (typeof item === "object" || (typeof item === "string" && UUID_ONLY.test(item))) return label;
      return `${label} ${valueText(item, timezone)}`;
    });
  if (parts.length === 0) return "none";
  const shown = parts.slice(0, OBJECT_PARTS);
  const more = parts.length - shown.length;
  return `${shown.join("; ")}${more > 0 ? `; and ${more} more` : ""}`;
}

const UUID_ONLY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** How many of a JSON value's fields are written out before the rest are counted. */
const OBJECT_PARTS = 4;

const isEmpty = (value: unknown) =>
  value === null ||
  value === undefined ||
  value === "" ||
  (Array.isArray(value) && value.length === 0) ||
  (typeof value === "object" && !Array.isArray(value) && Object.keys(value as object).length === 0);

const OPERATION_WORDS: Record<string, string> = {
  create: "Added",
  insert: "Added",
  update: "Changed",
  delete: "Removed",
  remove: "Removed"
};

/**
 * "Changed the commitment", "Added the action": what happened to the record, before its name. A `save` is either,
 * so it reads as added when no field had a value before. An undone write says so: "Added, then undone: the action".
 */
export function rowHeading(
  row: Pick<AgentChangeRow, "operation" | "entityType"> & { fields?: AgentChangeField[] },
  { undone = false }: { undone?: boolean } = {}
): string {
  const created =
    row.operation === "save" && (row.fields?.length ?? 0) > 0 && row.fields!.every((field) => field.before == null);
  const verb = created
    ? "Added"
    : row.operation === "save"
      ? "Changed"
      : (OPERATION_WORDS[row.operation] ?? fieldLabel(row.operation));
  const noun = nounFor(row.entityType);
  return `${verb}${undone ? ", then undone:" : ""} ${noun === "settings" ? "" : "the "}${noun}`;
}

/** The agent's claim about where the change came from, in words (the MCP `basis` argument). */
export function basisText(basis: string | null): { text: string; tone: "info" | "neutral" | "warn" } {
  if (basis === "stated") return { text: "You said so", tone: "info" };
  if (basis === "observed") return { text: "Read from a source", tone: "neutral" };
  if (basis === "inferred") return { text: "The agent's guess", tone: "warn" };
  return { text: "No basis given, so a guess", tone: "warn" };
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** What the write did to the plan, in one sentence. */
export function planEffectLine(plan: AgentChangePlanEffect): string {
  if (!plan.available) {
    if (plan.reason === "pending") return "The plan hasn't been recalculated since this change yet.";
    if (plan.reason === "pruned")
      return "The plan from before this change is no longer kept, so its effect can't be shown.";
    return "Its effect on the plan can't be shown.";
  }
  const parts = [
    plan.moved.length ? `moved ${plural(plan.moved.length, "block")}` : null,
    plan.added.length ? `added ${plural(plan.added.length, "block")}` : null,
    plan.dropped.length ? `dropped ${plural(plan.dropped.length, "block")}` : null,
    plan.sleepShiftMinutes
      ? `moved bedtime ${Math.abs(plan.sleepShiftMinutes)} min ${plan.sleepShiftMinutes > 0 ? "later" : "earlier"}`
      : null
  ].filter((part): part is string => part !== null);
  if (parts.length === 0) return "The plan for that day did not change.";
  const sentence = parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
  return `The plan ${sentence} that day.`;
}

/** "Spin class 6:00 pm → 6:30 pm" lines for the moved, added and dropped blocks; at most `limit`. */
export function planEffectItems(plan: AgentChangePlanEffect, timezone: string, limit = 5): string[] {
  if (!plan.available) return [];
  const time = (iso: string) =>
    dateTimeFormat(displayLocale(), { timeZone: timezone, hour: "numeric", minute: "2-digit" })
      .format(new Date(iso))
      .toLowerCase();
  return [
    ...plan.moved.map((block) => `${block.title}: ${time(block.fromStartsAt)} → ${time(block.toStartsAt)}`),
    ...plan.added.map((block) => `${block.title}: added at ${time(block.startsAt)}`),
    ...plan.dropped.map((block) => `${block.title}: dropped from ${time(block.startsAt)}`)
  ].slice(0, limit);
}
