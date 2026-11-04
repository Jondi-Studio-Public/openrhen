import {
  entityCommandBatchPayloadSchema,
  entityCommandPayloadSchema,
  primarySourceLabel,
  settleCatchUpCommandSchema,
  type AgentProposal,
  type EntityCommandPayload
} from "@openrhen/contracts";
import { KEYED_BY_NATURAL_KEY, companionCleared, omittedStoredFields } from "@/shared/record-in-state";
import {
  formatCalendarDay,
  formatInstant,
  formatRange,
  isDateOnly,
  isInstant,
  localiseInstants,
  offsetMinutes,
  type ZoneContext
} from "./proposal-values";

const REMOVABLE: ReadonlySet<string> = new Set(["span", "sleep_log_entry"]);

export type ChangeRow = { field: string; value: string };
/** `caution` is the one-line consequence of a change that moves more than the record it names. */
export type ChangeGroup = { title: string; rows: ChangeRow[]; caution?: string };
/** The plan's zone, which the person's dates are read in; UTC only when none is given. */
export type ChangeOptions = { timezone?: string; now?: Date };

const HIDDEN_KEYS = new Set(["id", "version", "commandId", "remove"]);
const TITLE_KEYS = ["title", "name", "text", "label"] as const;
const TITLE_MAX = 80;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `dueDate` and `due_date` both read "due date". */
const CONTROL_CHARS = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/** Bidi and zero-width controls can make a line read as something it is not; none is ever displayed. */
export const clean = (text: string): string => text.replace(CONTROL_CHARS, "");

/** Fields renamed in storage (migration 0133) that still read as before on screen. */
const LEGACY_LABELS: Record<string, string> = {
  shareToCalendar: "share with family",
  share_to_calendar: "share with family",
  calendarShareEnabled: "share with family enabled",
  calendar_share_enabled: "share with family enabled",
  sharePrimaryEvents: `share ${primarySourceLabel().toLowerCase()} shifts`,
  share_primary_events: `share ${primarySourceLabel().toLowerCase()} shifts`
};

/** `dueDate` and `due_date` both read "due date". */
function words(key: string): string {
  return (
    LEGACY_LABELS[key] ??
    clean(
      key
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replaceAll("_", " ")
        .toLowerCase()
    )
  );
}

const isEmpty = (value: unknown): boolean =>
  value === null ||
  value === undefined ||
  value === "" ||
  (Array.isArray(value) && value.length === 0) ||
  (isRecord(value) && Object.keys(value).length === 0);

/** An id or a list of ids: a string the person cannot read, kept for "Exact request". */
const isIdKey = (key: string): boolean => key === "ids" || /(?:Ids?|_ids?)$/.test(key);
const MINUTES_KEY = /(?:Minutes|_minutes)$/;

/** A value in the words the person uses: times in the plan's zone, yes or no, lists without brackets. */
function valueText(value: unknown, ctx: ZoneContext, key = ""): string {
  if (isEmpty(value)) return "none";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number") return MINUTES_KEY.test(key) ? `${value} min` : String(value);
  if (typeof value === "string") {
    if (isInstant(value)) return formatInstant(value, ctx);
    if (isDateOnly(value)) return formatCalendarDay(value, ctx);
    return clean(value);
  }
  if (Array.isArray(value) && value.every((item) => item === null || typeof item !== "object"))
    return value.map((item) => valueText(item, ctx)).join(", ");
  return clean(JSON.stringify(value));
}

/** "setup before" for `setupBeforeMinutes: 0`, which then reads "0 min". */
const labelFor = (key: string, value: unknown): string =>
  words(typeof value === "number" ? key.replace(MINUTES_KEY, "") : key);

function nameOf(record: Record<string, unknown>): string | null {
  for (const key of TITLE_KEYS) {
    const value = record[key];
    if (typeof value === "string" && clean(value).trim() !== "") return `"${clean(value).trim().slice(0, TITLE_MAX)}"`;
  }
  return null;
}

function idOf(record: Record<string, unknown>): string | null {
  if (typeof record.id === "string" && record.id !== "") return clean(record.id);
  if (typeof record.id === "number") return String(record.id);
  return null;
}

export type FindRecord = (
  kind: string,
  id: unknown,
  sent?: Record<string, unknown>
) => Record<string, unknown> | undefined;

const MORE_ROW: ChangeRow = { field: "more", value: "Links to other records are listed under Exact request." };

/** What an id field points at, in words: `{ field: "project", text: "Family" }`, or null if any id has no name here. */
type Resolve = (key: string, value: unknown) => { field: string; text: string } | null;

const snake = (words: string[]): string => words.map((w) => w.toLowerCase()).join("_");

/**
 * Names the records an id field points to, through the same lookup the card uses for the stored record, so two
 * proposals that differ only by project or dependency do not look alike. A kind the portal does not hold (a place,
 * say) stays unnamed and is left for "Exact request".
 */
function makeResolver(find: FindRecord | undefined, ownKind: string): Resolve {
  return (key, value) => {
    if (!find) return null;
    const stem = key.replace(/(?:Ids?|_ids?)$/, "");
    const parts = stem
      .replace(/_/g, " ")
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (parts.length === 0) return null;
    // "dependency" points at the same kind of record as the one being saved; "default routine preset" is a routine preset.
    const candidates = parts[parts.length - 1]!.toLowerCase() === "dependency" ? [ownKind] : [];
    for (let i = 0; i < parts.length; i += 1) candidates.push(snake(parts.slice(i)));
    const ids = Array.isArray(value) ? value : [value];
    if (ids.length === 0 || ids.some((id) => typeof id !== "string" && typeof id !== "number")) return null;
    for (const kind of candidates) {
      const names = ids.map((id) => {
        const found = find(kind, id);
        return found ? nameOf(found) : null;
      });
      if (names.every((name): name is string => name !== null))
        return {
          field: parts[parts.length - 1]!.toLowerCase() === "dependency" ? "depends on" : parts.join(" ").toLowerCase(),
          text: names.map((name) => name.slice(1, -1)).join(", ")
        };
    }
    return null;
  };
}

/**
 * The fields a record sets, in words. Empty fields are left out and ids the portal cannot name are left for "Exact
 * request"; a start and end on one day read as one range.
 */
function fieldRows(record: Record<string, unknown>, ctx: ZoneContext, resolve: Resolve): ChangeRow[] {
  const rows: ChangeRow[] = [];
  let hidden = false;
  const range =
    isInstant(record.startsAt) && isInstant(record.endsAt) ? formatRange(record.startsAt, record.endsAt, ctx) : null;
  for (const [key, value] of Object.entries(record)) {
    if (HIDDEN_KEYS.has(key)) continue;
    if (range !== null && (key === "startsAt" || key === "endsAt")) {
      if (key === "startsAt") rows.push({ field: "when", value: range });
      continue;
    }
    if (isEmpty(value)) continue;
    if (isIdKey(key)) {
      const named = resolve(key, value);
      if (named) rows.push({ field: named.field, value: named.text });
      else hidden = true;
      continue;
    }
    rows.push({ field: labelFor(key, value), value: valueText(value, ctx, key) });
  }
  if (hidden) rows.push(MORE_ROW);
  return rows;
}

/**
 * The one-line consequence of a settings change. Fixed moments (events, shifts) read in the new zone; routines, repeats
 * and sleep are placed by the clock in the settings zone, so they keep their clock times.
 */
function settingsCaution(
  record: Record<string, unknown>,
  stored: Record<string, unknown> | undefined,
  ctx: ZoneContext
): string {
  const zone = typeof record.timezone === "string" ? record.timezone : null;
  const was = typeof stored?.timezone === "string" ? stored.timezone : null;
  const keep = "Routines, repeats and sleep keep their clock times, in the new zone.";
  const generic = `Times already set will read in the new time zone. ${keep}`;
  if (zone !== null && was !== zone) {
    if (was === null) return generic;
    const before = offsetMinutes(was, ctx.now);
    const after = offsetMinutes(zone, ctx.now);
    if (before === null || after === null) return generic;
    const shift = after - before;
    if (shift === 0)
      return `The time zone changes, though its clock is the same today; daylight-saving dates differ. ${keep}`;
    const hours = Math.abs(shift) / 60;
    return `Times already set will read ${Number.isInteger(hours) ? hours : hours.toFixed(1)} h ${
      shift > 0 ? "later" : "earlier"
    }. ${keep}`;
  }
  return "This changes a setting that affects your whole plan. Check the new value before confirming.";
}

const restoreRows = (status: string): ChangeRow[] => [
  { field: "status", value: `${status} \u2192 pending` },
  { field: "other fields", value: "kept as stored (the rest of the request is ignored on restore)" }
];

function commandGroup(payload: EntityCommandPayload, find: FindRecord | undefined, ctx: ZoneContext): ChangeGroup {
  const group = commandRows(payload, find, ctx);
  const { command, body } = payload;
  if (command !== "save_entity" || body.entityType !== "settings") return group;
  const record = isRecord(body.entity) ? body.entity : {};
  return { ...group, caution: settingsCaution(record, find?.("settings", record.id, record), ctx) };
}

function commandRows(
  { command, body }: EntityCommandPayload,
  find: FindRecord | undefined,
  ctx: ZoneContext
): ChangeGroup {
  const rawKind =
    command === "save_project"
      ? "project"
      : command === "save_action"
        ? "action"
        : typeof body.entityType === "string" && body.entityType !== ""
          ? body.entityType
          : "record";
  const kind = clean(rawKind).replaceAll("_", " ");
  const resolve = makeResolver(find, rawKind);
  const raw = command === "save_entity" ? body.entity : command === "save_project" ? body.project : body.action;
  const record = isRecord(raw) ? raw : {};
  // Only a generic entity save removes: the project and action schemas drop `remove`, so their save is an edit.
  // Only a span or a logged night is removed by `remove`; any other save drops the flag and updates, so it is shown as
  // the update it is (entity-commands.ts, the span and sleep_log_entry branches).
  const removing = command === "save_entity" && REMOVABLE.has(rawKind) && record.remove === true;
  // A restore puts a replaced capture back in review and keeps every stored field; the rest of the request is
  // ignored (entity-commands.ts, the capture branch's `restore`).
  const restoring = command === "save_entity" && rawKind === "capture" && record.restore === true;
  const keyed = KEYED_BY_NATURAL_KEY.has(rawKind) ? find?.(rawKind, record.id, record) : undefined;
  const updating = removing || restoring || body.expectedVersion != null || keyed !== undefined;
  if (!updating) {
    const label = nameOf(record) ?? idOf(record);
    return {
      title: label === null ? `Create ${kind}` : `Create ${kind} ${label}`,
      rows: fieldRows(record, ctx, resolve)
    };
  }
  const verb = removing ? "Remove" : restoring ? "Restore" : "Update";
  const id = idOf(record);
  const stored = keyed ?? find?.(rawKind, record.id, record);
  if (!stored) {
    return {
      title: `${verb} ${kind}${id === null ? "" : ` ${id}`} (not in this portal's copy)`,
      rows: restoring ? restoreRows("replaced") : fieldRows(record, ctx, resolve)
    };
  }
  // The stored record's name, never the one the agent is giving it.
  const name = nameOf(stored);
  const label = name === null ? id : id === null ? name : `${name} (${id})`;
  const title = `${verb} ${kind}${label === null ? "" : ` ${label}`}`;
  if (removing) return { title, rows: fieldRows(stored, ctx, resolve) };
  if (restoring)
    return {
      title,
      rows: restoreRows(valueText(stored.status, ctx))
    };
  const rows: ChangeRow[] = [];
  const cleared = companionCleared(rawKind, stored, record);
  let hidden = false;
  for (const [key, value] of Object.entries(record)) {
    if (HIDDEN_KEYS.has(key)) continue;
    // The save clears it whatever the request says; it is listed with the cleared fields below.
    if (cleared.includes(key)) continue;
    if (isIdKey(key)) {
      if (JSON.stringify(stored[key] ?? null) === JSON.stringify(value ?? null)) continue;
      const was = resolve(key, stored[key]);
      const now = resolve(key, value);
      if (was && now) rows.push({ field: now.field, value: `${was.text} \u2192 ${now.text}` });
      else if (now && isEmpty(stored[key])) rows.push({ field: now.field, value: `none \u2192 ${now.text}` });
      else hidden = true;
      continue;
    }
    const before = valueText(stored[key], ctx, key);
    const after = valueText(value, ctx, key);
    if (before !== after) rows.push({ field: labelFor(key, value), value: `${before} \u2192 ${after}` });
  }
  // A save restates the whole record: a stored field the request leaves out is cleared, or reset to its default; a
  // companion field is cleared even when restated.
  for (const { key, becomes } of omittedStoredFields(rawKind, stored, record))
    rows.push({
      field: labelFor(key, stored[key]),
      value: `${valueText(stored[key], ctx, key)} \u2192 ${becomes === null ? "none" : valueText(becomes, ctx, key)} (${
        cleared.includes(key)
          ? "the save clears it with this attendance or routine source"
          : rawKind === "routine_step" && key === "dependencyIds" && becomes !== null
            ? "not in the request, so it becomes the step before it"
            : `not in the request, so it is ${becomes === null ? "cleared" : "reset"}`
      })`
    });
  if (hidden) rows.push(MORE_ROW);
  return { title, rows: rows.length > 0 ? rows : [{ field: "no field changes", value: "" }] };
}

function settleGroups(payload: unknown, ctx: ZoneContext): ChangeGroup[] | null {
  // The same schema the applier parses with, so the card shows the verdicts that would be applied.
  const parsed = settleCatchUpCommandSchema.safeParse({
    ...(isRecord(payload) ? payload : {}),
    commandId: "00000000-0000-4000-8000-000000000000"
  });
  if (!parsed.success) return null;
  const rows: ChangeRow[] = parsed.data.verdicts.map((verdict) => {
    if ("entryId" in verdict) {
      let value: string = verdict.verdict;
      if (verdict.at) value += ` at ${localiseInstants(verdict.at, ctx)}`;
      if (verdict.moveTo) value += ` move to ${localiseInstants(verdict.moveTo, ctx)}`;
      if (verdict.becomes) value += ` becomes ${verdict.becomes}`;
      if (verdict.remainingMinutes !== undefined) value += ` with ${verdict.remainingMinutes} min left`;
      return { field: clean(verdict.entryId), value: clean(value) };
    }
    if (verdict.bulk === "skip_older_than")
      return {
        field: `everything older than ${verdict.days} ${verdict.days === 1 ? "day" : "days"}`,
        value: "skipped"
      };
    const day = verdict.day ? ` on ${verdict.day}` : "";
    const project = verdict.projectId ? ` in project ${clean(verdict.projectId)}` : "";
    return { field: `all${day}${project}`, value: verdict.bulk === "all_dropped" ? "dropped" : "skipped" };
  });
  if (parsed.data.closeWindow) rows.push({ field: "catch-up window", value: "close" });
  const n = parsed.data.verdicts.length;
  return [{ title: `Settle ${n} catch-up ${n === 1 ? "entry" : "entries"}`, rows }];
}

/** What confirming this proposal will apply, in words; null when the portal cannot describe its kind. */
export function proposalChanges(
  proposal: AgentProposal,
  find?: FindRecord,
  options: ChangeOptions = {}
): ChangeGroup[] | null {
  const ctx: ZoneContext = { timezone: options.timezone ?? "UTC", now: options.now ?? new Date() };
  switch (proposal.kind) {
    case "entity_command": {
      const parsed = entityCommandPayloadSchema.safeParse(proposal.payload);
      return parsed.success ? [commandGroup(parsed.data, find, ctx)] : null;
    }
    case "entity_command_batch": {
      const parsed = entityCommandBatchPayloadSchema.safeParse(proposal.payload);
      return parsed.success ? parsed.data.commands.map((command) => commandGroup(command, find, ctx)) : null;
    }
    case "settle_catch_up":
      return settleGroups(proposal.payload, ctx);
    default:
      return null;
  }
}
