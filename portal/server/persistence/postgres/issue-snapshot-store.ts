import {
  ISSUE_SNAPSHOT_FORMAT_VERSION,
  issueSnapshotSchema,
  planningRuntimeStateSchema,
  type IssueSnapshot,
  type IssueSnapshotObservation,
  type IssueSnapshotReview,
  type IssueSnapshotSummary
} from "@openrhen/contracts";
import { PLAN_FORECAST_JOB_TYPE, checkIns, issueSnapshots, jobs, planningRuns, writeRows } from "@openrhen/database";
import { probeEngine } from "@/server/diagnostics/engine-probe";
import { databaseUrl } from "@/server/runtime-env";
import type { Row } from "./db-row";
import { sqlPool, type PoolSql, type Sql } from "./sql-pool";
import { ensureUser, NormalizedPostgresStateStore } from "./state-store";

const JOB_HISTORY_LIMIT = 20;
const CHANGE_LOG_LIMIT = 50;

type SummaryRow = Row<
  typeof issueSnapshots,
  | "id"
  | "description"
  | "captured_at"
  | "observed_at"
  | "panel_mode"
  | "planning_status"
  | "engine_input_version"
  | "size_bytes"
  | "reviewed_at"
  | "review_note"
>;

const SUMMARY_COLUMNS = (sql: Sql) => sql`
  SELECT id, description, captured_at, observed_at, panel_mode, planning_status, engine_input_version, size_bytes, reviewed_at, review_note
  FROM issue_snapshots
`;

const toSummary = (row: SummaryRow): IssueSnapshotSummary =>
  ({
    id: row.id,
    description: row.description,
    capturedAt: new Date(row.captured_at).toISOString(),
    observedAt: new Date(row.observed_at).toISOString(),
    mode: row.panel_mode,
    planningStatus: row.planning_status,
    engineInputVersion: row.engine_input_version,
    sizeBytes: Number(row.size_bytes),
    reviewedAt: row.reviewed_at ? new Date(row.reviewed_at).toISOString() : null,
    reviewNote: row.review_note
  }) as IssueSnapshotSummary;

/** A capture that aborts on the first oddity is useless — oddity is what it exists to record. */
async function attempt<T>(warnings: string[], label: string, operation: () => Promise<T>): Promise<T | null> {
  try {
    return await operation();
  } catch (error) {
    warnings.push(`${label}: ${error instanceof Error ? error.message : "unknown error"}`.slice(0, 300));
    return null;
  }
}

const iso = (value: Date | null | undefined) => (value ? new Date(value).toISOString() : null);

export class PostgresIssueSnapshotStore {
  constructor(private readonly sql: PoolSql) {}

  /**
   * Freezes one moment: authoritative state, the engine input and output behind the plan on screen,
   * the job queue, recent changes, and the browser's own account of what it was rendering.
   *
   * Both the server's state and the client's copy are kept. The browser polls, so a divergence
   * between them is a real and otherwise invisible bug class.
   */
  async capture(observation: IssueSnapshotObservation): Promise<{ id: string; warnings: string[] }> {
    const warnings: string[] = [];
    const userId = await ensureUser(this.sql);
    const readAt = new Date().toISOString();

    const serverState = await attempt(warnings, "authoritative state", () =>
      new NormalizedPostgresStateStore(this.sql).get()
    );

    const runRow = await attempt(warnings, "planning run", async () => {
      const rows = await this.sql<
        Row<
          typeof planningRuns,
          | "request_id"
          | "input_version"
          | "contract_version"
          | "engine_version"
          | "calculated_at"
          | "valid_until"
          | "created_at"
          | "result"
        >[]
      >`
        SELECT request_id, input_version, contract_version, engine_version, calculated_at, valid_until, created_at, result
        FROM planning_runs WHERE user_id=${userId} AND superseded_at IS NULL
        ORDER BY calculated_at DESC LIMIT 1
      `;
      return rows[0] ?? null;
    });
    if (!runRow) warnings.push("No current planning run exists for this user.");

    const engineInput = await this.readEngineRequest(warnings, userId, runRow?.input_version ?? null);

    const jobRows =
      (await attempt(
        warnings,
        "job history",
        async () => this.sql<
          (Row<
            typeof jobs,
            | "id"
            | "status"
            | "attempts"
            | "payload"
            | "available_at"
            | "created_at"
            | "locked_at"
            | "locked_by"
            | "last_error_code"
            | "last_error_message"
          > & {
            // Narrowed from `jsonb`: the `type = PLAN_FORECAST_JOB_TYPE` filter selects only jobs whose payload has this shape.
            payload: { cause?: string; request?: { inputVersion?: string } } | null;
          })[]
        >`
      SELECT id, status, attempts, payload, available_at, created_at, locked_at, locked_by, last_error_code, last_error_message
      FROM jobs WHERE type=${PLAN_FORECAST_JOB_TYPE} AND payload->>'userId'=${userId}
      ORDER BY created_at DESC LIMIT ${JOB_HISTORY_LIMIT}
    `
      )) ?? [];

    const changeRows =
      (await attempt(
        warnings,
        "change log",
        async () => this.sql<Row<typeof writeRows, "id" | "entity_type" | "entity_id" | "operation" | "created_at">[]>`
      SELECT id, entity_type, entity_id, operation, created_at FROM write_rows
      WHERE user_id=${userId} ORDER BY created_at DESC LIMIT ${CHANGE_LOG_LIMIT}
    `
      )) ?? [];

    // Check-in answers write `check_in` alone (plan invariant 5: record-only, no `write_rows` row).
    // Folded in here as change-log-shaped entries so a snapshot still shows recent answers.
    const checkInRows =
      (await attempt(
        warnings,
        "answered check-ins",
        async () => this.sql<
          // `WHERE answered_at IS NOT NULL` below guarantees the timestamp.
          (Row<typeof checkIns, "id" | "status"> & { answered_at: Date })[]
        >`
      SELECT id, status, answered_at FROM check_in
      WHERE user_id=${userId} AND answered_at IS NOT NULL ORDER BY answered_at DESC LIMIT ${CHANGE_LOG_LIMIT}
    `
      )) ?? [];

    const database = await attempt(warnings, "database health", async () => {
      const started = performance.now();
      const rows = await this.sql<{ version: string }[]>`SELECT version() AS version`;
      return {
        provider: "postgresql",
        connected: true,
        version: rows[0]?.version ?? "PostgreSQL",
        latencyMs: Math.round(performance.now() - started)
      };
    });
    const engine = await attempt(warnings, "engine health", () => probeEngine());

    // The identifier is chosen here rather than by the insert so the stored blob, the row, and every
    // exported copy of the file all carry the same one.
    const id = crypto.randomUUID();
    const { description, ...client } = observation;

    const snapshot: IssueSnapshot = issueSnapshotSchema.parse({
      formatVersion: ISSUE_SNAPSHOT_FORMAT_VERSION,
      id,
      description,
      capturedAt: readAt,
      client,
      server: {
        readAt,
        state: json(serverState),
        engineRequest: engineInput.request,
        engineRequestSource: engineInput.source,
        planningRun: runRow
          ? {
              requestId: runRow.request_id,
              inputVersion: runRow.input_version,
              contractVersion: runRow.contract_version,
              engineVersion: runRow.engine_version,
              calculatedAt: new Date(runRow.calculated_at).toISOString(),
              validUntil: new Date(runRow.valid_until).toISOString(),
              createdAt: iso(runRow.created_at),
              result: json(runRow.result)
            }
          : null,
        jobs: jobRows.map((row) => ({
          id: row.id,
          status: row.status,
          attempts: row.attempts,
          // Job payloads carry a full planning request each. Only the cause and input version are
          // kept here; the one request that matters is already in `engineRequest`.
          cause: row.payload?.cause ?? null,
          inputVersion: row.payload?.request?.inputVersion ?? null,
          availableAt: iso(row.available_at),
          createdAt: iso(row.created_at),
          lockedAt: iso(row.locked_at),
          lockedBy: row.locked_by,
          lastErrorCode: row.last_error_code,
          lastErrorMessage: row.last_error_message
        })),
        changeLog: [
          ...changeRows.map((row) => ({
            id: row.id,
            entityType: row.entity_type,
            entityId: row.entity_id,
            operation: row.operation,
            createdAt: new Date(row.created_at).toISOString()
          })),
          ...checkInRows.map((row) => ({
            id: row.id,
            entityType: "check_in",
            entityId: row.id,
            operation: "answer",
            status: row.status,
            source: "check_in",
            createdAt: new Date(row.answered_at).toISOString()
          }))
        ]
          .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
          .slice(0, CHANGE_LOG_LIMIT),
        health: { database: json(database), engine: json(engine) }
      },
      warnings
    });

    const sizeBytes = new TextEncoder().encode(JSON.stringify(snapshot)).byteLength;
    await this.sql`
      INSERT INTO issue_snapshots (id, user_id, observed_at, description, format_version, panel_mode, planning_status, engine_input_version, size_bytes, snapshot)
      VALUES (${id}, ${userId}, ${observation.observedAt}, ${description}, ${ISSUE_SNAPSHOT_FORMAT_VERSION}, ${observation.view.mode}, ${planningStatusOf(serverState)}, ${runRow?.input_version ?? null}, ${sizeBytes}, ${this.sql.json(snapshot as never)})
    `;
    return { id, warnings };
  }

  /**
   * The engine input lives in the job that carried it, keyed by the input version of the run it
   * produced. Falling back to the newest job is deliberate: a snapshot whose engine input is one
   * recalculation out of date still beats none, provided it says so.
   */
  private async readEngineRequest(
    warnings: string[],
    userId: string,
    inputVersion: string | null
  ): Promise<{ request: unknown; source: "matching_job" | "latest_job" | "unavailable" }> {
    if (inputVersion) {
      const matched = await attempt(warnings, "engine input", async () => {
        const rows = await this.sql<(Row<typeof jobs, "payload"> & { payload: { request?: unknown } })[]>`
          SELECT payload FROM jobs WHERE idempotency_key=${`${PLAN_FORECAST_JOB_TYPE}:${userId}:${inputVersion}`} LIMIT 1
        `;
        return rows[0]?.payload?.request ?? null;
      });
      if (matched) return { request: json(matched), source: "matching_job" };
    }
    const latest = await attempt(warnings, "engine input fallback", async () => {
      const rows = await this.sql<(Row<typeof jobs, "payload"> & { payload: { request?: unknown } })[]>`
        SELECT payload FROM jobs WHERE type=${PLAN_FORECAST_JOB_TYPE} AND payload->>'userId'=${userId}
        ORDER BY created_at DESC LIMIT 1
      `;
      return rows[0]?.payload?.request ?? null;
    });
    if (latest) {
      warnings.push(
        inputVersion
          ? `No job carries input version ${inputVersion}; the newest available engine input was captured instead.`
          : "No planning run to match; the newest available engine input was captured instead."
      );
      return { request: json(latest), source: "latest_job" };
    }
    warnings.push("No engine input could be recovered. Engine replay is not possible from this snapshot.");
    return { request: null, source: "unavailable" };
  }

  /** Outstanding reports first, then the closed ones — the list is a work queue, not an archive. */
  async list(limit = 50): Promise<IssueSnapshotSummary[]> {
    const userId = await ensureUser(this.sql);
    const rows = await this.sql<SummaryRow[]>`
      ${SUMMARY_COLUMNS(this.sql)} WHERE user_id=${userId}
      ORDER BY (reviewed_at IS NOT NULL), captured_at DESC LIMIT ${limit}
    `;
    return rows.map(toSummary);
  }

  /**
   * Records the verdict on a report, or reopens one closed too early.
   *
   * Only the verdict is writable. The captured evidence is never touched, so a closed report still
   * replays exactly as it was reported — which is the only reason closing one is safe to do.
   */
  async review(id: string, input: IssueSnapshotReview): Promise<IssueSnapshotSummary | null> {
    const userId = await ensureUser(this.sql);
    const rows = await this.sql<SummaryRow[]>`
      UPDATE issue_snapshots
      SET reviewed_at=${input.reviewed ? new Date() : null},
          review_note=${input.reviewed && input.note?.length ? input.note : null}
      WHERE id=${id} AND user_id=${userId}
      RETURNING id, description, captured_at, observed_at, panel_mode, planning_status, engine_input_version, size_bytes, reviewed_at, review_note
    `;
    return rows[0] ? toSummary(rows[0]) : null;
  }

  async get(id: string): Promise<IssueSnapshot | null> {
    const userId = await ensureUser(this.sql);
    const rows = await this.sql<
      Row<typeof issueSnapshots, "snapshot">[]
    >`SELECT snapshot FROM issue_snapshots WHERE id=${id} AND user_id=${userId} LIMIT 1`;
    return rows[0] ? (rows[0].snapshot as IssueSnapshot) : null;
  }
}

/** Strips class instances, `undefined`, and dates down to the plain JSON the contract accepts. */
function json(value: unknown) {
  return value === null || value === undefined ? null : (JSON.parse(JSON.stringify(value)) as never);
}

function planningStatusOf(state: unknown): string | null {
  const planning = state && typeof state === "object" ? (state as { planning?: unknown }).planning : null;
  const parsed = planningRuntimeStateSchema.safeParse(planning);
  return parsed.success ? parsed.data.status : null;
}

export async function withIssueSnapshotStore<T>(
  operation: (store: PostgresIssueSnapshotStore) => Promise<T>
): Promise<T> {
  const connectionString = databaseUrl();
  if (!connectionString) throw new Error("Issue snapshots require PostgreSQL.");
  return operation(new PostgresIssueSnapshotStore(sqlPool(connectionString)));
}
