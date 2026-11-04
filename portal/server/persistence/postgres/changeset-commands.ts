import {
  changesetFloor,
  hardFloorInstead,
  planningEntityCommandSchema,
  proposableCommandRefusal,
  saveActionCommandSchema,
  saveCommitmentRecurrenceRuleCommandSchema,
  saveProjectCommandSchema,
  scopeCovers,
  scopesForRoute,
  sessionCommandSchema,
  type ChangesetCommand,
  type ChangesetDuplicate,
  type ChangesetItem,
  type ChangesetItemResult,
  type ChangesetResult,
  type ChangesetRoute
} from "@openrhen/contracts";
import {
  changeLogActor,
  requestAgent,
  requestClaim,
  requestDirectWrites,
  requestScopes,
  runWithActor
} from "@/server/agent-actor";
import { decideWrite, entityProposal, proposalSummary, readStoredFacts, summaryList } from "@/server/agent-enforcement";
import { AgentProposalError } from "@/server/agent-proposals/errors";
import { proposeAgentChange } from "@/server/agent-proposals/store";
import { PLAN_DOCUMENT_KINDS, type PlanDocumentKind } from "@/server/search/plan-documents";
import { searchPlan } from "@/server/search/plan-search";
import { claimCommandReceipt, commandRequestHash, refuseCommandIdReuse } from "./command-receipt";
import { isUuid } from "./command-values";
import {
  CommandConflictError,
  ForbiddenCommandError,
  InvalidCommandError,
  NotFoundCommandError
} from "./command-errors";
import { saveEntity } from "./entity-commands";
import { ensureUser } from "./ensure-user";
import { nestedPool } from "./nested-pool";
import { saveAction, saveProject } from "./project-commands";
import { saveCommitmentRecurrenceRule } from "./recurrence-commands";
import { runSessionCommand } from "./session-commands";
import type { PoolSql, TxSql } from "./sql-pool";

/**
 * Changeset ingest: one agent message of facts, as the commands its own tools
 * would send, run in one transaction. Each command goes through the handler its own route uses, inside a savepoint,
 * so a refusal in a preview is that command's alone; a preview then rolls the whole transaction back, and an apply
 * keeps it only when every command went through.
 */

/** Runs one command through its route's own schema and handler. */
async function runItem(pool: PoolSql, path: ChangesetRoute, payload: Record<string, unknown>): Promise<void> {
  const fail = (what: string, issues: readonly { path: readonly PropertyKey[]; message: string }[]) => {
    const first = issues[0];
    throw new InvalidCommandError(
      `${what} does not match its schema${first ? `: ${first.path.map(String).join(".") || "(root)"} ${first.message}` : ""}.`
    );
  };
  if (path === "/api/commands/entity") {
    const parsed = planningEntityCommandSchema.safeParse(payload);
    if (!parsed.success) return fail("The entity command", parsed.error.issues);
    await saveEntity(pool, parsed.data);
  } else if (path === "/api/commands/project") {
    const parsed = saveProjectCommandSchema.safeParse(payload);
    if (!parsed.success) return fail("The project command", parsed.error.issues);
    await saveProject(pool, parsed.data);
  } else if (path === "/api/commands/action") {
    const parsed = saveActionCommandSchema.safeParse(payload);
    if (!parsed.success) return fail("The action command", parsed.error.issues);
    await saveAction(pool, parsed.data);
  } else if (path === "/api/commands/commitment-recurrence") {
    const parsed = saveCommitmentRecurrenceRuleCommandSchema.safeParse(payload);
    if (!parsed.success) return fail("The recurrence command", parsed.error.issues);
    await saveCommitmentRecurrenceRule(pool, parsed.data);
  } else {
    const parsed = sessionCommandSchema.safeParse(payload);
    if (!parsed.success) return fail("The session command", parsed.error.issues);
    await runSessionCommand(pool, parsed.data);
  }
}

type Decision =
  { action: "apply" } | { action: "propose"; reason: string; shadow: boolean } | { action: "deny"; message: string };

/**
 * What the token behind this request may do with one command: the same decision `withRoute` makes for the
 * command's own route (`enforceAgentRequest`). A person, a header-only name and an environment token are not held
 * to scopes there, so they are not here either.
 */
async function decide(tx: TxSql, item: ChangesetItem): Promise<Decision & { instead?: string }> {
  const agent = requestAgent();
  const scopes = requestScopes();
  if (agent === null || scopes === undefined) return { action: "apply" };
  // Read inside the set, so a commitment an earlier command shared or unshared is judged as it now stands.
  const stored = await tx.savepoint((sp) => readStoredFacts(sp, "POST", item.path, item.payload));
  const decision = scopesForRoute("POST", item.path, item.payload, stored);
  if (decision.kind === "public") return { action: "apply" };
  if (decision.kind === "refused") return { action: "deny", message: decision.message };
  const outcome = decideWrite(decision, {
    name: agent,
    source: "db",
    scopes: [...scopes],
    directWrites: (requestDirectWrites() ?? {}) as never
  });
  if (outcome.action === "deny")
    return {
      action: "deny",
      message:
        outcome.floor !== undefined
          ? `An agent token cannot make this write: ${outcome.floor}.`
          : `This token lacks ${outcome.missing.join(", ")} for this write.`
    };
  const instead = decision.floor ? hardFloorInstead(decision.floor) : null;
  return { ...outcome, ...(instead ? { instead } : {}) };
}

function sqlStateOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const SEARCH_KINDS = new Set<string>(PLAN_DOCUMENT_KINDS);

/**
 * The plan-search kind and id of the record a create command makes, read from the command itself (not from what the
 * client says it creates), so the duplicate check searches only the kind the write is.
 */
function createdRecord(item: ChangesetItem): { kind: PlanDocumentKind; id: string } | undefined {
  if (!item.creates) return undefined;
  const payload = item.payload;
  const [kind, entity] =
    item.path === "/api/commands/action"
      ? ["action", payload.action]
      : item.path === "/api/commands/project"
        ? ["project", payload.project]
        : item.path === "/api/commands/entity" && typeof payload.entityType === "string"
          ? [
              payload.entityType === "condition_definition" ? "condition" : payload.entityType.replaceAll("_", "-"),
              payload.entity
            ]
          : [undefined, undefined];
  const id = entity !== null && typeof entity === "object" ? (entity as { id?: unknown }).id : undefined;
  return kind !== undefined && SEARCH_KINDS.has(kind) && typeof id === "string"
    ? { kind: kind as PlanDocumentKind, id }
    : undefined;
}

/**
 * Whether this request may be shown other records' titles: the person, or a token that can read the plan. A token
 * that can only write gets no duplicate list, which would otherwise let it read titles through previews.
 */
function mayReadPlan(): boolean {
  const scopes = requestScopes();
  if (requestAgent() === null || scopes === undefined) return true;
  return scopes.some((scope) => scopeCovers(scope, "read:plan"));
}

/**
 * Records like the one a create made, read inside the transaction where it exists; empty when search cannot say.
 * Words only: a meaning search calls the embedder over the network, and this transaction holds the user lock every
 * other request waits on. In a savepoint, so a failed search does not abort the changeset's transaction.
 */
async function likelyDuplicates(
  tx: TxSql,
  created: { kind: PlanDocumentKind; id: string },
  createdHere: ReadonlySet<string>
): Promise<ChangesetDuplicate[]> {
  try {
    const found = await tx.savepoint((sp) =>
      searchPlan(sp, { like: created.id, kinds: [created.kind], status: "open", mode: "words", limit: 3 })
    );
    return found.results.map((hit) => ({
      kind: hit.kind,
      id: hit.id,
      title: hit.title,
      ...(hit.status !== undefined ? { status: hit.status } : {}),
      ...(createdHere.has(hit.id) ? { inThisChangeset: true } : {})
    }));
  } catch {
    return [];
  }
}

/** Postgres errors a command can meet against another command or a concurrent write, answered for that command. */
const SQL_CONFLICTS = new Set(["23505", "40P01", "40001"]);
const SQL_INVALID = new Set(["23503", "23514", "22P02"]);

/** A preview's results, carried out of the transaction it rolls back. */
class PreviewRollback extends Error {
  constructor(readonly result: ChangesetResult) {
    super("changeset preview");
  }
}

/** An apply that could not keep every command: the transaction rolls back and the results say why. */
class ApplyRollback extends Error {
  constructor(readonly result: ChangesetResult) {
    super("changeset apply refused");
  }
}

export async function runChangeset(sql: PoolSql, command: ChangesetCommand): Promise<ChangesetResult> {
  const userId = await ensureUser(sql);
  // Of the agent's own input, not of the commands built from it (which differ on a retry); none from a client that sends none.
  const requestHash = command.inputHash ? commandRequestHash("changeset", { inputHash: command.inputHash }) : null;
  if (command.mode === "apply" || command.replay === true) {
    // A retried apply answers with what the first one kept.
    // Only the caller's own: another agent's (or the person's) changeset is not this caller's to read back.
    const prior = await sql<{ command_type: string; request_hash: string | null; response: unknown; mine: boolean }[]>`
      SELECT command_type, request_hash, response, actor IS NOT DISTINCT FROM ${changeLogActor()} AS mine
      FROM writes WHERE id=${command.commandId} AND user_id=${userId}`;
    if (prior[0]) {
      if (prior[0].command_type !== "changeset" || !prior[0].mine) {
        if (command.replay === true)
          throw new NotFoundCommandError("No changeset was applied under that command id, so nothing landed.");
        throw new CommandConflictError(
          "That command id was already used by another write, so nothing was applied. Repeat the call with a NEW command-id (a fresh uuid); keep the same command-id only to retry a timeout of the same changeset.",
          {
            nextCall: {
              tool: "rhen_undo",
              arguments: { list: true },
              note: "lists the recorded writes with their ids, to see what that id already wrote"
            }
          }
        );
      }
      // A replay-only ask carries no intents to compare; an apply does, and other intents under this id are another write.
      if (command.replay !== true) refuseCommandIdReuse(prior[0], { commandType: "changeset", requestHash });
      return (prior[0].response as { result: ChangesetResult }).result;
    }
    if (command.replay === true)
      throw new NotFoundCommandError("No changeset was applied under that command id, so nothing landed.");
  }
  try {
    return await sql.begin(async (tx) => {
      if (
        command.mode === "apply" &&
        !(await claimCommandReceipt(tx, { id: command.commandId, userId, commandType: "changeset", requestHash }))
      )
        throw new CommandConflictError(
          "This changeset is being applied by another request. Check whether it landed: it appears in the write log under this command-id. If it does not, repeat the identical call with the same command-id.",
          {
            nextCall: {
              tool: "rhen_undo",
              arguments: { list: true },
              note: "lists the recorded writes; the changeset shows under its command-id once it has landed"
            }
          }
        );
      const result = await runItems(tx, command);
      if (command.mode === "preview") throw new PreviewRollback(result);
      if (!result.ok) throw new ApplyRollback(result);
      const kept: ChangesetResult = { ...result, changesetId: command.commandId };
      // `members` is what a revert of the set walks, and what Review > Agent changes folds into one row; `undoable`
      // the members that kept images, so an undo can tell one whose images have since expired from one that had none.
      // A proposal is not a member: once the person confirms it, it is theirs, undone on its own.
      const members = kept.items.flatMap((item) => (item.outcome === "applies" ? [item.commandId] : []));
      const undoable = kept.items.flatMap((item) => (item.undoable ? [item.commandId] : []));
      const questions = command.items.flatMap((item) =>
        item.question
          ? [
              {
                commandId: kept.items.find((entry) => entry.intent === item.intent)?.commandId,
                question: item.question
              }
            ]
          : []
      );
      await tx`UPDATE writes SET response=${tx.json({ members, undoable, questions, result: kept } as never)},
        state='applied', updated_at=now() WHERE id=${command.commandId} AND user_id=${userId}`;
      return kept;
    });
  } catch (error) {
    if (error instanceof PreviewRollback || error instanceof ApplyRollback) return error.result;
    throw error;
  }
}

/** The save a proposal replays for each route a proposal can hold. */
const COMMAND_FOR_PATH: Record<string, "save_entity" | "save_project" | "save_action"> = {
  "/api/commands/entity": "save_entity",
  "/api/commands/project": "save_project",
  "/api/commands/action": "save_action"
};

/**
 * The hard floor on the set as a whole: more than the bulk
 * threshold of updates, status changes or removals, or any command that touches people, makes the entire set the
 * owner's to confirm. Nothing applies; the set is filed as one atomic `entity_command_batch` proposal, so confirming
 * keeps every command or none. A set that cannot be a proposal (it holds session or recurrence commands) is refused
 * with the instruction to split it. Null when the caller is not token-held or the set is not floored.
 */
async function floorWholeSet(tx: TxSql, command: ChangesetCommand): Promise<ChangesetResult | null> {
  const actor = requestAgent();
  if (actor === null || requestScopes() === undefined) return null;
  const facts: ReturnType<typeof scopesForRoute>[] = [];
  for (const item of command.items) {
    const stored = await tx.savepoint((sp) => readStoredFacts(sp, "POST", item.path, item.payload));
    facts.push(scopesForRoute("POST", item.path, item.payload, stored));
  }
  const floor = changesetFloor(
    command.items.map((item, index) => {
      const decision = facts[index]!;
      // A create is read from the command (no version read), never from the agent's own `creates` claim.
      const proposable = Object.hasOwn(COMMAND_FOR_PATH, item.path);
      const isCreate =
        proposable && (item.payload.expectedVersion === null || item.payload.expectedVersion === undefined);
      return {
        intent: item.intent,
        path: item.path,
        ...(isCreate ? { creates: true } : {}),
        touchesPeople: decision.kind === "scopes" && decision.floor?.touchesPeople === true
      };
    })
  );
  if (floor === null) return null;
  const commandIdOf = (item: ChangesetItem) =>
    typeof item.payload.commandId === "string" ? item.payload.commandId : "";
  const refuseAll = (message: (index: number) => string): ChangesetResult => ({
    mode: command.mode,
    ok: false,
    items: command.items.map((item, index) => ({
      intent: item.intent,
      outcome: "invalid" as const,
      commandId: commandIdOf(item),
      message: message(index)
    }))
  });
  const split =
    " Split the set: send the updates that touch people, and any group of more than 20 changes, as separate changesets " +
    "of 20 or fewer, then send each again.";
  if (floor.unfileable.length > 0) return refuseAll(() => floor.reason);
  // Every command must be one the token may at least propose, and one a proposal can hold.
  const problems: (string | null)[] = [];
  for (const [index, item] of command.items.entries()) {
    const decision = facts[index]!;
    if (decision.kind === "refused") {
      problems.push(decision.message);
      continue;
    }
    if (decision.kind === "public" || decision.command === undefined) {
      problems.push("This command cannot be filed as a proposal.");
      continue;
    }
    const refusal = proposableCommandRefusal({ command: decision.command, body: item.payload });
    if (refusal !== null) {
      problems.push(refusal);
      continue;
    }
    const outcome = decideWrite(decision, {
      name: actor,
      source: "db",
      scopes: [...(requestScopes() ?? [])],
      directWrites: (requestDirectWrites() ?? {}) as never
    });
    problems.push(
      outcome.action === "deny"
        ? outcome.floor !== undefined
          ? `An agent token cannot make this write: ${outcome.floor}.`
          : `This token lacks ${outcome.missing.join(", ")} for this write.`
        : null
    );
  }
  if (problems.some((problem) => problem !== null))
    return refuseAll((index) =>
      problems[index] !== null
        ? `${floor.reason.split(", so the whole set")[0]}, so the whole set must be filed for the owner, but this command cannot be: ${problems[index]}.${split}`
        : `Not filed: another command in this set cannot be proposed, and a set is filed whole or not at all.${split}`
    );
  const claim = requestClaim() ?? {};
  const commands = command.items.map((item) => ({ command: COMMAND_FOR_PATH[item.path]!, body: item.payload }));
  const rows = commands.map(({ command: kind, body }) => proposalSummary(kind, body));
  try {
    const filed = await tx.savepoint((sp) =>
      proposeAgentChange(
        nestedPool(sp),
        actor,
        {
          kind: "entity_command_batch",
          summary: summaryList(`Changeset: ${commands.length} changes, all or nothing`, rows),
          payload: { atomic: true, commands },
          basis: claim.basis ?? "inferred",
          ...(claim.evidence ? { evidence: claim.evidence } : {})
        },
        { origin: "server" }
      )
    );
    return {
      mode: command.mode,
      ok: true,
      items: command.items.map((item) => ({
        intent: item.intent,
        outcome: "proposal" as const,
        commandId: commandIdOf(item),
        reason: floor.reason,
        instead: floor.instead,
        ...(command.mode === "apply" ? { proposalId: filed.proposal.id } : {})
      }))
    };
  } catch (error) {
    if (!(error instanceof AgentProposalError)) throw error;
    return refuseAll(
      () =>
        `${floor.reason} The proposal could not be filed (${error.status}): ${messageOf(error)} Nothing was applied. ` +
        (error.status === 429 || error.status === 409
          ? "Wait for the owner to confirm or reject what is already waiting, then send this set again."
          : `Reduce the set or split it.${split}`)
    );
  }
}

async function runItems(tx: TxSql, command: ChangesetCommand): Promise<ChangesetResult> {
  const actor = requestAgent();
  const baseClaim = requestClaim();
  const wholeSet = await floorWholeSet(tx, command);
  if (wholeSet !== null) return wholeSet;
  const items: ChangesetItemResult[] = [];
  const createdHere = new Set(command.items.flatMap((item) => (item.creates ? [item.creates.id] : [])));
  for (const item of command.items) {
    const commandId = typeof item.payload.commandId === "string" ? item.payload.commandId : undefined;
    // An id that is not a uuid would fail its cast in a lookup outside a savepoint and abort the whole transaction.
    if (!commandId || !isUuid(commandId)) {
      items.push({
        intent: item.intent,
        outcome: "invalid",
        commandId: commandId ?? "",
        message: "Every command in a changeset carries its own commandId, a UUID."
      });
      continue;
    }
    const claim = {
      ...baseClaim,
      ...(item.basis ? { basis: item.basis } : {}),
      ...(item.evidence ? { evidence: item.evidence } : {})
    };
    const decision = await decide(tx, item);
    if (decision.action === "deny") {
      items.push({ intent: item.intent, outcome: "invalid", commandId, message: decision.message });
      continue;
    }
    try {
      if (decision.action === "propose") {
        const kind = scopesForRoute("POST", item.path, item.payload);
        const replay = kind.kind === "scopes" && kind.command !== "close_entity" ? kind.command : undefined;
        if (replay === undefined) throw new InvalidCommandError("This write cannot be filed as a proposal.");
        const filed = await tx.savepoint((sp) =>
          proposeAgentChange(nestedPool(sp), actor, entityProposal(replay, item.payload, claim, decision.shadow), {
            origin: "server"
          })
        );
        items.push({
          intent: item.intent,
          outcome: "proposal",
          commandId,
          reason: decision.reason,
          ...(decision.instead ? { instead: decision.instead } : {}),
          ...(command.mode === "apply" ? { proposalId: filed.proposal.id } : {})
        });
        continue;
      }
      // A handler answers a command id it has a receipt for as already done, without running; inside a changeset
      // that would report another write as this set's own and make it a member that undo reverses.
      const used = await tx`SELECT 1 FROM writes WHERE id=${commandId}`;
      if (used.length > 0)
        throw new CommandConflictError(
          "That command id was already used by another write, so nothing was applied. Build the changeset again with a NEW command-id (a fresh uuid); each command inside it gets its own.",
          {
            nextCall: {
              tool: "rhen_changeset",
              arguments: { mode: "preview" },
              note: "start again from a preview with your changes and a new command-id"
            }
          }
        );
      await tx.savepoint((sp) =>
        runWithActor(
          actor,
          () => runItem(nestedPool(sp), item.path, item.payload),
          undefined,
          claim,
          requestScopes(),
          requestDirectWrites()
        )
      );
      const kept = await tx<
        { id: string }[]
      >`SELECT id FROM writes WHERE id=${commandId} AND images IS NOT NULL AND state IS NOT NULL`;
      const created = mayReadPlan() ? createdRecord(item) : undefined;
      const duplicates = created ? await likelyDuplicates(tx, created, createdHere) : [];
      items.push({
        intent: item.intent,
        outcome: "applies",
        commandId,
        undoable: kept.length > 0,
        ...(duplicates.length > 0 ? { likelyDuplicates: duplicates } : {})
      });
    } catch (error) {
      if (error instanceof CommandConflictError)
        items.push({ intent: item.intent, outcome: "conflict", commandId, message: messageOf(error) });
      else if (error instanceof AgentProposalError)
        items.push({
          intent: item.intent,
          outcome: error.status === 409 || error.status === 429 ? "conflict" : "invalid",
          commandId,
          status: error.status,
          message: messageOf(error)
        });
      else if (
        error instanceof InvalidCommandError ||
        error instanceof ForbiddenCommandError ||
        error instanceof NotFoundCommandError
      )
        items.push({ intent: item.intent, outcome: "invalid", commandId, message: messageOf(error) });
      else if (SQL_CONFLICTS.has(sqlStateOf(error)))
        items.push({ intent: item.intent, outcome: "conflict", commandId, message: messageOf(error) });
      else if (SQL_INVALID.has(sqlStateOf(error)))
        items.push({ intent: item.intent, outcome: "invalid", commandId, message: messageOf(error) });
      else throw error;
    }
  }
  return {
    mode: command.mode,
    ok: items.every((item) => item.outcome === "applies" || item.outcome === "proposal"),
    items
  };
}
