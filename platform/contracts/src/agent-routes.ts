import {
  AGENT_ENTITY_TYPES,
  downgradeScope,
  entityScope,
  isAgentWritableSettings,
  isWakeSettings,
  ownerOnlySettingsFieldsIn,
  requiredScopes,
  settingsPlace,
  type HardFloorCall,
  type WriteCall
} from "./agent-scopes.js";
import { CLOSE_BUDGET_LIMIT, CLOSE_TYPES, isCloseType } from "./closed-entity.js";
import { removedFieldMessage } from "./removed-field-names.js";
import { contractsExtensions, mergedList, mergedRecord } from "./extensions.js";
import "./private/index.js";

/**
 * The portal route to scope map: for a request from a scoped agent
 * token, which scopes the route needs and whether the write may land as a proposal instead. This is the only
 * place that knows it. A route not named here is refused to token agents (default deny), and a test in the
 * portal fails when a route file gains a method this table does not classify.
 */

export type RouteDecision =
  /** Anyone with a valid token may call it (health, the CLI bundle). */
  | { kind: "public" }
  | {
      kind: "scopes";
      /** All the scopes the operation needs; the 403 challenge lists every one of them. */
      scopes: string[];
      /** A read only: holding any one of these is enough (a read several kinds of token may make); `scopes` then lists the first, for the challenge. */
      anyOf?: string[];
      /** The call as `requiredScopes` and `hardFloorReason` know it; absent for reads. */
      call?: WriteCall;
      /** Floor facts about this very request (a removal flag, whether it reaches another person); present for writes. */
      floor?: HardFloorCall;
      /** True for save_entity, save_project and save_action: a `propose:` scope, a floor hit or a `directWrites` setting turns the write into a proposal. */
      downgradable?: boolean;
      /** For a downgradable write: the entity class `directWrites` is keyed by. */
      entityClass?: string;
      /** For a downgradable write: `save_entity`, `save_project` or `save_action`, the command an `entity_command` proposal replays. */
      command?: "save_entity" | "save_project" | "save_action" | "close_entity";
      /**
       * For a close: why it is filed as a proposal whatever the token holds (something under it is the owner's call, it is
       * shared, the row was not closed by this agent, or the facts could not be read).
       */
      mustPropose?: string;
      /** For a close: every type the call touches (the target's and what it takes with it); the token needs a direct write for each. */
      closeTypes?: string[];
    }
  /** Not a surface for agents at all: owner and device routes, and confirming. */
  | { kind: "refused"; reason: "owner-only"; message: string }
  /** A route that checks its own credential (the remote `/mcp` and its token endpoint); `X-OpenRhen-Token` is no key to it. */
  | { kind: "refused"; reason: "self-authenticated"; message: string }
  /** The route is not in the table: default deny. */
  | { kind: "refused"; reason: "unclassified"; message: string }
  /** The body names something this map cannot place (an unknown entity type). */
  | { kind: "refused"; reason: "unknown-entity"; message: string }
  /** The body names a field that was renamed and whose old name is no longer accepted (`removed-field-names.ts`). */
  | { kind: "refused"; reason: "removed-field"; message: string };

type Body = Record<string, unknown> | undefined;

const OWNER = (what: string, where = "in the portal"): RouteDecision => ({
  kind: "refused",
  reason: "owner-only",
  message:
    `${what} is for the owner; an agent token cannot use it, so nothing was changed. The person does it ${where}. ` +
    `Do not retry this call. Tell the owner: "I cannot do this myself; please do it ${where}."`
});

/** A job the engine worker runs or a report a device sends: nobody does it by hand, so there is no place to point at. */
const RUNS_ITSELF = (what: string): RouteDecision => ({
  kind: "refused",
  reason: "owner-only",
  message: `${what} is for the owner; an agent token cannot use it. It runs from the engine worker or the person's own device, so an agent has nothing to do here.`
});

const SETTINGS_ADD_ONS = "in Settings > Add-ons and sign-in";
const ON_CONNECTIONS = "on the Connections page";
const IN_NOTIFICATIONS = "in Settings > Notifications";

/** Where (or with which command) the person does an owner route, for the ones with a clear home; the rest say "in the portal". */
const OWNER_WHERE: Record<string, string> = {
  ...mergedRecord((extension) => extension.routes?.ownerWhere),
  "POST /api/agent-proposals/[id]/resolve": "in Inbox > Captured > From agents",
  "POST /api/agent-changes/[id]/undo": "in Review > Agent changes",
  "POST /api/agent-tokens": "with `rhen agent-token create --name <agent> --scopes <scopes>`",
  "DELETE /api/agent-tokens/[id]": SETTINGS_ADD_ONS,
  "PATCH /api/agent-tokens/[id]": SETTINGS_ADD_ONS,
  "POST /api/owner/credentials": "with `rhen owner-token create`",
  "DELETE /api/owner/credentials/[id]": SETTINGS_ADD_ONS,
  "POST /api/owner/signout": SETTINGS_ADD_ONS,
  "POST /api/owner/enroll": "on the Sign in page",
  "PUT /api/plan-map/switches": SETTINGS_ADD_ONS,
  "POST /api/connections/status": ON_CONNECTIONS,
  "PUT /api/connections/[connectionId]/calendars": ON_CONNECTIONS,
  "POST /api/connections/[connectionId]/sync": ON_CONNECTIONS,
  "POST /api/connections/[connectionId]/publish": ON_CONNECTIONS,
  "POST /api/connections/[connectionId]/import/preview": ON_CONNECTIONS,
  "POST /api/connections/[connectionId]/publish/remove": ON_CONNECTIONS,
  "POST /api/connections/[connectionId]/write-proof": ON_CONNECTIONS,
  "POST /api/push/subscriptions": IN_NOTIFICATIONS,
  "DELETE /api/push/subscriptions": IN_NOTIFICATIONS,
  "DELETE /api/push/subscriptions/[id]": IN_NOTIFICATIONS,
  "POST /api/push/test": IN_NOTIFICATIONS,
  "POST /api/snapshots": "with the Report issue button",
  "POST /api/snapshots/[id]/review": "on the Reports page"
};

/** Owner routes that are jobs or device reports (`RUNS_ITSELF`). */
const OWNER_RUNS_ITSELF = new Set([
  ...mergedList((extension) => extension.routes?.ownerRunsItself),
  "POST /api/device/action",
  "POST /api/integrations/pulse/tick",
  "POST /api/integrations/push/drain",
  "POST /api/integrations/travel/tick",
  "POST /api/integrations/derived/tick",
  "POST /api/location/observe",
  "POST /api/offer-log/shown",
  "POST /api/location/ping",
  "DELETE /api/location/suggestion",
  "POST /api/photo-checkins",
  "PATCH /api/photo-checkins/[id]",
  "POST /api/place-photos",
  "POST /api/plan-map/propose",
  "POST /api/plan-map/sweep",
  "POST /api/travel/geocode",
  "POST /api/travel/refresh"
]);

/**
 * What an agent is told when it names an entity type it cannot write: the ones it can. The contract review is the
 * person's, and a comparison is answered on its own route (`rhen_save` sends it there), not through `save_entity`.
 */
const TYPES_HINT = `Agents can write: ${AGENT_ENTITY_TYPES.filter((type) => type !== "deliverable_contract_review" && type !== "comparison").join(", ")}.`;

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/** Whether the write edits a stored record: an update carries the version it read, a create sends none (or null). */
const edits = (body: Body): boolean => typeof body?.expectedVersion === "number";

const scoped = (call: WriteCall, extra: Partial<HardFloorCall> = {}): RouteDecision => ({
  kind: "scopes",
  scopes: requiredScopes(call),
  call,
  floor: { ...call, ...extra }
});

/**
 * What the portal read from the stored record before deciding, for what the body alone cannot say: whether the
 * record a write changes is on the family calendar today. A body that leaves `shareToCalendar` out keeps the stored
 * flag, and one that sends `false` takes the record off, so both reach other people as surely as sending `true`.
 */
export interface StoredFacts {
  /** The stored commitment or recurrence rule shares with the family calendar. */
  shared?: boolean;
  /**
   * The place save creates or renames a place to a name the portal's environment maps shifts to (a store's place or the
   * default place), which relabels shared shift text on the family calendar.
   */
  envNamedPlace?: boolean;
  /**
   * What a close or restore touches, read from the stored rows (`POST /api/commands/close`). Absent means the rows were
   * not read (or the read failed), and the call is then filed for the owner rather than trusted.
   */
  closeTypes?: string[];
  /** Something the call closes is the owner's call: a deadline, a requirement route, prep for a shared commitment. */
  needsOwner?: boolean;
  /** Rows the call changes, the target included. */
  rowCount?: number;
  /** A restore only: the row was closed by this very agent, directly (`closed_by` is exactly `agent:<name>`). */
  restorableByAgent?: boolean;
  /** The target's version when read, pinned by a proposal that carries no `expected-version`. */
  closeVersion?: number;
  /** The rows besides the target that the call changes, with their versions, for a proposal to pin. */
  closeChildren?: { type: string; id: string; version: number }[];
  /** Closures by token agents in the last hour, from the write ledger (not the closed columns). */
  closedInHour?: number;
  /** The command id was already applied: the handler answers the retry from its receipt, so the budget is not asked. */
  closeCommandLanded?: boolean;
  /** `undoOfCommandId` names an agent create of this row that the ledger verifies and the window allows. */
  undoOfCreate?: boolean;
}

/**
 * The place a `save condition_definition` write names, for the portal to compare with the environment's place
 * names: the name sent, and the id when the write edits a stored place (whose stored name matters too, as renaming
 * it away relabels shifts as surely as renaming to one). Undefined for any other write, and for a kind that is
 * stated and is not a location.
 */
export function placeNameTarget(
  method: string,
  route: string,
  body: unknown
): { id?: string; name?: string } | undefined {
  if (method.toUpperCase() !== "POST" || route !== "/api/commands/entity") return undefined;
  const fields = record(body);
  if (fields?.entityType !== "condition_definition") return undefined;
  const entity = record(fields.entity);
  if (entity === undefined) return undefined;
  if (entity.kind !== undefined && entity.kind !== "location") return undefined;
  const id = str(entity.id);
  const name = str(entity.name);
  return { ...(id === undefined ? {} : { id }), ...(name === undefined ? {} : { name }) };
}

/**
 * The stored record whose `shareToCalendar` a write to this route can change or move: a commitment, a recurrence
 * rule, or the commitment a source split takes a source off. Undefined for a create or any other route. Ids are as
 * the client sent them; the portal maps them to stored ids as the handler does.
 */
export function sharingTarget(
  method: string,
  route: string,
  body: unknown
): { kind: "commitment" | "commitment-rule"; id: string } | undefined {
  if (method.toUpperCase() !== "POST") return undefined;
  const fields = record(body);
  if (fields === undefined) return undefined;
  if (route === "/api/commands/commitment-source-split") {
    const id = str(fields.commitmentId);
    return id === undefined ? undefined : { kind: "commitment", id };
  }
  // Without the version it read, the write creates the record, so nothing is stored to read.
  if (fields.expectedVersion === null || fields.expectedVersion === undefined) return undefined;
  if (route === "/api/commands/entity" && fields.entityType === "commitment") {
    const id = str(record(fields.entity)?.id);
    return id === undefined ? undefined : { kind: "commitment", id };
  }
  if (route === "/api/commands/commitment-recurrence") {
    const id = str(record(fields.rule)?.id);
    return id === undefined ? undefined : { kind: "commitment-rule", id };
  }
  return undefined;
}

/**
 * The row a close or restore names, for the portal to look up before deciding (what is under it, whether it is shared,
 * who closed it). Undefined for any other route or a body that does not name a target.
 */
export function closeTarget(
  method: string,
  route: string,
  body: unknown
): { type: string; id: string; verb: "archive" | "cancel"; do: "close" | "restore" } | undefined {
  if (method.toUpperCase() !== "POST" || route !== "/api/commands/close") return undefined;
  const fields = record(body);
  const type = str(fields?.type);
  const id = str(fields?.id);
  const verb = fields?.verb;
  const action = fields?.do;
  if (type === undefined || id === undefined) return undefined;
  if (verb !== "archive" && verb !== "cancel") return undefined;
  if (action !== "close" && action !== "restore") return undefined;
  return { type, id, verb, do: action };
}

/**
 * Archive and cancel (`POST /api/commands/close`): a downgradable write under the target's own scope. The stored facts
 * decide whether it may apply: anything the owner must decide, a call past 20 rows or 20 closures in the rolling hour, a token without a direct write for
 * every type the call reaches, or an agent restoring a row it did not close itself files ONE proposal instead.
 */
function closeWrite(body: Body, stored: StoredFacts): RouteDecision {
  const type = str(body?.type);
  const verb = body?.verb;
  if (type === undefined || !isCloseType(type) || (verb !== "archive" && verb !== "cancel"))
    return {
      kind: "refused",
      reason: "unknown-entity",
      message:
        `A close names a type and a verb. Types: ${CLOSE_TYPES.join(", ")}; verb: archive or cancel. ` +
        "An area, preset or place is archived; an appointment is cancelled."
    };
  const call: WriteCall = { tool: verb, entityType: type };
  const restoring = body?.do === "restore";
  const mustPropose =
    stored.closeTypes === undefined
      ? "the stored rows could not be read, so the close waits for the owner"
      : stored.needsOwner === true
        ? "something it closes is the owner's call (a deadline, a requirement route, or prep for a shared commitment), so the whole call waits for the owner"
        : stored.shared === true
          ? "it is shared with other people, so closing it is the owner's call"
          : restoring && stored.restorableByAgent !== true
            ? "this row was not closed by this agent directly (the owner, another agent or an import closed it, or the owner confirmed it), so restoring it is the owner's call"
            : !restoring &&
                stored.closeCommandLanded !== true &&
                stored.undoOfCreate !== true &&
                stored.closedInHour !== undefined &&
                stored.closedInHour + (stored.rowCount ?? 1) > CLOSE_BUDGET_LIMIT
              ? `closing ${stored.rowCount ?? 1} would make ${stored.closedInHour + (stored.rowCount ?? 1)} closures by agents in the last hour, over the ${CLOSE_BUDGET_LIMIT} allowed (counting this call), so the call waits for the owner`
              : undefined;
  return {
    kind: "scopes",
    scopes: [entityScope(type) as string],
    call,
    floor: { ...call, ...(stored.rowCount === undefined ? {} : { rowCount: stored.rowCount }) },
    downgradable: true,
    entityClass: type,
    command: "close_entity",
    closeTypes: stored.closeTypes ?? [type],
    ...(mustPropose === undefined ? {} : { mustPropose })
  };
}

/** `save_entity`: the entity type comes from the body and decides the scope, the class and the floor. */
function entityWrite(body: Body, stored: StoredFacts): RouteDecision {
  const entityType = str(body?.entityType);
  if (entityType === undefined)
    return { kind: "refused", reason: "unknown-entity", message: `The body names no entityType. ${TYPES_HINT}` };
  const entity = record(body?.entity) ?? {};
  const removed = removedFieldMessage(entity);
  if (removed !== null) return { kind: "refused", reason: "removed-field", message: `${entityType}: ${removed}` };
  // Approving a contract is the person's alone (design section 2).
  if (entityType === "deliverable_contract_review")
    return OWNER("Approving a deliverable's contract", "on the Deliverables page");
  // Confirming an Inbox item is an agent's, scoped like `inbox-act` (or the tool of an extension that owns the proposal type) and undoable from a row snapshot.
  // Not downgradable, like ignore. A capture from another person is refused in the handler: the route cannot see its source.
  if (entityType === "capture_review") {
    const owned = contractsExtensions()
      .map((extension) => extension.captureConfirmCall?.(entity))
      .find((call) => call !== undefined);
    const call: WriteCall = owned ?? { tool: "inbox-act", room: "captured", action: "confirm" };
    return scoped(call);
  }
  // Data-flow settings (who sees the plan, which model reads it) are the person's whatever the token: refused, never
  // filed as a proposal, so no card can carry them (security A7).
  if (entityType === "settings") {
    const fields = ownerOnlySettingsFieldsIn(entity);
    if (fields.length > 0)
      return {
        kind: "refused",
        reason: "owner-only",
        message:
          `settings: ${fields.join(", ")} ${fields.length === 1 ? "is" : "are"} the person's to change, ` +
          `in ${[...new Set(fields.map(settingsPlace))].join(", ")}; an agent token can neither save nor propose ` +
          `${fields.length === 1 ? "it" : "them"}. Tell the person the change.`
      };
  }
  // When the person woke is a fact, not a preference: it applies like a sleep log, under that scope and class.
  if (entityType === "settings" && isWakeSettings(entity)) {
    const call: WriteCall = { tool: "save", entityType: "sleep_log_entry" };
    return {
      kind: "scopes",
      scopes: [entityScope("sleep_log_entry") as string],
      call,
      floor: call,
      downgradable: true,
      entityClass: "sleep_log_entry",
      command: "save_entity"
    };
  }
  // A plan preference (sleep targets, buffers, bands, labels) applies directly with undo, for a token with every
  // class on (`directWriteMode`); timezone, setup and data-flow fields stay the person's.
  if (entityType === "settings" && isAgentWritableSettings(entity)) {
    const call: WriteCall = { tool: "save", entityType };
    return {
      kind: "scopes",
      scopes: ["write:entity:settings"],
      call,
      floor: { ...call, agentWritableSettings: true },
      downgradable: true,
      entityClass: "settings",
      command: "save_entity"
    };
  }
  const required = entityScope(entityType);
  if (required === undefined)
    return {
      kind: "refused",
      reason: "unknown-entity",
      message: `"${entityType}" is not an entity type agents can write. ${TYPES_HINT}`
    };
  // A capture that is no longer pending is being reviewed (confirmed, ignored), which is an inbox action. Ignoring a
  // kept (Someday or Reference) item drops it, which is on the hard floor: the handler refuses that, as only the
  // stored row says the item is kept.
  if (entityType === "capture") {
    const status = str(entity.status);
    if (status === "confirmed")
      return {
        kind: "refused",
        reason: "owner-only",
        message:
          "Saving a capture as confirmed is for the owner, so nothing was changed. " +
          "To confirm an Inbox item yourself, run `rhen inbox-act captured confirm <id> --type <type>` " +
          "(type is what the capture becomes, for example action)."
      };
    if (status !== undefined && status !== "pending") {
      const call: WriteCall = { tool: "inbox-act", room: "captured", action: status === "ignored" ? "ignore" : status };
      return { kind: "scopes", scopes: ["write:inbox"], call, floor: call };
    }
  }
  const call: WriteCall = {
    tool: "save",
    entityType,
    ...(entityType === "span" && entity.remove === true ? { action: "remove" } : {})
  };
  return {
    kind: "scopes",
    scopes: [required],
    call,
    floor: {
      ...call,
      remove: entity.remove === true,
      touchesPeople: entity.shareToCalendar === true || (entityType === "commitment" && stored.shared === true),
      ...(entityType === "condition_definition" && stored.envNamedPlace === true ? { envNamedPlace: true } : {}),
      existing: edits(body),
      ...(entityType === "settings" ? { settingsFields: Object.keys(entity).filter((key) => key !== "id") } : {})
    },
    downgradable: true,
    entityClass: entityType,
    command: "save_entity"
  };
}

function projectOrActionWrite(body: Body, entityType: "project" | "action"): RouteDecision {
  const inner = record(body?.[entityType]) ?? {};
  const call: WriteCall = { tool: "save", entityType };
  return {
    kind: "scopes",
    scopes: [entityScope(entityType) as string],
    call,
    floor: { ...call, remove: inner.remove === true },
    downgradable: true,
    entityClass: entityType,
    command: entityType === "project" ? "save_project" : "save_action"
  };
}

/**
 * Why one proposed `{ command, body }` cannot be a proposal, or null when it can. A proposal holds exactly the writes
 * the save routes would themselves file for the person: a save the route refuses (a contract review, a capture saved
 * as confirmed, a data-flow setting) is refused here too, and one the route never downgrades (confirming an Inbox
 * item) is made directly instead. A capture moved out of review is the exception: its floor depends on the stored
 * row. The portal's applier asks the same on proposing and again on confirming.
 */
export function proposableCommandRefusal(item: unknown): string | null {
  return unproposable(item)?.message ?? null;
}

type Refused = Extract<RouteDecision, { kind: "refused" }>;

function unproposable(item: unknown): Refused | null {
  const command = str(record(item)?.command);
  const body = record(record(item)?.body);
  if (command !== "save_entity" && command !== "save_project" && command !== "save_action")
    return {
      kind: "refused",
      reason: "unknown-entity",
      message:
        `payload-json.command must be "save_entity", "save_project" or "save_action"; ${command === undefined ? "none was sent" : `you sent "${command.slice(0, 40)}"`}. ` +
        'The payload is {"command": ..., "body": {...}}: save_entity with body {entityType, entity, expectedVersion}, save_project with body {project, expectedVersion}, save_action with body {action: the complete action, expectedVersion}.'
    };
  const decision =
    command === "save_project" || command === "save_action"
      ? projectOrActionWrite(body, command === "save_project" ? "project" : "action")
      : entityWrite(body, {});
  if (decision.kind === "refused") return decision;
  if (decision.kind === "scopes" && decision.downgradable) return null;
  // A capture moved out of review (ignored, dropped, reopened) is on the hard floor when it is a kept item or one
  // from another person: the route cannot see which, so the agent files it for the person, and the handler applies it once
  // the person confirms. Confirming an Inbox item (`capture_review`) is the agent's own and is made directly.
  if (
    command === "save_entity" &&
    str(body?.entityType) === "capture" &&
    decision.kind === "scopes" &&
    decision.call?.tool === "inbox-act"
  )
    return null;
  return {
    kind: "refused",
    reason: "owner-only",
    message:
      "That write is made directly, never proposed, so nothing was filed" +
      (decision.kind === "scopes" && decision.call?.tool === "inbox-act"
        ? ". Make it directly with `rhen inbox-act captured confirm <id> --type <type>` " +
          "(or `rhen inbox-act kept reopen <id>`)."
        : "; send it with its own command instead of through propose.")
  };
}

/** Proposing: the scopes are those of the proposal's own tool, plus (for entity kinds) the entity's propose-level scope. */
function proposalWrite(body: Body): RouteDecision {
  const scopes = ["propose:agent-change"];
  const kind = str(body?.kind);
  const payload = record(body?.payload);
  const commands: unknown[] =
    kind === "entity_command"
      ? [payload]
      : kind === "entity_command_batch" && Array.isArray(payload?.commands)
        ? payload.commands
        : [];
  for (const item of commands) {
    const refused = unproposable(item);
    if (refused !== null) return refused;
    const command = str(record(item)?.command);
    const commandBody = record(record(item)?.body);
    const entityType =
      command === "save_project" ? "project" : command === "save_action" ? "action" : str(commandBody?.entityType);
    const required = entityType === undefined ? undefined : entityScope(entityType);
    if (required === undefined)
      return {
        kind: "refused",
        reason: "unknown-entity",
        message: `A proposed command names an entity type agents cannot write. ${TYPES_HINT}`
      };
    const scope = downgradeScope(required);
    if (!scopes.includes(scope)) scopes.push(scope);
  }
  return { kind: "scopes", scopes, call: { tool: "propose" } };
}

const fixed = (call: WriteCall) => (): RouteDecision => scoped(call);

/**
 * Setting a recurring commitment (`{ rule }`). Two fields reach past the plan, so the floor reads the body: a
 * rule that shares with the family calendar publishes the occurrences to the calendar provider (it touches other people),
 * and a rule saved as `ended` ends the recurrence, the same removal `recurrence-goal` calls `end_*`.
 */
function recurrenceRuleWrite(body: Body, stored: StoredFacts): RouteDecision {
  const rule = record(body?.rule) ?? {};
  const removed = removedFieldMessage(rule);
  if (removed !== null) return { kind: "refused", reason: "removed-field", message: `commitment rule: ${removed}` };
  const ends = rule.status === "ended";
  return scoped(
    { tool: "recurrence", action: ends ? "end" : "set" },
    { touchesPeople: rule.shareToCalendar === true || stored.shared === true, existing: edits(body) }
  );
}

const DERIVED_OWNER_ONLY = (what: string): RouteDecision => ({
  kind: "refused",
  reason: "owner-only",
  message:
    `${what} is for the owner session; an agent token cannot write it, so nothing was changed. ` +
    `Labels are the person's own answers and count only from the owner session; the generic "correction" kind and any other derived kind are not open to tokens. ` +
    `A token with write:activity-derived may write source "derived" kinds fact and msg_class; a token with write:activity-event may write kinds override and fact_status. ` +
    `Do not retry this call. The person does it in the owner session (signed in to the portal or the app); tell the owner: "I cannot do this myself; please do it in the owner session."`
});

/**
 * The scope one activity row needs, or null when only the owner session may write it. A row that is not an object, or
 * has no text `source`, can never be stored (the handler rejects that row alone), so it asks only for the event scope.
 */
function activityEventScope(event: unknown): string | null {
  const row = record(event);
  const source = str(row?.source);
  if (row === undefined || source === undefined) return "write:activity-event";
  if (source === "derived-shadow") return "write:activity-derived";
  if (source !== "derived") return "write:activity-event";
  const kind = str(row.kind);
  if (kind === "fact" || kind === "msg_class") return "write:activity-derived";
  if (kind === "override" || kind === "fact_status") return "write:activity-event";
  return null;
}

/**
 * `POST /api/activity-events`: the scopes are the union over every row of the batch (or the shorthand event). Raw
 * sources need `write:activity-event`. Derived rows: `fact` and `msg_class` (and any `derived-shadow` row) need
 * `write:activity-derived`; `override` and `fact_status` need `write:activity-event`, so an extractor token cannot
 * outrank a person's confirmed status; `label` and every other derived kind (the generic `correction` included) are
 * the owner session's. A body or row that could never be stored needs only the event scope: the handler rejects it,
 * alone, with its own message. The shorthand test here is looser than the handler's (any body with a `source` and no
 * `events` list); the handler rejects the shapes that differ, so this can only over-demand.
 */
function activityEventsWrite(body: Body): RouteDecision {
  const events = body !== undefined && !Array.isArray(body.events) && "source" in body ? [body] : body?.events;
  if (!Array.isArray(events)) return { kind: "scopes", scopes: ["write:activity-event"] };
  const scopes = new Set<string>();
  for (const event of events) {
    const scope = activityEventScope(event);
    if (scope === null) return DERIVED_OWNER_ONLY("Writing this activity row");
    scopes.add(scope);
  }
  return { kind: "scopes", scopes: scopes.size === 0 ? ["write:activity-event"] : [...scopes] };
}

type Rule = (body: Body, stored: StoredFacts) => RouteDecision;

/**
 * A changeset carries commands for other routes, and the portal decides each of
 * them again, one by one, as its own route would: applied, filed as a proposal, or refused with that route's message.
 * The request itself needs only what every command could land with: its proposal scope when it may be filed as one,
 * else all its scopes. A command its route refuses adds nothing here; the portal answers that refusal for that command.
 */
function changesetWrite(body: Body): RouteDecision {
  const scopes: string[] = [];
  for (const raw of Array.isArray(body?.items) ? body.items : []) {
    const item = record(raw);
    const path = str(item?.path);
    const rule = path === undefined || path === "/api/commands/changeset" ? undefined : WRITE_RULES[`POST ${path}`];
    // The portal reads each command's stored facts when it decides it; the request itself needs no more scopes for them.
    const decision = rule?.(record(item?.payload), {});
    if (decision?.kind !== "scopes") continue;
    const needed = decision.downgradable ? [downgradeScope(decision.scopes[0] as string)] : decision.scopes;
    for (const scope of needed) if (!scopes.includes(scope)) scopes.push(scope);
  }
  // A replay carries no commands, but reads back a stored result, so it still needs the changeset tool's scope.
  if (scopes.length === 0) scopes.push("propose:entity");
  return { kind: "scopes", scopes };
}

/** Write routes agents may reach, keyed `METHOD route`. Everything else non-GET is in `OWNER_ROUTES` or unclassified. */
const WRITE_RULES: Record<string, Rule> = {
  "POST /api/commands/entity": entityWrite,
  "POST /api/commands/project": (body) => projectOrActionWrite(body, "project"),
  "POST /api/commands/action": (body) => projectOrActionWrite(body, "action"),
  // Keeping a project in the weekly review: an explicit confirmation, applied directly (never a proposal), with undo.
  // Deliberately its own `review` tool rather than the project trust level: an agent held to propose-only on
  // projects can still Keep one, because a Keep changes nothing in the plan but when the project next asks.
  "POST /api/commands/close": closeWrite,
  "POST /api/commands/project-review": fixed({ tool: "review" }),
  "POST /api/commands/session": fixed({ tool: "session" }),
  // Settles last night around when the person woke (`rhen wake`): finishes a running sleep, or completes last
  // night's planned sleep, or logs the night. Applied directly under the sleep log's scope, never a proposal.
  "POST /api/commands/wake": fixed({ tool: "wake" }),
  // The answer to a stretch offer `rhen_status` shows; the command itself holds an agent to the person's word.
  "POST /api/commands/stretch": fixed({ tool: "stretch" }),
  // The answer to a group of items to rank; the command holds an agent to the basis rules and a wrong group to the exact next call.
  "POST /api/commands/consequence": fixed({ tool: "rank" }),
  "POST /api/commands/activity": fixed({ tool: "activity" }),
  "POST /api/commands/check-in": fixed({ tool: "check-in" }),
  // Undo or redo of a session, check-in or catch-up write from its row snapshot; the `undo` tool's scope.
  "POST /api/commands/revert": fixed({ tool: "undo" }),
  // One message of facts: each command inside is decided by the portal as its own route would decide it.
  "POST /api/commands/changeset": changesetWrite,
  "POST /api/commands/cadence-completion": fixed({ tool: "cadence" }),
  "POST /api/commands/commitment-recurrence": recurrenceRuleWrite,
  // Splitting a source off a shared commitment changes what the family calendar shows.
  "POST /api/commands/commitment-source-split": (_body, stored) =>
    scoped({ tool: "recurrence", action: "split" }, { touchesPeople: stored.shared === true, existing: true }),
  "POST /api/commands/recurrence-goal": (body) =>
    str(body?.type)?.startsWith("end_")
      ? scoped({ tool: "recurrence", action: "end" }, { entityType: "action" })
      : scoped({ tool: "recurrence" }),
  "POST /api/commands/recalculate": fixed({ tool: "recalculate" }),
  ...Object.fromEntries(
    Object.entries(mergedRecord((extension) => extension.routes?.fixedWrites)).map(([key, call]) => [key, fixed(call)])
  ),
  "POST /api/commands/catch-up-settle": () => ({ kind: "scopes", scopes: ["propose:catch-up"] }),
  // Ending a lapsed pulse: direct, never a proposal.
  "POST /api/commands/reenter": () => ({ kind: "scopes", scopes: ["write:catch-up"] }),
  // Recording or ending a disruption: direct, never a proposal, undoable.
  "POST /api/commands/pulse-disruption": fixed({ tool: "disrupt" }),
  "POST /api/agent-proposals": proposalWrite,
  // Agent time ingest: its own narrow scope, never a proposal, nothing on the hard floor.
  "POST /api/agent-sessions": () => ({ kind: "scopes", scopes: ["write:agent-session"] }),
  // Activity store ingest: its own narrow scope, never a proposal, nothing on the hard floor.
  // Which scope a row needs depends on its source and kind (see activityEventsWrite).
  "POST /api/activity-events": (body) => activityEventsWrite(body),
  // An importer reports a finished file: capture scope, nothing on the hard floor, the body names no scope.
  "POST /api/activity-imports/runs": () => ({ kind: "scopes", scopes: ["write:activity-event"] }),
  "POST /api/imports/extract": fixed({ tool: "import", action: "extract" }),
  "POST /api/imports/preview": fixed({ tool: "import", action: "preview" }),
  "POST /api/imports/[id]/commit": fixed({ tool: "import", action: "commit" }),
  "POST /api/imports/[id]/commit-ready": fixed({ tool: "import", action: "commit" }),
  "PUT /api/imports/[id]": fixed({ tool: "import", action: "update" }),
  "DELETE /api/imports/[id]": fixed({ tool: "import", action: "delete" }),
  "POST /api/plan-map/links": fixed({ tool: "inbox-act", room: "map", action: "link" }),
  "POST /api/plan-map/links/[id]": fixed({ tool: "inbox-act", room: "map", action: "link" }),
  "POST /api/plan-map/links/bulk": fixed({ tool: "inbox-act", room: "map", action: "links-bulk" }),
  "POST /api/plan-map/findings/[id]": fixed({ tool: "inbox-act", room: "map", action: "finding" }),
  "POST /api/deliverables/[id]/chat": fixed({ tool: "deliverable", action: "chat" }),
  "POST /api/deliverables/[id]/handoff": fixed({ tool: "deliverable", action: "handoff" }),
  "POST /api/deliverables/[id]/sources": fixed({ tool: "deliverable", action: "sources" }),
  "POST /api/deliverables/[id]/workspace": fixed({ tool: "deliverable", action: "workspace" })
};

/**
 * Write routes that are never an agent's: confirming and resolving, token management, settings and switches,
 * and the surfaces of the person's devices, people, calendars and background jobs. Each says what it is.
 */
const OWNER_ROUTES: Record<string, string> = {
  ...mergedRecord((extension) => extension.routes?.ownerRoutes),
  "POST /api/agent-proposals/[id]/resolve": "Confirming or rejecting a proposal",
  "POST /api/agent-tokens": "Issuing an agent token",
  "POST /api/agent-changes/[id]/undo": "Undoing or redoing an agent change",
  "POST /api/owner/enroll": "Enrolling a browser",
  "POST /api/owner/signout": "Signing out",
  "POST /api/owner/credentials": "Issuing an owner token",
  "DELETE /api/owner/credentials/[id]": "Revoking an owner credential",
  "DELETE /api/agent-tokens/[id]": "Revoking an agent token",
  "PATCH /api/agent-tokens/[id]": "Changing what an agent token may write directly",
  "POST /api/connections/status": "Recording a connection check",
  "PUT /api/connections/[connectionId]/calendars": "Choosing calendars",
  "POST /api/connections/[connectionId]/sync": "Connection sync",
  "POST /api/connections/[connectionId]/publish": "Connection publishing",
  "POST /api/connections/[connectionId]/publish/remove": "Connection publishing",
  "POST /api/connections/[connectionId]/write-proof": "Connection write proof",
  "POST /api/connections/[connectionId]/import/preview": "Connection import",
  "POST /api/device/action": "A device action",
  // Watch history is the person's own viewing record, held where the engine cannot see it; no agent reads or writes it.
  "POST /api/imports/watch-history": "Importing a watch-history file",
  "DELETE /api/imports/watch-history/[id]": "Undoing a watch-history import",
  // The activity store's settings and deletions are the owner's: the content gate, retention, undoing an import, purging a source.
  "PUT /api/activity-sources/[source]": "Setting a source's content gate or retention",
  "DELETE /api/activity-sources/[source]/events": "Purging every event of a source",
  "DELETE /api/activity-imports/[id]": "Undoing an activity import",
  // Passwords and keys the person typed in: write-only, and never an agent's to set, list or remove. Nothing reads a value back.
  "PUT /api/settings/secrets/[name]": "Saving a password or key",
  "DELETE /api/settings/secrets/[name]": "Removing a password or key",
  // Where mail text is sent (a local model's LAN address, the hosted tier's caps, how far back to backfill): a data-flow
  // setting, so never an agent's to read or change. The hosted key is a saved key and is covered above.
  "PUT /api/derived-settings": "Setting where mail understanding runs, its models and caps",
  // Sends fixed synthetic text to the local or hosted model: reaches a LAN address and spends the hosted allowance.
  "POST /api/derived-settings/test": "Testing the mail-understanding models",
  "POST /api/review/watch-history/lengths": "Fetching video lengths with the saved YouTube key",
  "POST /api/integrations/pulse/tick": "The pulse job",
  "POST /api/integrations/push/drain": "The push queue",
  "POST /api/integrations/travel/tick": "The travel job",
  "POST /api/integrations/derived/tick": "The derived-rows job",
  "POST /api/location/observe": "A location report",
  "POST /api/offer-log/shown": "What the open Now page showed",
  "POST /api/location/ping": "A location ping",
  "DELETE /api/location/suggestion": "Dismissing a location suggestion",
  "POST /api/photo-checkins": "A photo check-in",
  "PATCH /api/photo-checkins/[id]": "Editing a photo check-in",
  "PUT /api/photo-checkins/mode": "The photo check-in switch",
  "POST /api/place-photos": "Place photos",
  "POST /api/plan-map/propose": "The plan-map proposers",
  "POST /api/plan-map/sweep": "The plan-map sweep",
  "PUT /api/plan-map/switches": "Plan-map switches",
  "DELETE /api/push/subscriptions/[id]": "Removing a push subscription",
  "POST /api/push/subscriptions": "Registering a push subscription",
  "DELETE /api/push/subscriptions": "Removing push subscriptions",
  "POST /api/push/test": "A test push",
  "POST /api/snapshots/[id]/review": "Reviewing an issue report",
  "POST /api/snapshots": "Reporting an issue",
  "PUT /api/state": "Replacing the whole state",
  "POST /api/travel/geocode": "Geocoding",
  "POST /api/travel/refresh": "A travel refresh"
};

/**
 * Routes outside `/api` that authenticate themselves, with an audience-bound access token or the agent token as
 * `client_secret`. An agent token sent in `X-OpenRhen-Token` to
 * one of these is refused, so the long-lived secret has exactly one door.
 */
const SELF_AUTHENTICATED: Record<string, string> = {
  "POST /mcp": "The remote MCP endpoint takes only an access token from /oauth/token",
  "POST /oauth/token": "The token endpoint takes the agent token as client_secret, not as a header",
  "POST /oauth/register": "Client registration grants nothing; an agent token is no use here",
  "POST /oauth/authorize": "The consent page is for the owner's browser, not an agent"
};

const READ_RULES: Record<string, string | "public"> = {
  ...mergedRecord((extension) => extension.routes?.readRules),
  // OAuth discovery documents (RFC 9728, RFC 8414): public by design, they name this server and nothing secret.
  "/.well-known/oauth-protected-resource": "public",
  "/.well-known/oauth-protected-resource/mcp": "public",
  "/.well-known/oauth-authorization-server": "public",
  "/api/state": "read:plan",
  "/api/check-ins/current": "read:plan",
  "/api/check-ins/summary": "read:plan",
  "/api/check-ins/trail": "read:plan",
  "/api/commitments/matches": "read:plan",
  "/api/events": "read:plan",
  "/api/planning/changes": "read:plan",
  "/api/planning/status": "read:plan",
  "/api/plan/search": "read:plan",
  "/api/review/area-time": "read:plan",
  "/api/sleep-log": "read:plan",
  "/api/travel/budget": "read:plan",
  "/api/device/now": "read:plan",
  "/api/pulse/preview": "read:plan",
  "/api/plan-map": "read:plan",
  "/api/plan-map/nudge": "read:plan",
  "/api/plan-map/reviewer": "read:plan",
  "/api/imports": "read:plan",
  "/api/imports/[id]": "read:plan",
  "/api/imports/reference-pack-guide": "read:plan",
  "/api/imports/reference-pack": "read:plan",
  "/api/imports/reference-pack.zip": "read:plan",
  "/api/imports/template.xlsx": "read:plan",
  "/api/imports/templates.zip": "read:plan",
  "/api/imports/templates/[entity]": "read:plan",
  "/api/integrations/calendar-sync/review-count": "read:plan",
  "/api/catch-up": "read:plan",
  "/api/doctor": "read:plan",
  "/api/attention": "read:plan",
  "/api/consequence/next": "read:plan",
  "/api/pulse/reentry": "read:plan",
  // The same read for a token that can only re-enter (the call it may make while every other is held) or only
  // propose (see `READ_ANY_OF`).
  "/api/commands/reenter": "write:catch-up",
  "/api/changes": "read:changes",
  // The activity store read-back exposes content over a token, so it has its own scope. The import check is the
  // capture token's own question (is this file already held), so it takes the capture scope, not the read one.
  "/api/activity-events": "read:activity-event",
  "/api/activity-imports": "write:activity-event",
  "/api/agent-proposals": "read:proposals",
  "/api/deliverable-source-files/[id]": "read:files",
  "/api/deliverables/[id]/chat": "read:files",
  "/api/deliverables/[id]/pack": "read:files",
  "/api/photo-checkins": "read:files",
  "/api/photo-checkins/[id]": "read:files",
  "/api/photo-checkins/[id]/photo": "read:files",
  "/api/place-photos": "read:files",
  "/api/health/database": "public",
  "/api/health/engine": "public",
  "/api/cli/version": "public",
  "/api/cli/bundle": "public"
};

/**
 * Reads that any one of several scopes opens. The re-entry questions (places, contexts, energies,
 * tier, items to review) are what a propose-only agent must see to ask the owner while the pulse is lapsed; the same data
 * is already readable under `read:plan` at `/api/pulse/reentry`. Answering stays `write:catch-up` (`WRITE_RULES`).
 */
const READ_ANY_OF: Record<string, string[]> = {
  "/api/commands/reenter": ["read:plan", "write:catch-up", "propose:catch-up"]
};

/** Reads that are the owner's: configuration, credentials' metadata, diagnostics and sync status. */
const OWNER_READS = new Set([
  ...mergedList((extension) => extension.routes?.ownerReads),
  "/oauth/authorize",
  "/api/agent-tokens",
  "/api/agent-sessions",
  "/api/activity-events/summary",
  "/api/agent-changes",
  "/api/agent-changes/[id]",
  "/api/review/watch-history",
  "/api/settings/secrets",
  "/api/derived-settings",
  "/api/closed",
  "/api/closed/summary",
  "/api/owner/credentials",
  "/api/owner/session",
  "/api/connections/status",
  "/api/connections/[connectionId]/calendars",
  "/api/connections/[connectionId]/proof",
  "/api/connections/[connectionId]/publish",
  "/api/connections/[connectionId]/sync",
  "/api/photo-checkins/mode",
  "/api/push/config",
  "/api/push/subscriptions",
  "/api/pulse/config",
  "/api/snapshots",
  "/api/snapshots/[id]"
]);

/**
 * Routes a drop-in (a push transport, a connection) owns. The drop-in registers them when it loads, so this file
 * names none of them and the classification tests in the portal still see them. Each field is the registered
 * form of the table of the same name above.
 */
export interface AgentRouteExtension {
  /** `METHOD route` to what the owner-only route is, as `OWNER_ROUTES`. */
  ownerRoutes?: Record<string, string>;
  /** The `METHOD route` keys among those that are jobs or device reports (`OWNER_RUNS_ITSELF`). */
  ownerRunsItself?: readonly string[];
  /** Owner-only `GET` routes (`OWNER_READS`). */
  ownerReads?: readonly string[];
  /** `METHOD route` to why it needs no owner credential (`OWNER_AUTH_EXEMPT`). */
  ownerAuthExempt?: Record<string, string>;
}

/** Adds a drop-in's routes to the tables. Returns a function that takes them out again (tests). */
export function registerAgentRoutes(extension: AgentRouteExtension): () => void {
  const added = {
    ownerRoutes: Object.keys(extension.ownerRoutes ?? {}),
    ownerRunsItself: [...(extension.ownerRunsItself ?? [])],
    ownerReads: [...(extension.ownerReads ?? [])],
    ownerAuthExempt: Object.keys(extension.ownerAuthExempt ?? {})
  };
  Object.assign(OWNER_ROUTES, extension.ownerRoutes);
  for (const key of added.ownerRunsItself) OWNER_RUNS_ITSELF.add(key);
  for (const route of added.ownerReads) OWNER_READS.add(route);
  Object.assign(OWNER_AUTH_EXEMPT, extension.ownerAuthExempt);
  return () => {
    for (const key of added.ownerRoutes) delete OWNER_ROUTES[key];
    for (const key of added.ownerRunsItself) OWNER_RUNS_ITSELF.delete(key);
    for (const route of added.ownerReads) OWNER_READS.delete(route);
    for (const key of added.ownerAuthExempt) delete OWNER_AUTH_EXEMPT[key];
  };
}

/** Whether the decision for this write depends on the request body, so the caller knows to read it. */
export function routeNeedsBody(method: string, route: string): boolean {
  return BODY_ROUTES.has(`${method.toUpperCase()} ${route}`);
}

const BODY_ROUTES = new Set([
  "POST /api/commands/changeset",
  "POST /api/commands/entity",
  "POST /api/commands/project",
  "POST /api/commands/action",
  "POST /api/commands/commitment-recurrence",
  "POST /api/commands/recurrence-goal",
  "POST /api/agent-proposals",
  "POST /api/commands/close",
  // The scope follows the source and kind of each row.
  "POST /api/activity-events"
]);

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * What a token agent's request needs. `body` is the parsed JSON body for a write (undefined when absent or
 * unreadable). Never throws; a request this map cannot place comes back `refused`.
 */
export function scopesForRoute(method: string, route: string, body?: unknown, stored: StoredFacts = {}): RouteDecision {
  const verb = method.toUpperCase();
  if (READ_METHODS.has(verb)) {
    if (verb === "OPTIONS") return { kind: "public" };
    if (OWNER_READS.has(route)) return OWNER(`Reading ${route}`);
    const rule = READ_RULES[route];
    if (rule === undefined) return unclassified(verb, route);
    const anyOf = READ_ANY_OF[route];
    if (rule === "public") return { kind: "public" };
    return anyOf === undefined ? { kind: "scopes", scopes: [rule] } : { kind: "scopes", scopes: [rule], anyOf };
  }
  const key = `${verb} ${route}`;
  const selfAuthenticated = SELF_AUTHENTICATED[key];
  if (selfAuthenticated !== undefined)
    return {
      kind: "refused",
      reason: "self-authenticated",
      message: `${selfAuthenticated}; do not send an agent token in X-OpenRhen-Token.`
    };
  const ownerOnly = OWNER_ROUTES[key];
  if (ownerOnly !== undefined)
    return OWNER_RUNS_ITSELF.has(key) ? RUNS_ITSELF(ownerOnly) : OWNER(ownerOnly, OWNER_WHERE[key]);
  const rule = WRITE_RULES[key];
  return rule === undefined ? unclassified(verb, route) : rule(record(body), stored);
}

function unclassified(verb: string, route: string): RouteDecision {
  return {
    kind: "refused",
    reason: "unclassified",
    message: `${verb} ${route} is not available to agent tokens. Find what you may call with \`rhen search\` or \`rhen list\`, or ask the owner to do it.`
  };
}

/** Every `METHOD route` the table classifies, for the portal test that walks the route files. */
export function classifiedRoutes(): string[] {
  return [
    ...Object.keys(WRITE_RULES),
    ...Object.keys(OWNER_ROUTES),
    ...Object.keys(SELF_AUTHENTICATED),
    ...Object.keys(READ_RULES).map((route) => `GET ${route}`),
    ...[...OWNER_READS].map((route) => `GET ${route}`)
  ];
}

/**
 * Routes that stay open to a caller with no owner credential even when owner auth is `require`, and why. Each
 * checks its own secret. This is the honest limit of `require`: a LAN caller can still reach these, so none of
 * them may ever write owner data an owner credential should guard. (The handheld and the worker have tokens of
 * their own: `DEVICE_ROUTES`, `WORKER_ROUTES`.)
 */
const OWNER_AUTH_EXEMPT: Record<string, string> = {
  "POST /api/owner/enroll": "checks its own secret",
  "GET /api/owner/session": "says whether the caller is signed in",
  "POST /api/location/ping": "its own bearer token",
  "POST /mcp": "checks its own audience-bound access token",
  "POST /oauth/token": "checks its own client secret, authorization code or refresh token",
  "POST /oauth/register": "registers a public client; it grants nothing until the owner approves",
  "GET /oauth/authorize": "checks the owner credential itself, and shows sign-in without one",
  "POST /oauth/authorize": "checks the owner credential and Origin itself"
};
/**
 * Routes only the worker calls, on the internal network. Under `require` they take a worker token
 * (`X-OpenRhen-Worker`) or an owner credential; they are not in `OWNER_AUTH_EXEMPT`. A worker token is
 * accepted nowhere else.
 */
const WORKER_ROUTES = new Set<string>();
for (const route of mergedList((extension) => extension.routes?.workerRoutes))
  for (const verb of ["GET", "POST"]) WORKER_ROUTES.add(`${verb} ${route}`);
for (const route of ["/api/connections/[connectionId]/sync", "/api/connections/[connectionId]/publish"])
  for (const verb of ["GET", "POST"]) WORKER_ROUTES.add(`${verb} ${route}`);
for (const route of [
  "/api/integrations/travel/tick",
  "/api/integrations/derived/tick",
  "/api/integrations/pulse/tick",
  "/api/integrations/push/drain",
  "/api/plan-map/sweep"
])
  WORKER_ROUTES.add(`POST ${route}`);

/** Whether the worker may call this route with a worker token. */
export function workerRoute(method: string, route: string): boolean {
  return WORKER_ROUTES.has(`${method.toUpperCase()} ${route}`);
}

/** Every worker `METHOD route`, for the tests that keep the list honest. */
export function workerRoutes(): string[] {
  return [...WORKER_ROUTES];
}

/**
 * Routes only the ESP32 handheld calls. Under `require` they take a device
 * token (`X-OpenRhen-Device`) or an owner credential; they are not in `OWNER_AUTH_EXEMPT`. A device token is
 * accepted nowhere else, and a worker token is not accepted here.
 */
const DEVICE_ROUTES = new Set<string>(["GET /api/device/now", "POST /api/device/action"]);

/** Whether the handheld may call this route with a device token. */
export function deviceRoute(method: string, route: string): boolean {
  return DEVICE_ROUTES.has(`${method.toUpperCase()} ${route}`);
}

/** Every device `METHOD route`, for the tests that keep the list honest. */
export function deviceRoutes(): string[] {
  return [...DEVICE_ROUTES];
}

/** Why this route needs no owner credential under `require`, or undefined when it does. */
export function ownerAuthExemption(method: string, route: string): string | undefined {
  return OWNER_AUTH_EXEMPT[`${method.toUpperCase()} ${route}`];
}

/** Every exempt `METHOD route`, for the test that keeps the list honest. */
export function ownerAuthExemptRoutes(): string[] {
  return [...Object.keys(OWNER_AUTH_EXEMPT), ...WORKER_ROUTES, ...DEVICE_ROUTES];
}
