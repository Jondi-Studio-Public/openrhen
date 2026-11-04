import { databaseUrl } from "@/server/runtime-env";
import { sqlPool, type PoolSql } from "@/server/persistence/postgres/sql-pool";
import { NormalizedPostgresStateStore } from "@/server/persistence/postgres/state-store";
import { ensureUser } from "@/server/persistence/postgres/ensure-user";
import type { EntityCommandWithHash } from "@/server/persistence/postgres/entity-commands";
import type { ReenterResult } from "@/server/persistence/postgres/reenter";
import type { RecordDisruptionResult } from "@/server/persistence/postgres/pulse-disruption";
import { notifyStateChanged, pendingMigrationTags } from "@openrhen/database";
import type { PortalState } from "@/state/portal-state";
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
  StretchCommand,
  StretchResult,
  RecordDisruptionCommand,
  SettleCatchUpCommand,
  SettleCatchUpResult,
  SplitCommitmentSourceCommand,
  WakeCommand,
  WakeResult
} from "@openrhen/contracts";

export interface DatabaseHealth {
  provider: "postgresql";
  connected: boolean;
  version: string;
  latencyMs: number;
}

interface StateStore {
  get(): Promise<unknown | null>;
  put(state: unknown): Promise<void>;
  saveProject(command: SaveProjectCommand): Promise<PortalState>;
  confirmProjectWanted(command: ConfirmProjectWantedCommand): Promise<PortalState>;
  saveAction(command: SaveActionCommand): Promise<PortalState>;
  runSessionCommand(command: SessionCommand): Promise<PortalState>;
  runActivityCommand(command: ActivityCommand): Promise<PortalState>;
  runWakeCommand(command: WakeCommand): Promise<{ wake: WakeResult | null; state: PortalState }>;
  runStretchCommand(command: StretchCommand): Promise<{ result: StretchResult; state: PortalState }>;
  runCheckInCommand(command: CheckInCommand): Promise<PortalState>;
  runRevertCommand(command: RevertCommand): Promise<PortalState>;
  runChangeset(command: ChangesetCommand): Promise<ChangesetResult>;
  recalculate(command: RecalculateCommand): Promise<PortalState>;
  saveEntity(command: EntityCommandWithHash): Promise<PortalState>;
  splitCommitmentSource(command: SplitCommitmentSourceCommand): Promise<PortalState>;
  saveCommitmentRecurrenceRule(command: SaveCommitmentRecurrenceRuleCommand): Promise<PortalState>;
  endRecurrenceGoal(command: EndRecurrenceGoalCommand): Promise<PortalState>;
  recordCadenceCompletion(command: RecordCadenceCompletionCommand): Promise<PortalState>;
  settleCatchUp(command: SettleCatchUpCommand): Promise<{ result: SettleCatchUpResult; state: PortalState }>;
  reenter(command: ReenterCommand): Promise<{ result: ReenterResult; state: PortalState }>;
  recordDisruption(command: RecordDisruptionCommand): Promise<{ result: RecordDisruptionResult; state: PortalState }>;
  health(): Promise<DatabaseHealth>;
  /** Whether `commandId` already has a `writes` row — see `NormalizedPostgresStateStore`. */
  hasCommandReceipt(commandId: string): Promise<boolean>;
  /**
   * Whether `receipt.id` has a receipt for this write: false when it has none, and `CommandIdReusedError` (409) when
   * the id belongs to a different write (another command type or request hash).
   */
  hasCommandReceiptFor(receipt: { id: string; commandType: string; requestHash: string }): Promise<boolean>;
  /** Whether the write kept row images that a revert can put back. */
  hasSnapshot(commandId: string): Promise<boolean>;
}

class PostgresStateStore implements StateStore {
  constructor(private readonly connectionString: string) {}

  /**
   * Runs one operation on the process-wide pool for this connection string. Nothing is closed
   * afterwards: the pool is meant to outlive the request, and ending it here would put a fresh
   * TCP and TLS handshake in front of every call.
   */
  private withClient<T>(operation: (sql: PoolSql) => Promise<T>): Promise<T> {
    return operation(sqlPool(this.connectionString));
  }

  /**
   * Like `withClient`, but for every command that writes. `NormalizedPostgresStateStore`'s own
   * methods each open and commit their own `sql.begin(...)` before this returns, so by the time
   * `operation` resolves the write is already durable — exactly when a listening tab should be told
   * about it, and never when `operation` rejects (a failed command notifies nobody).
   *
   * `ensureUser` costs one more indexed read of a single-row table (behind its own advisory lock) to
   * learn the id every command here already resolved once internally — cheap at this portal's
   * household scale, and simpler than threading the id back out of every command's return shape. A
   * `NOTIFY` failure is only logged (see `notifyStateChanged`), so it can never turn a successful
   * write into a failed request.
   */
  private async withWriteClient<T>(operation: (sql: PoolSql) => Promise<T>): Promise<T> {
    const sql = sqlPool(this.connectionString);
    const result = await operation(sql);
    try {
      const userId = await ensureUser(sql);
      notifyStateChanged(sql, { userId, kind: "state" });
    } catch (error) {
      console.error("PostgresStateStore.withWriteClient: could not notify state_changed", error);
    }
    return result;
  }

  get() {
    return this.withClient((sql) => new NormalizedPostgresStateStore(sql).get());
  }

  put(state: unknown) {
    return this.withWriteClient((sql) => new NormalizedPostgresStateStore(sql).put(state as PortalState));
  }

  saveProject(command: SaveProjectCommand) {
    return this.withWriteClient((sql) => new NormalizedPostgresStateStore(sql).saveProject(command));
  }

  confirmProjectWanted(command: ConfirmProjectWantedCommand) {
    return this.withWriteClient((sql) => new NormalizedPostgresStateStore(sql).confirmProjectWanted(command));
  }

  saveAction(command: SaveActionCommand) {
    return this.withWriteClient((sql) => new NormalizedPostgresStateStore(sql).saveAction(command));
  }

  runSessionCommand(command: SessionCommand) {
    return this.withWriteClient((sql) => new NormalizedPostgresStateStore(sql).runSessionCommand(command));
  }
  runActivityCommand(command: ActivityCommand) {
    return this.withWriteClient((sql) => new NormalizedPostgresStateStore(sql).runActivityCommand(command));
  }

  runWakeCommand(command: WakeCommand) {
    return this.withWriteClient((sql) => new NormalizedPostgresStateStore(sql).runWakeCommand(command));
  }

  runStretchCommand(command: StretchCommand) {
    return this.withWriteClient((sql) => new NormalizedPostgresStateStore(sql).runStretchCommand(command));
  }

  runCheckInCommand(command: CheckInCommand) {
    return this.withWriteClient((sql) => new NormalizedPostgresStateStore(sql).runCheckInCommand(command));
  }

  runRevertCommand(command: RevertCommand) {
    return this.withWriteClient((sql) => new NormalizedPostgresStateStore(sql).runRevertCommand(command));
  }

  runChangeset(command: ChangesetCommand) {
    return command.mode === "apply"
      ? this.withWriteClient((sql) => new NormalizedPostgresStateStore(sql).runChangeset(command))
      : this.withClient((sql) => new NormalizedPostgresStateStore(sql).runChangeset(command));
  }

  recalculate(command: RecalculateCommand) {
    return this.withWriteClient((sql) => new NormalizedPostgresStateStore(sql).recalculate(command));
  }

  saveEntity(command: EntityCommandWithHash) {
    return this.withWriteClient((sql) => new NormalizedPostgresStateStore(sql).saveEntity(command));
  }

  splitCommitmentSource(command: SplitCommitmentSourceCommand) {
    return this.withWriteClient((sql) => new NormalizedPostgresStateStore(sql).splitCommitmentSource(command));
  }

  saveCommitmentRecurrenceRule(command: SaveCommitmentRecurrenceRuleCommand) {
    return this.withWriteClient((sql) => new NormalizedPostgresStateStore(sql).saveCommitmentRecurrenceRule(command));
  }

  endRecurrenceGoal(command: EndRecurrenceGoalCommand) {
    return this.withWriteClient((sql) => new NormalizedPostgresStateStore(sql).endRecurrenceGoal(command));
  }

  recordCadenceCompletion(command: RecordCadenceCompletionCommand) {
    return this.withWriteClient((sql) => new NormalizedPostgresStateStore(sql).recordCadenceCompletion(command));
  }

  settleCatchUp(command: SettleCatchUpCommand) {
    return this.withWriteClient((sql) => new NormalizedPostgresStateStore(sql).settleCatchUp(command));
  }

  recordDisruption(command: RecordDisruptionCommand) {
    return this.withWriteClient((sql) => new NormalizedPostgresStateStore(sql).recordDisruption(command));
  }

  reenter(command: ReenterCommand) {
    return this.withWriteClient((sql) => new NormalizedPostgresStateStore(sql).reenter(command));
  }

  hasCommandReceipt(commandId: string) {
    return this.withClient((sql) => new NormalizedPostgresStateStore(sql).hasCommandReceipt(commandId));
  }

  hasCommandReceiptFor(receipt: { id: string; commandType: string; requestHash: string }) {
    return this.withClient((sql) => new NormalizedPostgresStateStore(sql).hasCommandReceiptFor(receipt));
  }

  hasSnapshot(commandId: string) {
    return this.withClient((sql) => new NormalizedPostgresStateStore(sql).hasSnapshot(commandId));
  }

  health() {
    const started = performance.now();
    return this.withClient(async (sql) => {
      const result = await sql<{ version: string }[]>`SELECT version() AS version`;
      const pending = await pendingMigrationTags(sql as never);
      if (pending.length) {
        throw Object.assign(
          new Error(
            `${pending.length} database migration${pending.length === 1 ? " is" : "s are"} pending (${pending.join(", ")}); run db:migrate`
          ),
          { code: "MIGRATIONS_PENDING" }
        );
      }
      return {
        provider: "postgresql" as const,
        connected: true,
        version: result[0]?.version ?? "PostgreSQL",
        latencyMs: Math.round(performance.now() - started)
      };
    });
  }
}

export function getStateStore(): StateStore {
  const connectionString = databaseUrl();
  if (!connectionString) throw new Error("The persistent database is unavailable: DATABASE_URL is not set.");
  return new PostgresStateStore(connectionString);
}
