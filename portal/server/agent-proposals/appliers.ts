import { createHash } from "node:crypto";
import {
  entityCommandBatchPayloadSchema,
  entityCommandPayloadSchema,
  planningEntityCommandSchema,
  proposableCommandRefusal,
  saveActionCommandSchema,
  saveProjectCommandSchema,
  settleCatchUpCommandSchema,
  type AgentProposalConflict
} from "@openrhen/contracts";
import { proposalSummary, storedRecord, summaryList } from "@/server/agent-enforcement";
import { settleCatchUp } from "@/server/persistence/postgres/catch-up";
import { CommandConflictError, InvalidCommandError } from "@/server/persistence/postgres/command-errors";
import { stableUuid } from "@/server/persistence/postgres/command-values";
import { nestedPool } from "@/server/persistence/postgres/nested-pool";
import { saveEntity } from "@/server/persistence/postgres/entity-commands";
import { saveAction, saveProject } from "@/server/persistence/postgres/project-commands";
import type { PoolSql } from "@/server/persistence/postgres/sql-pool";

/** What an applier is handed: the stored row, and the connection and user to replay it against. */
export interface ProposalContext {
  sql: PoolSql;
  userId: string;
}

export interface StoredProposal {
  id: string;
  agent: string;
  kind: string;
  payload: Record<string, unknown>;
  targetVersions: Record<string, number | null>;
  /** The revision being confirmed; absent means 1. */
  revision?: number;
}

const asUuid = (hex: string) =>
  `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;

/**
 * The receipt a confirm writes under: the proposal's id for its first revision, and one derived from id and revision
 * for a later one. An agent can replace a proposal while a confirm of the earlier revision is applying; that revision
 * stays pending, and confirming it later must write, not replay the earlier revision's receipt.
 */
export function receiptId(proposal: Pick<StoredProposal, "id" | "revision">): string {
  const revision = proposal.revision ?? 1;
  if (revision === 1) return proposal.id;
  return asUuid(createHash("sha256").update(`${proposal.id}:r${revision}`).digest("hex"));
}

/** Entity key to its version when proposed; null means the entity did not exist. */
export type TargetVersions = Record<string, number | null>;

export interface ProposalApplierHooks {
  /** Checks a payload when it is proposed, and names the entity versions it was written against. */
  validate?(
    payload: Record<string, unknown>
  ): { ok: true; targetVersions?: TargetVersions } | { ok: false; error: string };
  /**
   * The one line the person reads, built from a payload `validate` accepted and never from the agent's own words, so
   * the card cannot say one thing while confirming does another.
   */
  summarize?(context: ProposalContext, payload: Record<string, unknown>): Promise<string>;
  /** The current version of each entity in `proposal.targetVersions` that can be read; the rest are left to `apply`. */
  currentVersions?(context: ProposalContext, proposal: StoredProposal): Promise<TargetVersions>;
}

type Apply = (context: ProposalContext, proposal: StoredProposal) => Promise<unknown>;

const appliers = new Map<string, { apply: Apply; hooks: ProposalApplierHooks }>();

/**
 * Registers what confirming a proposal of `kind` does. `apply` replays the stored payload through the
 * normal write path and throws `CommandConflictError` when the target moved on; the store marks the
 * proposal `stale` for that. Later features (catch-up's `settle_catch_up`) plug in here.
 */
export function registerProposalApplier(kind: string, apply: Apply, hooks: ProposalApplierHooks = {}): void {
  appliers.set(kind, { apply, hooks });
}

export function proposalApplier(kind: string) {
  return appliers.get(kind);
}

/** The proposal kinds this portal can file and apply, for the refusal that names the ones it accepts. */
export function proposalKinds(): string[] {
  // The server files these itself (a bulk write, a catch-up settle); rhen_propose accepts only the rest.
  const serverFiled = new Set([BATCH_KIND, "settle_catch_up"]);
  return [...appliers.keys()].filter((kind) => !serverFiled.has(kind)).sort();
}

/** Entity version keys that differ between the proposal and now. Pure; only keys present in `current` are compared. */
export function versionConflicts(proposed: TargetVersions, current: TargetVersions): AgentProposalConflict[] {
  const conflicts: AgentProposalConflict[] = [];
  for (const [entity, now] of Object.entries(current)) {
    const then = proposed[entity] ?? null;
    if (then !== now) conflicts.push({ entity, proposedAgainst: then, current: now });
  }
  return conflicts;
}

// ---- entity_command: a stored save_entity / save_project / save_action ----

const ENTITY_KIND = "entity_command";

/** The fields a whole action must carry in a proposal: every key of the action schema that has no default or `optional`. */
const REQUIRED_ACTION_FIELDS = Object.entries(saveActionCommandSchema.shape.action.shape)
  .filter(([, field]) => !field.safeParse(undefined).success)
  .map(([name]) => name);

/** One schema issue as a line that names its path under the body and says what is missing or wrong. */
function commandIssueLine(prefix: string, issue: { path: PropertyKey[]; message: string }): string {
  const path = [prefix, ...issue.path.map(String)].join(".");
  const missing = /^Invalid input: expected (.+), received undefined$/.exec(issue.message);
  return missing ? `${path} is required (${missing[1]})` : `${path}: ${issue.message.replace(/^Invalid input: /, "")}`;
}

/**
 * Why a stored command is not a valid one: every problem with its path under `body` (up to six), the body shape the command
 * needs, and the call that fixes it. An action is never carried by `save_entity`; it needs the whole action record.
 */
function commandProblem(
  label: string,
  command: "save_entity" | "save_project" | "save_action",
  prefix: string,
  issues: readonly ({ path: PropertyKey[]; message: string } | string)[]
): string {
  const lines = issues
    .slice(0, 6)
    .map((issue) => (typeof issue === "string" ? issue : commandIssueLine(prefix, issue)));
  const more = issues.length > 6 ? ` (${issues.length - 6} more)` : "";
  const shape =
    command === "save_action"
      ? `For save_action, ${prefix} must be {"action": {the COMPLETE action: ${REQUIRED_ACTION_FIELDS.join(", ")}}, "expectedVersion": <the version you read, or null to create>}; ` +
        "save_entity cannot carry an action."
      : command === "save_project"
        ? `For save_project, ${prefix} must be {"project": {every field of the project}, "expectedVersion": <the version you read, or null to create>}.`
        : `For save_entity, ${prefix} must be {"entityType": <area|outcome|commitment|...>, "entity": {the record's fields}, "expectedVersion": <the version you read, or null to create>}; actions and projects use save_action and save_project.`;
  return `${label} command is invalid: ${lines.join("; ")}${more}. ${shape} Fix these and call rhen_propose again with the same coalesce-key.`;
}

function parseCommand(payload: Record<string, unknown>, commandId: string, prefix = "body") {
  const shape = entityCommandPayloadSchema.safeParse(payload);
  if (!shape.success)
    return {
      ok: false as const,
      error:
        'payload-json must be {"command": "save_entity" | "save_project" | "save_action", "body": {...}}; ' +
        `${shape.error.issues
          .slice(0, 3)
          .map((issue) => commandIssueLine("payload-json", issue))
          .join("; ")}.`
    };
  // The proposal's own id wins over any `commandId` in the stored body: one pointed at an old receipt would replay
  // that receipt, apply nothing, and still mark the proposal confirmed.
  const body = { ...shape.data.body, commandId };
  const sentType = shape.data.body.entityType;
  if (shape.data.command === "save_entity" && (sentType === "action" || sentType === "project"))
    return {
      ok: false as const,
      error: commandProblem("Entity", sentType === "action" ? "save_action" : "save_project", prefix, [
        `${prefix}.entityType "${String(sentType)}" cannot be sent with command save_entity`
      ])
    };
  if (shape.data.command === "save_entity") {
    const parsed = planningEntityCommandSchema.safeParse({ type: "save_entity", ...body });
    return parsed.success
      ? { ok: true as const, command: "save_entity" as const, data: parsed.data }
      : {
          ok: false as const,
          error: commandProblem("Entity", "save_entity", prefix, parsed.error.issues)
        };
  }
  if (shape.data.command === "save_project") {
    const parsed = saveProjectCommandSchema.safeParse(body);
    return parsed.success
      ? { ok: true as const, command: "save_project" as const, data: parsed.data }
      : {
          ok: false as const,
          error: commandProblem("Project", "save_project", prefix, parsed.error.issues)
        };
  }
  const parsed = saveActionCommandSchema.safeParse(body);
  return parsed.success
    ? { ok: true as const, command: "save_action" as const, data: parsed.data }
    : {
        ok: false as const,
        error: commandProblem("Action", "save_action", prefix, parsed.error.issues)
      };
}

/** The entity key and the version the command was written against, when the command names its entity. */
function targetOf(command: ReturnType<typeof parseCommand> & { ok: true }): TargetVersions {
  if (command.command === "save_project")
    return { [`project:${command.data.project.id}`]: command.data.expectedVersion };
  if (command.command === "save_action") return { [`action:${command.data.action.id}`]: command.data.expectedVersion };
  const id = command.data.entity.id;
  return typeof id === "string" ? { [`${command.data.entityType}:${id}`]: command.data.expectedVersion } : {};
}

/** The entity types whose version can be read before replaying; any other relies on the write's own check. */
async function readVersion(context: ProposalContext, key: string): Promise<number | null | undefined> {
  const [type, ...rest] = key.split(":");
  const rawId = rest.join(":");
  const { sql, userId } = context;
  const first = async (rows: Promise<{ version: number }[]>) => (await rows)[0]?.version ?? null;
  if (type === "project") {
    const id = await stableUuid(`project:${userId}`, rawId);
    return first(
      sql`SELECT p.version FROM projects p JOIN outcomes o ON o.id=p.outcome_id JOIN areas a ON a.id=o.area_id WHERE p.id=${id} AND a.user_id=${userId}`
    );
  }
  if (type === "action") {
    const id = await stableUuid(`action:${userId}`, rawId);
    return first(
      sql`SELECT ac.version FROM actions ac JOIN projects p ON p.id=ac.project_id JOIN outcomes o ON o.id=p.outcome_id JOIN areas a ON a.id=o.area_id WHERE ac.id=${id} AND a.user_id=${userId}`
    );
  }
  if (type === "area") {
    const id = await stableUuid(`area:${userId}`, rawId);
    return first(sql`SELECT version FROM areas WHERE id=${id} AND user_id=${userId}`);
  }
  if (type === "outcome") {
    const id = await stableUuid(`outcome:${userId}`, rawId);
    return first(
      sql`SELECT o.version FROM outcomes o JOIN areas a ON a.id=o.area_id WHERE o.id=${id} AND a.user_id=${userId}`
    );
  }
  if (type === "commitment") {
    const id = await stableUuid(`commitment:${userId}`, rawId);
    return first(sql`SELECT version FROM commitments WHERE id=${id} AND user_id=${userId}`);
  }
  return undefined;
}

async function applyCommand(context: ProposalContext, payload: Record<string, unknown>, commandId: string) {
  // Asked again on confirming, so a proposal filed before the rule tightened is refused rather than applied.
  const refusal = proposableCommandRefusal(payload);
  if (refusal !== null) throw new InvalidCommandError(`This change cannot be confirmed: ${refusal}`);
  const parsed = parseCommand(payload, commandId);
  if (!parsed.ok) throw new Error(parsed.error);
  if (parsed.command === "save_entity") return saveEntity(context.sql, parsed.data);
  if (parsed.command === "save_project") return saveProject(context.sql, parsed.data);
  return saveAction(context.sql, parsed.data);
}

function validateCommand(payload: Record<string, unknown>, prefix = "body") {
  // Only a write the save routes would themselves file for the person; the route asks the same of token agents.
  const refusal = proposableCommandRefusal(payload);
  if (refusal !== null) return { ok: false as const, error: refusal };
  const parsed = parseCommand(payload, crypto.randomUUID(), prefix);
  if (!parsed.ok) return parsed;
  // Staleness is only checkable when the agent says which version it wrote against (null for a create).
  const body = (payload as { body?: Record<string, unknown> }).body ?? {};
  const expected = body.expectedVersion;
  if (!(expected === null || typeof expected === "number"))
    return {
      ok: false as const,
      error: `${prefix}.expectedVersion is required: the version you read (a number), or null to create.`
    };
  return { ok: true as const, targetVersions: targetOf(parsed) };
}

async function currentVersionsOf(context: ProposalContext, proposal: StoredProposal): Promise<TargetVersions> {
  const current: TargetVersions = {};
  for (const key of Object.keys(proposal.targetVersions)) {
    const version = await readVersion(context, key);
    if (version !== undefined) current[key] = version;
  }
  return current;
}

/** One command's line: before and after when the stored record is still at the version the agent read. */
async function commandSummary(context: ProposalContext, payload: Record<string, unknown>): Promise<string> {
  const { command, body } = entityCommandPayloadSchema.parse(payload);
  const kind = command === "save_project" ? "project" : command === "save_action" ? "action" : String(body.entityType);
  const entity = (command === "save_entity" ? body.entity : body[kind]) as Record<string, unknown> | undefined;
  const updates = typeof body.expectedVersion === "number";
  const stored = updates ? await storedRecord(context.sql, kind, entity?.id, entity).catch(() => undefined) : undefined;
  return proposalSummary(command, body, stored?.version === body.expectedVersion ? stored : undefined);
}

registerProposalApplier(
  ENTITY_KIND,
  // The commandId is the revision's receipt, so confirming one revision twice replays it.
  (context, proposal) => applyCommand(context, proposal.payload, receiptId(proposal)),
  {
    validate: (payload) => validateCommand(payload),
    summarize: commandSummary,
    currentVersions: currentVersionsOf
  }
);

// ---- entity_command_batch: a bulk write held as one proposal, confirmed once ----

const BATCH_KIND = "entity_command_batch";

/** Each row's commandId is derived from the proposal and its position (any in the body is ignored), so a re-confirm replays receipts. */
function rowCommandId(receipt: string, index: number): string {
  return asUuid(createHash("sha256").update(`${receipt}:${index}`).digest("hex"));
}

/**
 * Rows apply in order, each through the normal write path with its own receipt. A row that fails stops the
 * batch; the rows before it stay applied and the proposal stays pending, so confirming again skips them
 * (their receipts replay) and retries the rest. An `atomic` batch (a floored changeset) instead runs in one
 * transaction: any failure rolls every row back, and each row's `expectedVersion` is checked by its own write.
 */
registerProposalApplier(
  BATCH_KIND,
  async (context, proposal) => {
    const batch = entityCommandBatchPayloadSchema.parse(proposal.payload);
    // Every row is checked before any applies, so a refused row never leaves the rows before it written.
    for (const [index, row] of batch.commands.entries()) {
      const refusal = proposableCommandRefusal(row);
      if (refusal !== null)
        throw new InvalidCommandError(
          `This change cannot be confirmed: row ${index + 1} of ${batch.commands.length}: ${refusal}`
        );
    }
    const rowError = (error: unknown, index: number, applied: string) => {
      // Name the row, keeping the error's class so the store still maps a conflict to stale and a refusal to 422.
      if (error instanceof CommandConflictError || error instanceof InvalidCommandError)
        return new (error.constructor as new (message: string) => Error)(
          `Row ${index + 1} of ${batch.commands.length} failed (${applied}): ${error.message}`
        );
      return error;
    };
    if (batch.atomic === true)
      // One transaction: a row that fails (a record changed since the agent read it, a refusal) rolls back every row
      // before it, so the proposal stays pending with nothing written. Each handler's own `begin` becomes a savepoint.
      return context.sql.begin(async (tx) => {
        const results: unknown[] = [];
        for (const [index, row] of batch.commands.entries()) {
          try {
            results.push(
              await applyCommand({ ...context, sql: nestedPool(tx) }, row, rowCommandId(receiptId(proposal), index))
            );
          } catch (error) {
            throw rowError(error, index, "none applied, the whole set was rolled back");
          }
        }
        return results;
      });
    const results: unknown[] = [];
    for (const [index, row] of batch.commands.entries()) {
      try {
        results.push(await applyCommand(context, row, rowCommandId(receiptId(proposal), index)));
      } catch (error) {
        throw rowError(error, index, `${index} applied before it`);
      }
    }
    return results;
  },
  {
    validate(payload) {
      const batch = entityCommandBatchPayloadSchema.safeParse(payload);
      if (!batch.success)
        return { ok: false, error: "payload must be { commands: [{ command, body }, ...] } with 1 to 500 commands." };
      const targetVersions: TargetVersions = {};
      for (const [index, row] of batch.data.commands.entries()) {
        const checked = validateCommand(row, `commands[${index}].body`);
        if (!checked.ok) return { ok: false, error: `commands[${index}]: ${checked.error}` };
        Object.assign(targetVersions, checked.targetVersions);
      }
      return { ok: true, targetVersions };
    },
    summarize(_context, payload) {
      const { commands, atomic } = entityCommandBatchPayloadSchema.parse(payload);
      const rows = commands.map(({ command, body }) => proposalSummary(command, body));
      return Promise.resolve(
        summaryList(
          `${commands.length} ${commands.length === 1 ? "change" : "changes"}${atomic === true ? ", all or nothing" : ""}`,
          rows
        )
      );
    },
    currentVersions: currentVersionsOf
  }
);

// ---- settle_catch_up: a stored catch-up settle ----

function catchUpCommand(payload: Record<string, unknown>, commandId: string) {
  return settleCatchUpCommandSchema.safeParse({ ...payload, commandId });
}

/** The line the catch-up route files a settle under; an agent proposing one directly gets the same. */
export function catchUpSettleSummary(verdicts: number, closeWindow: boolean): string {
  return `Settle ${verdicts} catch-up ${verdicts === 1 ? "entry" : "entries"}${closeWindow ? " and close the window" : ""}`;
}

registerProposalApplier(
  "settle_catch_up",
  async (context, proposal) => {
    const parsed = catchUpCommand(proposal.payload, receiptId(proposal));
    if (!parsed.success) throw new Error("The stored settle is no longer valid.");
    const result = await settleCatchUp(context.sql, parsed.data);
    // Nothing applied and something conflicted: the plan moved on since the agent read it.
    if (
      !result.results.some((entry) => entry.outcome === "applied") &&
      result.results.some((entry) => entry.outcome === "conflict")
    )
      throw new CommandConflictError(
        "Everything in this settle was already settled or changed. Review the list again: read what still needs settling with rhen_catch_up, then propose a fresh settle.",
        {
          nextCall: {
            tool: "rhen_catch_up",
            arguments: {},
            note: "lists what still needs settling now"
          }
        }
      );
    return result;
  },
  {
    validate(payload) {
      const parsed = catchUpCommand(payload, crypto.randomUUID());
      if (!parsed.success)
        return { ok: false, error: `Settle is invalid: ${parsed.error.issues[0]?.message ?? "validation failed"}.` };
      const targetVersions: TargetVersions = {};
      for (const verdict of parsed.data.verdicts) {
        if ("bulk" in verdict || !verdict.entryId.startsWith("deadline:")) continue;
        if (typeof verdict.version === "number")
          targetVersions[`project:${verdict.entryId.slice("deadline:".length)}`] = verdict.version;
      }
      return { ok: true, targetVersions };
    },
    summarize(_context, payload) {
      const parsed = catchUpCommand(payload, crypto.randomUUID());
      return Promise.resolve(
        parsed.success
          ? catchUpSettleSummary(parsed.data.verdicts.length, parsed.data.closeWindow === true)
          : "Settle catch-up"
      );
    },
    async currentVersions(context, proposal) {
      const current: TargetVersions = {};
      for (const key of Object.keys(proposal.targetVersions)) {
        const version = await readVersion(context, key);
        if (version !== undefined) current[key] = version;
      }
      return current;
    }
  }
);
