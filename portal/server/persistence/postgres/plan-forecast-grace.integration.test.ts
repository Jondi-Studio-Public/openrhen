import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { fileURLToPath } from "node:url";
import { integrationDatabaseName, lockPlanForecastPublication } from "@openrhen/database";
import { CommandConflictError, InvalidCommandError } from "./command-errors";
import { ensureUser } from "./ensure-user";
import { requireCurrentPlanForecast } from "./planning-evidence";

/**
 * Acting on a plan run past its validity boundary (the server tolerates two hours) must be safe
 * against the planning worker coming back mid-command: the command either waits for the publication
 * and reads the new run, or is refused as a retryable conflict. It must never be a claim that the
 * plan is unavailable when the server is fine, and never act on a run that was superseded under it.
 * Self-contained `_test` database, the same pattern as `activity-commands-plan-sanction`.
 */
config({ path: fileURLToPath(new URL("../../../../.env", import.meta.url)), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(
  process.env.PLAN_FORECAST_GRACE_TEST_DATABASE_NAME,
  "openrhen_plan_forecast_grace"
);

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("PLAN_FORECAST_GRACE_TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let userId: string;

const MINUTE = 60_000;

async function storeRun(calculatedAt: Date, validUntil: Date, supersededAt: Date | null = null): Promise<void> {
  const requestId = crypto.randomUUID();
  await sql`
    INSERT INTO planning_runs (user_id,request_id,input_version,contract_version,engine_version,calculated_at,valid_until,result,superseded_at)
    VALUES (
      ${userId},${requestId},'v1','1','v1',${calculatedAt},${validUntil},
      ${sql.json({
        contractVersion: "1",
        requestId,
        inputVersion: "v1",
        engineVersion: "v1",
        calculatedAt: calculatedAt.toISOString(),
        validUntil: validUntil.toISOString(),
        derivedState: {
          sleepPlans: [],
          occurrences: [],
          routineSteps: [],
          commitmentRepeats: [],
          commitmentTimelines: [],
          stepPlacements: []
        },
        schedule: {},
        recommendation: {},
        currentDirective: { kind: "none", title: "Nothing", recommendedMinutes: 0 },
        upcomingDirectives: [],
        continuation: null
      } as never)},
      ${supersededAt}
    )
  `;
}

/** The publish side: supersede the current run and insert a newer one, under the publication lock. */
async function publishNewRun(now: Date, validUntil: Date): Promise<void> {
  await sql.begin(async (tx) => {
    await lockPlanForecastPublication(tx as unknown as postgres.Sql, userId);
    await tx`UPDATE planning_runs SET superseded_at=${now} WHERE user_id=${userId} AND superseded_at IS NULL`;
    const requestId = crypto.randomUUID();
    await tx`
      INSERT INTO planning_runs (user_id,request_id,input_version,contract_version,engine_version,calculated_at,valid_until,result)
      VALUES (${userId},${requestId},'v2','1','v1',${now},${validUntil},${tx.json({
        contractVersion: "1",
        requestId,
        inputVersion: "v2",
        engineVersion: "v1",
        calculatedAt: now.toISOString(),
        validUntil: validUntil.toISOString(),
        derivedState: {
          sleepPlans: [],
          occurrences: [],
          routineSteps: [],
          commitmentRepeats: [],
          commitmentTimelines: [],
          stepPlacements: []
        },
        schedule: {},
        recommendation: {},
        currentDirective: { kind: "none", title: "Nothing", recommendedMinutes: 0 },
        upcomingDirectives: [],
        continuation: null
      } as never)})
    `;
  });
}

beforeAll(async () => {
  const admin = postgres(adminUrl!, { max: 1, connect_timeout: 10 });
  try {
    const existing = await admin<{ exists: boolean }[]>`
      SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = ${testDatabaseName}) AS exists
    `;
    if (!existing[0]?.exists) await admin.unsafe(`CREATE DATABASE "${testDatabaseName}"`);
  } finally {
    await admin.end();
  }
  const migrationSql = postgres(testUrl.toString(), { max: 1, connect_timeout: 10 });
  try {
    await migrate(drizzle(migrationSql), {
      migrationsFolder: fileURLToPath(new URL("../../../../platform/database/drizzle", import.meta.url))
    });
  } finally {
    await migrationSql.end();
  }
  sql = postgres(testUrl.toString(), { max: 6, connect_timeout: 10, fetch_types: false, prepare: true });
  userId = await ensureUser(sql);
}, 30_000);

beforeEach(async () => {
  await sql.unsafe("TRUNCATE TABLE planning_runs RESTART IDENTITY CASCADE");
});

afterAll(async () => {
  await sql?.end();
});

describe("requireCurrentPlanForecast past the validity boundary", () => {
  it("accepts a run inside the two-hour tolerance and refuses one beyond it", async () => {
    const now = new Date();
    await storeRun(new Date(now.getTime() - 90 * MINUTE), new Date(now.getTime() - 30 * MINUTE));
    await expect(sql.begin((tx) => requireCurrentPlanForecast(tx as never, userId, now))).resolves.toBeTruthy();
    await expect(
      sql.begin((tx) => requireCurrentPlanForecast(tx as never, userId, new Date(now.getTime() + 100 * MINUTE)))
    ).rejects.toBeInstanceOf(InvalidCommandError);
  });

  it("takes the publication lock even while the plan is current", async () => {
    const now = new Date();
    await storeRun(new Date(now.getTime() - 10 * MINUTE), new Date(now.getTime() + 50 * MINUTE));
    const order: string[] = [];
    let command: Promise<unknown> = Promise.resolve();
    await sql.begin(async (holder) => {
      await lockPlanForecastPublication(holder as unknown as postgres.Sql, userId);
      // A command locks in the publish's order, so it waits for the publish in flight.
      command = sql
        .begin((tx) => requireCurrentPlanForecast(tx as never, userId, now))
        .then(() => order.push("command"));
      await new Promise((resolve) => setTimeout(resolve, 300));
      order.push("published");
    });
    await command;
    expect(order).toEqual(["published", "command"]);
  });

  it("waits for a publish in flight and judges the command against the new run", async () => {
    const now = new Date();
    await storeRun(new Date(now.getTime() - 90 * MINUTE), new Date(now.getTime() - 30 * MINUTE));
    const fresh = new Date(now.getTime() + 60 * MINUTE);
    let publishing: Promise<void> = Promise.resolve();
    await sql.begin(async (holder) => {
      await lockPlanForecastPublication(holder as unknown as postgres.Sql, userId);
      // The command starts while the lock is held, then the lock holder commits its new run.
      const command = sql.begin((tx) => requireCurrentPlanForecast(tx as never, userId, now));
      await new Promise((resolve) => setTimeout(resolve, 300));
      await holder`UPDATE planning_runs SET superseded_at=${now} WHERE user_id=${userId} AND superseded_at IS NULL`;
      const requestId = crypto.randomUUID();
      await holder`
        INSERT INTO planning_runs (user_id,request_id,input_version,contract_version,engine_version,calculated_at,valid_until,result)
        VALUES (${userId},${requestId},'v2','1','v1',${now},${fresh},${holder.json({
          contractVersion: "1",
          requestId,
          inputVersion: "v2",
          engineVersion: "v1",
          calculatedAt: now.toISOString(),
          validUntil: fresh.toISOString(),
          derivedState: {
            sleepPlans: [],
            occurrences: [],
            routineSteps: [],
            commitmentRepeats: [],
            commitmentTimelines: [],
            stepPlacements: []
          },
          schedule: {},
          recommendation: {},
          currentDirective: { kind: "none", title: "Nothing", recommendedMinutes: 0 },
          upcomingDirectives: [],
          continuation: null
        } as never)})
      `;
      publishing = command.then(async (run) => {
        expect(run.inputVersion).toBe("v2");
        expect(new Date(run.validUntil).getTime()).toBe(fresh.getTime());
      });
    });
    await publishing;
  });

  it("makes a publish wait for a command acting on a graced run", async () => {
    const now = new Date();
    await storeRun(new Date(now.getTime() - 90 * MINUTE), new Date(now.getTime() - 30 * MINUTE));
    const order: string[] = [];
    let publish: Promise<unknown> = Promise.resolve();
    await sql.begin(async (tx) => {
      await requireCurrentPlanForecast(tx as never, userId, now);
      publish = publishNewRun(now, new Date(now.getTime() + 60 * MINUTE)).then(() => order.push("published"));
      await new Promise((resolve) => setTimeout(resolve, 300));
      order.push("command-committing");
    });
    await publish;
    expect(order).toEqual(["command-committing", "published"]);
  });

  it("refuses with a retryable conflict, not 'unavailable', when the publication lock stays busy", async () => {
    const now = new Date();
    await storeRun(new Date(now.getTime() - 90 * MINUTE), new Date(now.getTime() - 30 * MINUTE));
    await sql.begin(async (holder) => {
      await lockPlanForecastPublication(holder as unknown as postgres.Sql, userId);
      const error = await sql
        .begin((tx) => requireCurrentPlanForecast(tx as never, userId, now))
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(CommandConflictError);
      expect((error as Error).message).toMatch(/refreshing right now/);
    });
  }, 20_000);
});
