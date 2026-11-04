import {
  AGENT_PROPOSAL_SUMMARY_MAX,
  closeEntityPayloadSchema,
  isClosedStatus,
  closeTarget,
  directWriteMode,
  downgradeScope,
  entityScope,
  hardFloorInstead,
  hardFloorReason,
  primarySourceLabel,
  routeNeedsBody,
  scopeCovers,
  scopesForRoute,
  placeNameTarget,
  sharingTarget,
  type AgentProposal,
  type ProposeAgentChange,
  type RouteDecision,
  type StoredFacts
} from "@openrhen/contracts";
import { envPlaceNames, normalisePlaceName } from "./private/env-named-places";
import "./drop-ins";
import { newTokenFor } from "./agent-token-recipe";
import type { AgentPrincipal } from "./agent-tokens";
import type { WriteClaim } from "./agent-actor";
import { companionCleared, omittedStoredFields, recordInState } from "@/shared/record-in-state";
import { PROPOSALS_UNAVAILABLE, proposalErrorResponse } from "./agent-proposals/errors";
import type { Sql } from "./persistence/postgres/sql-pool";

/**
 * Scope enforcement for database tokens, run by `withRoute` after
 * the token is recognised. Only a token agent comes here: a header-only name and an anonymous caller are
 * unchanged, and an environment token keeps its route list. Default deny: a route the contracts map does not
 * place is refused, so a new route is closed to agents until someone classifies it.
 */

type Scoped = Extract<RouteDecision, { kind: "scopes" }>;

export type WriteOutcome =
  | { action: "apply" }
  | { action: "propose"; reason: string; shadow: boolean }
  | { action: "deny"; missing: string[]; floor?: string };

const holds = (held: readonly string[], required: string) => held.some((scope) => scopeCovers(scope, required));

/** Where the person turns "Writes apply directly" on for a token; scopes are fixed when a token is issued. */
const TOKEN_SETTINGS = "Settings > Add-ons and sign-in";
/** How the person gives an agent scopes it lacks: a new token, since the Settings page cannot change one's scopes. */
const NEW_TOKEN = "`rhen agent-token create --name <agent> --scopes <scopes>`";

/**
 * What a write needs and what the token allows. Pure: the matrix of scopes, hard floor and
 * `directWrites` lives here. A write on the three save routes applies when the token holds the `write:` scope and
 * `directWrites` is `on` for the entity class, whatever its basis (stated, inferred, observed or missing): the
 * person undoes a change they dislike afterwards instead of confirming it first, and the basis still goes to the
 * change log. Otherwise (shadow, off, a `propose:` scope, the hard floor) it becomes a proposal; any other route
 * either applies or is denied.
 */
export function decideWrite(decision: Scoped, principal: AgentPrincipal): WriteOutcome {
  const held = principal.scopes ?? [];
  const floor = decision.floor ? hardFloorReason(decision.floor) : null;
  if (!decision.downgradable) {
    const missing = decision.scopes.filter((scope) => !holds(held, scope));
    if (missing.length > 0) return { action: "deny", missing };
    return floor === null ? { action: "apply" } : { action: "deny", missing: [], floor };
  }
  const required = decision.scopes[0] as string;
  const mayPropose = holds(held, required) || holds(held, downgradeScope(required));
  if (!mayPropose) return { action: "deny", missing: [required] };
  if (floor !== null) return { action: "propose", reason: floor, shadow: false };
  // A close the stored rows say the owner must decide (or that could not be read) is one proposal whatever the token holds.
  if (decision.mustPropose !== undefined) return { action: "propose", reason: decision.mustPropose, shadow: false };
  // A `propose:` scope in the table (a capture) is already a reviewable item: it is written as asked.
  if (required.startsWith("propose:")) return { action: "apply" };
  const what = (decision.entityClass ?? "this kind of record").replace(/_/g, " ");
  if (!holds(held, required))
    return {
      action: "propose",
      reason: `this token may only propose changes to ${what}; the person can issue a token that writes them directly: ${NEW_TOKEN}`,
      shadow: false
    };
  // A close reaches other types (children, a commitment's steps and prep): the token needs a direct write for each,
  // else the whole call is one proposal rather than a partial apply (plan D10).
  for (const type of decision.closeTypes ?? []) {
    if (type === decision.entityClass) continue;
    const need = entityScope(type);
    const reach = type.replace(/_/g, " ");
    if (need === undefined || !holds(held, need))
      return {
        action: "propose",
        reason: `closing this also changes ${reach} records, and this token may not write ${reach} directly, so the whole call waits for the person`,
        shadow: false
      };
    const reachMode = directWriteMode(principal.directWrites, type);
    if (reachMode !== "on")
      return {
        action: "propose",
        reason: `closing this also changes ${reach} records, and direct writes are ${reachMode === "shadow" ? "in shadow" : "off"} for them, so the whole call waits for the person`,
        shadow: reachMode === "shadow"
      };
  }
  const mode = directWriteMode(principal.directWrites, decision.entityClass ?? "");
  if (mode === "on") return { action: "apply" };
  return {
    action: "propose",
    reason:
      `direct writes are ${mode === "shadow" ? "in shadow for" : "off for"} ${what}, so it waits for the person; ` +
      `they can turn on "Writes apply directly" for this token in ${TOKEN_SETTINGS}`,
    shadow: mode === "shadow"
  };
}

const challenge = (scopes: string[]) => `Bearer error="insufficient_scope", scope="${scopes.join(" ")}"`;

/** A 403 for a missing scope: the body names what is missing, the challenge lists every scope the operation needs. */
function insufficientScope(required: string[], missing: string[], held: readonly string[] = []): Response {
  const lacks = missing.join(", ");
  return Response.json(
    {
      error:
        `This token lacks the scope ${lacks}, so nothing was done; it holds ${held.length > 0 ? held.join(", ") : "no scopes"}. ` +
        `Do not retry this call: it cannot succeed with this token. Tell the owner: "This agent needs the ${lacks} scope; ` +
        `please issue it a new token that has it (in a terminal: ${newTokenFor([...held, ...missing])}), or reconnect ` +
        `the OAuth client to approve it again."`,
      requiredScopes: required,
      missingScopes: missing
    },
    { status: 403, headers: { "www-authenticate": challenge(required) } }
  );
}

const forbidden = (error: string, suggestedPath?: string | null) =>
  Response.json({ error, ...(suggestedPath ? { suggestedPath } : {}) }, { status: 403 });

const label = (entity: Record<string, unknown> | undefined): string | undefined => {
  for (const key of ["title", "name", "text", "label"]) {
    const value = entity?.[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim().replace(/\s+/g, " ").slice(0, 80);
  }
  return undefined;
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/** The entity kind a save command writes and the record it carries. */
function savedEntity(command: string, body: Record<string, unknown>) {
  const kind = command === "save_project" ? "project" : command === "save_action" ? "action" : String(body.entityType);
  const entity = asRecord(command === "save_entity" ? body.entity : body[kind]);
  return { kind, entity };
}

/** Fields that name or version a record; they are never a change. */
const NOT_A_CHANGE = new Set(["id", "version", "commandId"]);
/** Changes named in a summary before "and N more". */
const SUMMARY_CHANGES = 5;
const SUMMARY_VALUE_MAX = 40;

/** A commitment's sharing flag still reads as before on screen (migration 0133 renamed the field). */
const words = (key: string) =>
  (key === "shareToCalendar" ? "share with family" : undefined) ??
  key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .toLowerCase();

/** The portal's names for the settings fields an agent can still only propose; any other field reads as its key in words. */
const SETTINGS_LABELS: Record<string, string> = {
  setupCompleted: "setup completed",
  calendarShareEnabled: "share with family calendar",
  sharePrimaryEvents: `share ${primarySourceLabel()} shifts`,
  pulsePublishEnabled: "Pulse publishing",
  deliverableChatModel: "deliverable workspace chat model",
  importExtractorModel: "import extraction model"
};

const fieldName = (kind: string, key: string) => (kind === "settings" ? SETTINGS_LABELS[key] : undefined) ?? words(key);

const shown = (value: unknown): string => {
  if (value === undefined || value === null || value === "") return "none";
  const text = (typeof value === "object" ? JSON.stringify(value) : String(value)).replace(/\s+/g, " ").trim();
  if (text.length <= SUMMARY_VALUE_MAX) return text;
  return Array.isArray(value) ? `${value.length} items` : `${text.slice(0, SUMMARY_VALUE_MAX - 1)}…`;
};

const sorted = (_key: string, value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
    : value;

/** An action's requirement pathways are read as `{ id, contextIds }` and written as the context ids alone; the write accepts both. */
const pathwaysAsWritten = (value: unknown): unknown =>
  Array.isArray(value) ? value.map((pathway) => asRecord(pathway)?.contextIds ?? pathway) : value;

/** Equal as stored: the same instant in another notation, or the same object with its keys in another order, is no change. */
function sameValue(key: string, a: unknown, b: unknown): boolean {
  if (key === "requirementPathways") return sameValue("", pathwaysAsWritten(a), pathwaysAsWritten(b));
  const instant = (value: unknown) =>
    typeof value === "string" && /^\d{4}-\d\d-\d\dT/.test(value) ? Date.parse(value) : NaN;
  if (!Number.isNaN(instant(a)) && !Number.isNaN(instant(b))) return instant(a) === instant(b);
  return JSON.stringify(a ?? null, sorted) === JSON.stringify(b ?? null, sorted);
}

interface Difference {
  path: string[];
  before: unknown;
  after: unknown;
}

/** Where two values differ: objects are walked key by key, so a changed `recurrence.endDate` is named, not the whole `recurrence`. */
function differences(before: unknown, after: unknown, path: string[]): Difference[] {
  const was = asRecord(before);
  const now = asRecord(after);
  if (was && now)
    return [...new Set([...Object.keys(was), ...Object.keys(now)])].flatMap((key) =>
      differences(was[key], now[key], [...path, key])
    );
  return sameValue(path[0] ?? "", before, after) ? [] : [{ path, before, after }];
}

/** `head: a; b; and N more`, with as many changes as fit within the summary limit (at most `SUMMARY_CHANGES`). */
function listChanges(head: string, changes: readonly string[]): string {
  let text = head;
  for (let named = Math.min(changes.length, SUMMARY_CHANGES); named > 0; named--) {
    const more = changes.length > named ? `; and ${changes.length - named} more` : "";
    text = `${head}: ${changes.slice(0, named).join("; ")}${more}`;
    if (text.length <= AGENT_PROPOSAL_SUMMARY_MAX) break;
  }
  return text;
}

const capped = (text: string) =>
  text.length > AGENT_PROPOSAL_SUMMARY_MAX ? `${text.slice(0, AGENT_PROPOSAL_SUMMARY_MAX - 1)}…` : text;

/** `head: a; b; and N more` within the summary limit, for a proposal of several writes (a batch). */
export function summaryList(head: string, items: readonly string[]): string {
  return capped(items.length ? listChanges(head, items) : head);
}

/**
 * One line for the Inbox, at most 300 characters, built from the command and never from free-form claims. A
 * create names the record; a removal says so; an update lists the fields that change, as `field before → after`
 * when the stored record (`current`) is known and as `field set to after` when it is not.
 */
export function proposalSummary(
  command: string,
  body: Record<string, unknown>,
  current?: Record<string, unknown>
): string {
  const { kind, entity } = savedEntity(command, body);
  const created = body.expectedVersion === null || body.expectedVersion === undefined;
  const name = label(current) ?? label(entity);
  const subject = `${kind.replace(/_/g, " ")}${name ? ` "${name}"` : ""}`;
  let text: string;
  // A restore puts a replaced capture back in review and keeps its stored fields; the rest of the request is ignored.
  if (command === "save_entity" && kind === "capture" && entity?.restore === true)
    text = `Restore ${subject}: status → pending (other fields kept)`;
  else if (created) text = `Create ${subject}`;
  // Only a span or a logged night is removed by `remove`; every other save drops the flag and updates.
  else if (command === "save_entity" && (kind === "span" || kind === "sleep_log_entry") && entity?.remove === true)
    text = `Remove ${subject}${name || typeof entity.id !== "string" ? "" : ` ${entity.id}`}`;
  else {
    const named = Object.entries(entity ?? {}).filter(([key]) => !NOT_A_CHANGE.has(key));
    const changes =
      current === undefined
        ? named.map(([key, value]) => `${fieldName(kind, key)} set to ${shown(value)}`)
        : named
            // A field the save clears because of another one is listed with the cleared fields below.
            .filter(([key]) => !companionCleared(kind, current, entity ?? {}).includes(key))
            .flatMap(([key, value]) => differences(current[key], value, [key]))
            .map(({ path, before, after }) => {
              const field = [fieldName(kind, path[0] as string), ...path.slice(1)].join(".");
              const [was, now] = [shown(before), shown(after)];
              // Two long values that read alike once cut short are not worth printing twice.
              return was === now ? `${field} changed` : `${field} ${was} → ${now}`;
            })
            // A save restates the whole record: a stored field the request leaves out is cleared or reset.
            .concat(
              omittedStoredFields(kind, current, entity ?? {}).map(
                ({ key, becomes }) =>
                  `${fieldName(kind, key)} ${shown(current[key])} → ${becomes === null ? "none" : shown(becomes)}`
              )
            );
    text = changes.length ? listChanges(`Update ${subject}`, changes) : `Update ${subject} (no field changes)`;
  }
  return capped(text);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The `entity_command` proposal for a downgraded save. The body is stored exactly as sent, so confirming replays it. */
export function entityProposal(
  command: "save_entity" | "save_project" | "save_action",
  body: Record<string, unknown>,
  claim: WriteClaim,
  shadow: boolean,
  current?: Record<string, unknown>
): ProposeAgentChange & { shadow?: boolean } {
  const { kind, entity } = savedEntity(command, body);
  const id = entity?.id;
  const commandId = typeof body.commandId === "string" && UUID.test(body.commandId) ? body.commandId : undefined;
  return {
    kind: "entity_command",
    summary: proposalSummary(command, body, current),
    payload: { command, body },
    basis: claim.basis ?? "inferred",
    ...(claim.evidence ? { evidence: claim.evidence } : {}),
    ...(typeof id === "string" ? { coalesceKey: `${kind}:${id}`.slice(0, 200) } : {}),
    ...(commandId ? { commandId } : {}),
    ...(shadow ? { shadow: true } : {})
  };
}

export interface EnforceDeps {
  /** Files the proposal; the default uses the portal database. */
  propose?: (agent: string, input: ProposeAgentChange & { shadow?: boolean }) => Promise<{ proposal: AgentProposal }>;
  /** The stored record an update would change, so its summary can say before and after; the default reads the portal database. */
  current?: (kind: string, id: unknown, sent?: Record<string, unknown>) => Promise<Record<string, unknown> | undefined>;
  /** What the stored record says that the body cannot (`readStoredFacts`); the default reads the portal database. */
  stored?: (method: string, route: string, body: unknown, agent?: string) => Promise<StoredFacts>;
}

/**
 * The stored facts a write's floor needs from the database, not the body: whether the commitment or recurrence rule
 * it changes is on the family calendar now. A body that leaves `shareToCalendar` out keeps that flag, so the floor
 * cannot take the client's word for it. Read the same way the handler maps ids. One the portal cannot read counts
 * as shared, so a doubt files the write for the person rather than letting it through.
 */
export async function readStoredFacts(
  sql: Sql,
  method: string,
  route: string,
  body: unknown,
  env: Record<string, string | undefined> = process.env,
  agent?: string
): Promise<StoredFacts> {
  const closing = closeTarget(method, route, body);
  if (closing !== undefined) return readCloseFacts(sql, body, closing, agent);
  const placeFacts = await readPlaceFacts(sql, method, route, body, env);
  const target = sharingTarget(method, route, body);
  if (target === undefined) return placeFacts;
  try {
    const { stableUuid } = await import("./persistence/postgres/command-values");
    const users = await sql<{ id: string }[]>`SELECT id FROM users ORDER BY created_at LIMIT 1`;
    const userId = users[0]?.id;
    if (userId === undefined) return placeFacts;
    // A source split names the stored commitment id itself; a save maps the id it was given.
    const commitmentId =
      route === "/api/commands/commitment-source-split"
        ? target.id
        : await stableUuid(`commitment:${userId}`, target.id);
    const rows =
      target.kind === "commitment"
        ? await sql<{ shared: boolean }[]>`
            SELECT share_to_calendar AS shared FROM commitments
            WHERE id=${commitmentId} AND user_id=${userId}`
        : await sql<{ shared: boolean }[]>`
            SELECT share_to_calendar AS shared FROM commitment_recurrence_rules
            WHERE id=${await stableUuid(`commitment-recurrence:${userId}`, target.id)} AND user_id=${userId}`;
    return { ...placeFacts, shared: rows[0]?.shared === true };
  } catch {
    return { ...placeFacts, shared: true };
  }
}

/**
 * What a close or restore touches and who closed the row, read from the stored rows with the same preview the handler
 * plans from. A row that is not there reads as an ordinary call (the handler then refuses with the list that names the
 * real ids); a read that fails reads as the owner's call, so a doubt files the close for the person.
 */
export async function readCloseFacts(
  sql: Sql,
  body: unknown,
  target: NonNullable<ReturnType<typeof closeTarget>>,
  agent: string | undefined
): Promise<StoredFacts> {
  try {
    const [
      { previewClose, storedIdFor },
      { closedInWindow },
      { cascadeIsOwnCreate, verifyUndoOfCreate },
      { ensureUser }
    ] = await Promise.all([
      import("./persistence/postgres/close-commands"),
      import("./persistence/postgres/close-budget"),
      import("./persistence/postgres/close-undo"),
      import("./persistence/postgres/ensure-user")
    ]);
    const fields = asRecord(body) ?? {};
    const preview = await previewClose(sql, {
      type: target.type,
      id: target.id,
      verb: target.verb,
      do: target.do,
      ...(typeof fields.expectedVersion === "number" ? { expectedVersion: fields.expectedVersion } : {}),
      ...(typeof fields.reason === "string" ? { reason: fields.reason } : {}),
      ...(fields.includeChildren === true ? { includeChildren: true } : {})
    } as never);
    const userId = await ensureUser(sql);
    // A retry of a call that already landed is answered from its receipt by the handler: not asked of the budget again.
    const commandId =
      typeof fields.commandId === "string" && UUID.test(fields.commandId) ? fields.commandId : undefined;
    const landed =
      commandId !== undefined &&
      (
        await sql`SELECT 1 FROM writes WHERE id=${commandId} AND user_id=${userId} AND command_type='close_entity' LIMIT 1`
      ).length > 0;
    // An undo of the agent's own create is exempt from the brake; the same ledger test the handler makes.
    const undoId =
      typeof fields.undoOfCommandId === "string" && UUID.test(fields.undoOfCommandId)
        ? fields.undoOfCommandId
        : undefined;
    const undoOfCreate =
      undoId !== undefined &&
      target.do === "close" &&
      typeof fields.expectedVersion === "number" &&
      fields.expectedVersion === preview.version &&
      (await verifyUndoOfCreate(
        sql,
        userId,
        target.type,
        await storedIdFor(target.type as never, userId, target.id),
        undoId,
        preview.version,
        agent ?? null
      )) &&
      // and what the close takes with it is the agent's own create too (the handler makes the same test)
      (await cascadeIsOwnCreate(sql, userId, preview.children, agent ?? null));
    const { used } = await closedInWindow(sql, userId);
    return {
      closedInHour: used,
      closeCommandLanded: landed,
      undoOfCreate,
      closeTypes: preview.closeTypes,
      needsOwner: preview.needsOwner,
      shared: preview.shared,
      rowCount: preview.rowCount,
      // Only the agent's own direct close is the agent's to undo; the owner's, another agent's, an import's and a
      // confirmed one (`agent:<name>:confirmed`) are not.
      // A row that is missing or not closed has nothing to restore: that is the handler's refusal (with the exact next
      // call), not a question for the owner, so it is let through.
      restorableByAgent:
        !preview.found ||
        !isClosedStatus(preview.status) ||
        (agent !== undefined && (preview.closedBy === `agent:${agent}` || preview.closedBy === `agent:${agent}:undo`)),
      ...(preview.version === null ? {} : { closeVersion: preview.version }),
      closeChildren: preview.children.map((child) => ({ type: child.type, id: child.id, version: child.version }))
    };
  } catch {
    return { needsOwner: true, shared: true };
  }
}

/**
 * True when `name` is a place the roster connection labels shifts with, compared ignoring case and spacing. False for
 * every name while the environment names none, so the floor exists only while that path runs.
 */
export function namesEnvPlace(name: string | undefined, env: Record<string, string | undefined>): boolean {
  if (name === undefined) return false;
  return envPlaceNames(env).includes(normalisePlaceName(name));
}

/**
 * Whether a place save creates, renames to, or renames away from an environment-named place. A place the portal
 * cannot read counts as one, so a doubt files the save for the person.
 */
async function readPlaceFacts(
  sql: Sql,
  method: string,
  route: string,
  body: unknown,
  env: Record<string, string | undefined>
): Promise<StoredFacts> {
  const target = placeNameTarget(method, route, body);
  if (target === undefined || envPlaceNames(env).length === 0) return {};
  if (namesEnvPlace(target.name, env)) return { envNamedPlace: true };
  if (target.id === undefined) return {};
  try {
    const rows = await sql<{ name: string; kind: string }[]>`
      SELECT name, kind FROM condition_definitions WHERE id=${target.id} LIMIT 1`;
    return rows[0]?.kind === "location" && namesEnvPlace(rows[0].name, env) ? { envNamedPlace: true } : {};
  } catch {
    return { envNamedPlace: true };
  }
}

/** `readStoredFacts` against the portal database; with none, nothing is stored to read. */
async function defaultStored(method: string, route: string, body: unknown, agent?: string): Promise<StoredFacts> {
  const needsRead =
    sharingTarget(method, route, body) !== undefined ||
    placeNameTarget(method, route, body) !== undefined ||
    closeTarget(method, route, body) !== undefined;
  if (!needsRead) return {};
  try {
    const [{ databaseUrl }, { sqlPool }] = await Promise.all([
      import("./runtime-env"),
      import("./persistence/postgres/sql-pool")
    ]);
    const url = databaseUrl();
    return url ? await readStoredFacts(sqlPool(url), method, route, body, process.env, agent) : {};
  } catch {
    // A failed read is a doubt, and a doubt files the write for the person.
    if (closeTarget(method, route, body) !== undefined) return { needsOwner: true, shared: true };
    return sharingTarget(method, route, body) !== undefined ? { shared: true } : { envNamedPlace: true };
  }
}

async function defaultPropose(agent: string, input: ProposeAgentChange & { shadow?: boolean }) {
  const [{ databaseUrl }, { sqlPool }, { proposeAgentChange }] = await Promise.all([
    import("./runtime-env"),
    import("./persistence/postgres/sql-pool"),
    import("./agent-proposals/store")
  ]);
  const url = databaseUrl();
  if (!url) throw new NoDatabase();
  // Filed by the portal on the agent's behalf, never by the agent itself (`SERVER_FILED_KINDS`).
  return proposeAgentChange(sqlPool(url), agent, input, { origin: "server" });
}

class NoDatabase extends Error {}

/** The stored record in the portal's own shape, or undefined when it is not there (the summary then lists only the new values). */
export async function storedRecord(
  sql: Sql,
  kind: string,
  id: unknown,
  sent?: Record<string, unknown>
): Promise<Record<string, unknown> | undefined> {
  const { readPortalState } = await import("./persistence/postgres/state-read");
  return recordInState(await readPortalState(sql), kind, id, sent);
}

/** `storedRecord` against the portal database; undefined when there is none or it cannot be read. */
async function defaultCurrent(
  kind: string,
  id: unknown,
  sent?: Record<string, unknown>
): Promise<Record<string, unknown> | undefined> {
  try {
    const [{ databaseUrl }, { sqlPool }] = await Promise.all([
      import("./runtime-env"),
      import("./persistence/postgres/sql-pool")
    ]);
    const url = databaseUrl();
    return url ? await storedRecord(sqlPool(url), kind, id, sent) : undefined;
  } catch {
    return undefined;
  }
}

/** The JSON body of a clone (so the handler still reads its own), whatever the content-type says: the handler does not look at it either. */
async function readBody(request: Request): Promise<unknown> {
  return request
    .clone()
    .json()
    .catch(() => undefined);
}

/**
 * What an agent does about a proposal it now regrets. There is no withdraw, so say so, and say which of the two cases
 * it is in: a save with a record id carries a coalesce key and a corrected save replaces the pending card; a settings
 * save, a delete or a new record without an id has no key, so a different second call files a second card.
 * Every call is the backticked CLI form, which stdio rewrites to the tool name; the agent may have used any of the
 * save tools, hence "the same save call you just used".
 */
function takeBackNote(proposalId: string, hasRecordId: boolean): string {
  if (!hasRecordId)
    return (
      "You cannot take a proposal back. A different second call files a second card (an identical copy returns " +
      `the same card), so do not resend. If the owner is in this conversation, say: "Please reject proposal ${proposalId} ` +
      'in Inbox > Captured > From agents." Otherwise put that in your next report.'
    );
  return (
    "You cannot take a proposal back. To correct it, repeat the same save call you just used (`rhen save` for a " +
    "plain save) with the same record id, the corrected values and a new commandId (or none). If the answer is again " +
    `"Filed as proposal" and its revision is above 1, it replaced this card. If the correction is applied directly ` +
    `instead, proposal ${proposalId} is still pending: tell the owner to reject it in Inbox > Captured > From agents. ` +
    "A replaced card does not prove the owner had not already confirmed the first: check `rhen proposals` after " +
    "a minute, and if the first shows confirmed, tell the owner."
  );
}

/**
 * The `close_entity` proposal for a close the token may not apply directly: the call as sent plus the rows under it the
 * server resolved just now (with their versions), so confirming closes exactly those or goes stale. The line the
 * person reads is written from storage by the applier, never taken from the agent.
 */
function closeProposal(
  payload: Record<string, unknown>,
  facts: StoredFacts,
  claim: WriteClaim,
  shadow: boolean
): (ProposeAgentChange & { shadow?: boolean }) | null {
  const target = closeTarget("POST", "/api/commands/close", payload);
  if (target === undefined) return null;
  const expectedVersion = typeof payload.expectedVersion === "number" ? payload.expectedVersion : facts.closeVersion;
  const children = facts.closeChildren ?? [];
  const commandId =
    typeof payload.commandId === "string" && UUID.test(payload.commandId) ? payload.commandId : undefined;
  const reason = typeof payload.reason === "string" && payload.reason.trim() !== "" ? payload.reason.trim() : undefined;
  return {
    kind: "close_entity",
    payload: {
      type: target.type,
      verb: target.verb,
      id: target.id,
      do: target.do,
      ...(expectedVersion === undefined ? {} : { expectedVersion }),
      ...(reason === undefined ? {} : { reason: reason.slice(0, 500) }),
      ...(payload.includeChildren === true ? { includeChildren: true } : {}),
      children,
      cascadeTypes: (facts.closeTypes ?? []).filter((type) => type !== target.type)
    },
    basis: claim.basis ?? "inferred",
    ...(claim.evidence ? { evidence: claim.evidence } : {}),
    coalesceKey: `close:${target.type}:${target.id}`.slice(0, 200),
    ...(commandId ? { commandId } : {}),
    ...(shadow ? { shadow: true } : {})
  };
}

async function fileClose(
  payload: Record<string, unknown>,
  facts: StoredFacts,
  claim: WriteClaim,
  outcome: Extract<WriteOutcome, { action: "propose" }>,
  principal: AgentPrincipal,
  deps: EnforceDeps
): Promise<Response> {
  const filing = closeProposal(payload, facts, claim, outcome.shadow);
  if (filing === null || closeEntityPayloadSchema.safeParse(filing.payload).success === false)
    return Response.json(
      { error: "A close needs type, id, verb, do (close or restore) and, for a restore, expected-version." },
      { status: 400 }
    );
  try {
    const { proposal } = await (deps.propose ?? defaultPropose)(principal.name, filing);
    const tool = payload.verb === "archive" ? "rhen_archive" : "rhen_cancel";
    return Response.json(
      {
        proposal,
        filedBecause: outcome.reason,
        agentNote:
          `Filed as proposal ${proposal.id}. The ${payload.do === "restore" ? "restore" : "close"} has NOT been applied: the owner must confirm it in ` +
          "Inbox > Captured > From agents. Do not send it again unchanged. Check the outcome later with `rhen proposals` " +
          `(status pending, confirmed, rejected or stale). Why it was filed: ${outcome.reason}. ` +
          `You cannot take a proposal back. To change it, repeat the ${tool} call for the same row: a repeat replaces this card while it is pending. ` +
          "If the owner already confirmed the first, the repeat is refused because the row is already closed."
      },
      { status: 202 }
    );
  } catch (error) {
    if (error instanceof NoDatabase) return Response.json({ error: PROPOSALS_UNAVAILABLE }, { status: 503 });
    return proposalErrorResponse(error);
  }
}

/**
 * Returns the response that ends the request (a refusal, or the 202 for a write filed as a proposal), or null
 * when the handler should run. Environment tokens and anonymous callers never reach this.
 */
export async function enforceAgentRequest(
  request: Request,
  route: string,
  principal: AgentPrincipal,
  claim: WriteClaim,
  deps: EnforceDeps = {}
): Promise<Response | null> {
  const method = request.method.toUpperCase();
  const isWrite = !["GET", "HEAD", "OPTIONS"].includes(method);
  const needsBody = isWrite && routeNeedsBody(method, route);
  const body = needsBody ? await readBody(request) : undefined;
  // A decision that depends on the body is never made without one, and the handler never sees a body we could not read.
  if (needsBody && !asRecord(body))
    return Response.json({ error: "The request body must be a JSON object." }, { status: 400 });
  const facts = isWrite ? await (deps.stored ?? defaultStored)(method, route, body, principal.name) : {};
  const decision = scopesForRoute(method, route, body, facts);
  if (decision.kind === "public") return null;
  if (decision.kind === "refused") {
    // A removed field name is a malformed request, not a missing right: say so in a 400 that names the current field.
    // A misspelt entity type is likewise a malformed request: a 400 that lists the valid types, not a guarded refusal.
    if (decision.reason === "removed-field" || decision.reason === "unknown-entity")
      return Response.json({ error: decision.message }, { status: 400 });
    return forbidden(decision.message);
  }
  const held = principal.scopes ?? [];

  if (!isWrite) {
    if (decision.anyOf !== undefined)
      return decision.anyOf.some((scope) => holds(held, scope))
        ? null
        : insufficientScope(decision.anyOf, [decision.anyOf.join(" or ")], held);
    const missing = decision.scopes.filter((scope) => !holds(held, scope));
    return missing.length === 0 ? null : insufficientScope(decision.scopes, missing, held);
  }

  const outcome = decideWrite(decision, principal);
  if (outcome.action === "apply") return null;
  if (outcome.action === "deny") {
    // The floor's reason already says what the agent can do instead; `propose` cannot file these writes.
    if (outcome.floor !== undefined)
      return forbidden(
        `An agent token cannot make this write: ${outcome.floor}.`,
        decision.floor ? hardFloorInstead(decision.floor) : null
      );
    return insufficientScope(decision.scopes, outcome.missing, held);
  }

  const payload = asRecord(body);
  if (!payload || decision.command === undefined)
    return Response.json({ error: "The request body must be a JSON object." }, { status: 400 });
  if (decision.command === "close_entity") return fileClose(payload, facts, claim, outcome, principal, deps);
  // A caller that files through its own `propose` (a test) reads no record unless it also supplies `current`.
  const lookup = deps.current ?? (deps.propose ? undefined : defaultCurrent);
  const saved = savedEntity(decision.command, payload);
  const updates = payload.expectedVersion !== null && payload.expectedVersion !== undefined;
  const stored = lookup && updates ? await lookup(saved.kind, saved.entity?.id, saved.entity) : undefined;
  // A record that changed after the agent read it would show the person's newer edit as the agent reverting it,
  // so the summary then lists only the new values. Confirming still checks the version and goes stale.
  const current = stored?.version === payload.expectedVersion ? stored : undefined;
  try {
    const filing = entityProposal(decision.command, payload, claim, outcome.shadow, current);
    const { proposal } = await (deps.propose ?? defaultPropose)(principal.name, filing);
    return Response.json(
      {
        proposal,
        filedBecause: outcome.reason,
        agentNote:
          `Filed as proposal ${proposal.id}. Your change has NOT been applied: the owner must confirm it in ` +
          "Inbox > Captured > From agents. Do not send it again unchanged. Check the outcome later with `rhen proposals` " +
          `(status pending, confirmed, rejected or stale). Why it was filed: ${outcome.reason} ` +
          takeBackNote(proposal.id, filing.coalesceKey !== undefined)
      },
      { status: 202 }
    );
  } catch (error) {
    if (error instanceof NoDatabase) return Response.json({ error: PROPOSALS_UNAVAILABLE }, { status: 503 });
    return proposalErrorResponse(error);
  }
}
