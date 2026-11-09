/**
 * Agent scopes: one vocabulary `<verb>:<resource>[:<qualifier>]`
 * for MCP `--allow-writes`, token scopes and OAuth scope strings, and the one table that maps each CLI write
 * tool to the scopes it needs. This module is plumbing: nothing in PR 2 enforces it. PR 3 (agent tokens) makes the
 * portal wrapper, the CLI and the MCP tool filter read `requiredScopes`, `OWNER_ONLY_SETTINGS_FIELDS` and
 * `hardFloorReason`; until then a headerless caller counts as the owner. Confirming (`inbox-act ... confirm`,
 * `email-act confirm`, which write the plan and never send mail) takes the scope of its tool and is undoable;
 * `agent-routes.ts` refuses only a plain capture saved as confirmed and a contract review, not here.
 */
import { contractsExtensions, mergedList, mergedRecord } from "./extensions.js";
import { HIDING_STATUS } from "./closed-status.js";
import { isCloseType } from "./closed-entity.js";
import "./private/index.js";

export const SCOPE_VERBS = ["read", "propose", "write", "act", "admin"] as const;
export type ScopeVerb = (typeof SCOPE_VERBS)[number];

export interface ParsedScope {
  verb: ScopeVerb;
  resource: string;
  qualifier?: string;
}

export type ScopeParseResult = { ok: true; scope: ParsedScope } | { ok: false; reason: string };

const RESOURCE = /^[a-z][a-z0-9-]*$/;
const QUALIFIER = /^[a-z][a-z0-9_-]*$/;

/** Parses `<verb>:<resource>[:<qualifier>]`. Shape only: `isKnownScope` says whether the scope exists. */
export function parseScope(raw: string): ScopeParseResult {
  const parts = raw.split(":");
  if (parts.length < 2 || parts.length > 3)
    return { ok: false, reason: `"${raw}" is not <verb>:<resource>[:<qualifier>].` };
  const [verb, resource, qualifier] = parts as [string, string, string | undefined];
  if (!(SCOPE_VERBS as readonly string[]).includes(verb))
    return { ok: false, reason: `"${raw}" has an unknown verb "${verb}"; use ${SCOPE_VERBS.join(", ")}.` };
  if (!RESOURCE.test(resource)) return { ok: false, reason: `"${raw}" has an invalid resource "${resource}".` };
  if (qualifier !== undefined && !QUALIFIER.test(qualifier))
    return { ok: false, reason: `"${raw}" has an invalid qualifier "${qualifier}".` };
  return { ok: true, scope: { verb: verb as ScopeVerb, resource, ...(qualifier === undefined ? {} : { qualifier }) } };
}

/** Whether a held scope satisfies a required one: same resource, no narrower qualifier, and `write` also covers `propose`. */
export function scopeCovers(held: string, required: string): boolean {
  const a = parseScope(held);
  const b = parseScope(required);
  if (!a.ok || !b.ok) return false;
  const verbOk = a.scope.verb === b.scope.verb || (a.scope.verb === "write" && b.scope.verb === "propose");
  return (
    verbOk &&
    a.scope.resource === b.scope.resource &&
    (a.scope.qualifier === undefined || a.scope.qualifier === b.scope.qualifier)
  );
}

/** The scope that lets a write land as a proposal: `write:x` downgrades to `propose:x`; other verbs are unchanged. */
export function downgradeScope(scope: string): string {
  return scope.startsWith("write:") ? `propose:${scope.slice("write:".length)}` : scope;
}

/** Every `entityType` `save` and `bulk` can write: the 17-value entity enum plus the dedicated project and action routes. */
export const AGENT_ENTITY_TYPES = [
  "area",
  "outcome",
  "project",
  "action",
  "commitment",
  "capture",
  "deliverable",
  "routine_step",
  "routine_preset",
  "sleep_plan",
  "planning_focus",
  "span",
  "condition_definition",
  "settings",
  "daily_plan",
  "current_availability",
  "sleep_log_entry",
  "capture_review",
  "deliverable_contract_review"
] as const;
export type AgentEntityType = (typeof AGENT_ENTITY_TYPES)[number];

/** Entity types an agent can at most propose, whatever its token: settings and data-flow fields are on the hard floor. */
const PROPOSE_ONLY_ENTITIES: ReadonlySet<string> = new Set(["settings"]);

/** The scope `save`/`bulk` need for one entity type; undefined for a type outside the vocabulary. */
export function entityScope(entityType: string): string | undefined {
  if (!(AGENT_ENTITY_TYPES as readonly string[]).includes(entityType)) return undefined;
  // A capture is a reviewable item already, so `save capture` and `capture` share one scope.
  if (entityType === "capture") return "propose:capture";
  return PROPOSE_ONLY_ENTITIES.has(entityType) ? `propose:entity:${entityType}` : `write:entity:${entityType}`;
}

/** The scopes a read can need. Reads of mail, other people's messages and files are what `require` will gate (PR 3). */
export const READ_SCOPES: readonly string[] = [
  "read:plan",
  ...mergedList((extension) => extension.readScopes),
  "read:files",
  "read:changes",
  "read:proposals"
];

/** Never grantable to an agent: owner only. */
export const ADMIN_SCOPES = ["admin:tokens", "admin:switches"] as const;

/**
 * The tools whose scopes are fixed by the tool alone. `save` and `bulk` are resolved by entity type
 * (`entityScope`), `inbox-act` by room and action (`requiredScopes`).
 */
const FIXED_TOOL_SCOPES = {
  capture: ["propose:capture"],
  propose: ["propose:agent-change"],
  arrive: ["write:arrival"],
  // The person's answer to a stretch offer: it waives the energy cut, so it takes the availability scope energy is set with.
  stretch: ["write:entity:current_availability"],
  // When the person woke is a fact about last night's sleep, so it takes the sleep log's scope, as the wake-only
  // settings save does (`WAKE_SETTINGS_FIELDS`). Applied directly with no proposal: it records what happened.
  wake: ["write:entity:sleep_log_entry"],
  // "I'm free" is a commitment save that sends `free` alone, so it takes the commitment save's scope.
  free: ["write:entity:commitment"],
  session: ["write:session"],
  span: ["write:entity:span"],
  activity: ["write:activity"],
  deliverable: ["write:deliverable"],
  "check-in": ["write:check-in"],
  disruption: ["write:disruption"],
  routine: ["write:routine"],
  recalculate: ["write:recalculate"],
  review: ["write:entity:project"],
  undo: ["write:undo"],
  cadence: ["write:cadence"],
  recurrence: ["write:recurrence"],
  import: ["write:import"],
  "catch-up-settle": ["propose:catch-up"],
  // Ends a lapsed pulse: applied directly, never a proposal, undoable.
  reenter: ["write:catch-up"],
  // The least a changeset's writes need; the portal holds each write inside it to its own route's scopes.
  changeset: ["propose:entity"],
  // Keeps a deviation on plan: the check-in answer's other half, so the same scope.
  disrupt: ["write:check-in"]
} as const satisfies Record<string, readonly string[]>;

/** The tools whose scopes the tool alone fixes: the core table plus what the registered extensions add. */
function fixedToolScopes(): Record<string, readonly string[]> {
  return { ...FIXED_TOOL_SCOPES, ...mergedRecord((extension) => extension.toolScopes) };
}

/**
 * Every CLI tool that changes portal state (`mutates` in tools/cli/src/registry.ts, `mcp` excluded). A
 * test in tools/cli fails when the registry gains one that is not listed here.
 */
export const AGENT_WRITE_TOOLS = [
  ...Object.keys(fixedToolScopes()),
  "save",
  "bulk",
  "inbox-act",
  "archive",
  "cancel"
].sort();

export interface WriteCall {
  tool: string;
  /**
   * For `save` and `bulk`: the canonical entity type (`routine_step`, not `routine-step`). On the hard floor a
   * recurrence end carries `action` when it ends a recurring action's goal rather than a commitment's rule.
   */
  entityType?: string | undefined;
  /** For `inbox-act`: the room (`captured`, `kept`, `people`, `map`). */
  room?: string | undefined;
  /** The subcommand or action (`remove`, `confirm`, `reply`, `delete`, `end`). */
  action?: string | undefined;
}

const INBOX_PLAN_MAP_ACTIONS = new Set(["link", "links-bulk", "finding"]);

/** The scopes a call needs; empty for a tool outside the table (the caller treats that as refused). */
export function requiredScopes(call: WriteCall): string[] {
  if (call.tool === "save" || call.tool === "bulk") {
    const scope = call.entityType === undefined ? undefined : entityScope(call.entityType);
    return scope === undefined ? [] : [scope];
  }
  if (call.tool === "archive" || call.tool === "cancel") {
    // Per type like `save`, but only for the eight types a close can name (closed-entity.ts).
    const scope =
      call.entityType !== undefined && isCloseType(call.entityType) ? entityScope(call.entityType) : undefined;
    return scope === undefined ? [] : [scope];
  }
  if (call.tool === "inbox-act") {
    for (const extension of contractsExtensions()) {
      const scopes = extension.inboxActScopes?.(call);
      if (scopes !== undefined) return scopes;
    }
    if (call.room === "map" || (call.action !== undefined && INBOX_PLAN_MAP_ACTIONS.has(call.action)))
      return ["write:plan-map"];
    return ["write:inbox"];
  }
  const fixed = fixedToolScopes()[call.tool];
  return fixed ? [...fixed] : [];
}

/**
 * Write scopes a driving agent needs beyond the ones the MCP tools name to be listed: `write:entity` makes saves
 * apply instead of filing proposals, `write:catch-up` does the same for a settle, and `write:plan-map` is what
 * `inbox-act` asks for in the map room (`requiredScopes`). OAuth offers and grants these (portal mcp-oauth.ts
 * SCOPES_SUPPORTED) and the OpenClaw plugin requests them.
 */
export const AGENT_DRIVE_WRITE_SCOPES = ["write:entity", "write:catch-up", "write:plan-map"] as const;

/** True when the tool is in the table (every scope function above gives a result for it). */
export function isAgentWriteTool(tool: string): boolean {
  return AGENT_WRITE_TOOLS.includes(tool);
}

/** Settings fields that decide where data flows or which model sees it; owner only whatever the token says (security A7). */
export const OWNER_ONLY_SETTINGS_FIELDS = [
  "calendarShareEnabled",
  "sharePrimaryEvents",
  "pulsePublishEnabled",
  "deliverableChatModel",
  "importExtractorModel"
] as const;

/**
 * Settings fields that record what happened rather than what the person prefers, so an agent writes them directly
 * (with undo) like a sleep log, under the sleep log's scope and class. `lastWokeAt` is when the person last woke:
 * it goes stale every morning unless something records it, and the sleep and prep numbers read it (owner decision,
 * 2026-10-27).
 */
export const WAKE_SETTINGS_FIELDS = ["lastWokeAt"] as const;

/**
 * Settings fields that stay the person's to confirm: a change of timezone moves every time in the plan, and setup
 * decides whether the portal opens on the setup screen. With the data-flow fields (`OWNER_ONLY_SETTINGS_FIELDS`,
 * refused outright) these are the settings guarded by what they mean (owner decision, 2026-10-27).
 */
export const PROPOSE_ONLY_SETTINGS_FIELDS = ["timezone", "setupCompleted", "setupCompletedAt"] as const;

/**
 * Settings fields that shape the plan, which an agent changes directly, with undo (owner decision, 2026-10-27). A field
 * listed nowhere is filed for the person, so a new setting is guarded until someone classifies it here; a test
 * checks that every settings field is in exactly one of these lists.
 */
export const PLAN_PREFERENCE_SETTINGS_FIELDS = [
  "planningHorizonEnd",
  "assertedConditions",
  "defaultUsableFraction",
  "defaultSetupBufferMinutes",
  "defaultTransitionBufferMinutes",
  "submissionBufferMinutes",
  "submissionBufferPercent",
  "energyMeanings",
  "estimateBucketsMinutes",
  "estimateCalibrationEnabled",
  "preferredBedtime",
  "preferredWakeTime",
  "desiredSleepMinutes",
  "minimumSleepMinutes",
  "maxAwakeHours",
  "bedtimeDeviationMinutes",
  "recoveryStartTime",
  "recoveryEndTime",
  "recoveryWeekdays",
  "bedtimeRoutinePresetId",
  "wakeRoutinePresetId",
  "homeLocationId",
  "disruptionKindLabels",
  "disruptionWhenPresets",
  "disruptionDurationPresets",
  "disruptionRetroFallbackMinutes",
  "arrivalMarginMinutes",
  "sessionBreakMinutes",
  "defaultTransportMode",
  "leaveByLeadMinutes",
  "pulseUnknownToOffMinutes",
  "pulseFurtherPrompts",
  "pulseUnknownHardOffMinutes",
  "timeBands",
  "startByWarningMinutes",
  "locale",
  "planCodePattern"
] as const;

const settingsFields = (entity: unknown): string[] | null =>
  entity === null || typeof entity !== "object" || Array.isArray(entity)
    ? null
    : Object.keys(entity).filter((key) => key !== "id");

/** True when a settings payload names at least one field and only when the person woke (`id` aside). */
export function isWakeSettings(entity: unknown): boolean {
  const fields = settingsFields(entity);
  return (
    fields !== null &&
    fields.length > 0 &&
    fields.every((key) => (WAKE_SETTINGS_FIELDS as readonly string[]).includes(key))
  );
}

/**
 * True when a settings payload names at least one field and only plan preferences or when the person woke (`id`
 * aside). Such a change applies directly for an agent, with undo.
 */
export function isAgentWritableSettings(entity: unknown): boolean {
  const fields = settingsFields(entity);
  const writable: readonly string[] = [...PLAN_PREFERENCE_SETTINGS_FIELDS, ...WAKE_SETTINGS_FIELDS];
  return fields !== null && fields.length > 0 && fields.every((key) => writable.includes(key));
}

/** The owner-only settings fields an entity payload names (presence is enough, even if the value is unchanged). */
export function ownerOnlySettingsFieldsIn(entity: Record<string, unknown>): string[] {
  return OWNER_ONLY_SETTINGS_FIELDS.filter((field) => Object.prototype.hasOwnProperty.call(entity, field));
}

export interface GrantableScopesResult {
  scopes: string[];
  errors: string[];
}

/**
 * Validates scopes before they are granted to an agent token: each must parse, be a scope this vocabulary
 * knows, and not be an `admin` scope. Returns the normalised list and every problem found.
 */
export function validateGrantableScopes(raw: readonly string[]): GrantableScopesResult {
  const scopes: string[] = [];
  const errors: string[] = [];
  for (const entry of raw) {
    const scope = entry.trim();
    const parsed = parseScope(scope);
    if (!parsed.ok) errors.push(parsed.reason);
    else if (parsed.scope.verb === "admin") errors.push(`"${scope}" is owner only and cannot be granted to an agent.`);
    else if (!isKnownScope(scope)) errors.push(`"${scope}" is not a scope OpenRhen knows.`);
    else if (!scopes.includes(scope)) scopes.push(scope);
  }
  return { scopes, errors };
}

let knownScopes: Set<string> | undefined;

/** Whether a scope string names a scope in the vocabulary: a read scope, a table scope, or a broader `<verb>:entity`. */
export function isKnownScope(scope: string): boolean {
  if (knownScopes === undefined) {
    knownScopes = new Set<string>([...READ_SCOPES, ...ADMIN_SCOPES]);
    for (const scopes of Object.values(fixedToolScopes())) for (const entry of scopes) knownScopes.add(entry);
    for (const scope of mergedList((extension) => extension.knownScopes)) knownScopes.add(scope);
    // A settle from a token with only this scope is filed as a proposal.
    knownScopes.add("propose:catch-up");
    knownScopes.add("write:inbox");
    // Posting session records for agent time. Not a CLI tool, so not in FIXED_TOOL_SCOPES.
    knownScopes.add("write:agent-session");
    // The activity store: capture posts events; reading them back (content included) is its own scope.
    knownScopes.add("write:activity-event");
    knownScopes.add("read:activity-event");
    // Health-class sources (physiology, apple-health, iphone-health) are withheld from a read unless the token also holds this
    // scope. Deliberately not in SCOPES_SUPPORTED (portal/server/mcp-oauth.ts): a default OAuth grant never includes it.
    knownScopes.add("read:activity-health");
    // Writing derived rows an extractor produces (fact, msg_class). Never override or fact_status: those need write:activity-event.
    knownScopes.add("write:activity-derived");
    knownScopes.add("write:plan-map");
    // A token holding this scope has its settle applied directly.
    knownScopes.add("write:catch-up");
    for (const type of AGENT_ENTITY_TYPES) {
      const scope = entityScope(type);
      if (scope !== undefined) knownScopes.add(scope);
      knownScopes.add(`propose:entity:${type}`);
    }
    for (const type of AGENT_ENTITY_TYPES)
      if (!PROPOSE_ONLY_ENTITIES.has(type)) knownScopes.add(`write:entity:${type}`);
    knownScopes.add("propose:entity");
    knownScopes.add("write:entity");
  }
  return knownScopes.has(scope);
}

export interface HardFloorCall extends WriteCall {
  /** True for a settings change that names only plan preferences (`isAgentWritableSettings`), which is not on the floor. */
  agentWritableSettings?: boolean | undefined;
  /** True when the payload carries `remove: true` (span, sleep_log_entry). */
  remove?: boolean | undefined;
  /** How many rows the write touches; the caller counts them (a bulk's matched records, an import's records). */
  rowCount?: number | undefined;
  /** True when the write reaches another person: shared calendar or the calendar provider, another person, anything sent outward. */
  touchesPeople?: boolean | undefined;
  /**
   * True when the write edits a stored record (its body carries the version it read, `expectedVersion`). A shared
   * flag on it may be the record's own, merged in by the CLI, rather than a new share, so the reason must not tell
   * the agent to turn sharing off: that would take the event off the family calendar.
   */
  existing?: boolean | undefined;
  /**
   * True when a place save creates or renames a place to a name the portal's environment maps shifts to; the shared
   * shift text on the family calendar follows that place's name.
   */
  envNamedPlace?: boolean | undefined;
  /** For a settings save: the fields the payload names (`id` aside), so the reason can say which are the person's. */
  settingsFields?: readonly string[] | undefined;
}

/** A bulk write above this many rows becomes one batch proposal. */
export const BULK_PROPOSAL_THRESHOLD = 20;

/**
 * Where the person changes each settings field an agent cannot, so a refusal can point at the screen. A field
 * missing here is only known to be in Settings.
 */
const PERSON_SETTINGS_WHERE: Record<string, string> = {
  timezone: "Settings > Planning",
  setupCompleted: "the Setup page",
  setupCompletedAt: "the Setup page",
  calendarShareEnabled: "Settings > Family calendar sharing",
  sharePrimaryEvents: "Settings > Family calendar sharing",
  pulsePublishEnabled: "Settings > Pulse",
  deliverableChatModel: "Settings > AI models",
  importExtractorModel: "Settings > AI models"
};

/** Where the person changes one settings field an agent cannot (`Settings` alone for a field nobody has placed). */
export function settingsPlace(field: string): string {
  return PERSON_SETTINGS_WHERE[field] ?? "Settings";
}

/** A floored call: why it is the person's, and the one path the reason names for what to do instead. */
interface HardFloor {
  reason: string;
  /** A `rhen` command the agent can run, or where in the portal the person does it when only they can. */
  instead: string;
}

/** Builds a floor from its path, handing the path to the reason so the reason always names it. */
const floor = (instead: string, reason: (path: string) => string): HardFloor => ({ instead, reason: reason(instead) });

/** A settings floor: which fields stay the person's and where they change them; the rest of a mixed save is not held for this. */
function settingsFloor(fields: readonly string[] | undefined): HardFloor {
  const writable: readonly string[] = [...PLAN_PREFERENCE_SETTINGS_FIELDS, ...WAKE_SETTINGS_FIELDS];
  const guarded = (fields ?? []).filter((field) => !writable.includes(field));
  const mixed = (fields ?? []).length > guarded.length;
  const names = guarded.length > 0 ? guarded.join(", ") : "timezone, setup and data-flow fields";
  const places = [...new Set(guarded.map(settingsPlace))];
  return floor(
    places.length > 0 ? places.join(", ") : "Settings",
    (path) =>
      `settings: ${names} ${guarded.length === 1 ? "is" : "are"} the person's to change, in ${path}` +
      (mixed ? "; the plan preferences in this save are not held for that, so send them in a save of their own" : "")
  );
}

/**
 * The family-calendar floor. Only a new record can be saved unshared and shared by the person afterwards; an edit to
 * a stored one may carry the record's own `shareToCalendar: true`, so it is never told to turn sharing off. A save is
 * filed as a proposal (the save routes downgrade); a recurring rule cannot be proposed, so only the person changes it.
 */
function peopleFloor(tool: string | undefined, existing: boolean): HardFloor {
  if (tool === "recurrence")
    return existing
      ? floor(
          "Schedule > Recurring commitments",
          (path) =>
            "touches another person: a recurring commitment shared with the family calendar, or a change that " +
            `shares one, is the person's to change, in ${path}; tell them the change`
        )
      : floor(
          "Schedule > Recurring commitments",
          (path) =>
            "touches another person: sharing with the family calendar is the person's call; " +
            `set the rule with shareToCalendar off, and they share it in ${path}`
        );
  return existing
    ? floor(
        "Inbox > Captured > From agents",
        (path) =>
          "touches another person: a commitment shared with the family calendar, or a change that shares one, " +
          `needs the person's confirm, so this waits for them in ${path}`
      )
    : floor(
        "the commitment's Family calendar section",
        (path) =>
          "touches another person: sharing with the family calendar is the person's call; " +
          `leave shareToCalendar off, and they turn it on in ${path}`
      );
}

/** The floor a call is on, or null: the one place `hardFloorReason` and `hardFloorInstead` read, so they cannot drift. */
function hardFloorOf(call: HardFloorCall): HardFloor | null {
  const { tool, action } = call;
  const type = call.entityType ?? "record";
  const kind = type.replace(/_/g, " ");
  if (
    (tool === "span" && action === "remove") ||
    (call.entityType === "span" && (call.remove === true || action === "remove"))
  )
    return floor(
      "rhen span set <span> --end YYYY-MM-DD",
      (path) => `removal: deleting a span is the person's call; to shorten it instead, run \`${path}\``
    );
  if (call.remove === true && type === "sleep_log_entry")
    return floor(
      "rhen save sleep-log-entry --id <id> --set sleepAt=<time> --set wakeAt=<time>",
      (path) => `removal: deleting a logged night is the person's call; to correct its times instead, run \`${path}\``
    );
  if (call.remove === true) {
    const status = HIDING_STATUS[type];
    const path =
      type === "capture"
        ? "rhen inbox-act captured ignore <id>"
        : status !== undefined
          ? `rhen ${status === "archived" ? "archive" : "cancel"} ${type} <id> close --reason "<why>"`
          : undefined;
    return path !== undefined
      ? floor(
          path,
          (shown) =>
            `removal: deleting this ${kind} is the person's call; to take it out of the plan instead, run \`${shown}\``
        )
      : floor("the portal", (shown) => `removal: deleting this ${kind} is the person's call; they do it in ${shown}`);
  }
  if (tool === "import" && action === "delete")
    return floor(
      "rhen import update <id> --from <file>",
      (path) =>
        "removal: deleting an import batch is the person's call (Inbox > Calendar & imports); " +
        `to fix its records instead, run \`${path}\``
    );
  if (tool === "recurrence" && action === "end" && call.touchesPeople === true)
    // Setting an end date is a `recurrence set` on the same shared rule, which is refused too, so it is no way out.
    return floor(
      "Schedule > Recurring commitments",
      (path) =>
        "removal: ending a recurring commitment shared with the family calendar is the person's call, " +
        `and so is giving it an end date; they do it in ${path}`
    );
  if (tool === "recurrence" && action === "end")
    return call.entityType === "action"
      ? floor(
          "rhen save action --id <action> --set recurrence.endDate=YYYY-MM-DD",
          (path) =>
            `removal: ending a recurring action is the person's call; to stop it sooner, give it an end date: \`${path}\``
        )
      : floor(
          "rhen recurrence set --id <rule> --set endDate=YYYY-MM-DD --yes",
          (path) => `removal: ending a recurrence is the person's call; to stop it sooner, set an end date: \`${path}\``
        );
  if (tool === "inbox-act" && call.room === "kept" && action === "drop")
    return floor(
      "rhen inbox-act kept reopen <id>",
      (path) =>
        "removal: dropping a kept item is the person's call (Inbox > Someday & reference); " +
        `to send it back to review instead, run \`${path}\``
    );
  // An import commit is one request, so the server counts its rows and shared commitments; it has no proposal
  // form, so the batch stays a draft for the person to commit.
  if (
    tool === "import" &&
    action === "commit" &&
    (call.touchesPeople === true || (call.rowCount !== undefined && call.rowCount > BULK_PROPOSAL_THRESHOLD))
  )
    return floor(
      "Inbox > Calendar & imports",
      (path) =>
        (call.touchesPeople === true
          ? "touches another person: the batch changes commitments on the family calendar"
          : `bulk: ${call.rowCount} rows is over ${BULK_PROPOSAL_THRESHOLD}`) +
        `, so the person commits it in ${path}; the batch stays a draft for them`
    );
  for (const rule of mergedList((extension) => extension.floorRules))
    if (rule.matches(call)) return floor(rule.place, rule.message);
  if (tool === "save" && call.entityType === "settings" && call.agentWritableSettings !== true)
    return settingsFloor(call.settingsFields);
  if (call.rowCount !== undefined && call.rowCount > BULK_PROPOSAL_THRESHOLD)
    return floor(
      "Inbox > Captured > From agents",
      (path) =>
        `bulk: ${call.rowCount} rows is over ${BULK_PROPOSAL_THRESHOLD}, so the person confirms them as one batch in ${path}`
    );
  if (call.envNamedPlace === true)
    return floor(
      "Inbox > Captured > From agents",
      (path) =>
        "shared shift text: this place's name is one the roster sync uses to label shifts on the family calendar, " +
        `so creating or renaming a place to it is the person's call; it waits for them in ${path}`
    );
  if (call.touchesPeople === true) return peopleFloor(tool, call.existing === true);
  return null;
}

/**
 * Hard floor (design section 2): whatever the basis or the token, these land as proposals. Returns the reason
 * to show the person, or null when the call is not on the floor. Pure; PR 3 applies it after scope resolution.
 * Setting a status to cancelled, archived or dropped is not on it: that is a field change the person can undo.
 * Each reason starts with its class and names what the agent can do instead, or says only the person can and
 * where. The same text goes back to the agent whether the write was filed as a proposal or refused.
 */
export function hardFloorReason(call: HardFloorCall): string | null {
  return hardFloorOf(call)?.reason ?? null;
}

/**
 * Just the path the call's `hardFloorReason` names: a `rhen` command the agent can run in its place, or where
 * in the portal the person does it when only they can. Null when the call is not on the floor.
 */
export function hardFloorInstead(call: HardFloorCall): string | null {
  return hardFloorOf(call)?.instead ?? null;
}
