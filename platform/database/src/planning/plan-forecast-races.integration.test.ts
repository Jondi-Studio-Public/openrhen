import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import {
  PLAN_FORECAST_JOB_TYPE,
  claimPlanForecastJob,
  enqueuePlanForecastJob,
  processPlanForecastJob,
  reclaimExpiredPlanForecastJobs
} from "./plan-forecast-runtime.js";
import {
  jobStatusOf,
  minimalPlanForecastRequest,
  startStandInEngine,
  type StandInEngine
} from "./plan-forecast-engine-harness.js";
import { integrationDatabaseName } from "../operations/integration-database.js";

// Race and failure reproductions for plan-forecast-runtime.ts, each pinned to the fix that closed it.
//
//   Chaining the next `validity_boundary` job used to sit inside the engine/persist `try`, so a
//   failure there turned an already-completed job back into a retry blamed on the engine.
//
//   A completed job chained its next `validity_boundary` job from the OLD snapshot, and that
//   enqueue superseded every other waiting job for the user, including a newer write's own job that
//   landed after the post-engine-call check. The boundary job then persisted state ignoring the write.
//
//   `newerActivePlanForecastJobExists` ignores completed jobs, so with two workers an older
//   job still in its engine call could overwrite a newer job that already completed.
//
//   `newerActivePlanForecastJobExists` also ignored a newer state-change job that had already
//   failed, so with two workers an older job still in its engine call could publish, and chain a
//   boundary job from, a snapshot that omits the write the failed job carried.
//
//   Lease expiry: the reaper marked an over-budget claim `failed`/`abandoned_lock` while its live
//   worker was still persisting; that worker then published, failed its guarded completion, and
//   returned without chaining the next boundary job, so nothing ever refreshed the plan again.
//
// The chaining and supersede races are hit deterministically by triggers that fire inside the worker's own
// statements; the two-worker overwrite race by a stand-in engine that holds one request until released.

config({ path: resolve(process.cwd(), "../../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(process.env.PLAN_RACES_TEST_DATABASE_NAME, "openrhen_plan_races");

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("PLAN_RACES_TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let userId: string;

// The stand-in engine (plan-forecast-engine-harness.ts) can hold one request until the test releases
// it, which is how the two-worker race is made deterministic. Its `validUntil` is set per test: a
// future one makes a completed run chain a `validity_boundary` follow-up job (needed for the supersede race), a past
// one chains nothing (needed for the two-worker race, where a completion's own chained job would give the resuming
// older job a *real* newer pending job to find, for a reason unrelated to the bug under test).
let engine: StandInEngine;

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

  engine = await startStandInEngine(15_000);
}, 60_000);

beforeEach(async () => {
  await sql.unsafe("TRUNCATE TABLE users, jobs RESTART IDENTITY CASCADE");
  const users = await sql<{ id: string }[]>`INSERT INTO users (display_name) VALUES ('Races Fixture') RETURNING id`;
  userId = users[0]!.id;
});

afterEach(() => {
  // Releases a request the two-worker race may still be holding if the test failed before releasing it, so no
  // pending await leaks into later tests.
  engine.reset();
});

afterAll(async () => {
  await sql?.end();
  await engine?.close();
});

const statusOf = (id: string) => jobStatusOf(sql, id);

describe("chained boundary job supersedes a newer write's job", () => {
  const triggerName = "races_after_planning_run_insert";
  const functionName = "races_inject_newer_job";

  /**
   * Simulates "a user write lands between the post-call newer-job check and the chain enqueue" by
   * firing inside job A's own persist transaction, on the `planning_runs` INSERT — which is exactly
   * that window: before `finish()` marks A completed, long before `persistedAt` is computed and the
   * chain job is enqueued. It inserts:
   *   - a newer `planning_state_changed` job `J` for the same user (the write's own recalculation
   *     request), left `pending` and never claimed by this test;
   *   - a `write_rows` row one second in the past (relative to the transaction), so it is guaranteed
   *     to predate the `persistedAt` the app computes afterwards — reproducing the timing the claim
   *     describes without depending on wall-clock races.
   */
  async function armTrigger() {
    await sql.unsafe(`
      CREATE OR REPLACE FUNCTION ${functionName}() RETURNS trigger AS $$
      BEGIN
        INSERT INTO jobs (type, payload, idempotency_key, status, available_at)
        VALUES (
          '${PLAN_FORECAST_JOB_TYPE}',
          jsonb_build_object('userId', NEW.user_id, 'cause', 'planning_state_changed', 'request', jsonb_build_object('inputVersion','race-b-newer-write')),
          'race-b-newer-write-key-' || NEW.id::text,
          'pending',
          CURRENT_TIMESTAMP
        );
        WITH w AS (
          INSERT INTO writes (id, user_id, command_type, created_at)
          VALUES (gen_random_uuid(), NEW.user_id, 'action', CURRENT_TIMESTAMP - INTERVAL '1 second') RETURNING id
        )
        INSERT INTO write_rows (write_id, user_id, entity_type, operation, created_at)
        SELECT id, NEW.user_id, 'action', 'update', CURRENT_TIMESTAMP - INTERVAL '1 second' FROM w;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await sql.unsafe(`
      CREATE TRIGGER ${triggerName}
      AFTER INSERT ON planning_runs
      FOR EACH ROW EXECUTE FUNCTION ${functionName}();
    `);
  }

  async function disarmTrigger() {
    await sql.unsafe(`DROP TRIGGER IF EXISTS ${triggerName} ON planning_runs`);
    await sql.unsafe(`DROP FUNCTION IF EXISTS ${functionName}()`);
  }

  afterEach(async () => {
    await disarmTrigger();
  });

  it("keeps the concurrent write's job and chains no boundary job from the stale snapshot", async () => {
    engine.validUntil = "future";
    await armTrigger();

    const jobAId = await enqueuePlanForecastJob(
      sql,
      userId,
      await minimalPlanForecastRequest(new Date()),
      "planning_state_changed"
    );
    expect(await statusOf(jobAId)).toBe("pending");

    const outcomeA = await processPlanForecastJob(sql, engine.config, "worker-a", jobAId);
    expect(outcomeA).toBe("completed");
    expect(engine.callCount).toBe(1);

    // The trigger fired during A's persist transaction and inserted J (the concurrent write's own
    // recalculation request) and a write_rows row, inside the window between A's post-call check and
    // its chain step.
    const jRow = await sql<{ id: string; status: string }[]>`
      SELECT id,status FROM jobs
      WHERE type=${PLAN_FORECAST_JOB_TYPE} AND payload->>'cause'='planning_state_changed' AND id<>${jobAId}::uuid
    `;
    expect(jRow, "the trigger should have inserted exactly one J row").toHaveLength(1);

    // J represents a real, newer write and must survive; it will chain its own boundary job from
    // fresh state, so A chains nothing from its now-stale snapshot.
    expect(jRow[0]!.status, "J (the concurrent write's own job) should still be pending").toBe("pending");
    const cRow = await sql`
      SELECT id FROM jobs WHERE type=${PLAN_FORECAST_JOB_TYPE} AND payload->>'cause'='validity_boundary'
    `;
    expect(cRow, "A must not chain a boundary job while a newer write's job is waiting").toHaveLength(0);
  });

  it("supersedes a boundary job without an engine call when a write's job committed late but sorts before it", async () => {
    engine.validUntil = "future";
    // C was chained with a capture time of now; the write's transaction started earlier and committed
    // after, so both its job and its write_rows row are dated before C. Only the waiting job gives it away.
    const jobCId = await enqueuePlanForecastJob(
      sql,
      userId,
      await minimalPlanForecastRequest(new Date()),
      "validity_boundary",
      undefined,
      new Date().toISOString()
    );
    const jobJ = await sql<{ id: string }[]>`
      INSERT INTO jobs (type,payload,idempotency_key,status,available_at,created_at)
      VALUES (
        ${PLAN_FORECAST_JOB_TYPE},
        ${sql.json({ userId, cause: "planning_state_changed", request: { inputVersion: "late-write" } } as never)},
        'late-write-key','pending',CURRENT_TIMESTAMP + INTERVAL '1 hour',CURRENT_TIMESTAMP - INTERVAL '5 seconds'
      ) RETURNING id
    `;
    await sql`WITH w AS (INSERT INTO writes (id,user_id,command_type,created_at) VALUES (gen_random_uuid(),${userId},'action',CURRENT_TIMESTAMP - INTERVAL '5 seconds') RETURNING id) INSERT INTO write_rows (write_id,user_id,entity_type,operation,created_at) SELECT id,${userId},'action','update',CURRENT_TIMESTAMP - INTERVAL '5 seconds' FROM w`;

    const outcomeC = await processPlanForecastJob(sql, engine.config, "worker-a", jobCId);

    expect(outcomeC).toBe("superseded");
    expect(engine.callCount).toBe(0);
    expect(await statusOf(jobJ[0]!.id)).toBe("pending");
  });
});

describe("a failure chaining the next boundary job", () => {
  const triggerName = "races_reject_boundary_job";
  const functionName = "races_reject_boundary_job_fn";

  afterEach(async () => {
    await sql.unsafe(`DROP TRIGGER IF EXISTS ${triggerName} ON jobs`);
    await sql.unsafe(`DROP FUNCTION IF EXISTS ${functionName}()`);
  });

  it("leaves the job completed after one engine call and records the chain failure under its own code", async () => {
    engine.validUntil = "future";
    await sql.unsafe(`
      CREATE OR REPLACE FUNCTION ${functionName}() RETURNS trigger AS $$
      BEGIN
        IF NEW.payload->>'cause' = 'validity_boundary' THEN
          RAISE EXCEPTION 'boundary chain rejected by test';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await sql.unsafe(
      `CREATE TRIGGER ${triggerName} BEFORE INSERT ON jobs FOR EACH ROW EXECUTE FUNCTION ${functionName}();`
    );

    const jobId = await enqueuePlanForecastJob(
      sql,
      userId,
      await minimalPlanForecastRequest(new Date()),
      "planning_state_changed"
    );
    const outcome = await processPlanForecastJob(sql, engine.config, "worker-a", jobId);

    expect(outcome).toBe("completed");
    expect(engine.callCount).toBe(1);
    const row = await sql<{ status: string; attempts: number; last_error_code: string | null }[]>`
      SELECT status,attempts,last_error_code FROM jobs WHERE id=${jobId}
    `;
    expect(row[0]).toEqual({ status: "completed", attempts: 1, last_error_code: "boundary_chain_failed" });
    const current = await sql`SELECT id FROM planning_runs WHERE user_id=${userId} AND superseded_at IS NULL`;
    expect(current).toHaveLength(1);
  });

  it("still retries an engine failure before anything is persisted, blaming the engine", async () => {
    const jobId = await enqueuePlanForecastJob(
      sql,
      userId,
      await minimalPlanForecastRequest(new Date()),
      "planning_state_changed"
    );
    const outcome = await processPlanForecastJob(
      sql,
      { ...engine.config, url: "http://127.0.0.1:1" },
      "worker-a",
      jobId
    );

    expect(outcome).toBe("retrying");
    const row = await sql<{ status: string; last_error_code: string | null }[]>`
      SELECT status,last_error_code FROM jobs WHERE id=${jobId}
    `;
    expect(row[0]).toEqual({ status: "retrying", last_error_code: "plan_forecast_unavailable" });
  });

  it("fails an engine rejection at once instead of retrying it six times", async () => {
    const rejecting = createServer((_request, response) => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "calculation_failed", message: "x" } }));
    });
    await new Promise<void>((done) => rejecting.listen(0, "127.0.0.1", done));
    try {
      const { port } = rejecting.address() as AddressInfo;
      const jobId = await enqueuePlanForecastJob(
        sql,
        userId,
        await minimalPlanForecastRequest(new Date()),
        "planning_state_changed"
      );
      const outcome = await processPlanForecastJob(
        sql,
        { ...engine.config, url: `http://127.0.0.1:${port}` },
        "worker-a",
        jobId
      );

      expect(outcome).toBe("failed");
      const row = await sql<{ status: string; last_error_code: string | null; last_error_message: string | null }[]>`
        SELECT status,last_error_code,last_error_message FROM jobs WHERE id=${jobId}
      `;
      expect(row[0]).toEqual({
        status: "failed",
        last_error_code: "plan_forecast_rejected",
        last_error_message: "Plan and Forecast Engine returned 500 (calculation_failed)."
      });
    } finally {
      await new Promise((done) => rejecting.close(done));
    }
  });
});

describe("stale overwrite with two workers", () => {
  it("never lets an older job A, still mid-engine-call, overwrite a newer job B that already completed", async () => {
    // Past validUntil: neither completion chains its own follow-up job, isolating the exact
    // mechanism under test (newerActivePlanForecastJobExists not counting a completed job) from an
    // unrelated chained job that would otherwise also be "newer and pending" when A resumes.
    engine.validUntil = "past";
    const olderAt = new Date(Date.now() - 60_000);
    const newerAt = new Date();
    const requestA = await minimalPlanForecastRequest(olderAt);
    const requestB = await minimalPlanForecastRequest(newerAt);
    expect(requestA.inputVersion).not.toBe(requestB.inputVersion);

    const jobAId = await enqueuePlanForecastJob(sql, userId, requestA, "planning_state_changed");
    expect(await statusOf(jobAId)).toBe("pending");

    // Arm the engine to hang on A's specific request.
    const heldA = engine.holdRequest(requestA.inputVersion);

    // Start processing A on "worker-1" — this claims A (status -> running) and then hangs inside the
    // engine call.
    const outcomeAPromise = processPlanForecastJob(sql, engine.config, "worker-1", jobAId);
    await heldA.reached;

    // A is claimed and mid-call, so it is 'running', not 'pending' — enqueueing B's own job must not
    // (and per the code, does not) touch it.
    expect(await statusOf(jobAId)).toBe("running");

    const jobBId = await enqueuePlanForecastJob(sql, userId, requestB, "planning_state_changed");
    expect(await statusOf(jobAId)).toBe("running");
    expect(await statusOf(jobBId)).toBe("pending");

    // A second worker claims and fully processes B while A is still hung.
    const outcomeB = await processPlanForecastJob(sql, engine.config, "worker-2", jobBId);
    expect(outcomeB).toBe("completed");
    expect(await statusOf(jobBId)).toBe("completed");

    const afterBRun = await sql<{ id: string; request_id: string }[]>`
      SELECT id,request_id FROM planning_runs WHERE user_id=${userId} AND superseded_at IS NULL
    `;
    expect(afterBRun).toHaveLength(1);
    const bRequestId = engine.requestIdFor(requestB.inputVersion);
    expect(afterBRun[0]!.request_id).toBe(bRequestId);

    // Release A. Its post-call "newer job?" check only counts pending/retrying/running jobs and B is
    // now 'completed', so it is the persist itself that has to refuse A's older result.
    heldA.release();
    const outcomeA = await outcomeAPromise;
    expect(outcomeA).toBe("superseded");

    const finalRun = await sql<{ id: string; request_id: string }[]>`
      SELECT id,request_id FROM planning_runs WHERE user_id=${userId} AND superseded_at IS NULL
    `;
    expect(finalRun).toHaveLength(1);
    expect(finalRun[0]!.request_id, "the current planning_runs row should still be B's, not A's stale one").toBe(
      bRequestId
    );
    const aRun =
      await sql`SELECT id FROM planning_runs WHERE request_id=${engine.requestIdFor(requestA.inputVersion) ?? ""}`;
    expect(aRun).toHaveLength(0);
  });
});

describe("a newer state-change job rejected while an older job is mid-engine-call", () => {
  /** The user's change (B) is rejected terminally; no plan built after it exists, so none may be claimed. */
  async function failedNewerWrite(olderRequest: Awaited<ReturnType<typeof minimalPlanForecastRequest>>) {
    const requestB = await minimalPlanForecastRequest(new Date(Date.now() + 1_000));
    engine.rejectRequest(requestB.inputVersion);
    const jobBId = await enqueuePlanForecastJob(sql, userId, requestB, "planning_state_changed");
    expect(olderRequest.inputVersion).not.toBe(requestB.inputVersion);
    expect(await processPlanForecastJob(sql, engine.config, "worker-2", jobBId)).toBe("failed");
    expect(await statusOf(jobBId)).toBe("failed");
  }

  const jobsForUser = () => sql<{ id: string; status: string; cause: string }[]>`
    SELECT id,status,payload->>'cause' AS cause FROM jobs WHERE payload->>'userId'=${userId}
  `;
  const runCount = async () =>
    Number((await sql<{ n: string }[]>`SELECT count(*) AS n FROM planning_runs WHERE user_id=${userId}`)[0]!.n);

  it("does not publish the older job's plan or chain a boundary job from its stale state", async () => {
    // A future validUntil is what makes a completed run chain a boundary job, so a missing barrier shows.
    engine.validUntil = "future";
    const requestA = await minimalPlanForecastRequest(new Date(Date.now() - 60_000));
    const jobAId = await enqueuePlanForecastJob(sql, userId, requestA, "planning_state_changed");
    const heldA = engine.holdRequest(requestA.inputVersion);
    const outcomeA = processPlanForecastJob(sql, engine.config, "worker-1", jobAId);
    await heldA.reached;

    await failedNewerWrite(requestA);

    heldA.release();
    expect(await outcomeA).toBe("superseded");
    expect(await statusOf(jobAId)).toBe("superseded");
    expect(await runCount()).toBe(0);
    expect((await jobsForUser()).filter((job) => job.cause === "validity_boundary")).toEqual([]);
  });

  it("does not let a running boundary job publish a plan dated after the rejected write", async () => {
    engine.validUntil = "future";
    // A boundary job's snapshot is dated after the older write; the rejected write lands after it.
    const requestC = await minimalPlanForecastRequest(new Date(Date.now() + 60_000));
    const jobCId = await enqueuePlanForecastJob(
      sql,
      userId,
      requestC,
      "validity_boundary",
      undefined,
      new Date().toISOString()
    );
    const heldC = engine.holdRequest(requestC.inputVersion);
    const outcomeC = processPlanForecastJob(sql, engine.config, "worker-1", jobCId);
    await heldC.reached;

    await failedNewerWrite(requestC);

    heldC.release();
    expect(await outcomeC).toBe("superseded");
    expect(await runCount()).toBe(0);
    expect((await jobsForUser()).filter((job) => job.cause === "validity_boundary" && job.id !== jobCId)).toEqual([]);
  });

  it("still treats the rejected write as newer when the database clock stepped back after the older job was queued", async () => {
    // #795: "newer" used to be `created_at`, the enqueuing transaction's wall-clock start, so a clock
    // correction between two inserts made the later write look older and its rejection read as a
    // supersession. Enqueue order is what matters, and no timestamp may override it.
    engine.validUntil = "future";
    const requestA = await minimalPlanForecastRequest(new Date(Date.now() - 60_000));
    const jobAId = await enqueuePlanForecastJob(sql, userId, requestA, "planning_state_changed");
    const heldA = engine.holdRequest(requestA.inputVersion);
    const outcomeA = processPlanForecastJob(sql, engine.config, "worker-1", jobAId);
    await heldA.reached;

    const requestB = await minimalPlanForecastRequest(new Date(Date.now() + 1_000));
    engine.rejectRequest(requestB.inputVersion);
    const jobBId = await enqueuePlanForecastJob(sql, userId, requestB, "planning_state_changed");
    await sql`UPDATE jobs SET created_at=created_at-INTERVAL '1 hour' WHERE id=${jobBId}`;
    expect(await processPlanForecastJob(sql, engine.config, "worker-2", jobBId)).toBe("failed");

    heldA.release();
    expect(await outcomeA).toBe("superseded");
    expect(await runCount()).toBe(0);
  });

  it("is not held back by a failed boundary job, which carries no write", async () => {
    engine.validUntil = "future";
    const requestA = await minimalPlanForecastRequest(new Date(Date.now() - 60_000));
    const jobAId = await enqueuePlanForecastJob(sql, userId, requestA, "planning_state_changed");
    const heldA = engine.holdRequest(requestA.inputVersion);
    const outcomeA = processPlanForecastJob(sql, engine.config, "worker-1", jobAId);
    await heldA.reached;

    const requestBoundary = await minimalPlanForecastRequest(new Date(Date.now() + 1_000));
    engine.rejectRequest(requestBoundary.inputVersion);
    const boundaryId = await enqueuePlanForecastJob(sql, userId, requestBoundary, "validity_boundary");
    expect(await processPlanForecastJob(sql, engine.config, "worker-2", boundaryId)).toBe("failed");

    heldA.release();
    expect(await outcomeA).toBe("completed");
    expect(await runCount()).toBe(1);
  });
});

describe("a claim the reaper gave up on mid-call, whose live worker then publishes", () => {
  /** Claims A, takes it past its lease while the engine call is held, and reaps it. */
  async function reapedMidCall(attemptsBefore: number, beforeReap?: () => Promise<void>) {
    engine.validUntil = "future";
    const request = await minimalPlanForecastRequest(new Date(Date.now() - 60_000));
    const jobId = await enqueuePlanForecastJob(sql, userId, request, "planning_state_changed");
    // A prior attempt that failed while persisting, so the engine-outage exemption does not apply.
    await sql`UPDATE jobs SET attempts=${attemptsBefore},last_error_code='plan_forecast_persist_failed' WHERE id=${jobId}`;
    const held = engine.holdRequest(request.inputVersion);
    const outcome = processPlanForecastJob(sql, engine.config, "worker-1", jobId);
    await held.reached;
    await beforeReap?.();
    await sql`UPDATE jobs SET locked_at=CURRENT_TIMESTAMP-INTERVAL '1 hour' WHERE id=${jobId}`;
    const reaped = await reclaimExpiredPlanForecastJobs(sql, 120);
    return { jobId, held, outcome, reaped };
  }

  const boundaryJobs = () =>
    sql<{ id: string }[]>`
      SELECT id FROM jobs WHERE payload->>'userId'=${userId} AND payload->>'cause'='validity_boundary'
    `;

  it("completes the job and chains its boundary job when the reaper had already failed it", async () => {
    const { jobId, held, outcome, reaped } = await reapedMidCall(5);
    expect(reaped).toEqual({ requeued: 0, failed: 1 });
    expect(await statusOf(jobId)).toBe("failed");

    held.release();
    expect(await outcome).toBe("completed");
    const [row] = await sql<{ status: string; failed_at: Date | null; last_error_code: string | null }[]>`
      SELECT status,failed_at,last_error_code FROM jobs WHERE id=${jobId}
    `;
    expect(row).toEqual({ status: "completed", failed_at: null, last_error_code: null });
    expect(await boundaryJobs()).toHaveLength(1);
    const runs = await sql`SELECT id FROM planning_runs WHERE user_id=${userId} AND superseded_at IS NULL`;
    expect(runs).toHaveLength(1);
  });

  it("completes a job the reaper only requeued, so it is not run a second time", async () => {
    const { jobId, held, outcome, reaped } = await reapedMidCall(1);
    expect(reaped).toEqual({ requeued: 1, failed: 0 });
    expect(await statusOf(jobId)).toBe("retrying");

    held.release();
    expect(await outcome).toBe("completed");
    expect(await statusOf(jobId)).toBe("completed");
    expect(await boundaryJobs()).toHaveLength(1);
  });

  it("leaves the job and its boundary chain to the worker that claimed it after the reaper", async () => {
    const { jobId, held, outcome } = await reapedMidCall(1);
    // The requeued row was claimed again before the first worker finished.
    const reclaimed = await claimPlanForecastJob(sql, "worker-2", jobId);
    expect(reclaimed?.id).toBe(jobId);

    held.release();
    expect(await outcome).toBe("superseded");
    const [row] = await sql<{ status: string; locked_by: string | null }[]>`
      SELECT status,locked_by FROM jobs WHERE id=${jobId}
    `;
    expect(row).toEqual({ status: "running", locked_by: "worker-2" });
    expect(await boundaryJobs()).toHaveLength(0);
  });

  /** A newer write's job, enqueued while A is still running, so A's own claim is not swept. */
  const newerWrite = async () => {
    const request = await minimalPlanForecastRequest(new Date());
    return enqueuePlanForecastJob(sql, userId, request, "planning_state_changed");
  };

  it.each([
    { attemptsBefore: 1, reaperLeft: "retrying" },
    { attemptsBefore: 5, reaperLeft: "failed" }
  ])(
    "records a newer job's supersession on a row the reaper left $reaperLeft, and never re-claims it",
    async ({ attemptsBefore, reaperLeft }) => {
      let newerJobId = "";
      const reaped = await reapedMidCall(attemptsBefore, async () => void (newerJobId = await newerWrite()));
      expect(await statusOf(reaped.jobId)).toBe(reaperLeft);

      reaped.held.release();
      expect(await reaped.outcome).toBe("superseded");
      expect(await statusOf(reaped.jobId)).toBe("superseded");
      const [row] = await sql<{ failed_at: Date | null }[]>`SELECT failed_at FROM jobs WHERE id=${reaped.jobId}`;
      expect(row!.failed_at).toBeNull();
      // Nothing is left to claim for A, so a worker asking for it makes no engine call.
      const callsBefore = engine.callCount;
      expect(await processPlanForecastJob(sql, engine.config, "worker-3", reaped.jobId)).toBe("idle");
      expect(engine.callCount).toBe(callsBefore);
      expect(await boundaryJobs()).toHaveLength(0);
      expect(await statusOf(newerJobId)).toBe("pending");
    }
  );

  it("leaves a replacement worker's claim alone when the first worker finds a newer job", async () => {
    const { jobId, held, outcome } = await reapedMidCall(1, async () => void (await newerWrite()));
    expect((await claimPlanForecastJob(sql, "worker-2", jobId))?.id).toBe(jobId);

    held.release();
    expect(await outcome).toBe("superseded");
    const [row] = await sql<{ status: string; locked_by: string | null }[]>`
      SELECT status,locked_by FROM jobs WHERE id=${jobId}
    `;
    expect(row).toEqual({ status: "running", locked_by: "worker-2" });
  });

  it("records an engine failure on a row the reaper requeued", async () => {
    engine.validUntil = "future";
    const request = await minimalPlanForecastRequest(new Date(Date.now() - 60_000));
    engine.rejectRequest(request.inputVersion);
    const held = engine.holdRequest(request.inputVersion);
    const jobId = await enqueuePlanForecastJob(sql, userId, request, "planning_state_changed");
    const outcome = processPlanForecastJob(sql, engine.config, "worker-1", jobId);
    await held.reached;
    await sql`UPDATE jobs SET locked_at=CURRENT_TIMESTAMP-INTERVAL '1 hour' WHERE id=${jobId}`;
    expect(await reclaimExpiredPlanForecastJobs(sql, 120)).toEqual({ requeued: 1, failed: 0 });

    held.release();
    expect(await outcome).toBe("failed");
    const [row] = await sql<{ status: string; last_error_code: string | null }[]>`
      SELECT status,last_error_code FROM jobs WHERE id=${jobId}
    `;
    expect(row).toEqual({ status: "failed", last_error_code: "plan_forecast_rejected" });
  });
});
