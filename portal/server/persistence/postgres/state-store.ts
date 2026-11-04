import type {
  ActivityCommand,
  ChangesetCommand,
  ChangesetResult,
  CheckInCommand,
  ConfirmProjectWantedCommand,
  EndRecurrenceGoalCommand,
  RecalculateCommand,
  RecordCadenceCompletionCommand,
  RevertCommand,
  SaveActionCommand,
  SaveCommitmentRecurrenceRuleCommand,
  SaveProjectCommand,
  SessionCommand,
  ReenterCommand,
  RecordDisruptionCommand,
  SettleCatchUpCommand,
  SettleCatchUpResult,
  SplitCommitmentSourceCommand,
  WakeCommand,
  WakeResult
} from "@openrhen/contracts";
import type { PortalState } from "@/state/portal-state";
import { runActivityCommand } from "./activity-commands";
import { runChangeset } from "./changeset-commands";
import { runCheckInCommand } from "./check-in-commands";
import { splitCommitmentSource } from "./commitment-source-commands";
import { hasCommandReceipt } from "./command-receipt";
import { saveEntity, type EntityCommandWithHash } from "./entity-commands";
import { ensureUser } from "./ensure-user";
import { recalculate, recordStateChange } from "./planning-evidence";
import { withCommandRetry } from "./command-retry";
import { confirmProjectWanted, saveAction, saveProject } from "./project-commands";
import { settleCatchUp } from "./catch-up";
import { recordDisruption, type RecordDisruptionResult } from "./pulse-disruption";
import { reenter, type ReenterResult } from "./reenter";
import { endRecurrenceGoal, recordCadenceCompletion, saveCommitmentRecurrenceRule } from "./recurrence-commands";
import { runRevertCommand } from "./write-revert";
import { runSessionCommand } from "./session-commands";
import { runWakeCommand } from "./wake-command";
import type { PoolSql } from "./sql-pool";
import { readStateAfterCommit } from "./read-after-commit";
import { readPortalState } from "./state-read";
import { replaceState } from "./state-replace";

/**
 * The normalised PostgreSQL store: one object bound to a connection, forwarding to the command
 * handler that owns each aggregate. The handlers live beside it — `state-read.ts` hydrates the whole
 * document, and each `*-commands.ts` module holds the writes for one part of the model.
 *
 * Bound to `PoolSql`, not the permissive `Sql`, because `put()` opens its own transaction: a
 * transaction handle passed in here (a caller already running its own `sql.begin`) is now a `tsc`
 * error rather than the `TypeError: sql.begin is not a function` that shipped once (see sql-pool.ts).
 *
 * Every command method runs under `withCommandRetry`, so a transaction Postgres kills as a deadlock
 * victim (40P01, e.g. against the plan-forecast worker's publish) is run again, not a 500.
 */
export class NormalizedPostgresStateStore {
  constructor(private readonly sql: PoolSql) {}

  get(): Promise<PortalState | null> {
    return readPortalState(this.sql);
  }

  async put(state: PortalState): Promise<void> {
    const userId = await ensureUser(this.sql);
    await this.sql.begin(async (tx) => {
      await replaceState(tx, userId, state);
      await recordStateChange(tx, userId, { entityType: "state", operation: "replace", at: new Date() });
    });
  }

  saveProject(command: SaveProjectCommand): Promise<PortalState> {
    return withCommandRetry(() => saveProject(this.sql, command));
  }

  confirmProjectWanted(command: ConfirmProjectWantedCommand): Promise<PortalState> {
    return withCommandRetry(() => confirmProjectWanted(this.sql, command));
  }

  saveAction(command: SaveActionCommand): Promise<PortalState> {
    return withCommandRetry(() => saveAction(this.sql, command));
  }

  saveCommitmentRecurrenceRule(command: SaveCommitmentRecurrenceRuleCommand): Promise<PortalState> {
    return withCommandRetry(() => saveCommitmentRecurrenceRule(this.sql, command));
  }

  endRecurrenceGoal(command: EndRecurrenceGoalCommand): Promise<PortalState> {
    return withCommandRetry(() => endRecurrenceGoal(this.sql, command));
  }

  recordCadenceCompletion(command: RecordCadenceCompletionCommand): Promise<PortalState> {
    return withCommandRetry(() => recordCadenceCompletion(this.sql, command));
  }

  async settleCatchUp(command: SettleCatchUpCommand): Promise<{ result: SettleCatchUpResult; state: PortalState }> {
    const result = await withCommandRetry(() => settleCatchUp(this.sql, command));
    return { result, state: await readStateAfterCommit(this.sql) };
  }

  async recordDisruption(
    command: RecordDisruptionCommand
  ): Promise<{ result: RecordDisruptionResult; state: PortalState }> {
    const result = await recordDisruption(this.sql, command);
    return { result, state: await readStateAfterCommit(this.sql) };
  }

  async reenter(command: ReenterCommand): Promise<{ result: ReenterResult; state: PortalState }> {
    const result = await reenter(this.sql, command);
    return { result, state: await readStateAfterCommit(this.sql) };
  }

  runSessionCommand(command: SessionCommand): Promise<PortalState> {
    return withCommandRetry(() => runSessionCommand(this.sql, command));
  }

  runActivityCommand(command: ActivityCommand): Promise<PortalState> {
    return withCommandRetry(() => runActivityCommand(this.sql, command));
  }

  runWakeCommand(command: WakeCommand): Promise<{ wake: WakeResult | null; state: PortalState }> {
    return runWakeCommand(this.sql, command);
  }

  runCheckInCommand(command: CheckInCommand): Promise<PortalState> {
    return withCommandRetry(() => runCheckInCommand(this.sql, command));
  }

  runRevertCommand(command: RevertCommand): Promise<PortalState> {
    return withCommandRetry(() => runRevertCommand(this.sql, command));
  }

  runChangeset(command: ChangesetCommand): Promise<ChangesetResult> {
    return runChangeset(this.sql, command);
  }

  recalculate(command: RecalculateCommand): Promise<PortalState> {
    return withCommandRetry(() => recalculate(this.sql, command));
  }

  saveEntity(command: EntityCommandWithHash): Promise<PortalState> {
    return withCommandRetry(() => saveEntity(this.sql, command));
  }

  splitCommitmentSource(command: SplitCommitmentSourceCommand): Promise<PortalState> {
    return withCommandRetry(() => splitCommitmentSource(this.sql, command));
  }

  /**
   * Whether the write `commandId` kept row images, so `POST /api/commands/revert` can undo it. A write that changed
   * nothing keeps none, and the route then does not claim it is revertible.
   */
  async hasSnapshot(commandId: string): Promise<boolean> {
    const userId = await ensureUser(this.sql);
    const rows = await this.sql<
      { id: string }[]
    >`SELECT id FROM writes WHERE id=${commandId} AND user_id=${userId} AND images IS NOT NULL AND state IS NOT NULL`;
    return rows.length > 0;
  }

  /**
   * Whether `commandId` already has a row in `writes` — the same check every `run*Command`
   * and `saveEntity` makes internally before deciding whether to apply a write, exposed standalone for
   * `POST /api/device/action` (`device-now.ts`'s `resolveDeviceCommandId`). The device route needs the
   * answer *before* it evaluates any state-based precondition ("something startable", "something being
   * tracked"): a write that landed but whose response never reached the device leaves those
   * preconditions false on the retry even though the retry names the same command, and asking the
   * command handler would never get the chance to say "already done" — the route's own precondition
   * would refuse the retry first.
   */
  async hasCommandReceiptFor(receipt: { id: string; commandType: string; requestHash: string }): Promise<boolean> {
    const userId = await ensureUser(this.sql);
    return hasCommandReceipt(this.sql, { ...receipt, userId });
  }

  async hasCommandReceipt(commandId: string): Promise<boolean> {
    const userId = await ensureUser(this.sql);
    const rows = await this.sql<{ id: string }[]>`SELECT id FROM writes WHERE id=${commandId} AND user_id=${userId}`;
    return rows.length > 0;
  }
}

// Kept exported from here because route handlers and the sibling stores already import them from
// this module; the definitions now live with the code that raises and uses them.
export { CommandConflictError, InvalidCommandError } from "./command-errors";
export { ensureUser } from "./ensure-user";
export type { Sql } from "./sql-pool";
