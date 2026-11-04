import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import { PLAN_FORECAST_JOB_TYPE } from "./plan-forecast-runtime.js";
import { integrationDatabaseName } from "../operations/integration-database.js";
import {
  defaultPlanningRetentionConfig,
  pruneExpiredPlanningEvidence,
  type PlanningRetentionConfig
} from "./plan-retention.js";

config({ path: resolve(process.cwd(), "../../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
// A database of its own, not the portal's `_test` one: these suites truncate, and two suites
// truncating the same database concurrently is a flake nobody can reproduce afterwards.
const testDatabaseName = integrationDatabaseName(process.env.RETENTION_TEST_DATABASE_NAME, "openrhen_retention");

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("RETENTION_TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

const DAY = 86_400_000;
const HOUR = 3_600_000;
const now = Date.now();
const daysAgo = (days: number) => new Date(now - days * DAY);
const hoursAgo = (hours: number) => new Date(now - hours * HOUR);

let sql: postgres.Sql;
let userId: string;
let projectId: string;

const retention = (overrides: Partial<PlanningRetentionConfig> = {}): PlanningRetentionConfig => ({
  ...defaultPlanningRetentionConfig,
  ...overrides
});

async function insertJob(input: {
  status: string;
  createdAt: Date;
  inputVersion?: string;
  owner?: string;
}): Promise<string> {
  const inputVersion = input.inputVersion ?? crypto.randomUUID();
  const owner = input.owner ?? userId;
  const rows = await sql<{ id: string }[]>`
    INSERT INTO jobs (type, payload, idempotency_key, status, created_at, completed_at)
    VALUES (
      ${PLAN_FORECAST_JOB_TYPE},
      ${sql.json({ userId: owner, cause: "command", request: { inputVersion } } as never)},
      ${`${PLAN_FORECAST_JOB_TYPE}:${owner}:${inputVersion}`},
      ${input.status},
      ${input.createdAt},
      ${input.status === "completed" ? input.createdAt : null}
    )
    RETURNING id
  `;
  return rows[0]!.id;
}

async function insertRun(input: { calculatedAt: Date; superseded: boolean }): Promise<string> {
  const requestId = crypto.randomUUID();
  const rows = await sql<{ id: string; request_id: string }[]>`
    INSERT INTO planning_runs (user_id, request_id, input_version, contract_version, engine_version, calculated_at, valid_until, result, superseded_at)
    VALUES (${userId}, ${requestId}, ${crypto.randomUUID()}, '1', '1', ${input.calculatedAt}, ${new Date(input.calculatedAt.getTime() + 3_600_000)}, ${sql.json({ requestId } as never)}, ${input.superseded ? input.calculatedAt : null})
    RETURNING id, request_id
  `;
  return rows[0]!.id;
}

async function insertRecommendation(input: { calculatedAt: Date; superseded: boolean }): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO recommendations (user_id, calculated_at, valid_until, input_version, kind, headline, explanation, superseded_at)
    VALUES (${userId}, ${input.calculatedAt}, ${new Date(input.calculatedAt.getTime() + 3_600_000)}, ${crypto.randomUUID()}, 'action', 'Do the thing', 'Because it is due.', ${input.superseded ? input.calculatedAt : null})
    RETURNING id
  `;
  const id = rows[0]!.id;
  await sql`
    INSERT INTO recommendation_candidates (recommendation_id, target_type, target_id, rank, total_score, score_components, eligible)
    VALUES (${id}, 'action', ${crypto.randomUUID()}, 1, 10, ${sql.json({} as never)}, true)
  `;
  return id;
}

async function insertForecast(calculatedAt: Date) {
  await sql`
    INSERT INTO forecast_snapshots (project_id, calculated_at, input_version, health)
    VALUES (${projectId}, ${calculatedAt}, ${crypto.randomUUID()}, 'on_track')
  `;
}

async function insertIssueSnapshot(input: { jobIds: string[]; requestId: string | null; inputVersion: string | null }) {
  const snapshot = {
    server: {
      jobs: input.jobIds.map((id) => ({ id, status: "completed" })),
      planningRun: input.requestId ? { requestId: input.requestId } : null
    }
  };
  await sql`
    INSERT INTO issue_snapshots (user_id, observed_at, description, format_version, panel_mode, engine_input_version, size_bytes, snapshot)
    VALUES (${userId}, ${daysAgo(0)}, 'The plan was wrong.', '1', 'recommendation', ${input.inputVersion}, 100, ${sql.json(snapshot as never)})
  `;
}

/**
 * A receipt, optionally with the `write_rows` row the portal writes for it in the same transaction.
 * Every command path today writes one, which is exactly why the audited case has to stay safe.
 */
async function insertReceipt(input: { createdAt: Date; audited: boolean; response?: unknown }): Promise<string> {
  const id = crypto.randomUUID();
  await sql`
    INSERT INTO writes (id, user_id, command_type, response, created_at)
    VALUES (${id}, ${userId}, 'save_action', ${sql.json((input.response ?? {}) as never)}, ${input.createdAt})
  `;
  if (input.audited)
    await sql`
      INSERT INTO write_rows (user_id, write_id, entity_type, entity_id, operation, created_at)
      VALUES (${userId}, ${id}, 'action', ${crypto.randomUUID()}, 'save', ${input.createdAt})
    `;
  return id;
}

async function insertProviderTelemetry(startedAt: Date): Promise<void> {
  await sql`
    INSERT INTO provider_call_telemetry (provider, operation, kind, started_at, ok)
    VALUES ('openai', 'extract_contract', 'real_call', ${startedAt}, true)
  `;
}

const providerTelemetryCount = async () =>
  (await sql<{ count: string }[]>`SELECT count(*) FROM provider_call_telemetry`)[0]!.count;

async function insertJourneySample(observedAt: Date): Promise<void> {
  await sql`
    INSERT INTO journey_samples
      (user_id, origin_location_id, destination_location_id, mode, minutes, departed_at, observed_at, source)
    VALUES (${userId}, 'home', 'office', 'car', 20, ${observedAt}, ${observedAt}, 'google')
  `;
}

const journeySampleCount = async () => (await sql<{ count: string }[]>`SELECT count(*) FROM journey_samples`)[0]!.count;

async function insertPushOutboxRow(createdAt: Date): Promise<void> {
  await sql`
    INSERT INTO push_outbox (user_id, dedupe_key, kind, payload, status, expires_at, created_at)
    VALUES (${userId}, ${`leave_by:c1:2026-09-26T08:30:00.000Z:${createdAt.toISOString()}`}, 'reminder',
      ${sql.json({ title: "t", body: "b", tag: "x", url: "/now" })}, 'sent', ${createdAt}, ${createdAt})
  `;
}

const pushOutboxCount = async () => (await sql<{ count: string }[]>`SELECT count(*) FROM push_outbox`)[0]!.count;

const jobIds = async () => (await sql<{ id: string }[]>`SELECT id FROM jobs`).map((row) => row.id);
const receiptIds = async () => (await sql<{ id: string }[]>`SELECT id FROM writes`).map((row) => row.id);
const responseOf = async (id: string) =>
  (await sql<{ response: unknown }[]>`SELECT response FROM writes WHERE id=${id}`)[0]?.response ?? null;
const changeLogRows = async () =>
  (await sql<{ id: string; write_id: string }[]>`SELECT id, write_id FROM write_rows ORDER BY id`).map((row) => ({
    id: row.id,
    commandId: row.write_id
  }));
const requestOf = async (id: string) =>
  (await sql<{ request: unknown }[]>`SELECT payload->'request' AS request FROM jobs WHERE id=${id}`)[0]?.request ??
  null;
const runIds = async () => (await sql<{ id: string }[]>`SELECT id FROM planning_runs`).map((row) => row.id);

beforeAll(async () => {
  const admin = postgres(adminUrl!, { max: 1, connect_timeout: 10 });
  try {
    const existing = await admin<
      { exists: boolean }[]
    >`SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = ${testDatabaseName}) AS exists`;
    if (!existing[0]?.exists) await admin.unsafe(`CREATE DATABASE "${testDatabaseName}"`);
  } finally {
    await admin.end();
  }
  const migrationSql = postgres(testUrl.toString(), { max: 1, connect_timeout: 10 });
  try {
    await migrate(drizzle(migrationSql), { migrationsFolder: resolve(process.cwd(), "drizzle") });
  } finally {
    await migrationSql.end();
  }
  sql = postgres(testUrl.toString(), { max: 5, connect_timeout: 10, fetch_types: false });
}, 60_000);

beforeEach(async () => {
  // This suite is allowed to clear only a database whose validated name ends in _test.
  await sql.unsafe("TRUNCATE TABLE users, jobs, provider_call_telemetry, journey_samples RESTART IDENTITY CASCADE");
  const users = await sql<{ id: string }[]>`INSERT INTO users (display_name) VALUES ('Retention Fixture') RETURNING id`;
  userId = users[0]!.id;
  const areas = await sql<{ id: string }[]>`
    INSERT INTO areas (user_id, name, sort_order) VALUES (${userId}, 'Study', 1) RETURNING id
  `;
  const outcomes = await sql<{ id: string }[]>`
    INSERT INTO outcomes (area_id, title, definition_of_done) VALUES (${areas[0]!.id}, 'Graduate', 'Degree awarded') RETURNING id
  `;
  const projects = await sql<{ id: string }[]>`
    INSERT INTO projects (outcome_id, title) VALUES (${outcomes[0]!.id}, 'Thesis') RETURNING id
  `;
  projectId = projects[0]!.id;
});

afterAll(async () => {
  await sql?.end();
});

describe("planning evidence retention", () => {
  it("removes finished jobs past the window while keeping the queue and the newest job per user", async () => {
    const pending = await insertJob({ status: "pending", createdAt: daysAgo(40) });
    const retrying = await insertJob({ status: "retrying", createdAt: daysAgo(40) });
    const running = await insertJob({ status: "running", createdAt: daysAgo(40) });
    const staleSuperseded = await insertJob({ status: "superseded", createdAt: daysAgo(40) });
    const staleCompleted = await insertJob({ status: "completed", createdAt: daysAgo(39) });
    const newestCompleted = await insertJob({ status: "completed", createdAt: daysAgo(20) });
    // Newer than every other job for this user, and the last thing the portal's status read sees.
    const newestOfAll = await insertJob({ status: "failed", createdAt: daysAgo(10) });
    const otherUsersJob = await insertJob({ status: "superseded", createdAt: daysAgo(40), owner: crypto.randomUUID() });

    const counts = await pruneExpiredPlanningEvidence(sql, retention());

    expect(counts.jobs).toBe(2);
    const remaining = await jobIds();
    // In flight, newest per user, newest completed per user, and another user's only job — which is
    // that user's newest and so is never a candidate.
    expect(remaining.sort()).toEqual([pending, retrying, running, newestCompleted, newestOfAll, otherUsersJob].sort());
    expect(remaining).not.toContain(staleSuperseded);
    expect(remaining).not.toContain(staleCompleted);
  });

  it("keeps finished jobs that are still inside the retention window", async () => {
    await insertJob({ status: "completed", createdAt: daysAgo(0) });
    const insideWindow = await insertJob({ status: "superseded", createdAt: daysAgo(1) });
    const outsideWindow = await insertJob({ status: "superseded", createdAt: daysAgo(30) });

    const counts = await pruneExpiredPlanningEvidence(sql, retention());

    expect(counts.jobs).toBe(1);
    const remaining = await jobIds();
    expect(remaining).toContain(insideWindow);
    expect(remaining).not.toContain(outsideWindow);
  });

  it("keeps the job an issue snapshot names and the job carrying its engine input", async () => {
    const referencedById = await insertJob({ status: "completed", createdAt: daysAgo(40) });
    const referencedByInputVersion = await insertJob({
      status: "completed",
      createdAt: daysAgo(41),
      inputVersion: "abc123"
    });
    const unreferenced = await insertJob({ status: "superseded", createdAt: daysAgo(42) });
    await insertJob({ status: "completed", createdAt: daysAgo(1) });
    await insertIssueSnapshot({ jobIds: [referencedById], requestId: null, inputVersion: "abc123" });

    const counts = await pruneExpiredPlanningEvidence(sql, retention());

    expect(counts.jobs).toBe(1);
    const remaining = await jobIds();
    expect(remaining).toContain(referencedById);
    expect(remaining).toContain(referencedByInputVersion);
    expect(remaining).not.toContain(unreferenced);
  });

  it("keeps the current run, the per-user cap of superseded runs, and anything a snapshot replays", async () => {
    const current = await insertRun({ calculatedAt: daysAgo(0), superseded: false });
    const recent = await insertRun({ calculatedAt: daysAgo(5), superseded: true });
    const withinCap = await insertRun({ calculatedAt: daysAgo(60), superseded: true });
    const beyondCap = await insertRun({ calculatedAt: daysAgo(90), superseded: true });
    const referenced = await insertRun({ calculatedAt: daysAgo(120), superseded: true });
    const referencedRequestId = (
      await sql<{ request_id: string }[]>`SELECT request_id FROM planning_runs WHERE id=${referenced}`
    )[0]!.request_id;
    await insertIssueSnapshot({ jobIds: [], requestId: referencedRequestId, inputVersion: null });

    // A cap of two superseded rows per user: `recent` and `withinCap` are the two newest.
    const counts = await pruneExpiredPlanningEvidence(sql, retention({ supersededPerUser: 2 }));

    expect(counts.planningRuns).toBe(1);
    const remaining = await runIds();
    expect(remaining.sort()).toEqual([current, recent, withinCap, referenced].sort());
    expect(remaining).not.toContain(beyondCap);
  });

  it("never deletes a recommendation a session was started from", async () => {
    const usedBySession = await insertRecommendation({ calculatedAt: daysAgo(90), superseded: true });
    const expendable = await insertRecommendation({ calculatedAt: daysAgo(91), superseded: true });
    const current = await insertRecommendation({ calculatedAt: daysAgo(0), superseded: false });
    await sql`
      INSERT INTO sessions (user_id, recommendation_id, planned_started_at, planned_end_at, planned_minutes, remaining_before_minutes)
      VALUES (${userId}, ${usedBySession}, ${daysAgo(90)}, ${daysAgo(90)}, 30, 60)
    `;

    const counts = await pruneExpiredPlanningEvidence(sql, retention({ supersededPerUser: 1 }));

    expect(counts.recommendations).toBe(1);
    expect(counts.recommendationCandidates).toBe(1);
    const remaining = (await sql<{ id: string }[]>`SELECT id FROM recommendations`).map((row) => row.id);
    expect(remaining.sort()).toEqual([usedBySession, current].sort());
    expect(remaining).not.toContain(expendable);
    // The session keeps pointing at a row that still exists, rather than being silently edited by
    // the ON DELETE SET NULL that removing its recommendation would have triggered.
    const sessions = await sql<{ recommendation_id: string | null }[]>`SELECT recommendation_id FROM sessions`;
    expect(sessions[0]!.recommendation_id).toBe(usedBySession);
  });

  it("keeps recent forecast rows and the most recent row per project", async () => {
    await insertForecast(daysAgo(2));
    await insertForecast(daysAgo(50));
    await insertForecast(daysAgo(80));

    const counts = await pruneExpiredPlanningEvidence(sql, retention());

    expect(counts.forecastSnapshots).toBe(2);
    const remaining = await sql<{ calculated_at: Date }[]>`SELECT calculated_at FROM forecast_snapshots`;
    expect(remaining).toHaveLength(1);
    expect(new Date(remaining[0]!.calculated_at).getTime()).toBe(daysAgo(2).getTime());
  });

  it("does nothing at all when retention is switched off", async () => {
    await insertJob({ status: "completed", createdAt: daysAgo(40) });
    await insertJob({ status: "superseded", createdAt: daysAgo(41) });
    await insertRun({ calculatedAt: daysAgo(90), superseded: true });
    await insertReceipt({ createdAt: daysAgo(90), audited: false, response: { ok: true } });
    await insertProviderTelemetry(daysAgo(40));
    await insertJourneySample(daysAgo(200));

    const counts = await pruneExpiredPlanningEvidence(sql, retention({ enabled: false }));

    expect(counts).toEqual({
      jobs: 0,
      planningRuns: 0,
      forecastSnapshots: 0,
      recommendations: 0,
      recommendationCandidates: 0,
      jobPayloadsCompacted: 0,
      providerTelemetryDeleted: 0,
      journeySamplesDeleted: 0,
      pushOutboxDeleted: 0,
      pulseSegmentsDeleted: 0,
      beforeImagesCleared: 0
    });
    expect(await jobIds()).toHaveLength(2);
    expect(await runIds()).toHaveLength(1);
    expect(await receiptIds()).toHaveLength(1);
    expect(await providerTelemetryCount()).toBe("1");
    expect(await journeySampleCount()).toBe("1");
  });

  it("prunes provider call telemetry on its own seven-day window, alongside the rest of the sweep", async () => {
    await insertProviderTelemetry(daysAgo(8));
    await insertProviderTelemetry(daysAgo(6));

    const counts = await pruneExpiredPlanningEvidence(sql, retention());

    expect(counts.providerTelemetryDeleted).toBe(1);
    expect(await providerTelemetryCount()).toBe("1");
  });

  it("moves the provider telemetry window with its own config field rather than the run ones", async () => {
    await insertProviderTelemetry(daysAgo(3));
    await insertProviderTelemetry(daysAgo(10));

    const counts = await pruneExpiredPlanningEvidence(sql, retention({ providerTelemetryRetentionDays: 5 }));

    expect(counts.providerTelemetryDeleted).toBe(1);
    expect(await providerTelemetryCount()).toBe("1");
  });

  it("prunes journey samples past the 180-day summary window", async () => {
    await insertJourneySample(daysAgo(181));
    await insertJourneySample(daysAgo(179));

    const counts = await pruneExpiredPlanningEvidence(sql, retention());

    expect(counts.journeySamplesDeleted).toBe(1);
    expect(await journeySampleCount()).toBe("1");
  });

  it("prunes push_outbox rows past their 30-day retention window", async () => {
    await insertPushOutboxRow(daysAgo(31));
    await insertPushOutboxRow(daysAgo(29));

    const counts = await pruneExpiredPlanningEvidence(sql, retention());

    expect(counts.pushOutboxDeleted).toBe(1);
    expect(await pushOutboxCount()).toBe("1");
  });

  it("clears an agent write's before-image after 90 days but never deletes the write_rows row", async () => {
    const insertChange = async (createdAt: Date, evidence: Record<string, unknown>) => {
      const writeId = await insertReceipt({ createdAt, audited: false });
      return (
        await sql<{ id: string }[]>`
          INSERT INTO write_rows (write_id, user_id, entity_type, entity_id, operation, evidence, created_at)
          VALUES (${writeId}, ${userId}, 'project', 'p1', 'save', ${sql.json(evidence as never)}, ${createdAt})
          RETURNING id`
      )[0]!.id;
    };
    const old = await insertChange(daysAgo(91), { before: { title: "Old" }, kept: 1 });
    const recent = await insertChange(daysAgo(89), { before: { title: "New" } });

    const counts = await pruneExpiredPlanningEvidence(sql, retention());

    expect(counts.beforeImagesCleared).toBe(1);
    const rows = await sql<{ id: string; evidence: Record<string, unknown> }[]>`SELECT id, evidence FROM write_rows`;
    expect(rows.find((row) => row.id === old)?.evidence).toEqual({ kept: 1 });
    expect(rows.find((row) => row.id === recent)?.evidence).toEqual({ before: { title: "New" } });
  });

  it("drops the embedded engine request from finished jobs nothing can still read it from", async () => {
    const inFlight = await insertJob({ status: "pending", createdAt: hoursAgo(3) });
    const expendable = await insertJob({ status: "superseded", createdAt: hoursAgo(4) });
    // Newest, and newest completed, per user: the portal's status read and the snapshot fallback.
    const justFinished = await insertJob({ status: "completed", createdAt: hoursAgo(0) });

    const counts = await pruneExpiredPlanningEvidence(sql, retention());

    expect(counts.jobPayloadsCompacted).toBe(1);
    expect(await requestOf(expendable)).toBeNull();
    // The payload is the work itself while a job is queued, and a job that has only just finished
    // may still be the subject of a capture happening right now.
    expect(await requestOf(inFlight)).not.toBeNull();
    expect(await requestOf(justFinished)).not.toBeNull();
    // The row itself is untouched; only the state blob inside it went.
    expect(await jobIds()).toContain(expendable);
  });

  it("keeps the engine request behind the current run and behind every issue snapshot", async () => {
    const currentRunVersion = "current-run-version";
    const snapshotVersion = "snapshot-version";
    const behindCurrentRun = await insertJob({
      status: "completed",
      createdAt: hoursAgo(6),
      inputVersion: currentRunVersion
    });
    const namedBySnapshot = await insertJob({ status: "superseded", createdAt: hoursAgo(7) });
    const behindSnapshotInput = await insertJob({
      status: "superseded",
      createdAt: hoursAgo(8),
      inputVersion: snapshotVersion
    });
    const expendable = await insertJob({ status: "superseded", createdAt: hoursAgo(9) });
    await insertJob({ status: "completed", createdAt: hoursAgo(0) });
    await sql`
      INSERT INTO planning_runs (user_id, request_id, input_version, contract_version, engine_version, calculated_at, valid_until, result)
      VALUES (${userId}, ${crypto.randomUUID()}, ${currentRunVersion}, '1', '1', ${hoursAgo(6)}, ${daysAgo(-1)}, ${sql.json({} as never)})
    `;
    await insertIssueSnapshot({ jobIds: [namedBySnapshot], requestId: null, inputVersion: snapshotVersion });

    const counts = await pruneExpiredPlanningEvidence(sql, retention());

    expect(counts.jobPayloadsCompacted).toBe(1);
    // `issue-snapshot-store` recovers a fresh snapshot's engine input by looking up the job keyed on
    // the current run's input version, so emptying that one would break capture, not just history.
    expect(await requestOf(behindCurrentRun)).not.toBeNull();
    expect(await requestOf(namedBySnapshot)).not.toBeNull();
    expect(await requestOf(behindSnapshotInput)).not.toBeNull();
    expect(await requestOf(expendable)).toBeNull();
  });

  it("keeps every write and its rows however old, so an old commandId still replays", async () => {
    const old = await insertReceipt({ createdAt: daysAgo(400), audited: true, response: { ok: true } });
    const fresh = await insertReceipt({ createdAt: daysAgo(1), audited: true, response: { ok: true } });
    const auditBefore = await changeLogRows();
    expect(auditBefore).toHaveLength(2);

    await pruneExpiredPlanningEvidence(sql, retention());

    expect((await receiptIds()).sort()).toEqual([old, fresh].sort());
    expect(await responseOf(old)).toEqual({ ok: true });
    // Not one write_rows row was deleted or re-pointed: the same ids, still under the same writes.
    expect(await changeLogRows()).toEqual(auditBefore);
  });
});
