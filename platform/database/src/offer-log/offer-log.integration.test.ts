import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import { PLAN_FORECAST_CONTRACT_VERSION, type PlanForecastResponse } from "@openrhen/contracts";
import { integrationDatabaseName } from "../operations/integration-database.js";
import { persistPlanForecastResult } from "../planning/plan-forecast-runtime.js";
import { defaultPlanningRetentionConfig, pruneExpiredPlanningEvidence } from "../planning/plan-retention.js";
import { recordOffered, recordOutcome, type OfferedCandidate } from "./offer-log.js";

/**
 * The Now offer log's database behaviour: the `offered` writer inside `persistPlanForecastResult` (one row per change
 * of what is offered, top five only, same transaction), the outcome writer's rank and idempotency rules, and the
 * promise that planning retention and deleting an action leave the log alone.
 */
config({ path: resolve(process.cwd(), "../../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(process.env.OFFER_LOG_TEST_DATABASE_NAME, "openrhen_offer_log");

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("OFFER_LOG_TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let userId: string;
let projectId: string;
let calls = 0;

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
  await sql.unsafe("TRUNCATE TABLE users RESTART IDENTITY CASCADE");
  const users = await sql<{ id: string }[]>`
    INSERT INTO users (display_name, timezone) VALUES ('Offer Log Fixture', 'Australia/Sydney') RETURNING id`;
  userId = users[0]!.id;
  await sql`INSERT INTO user_preferences (user_id) VALUES (${userId})`;
  const area = await sql<{ id: string }[]>`
    INSERT INTO areas (user_id,name,status,sort_order) VALUES (${userId},'Area','active',0) RETURNING id`;
  const outcome = await sql<{ id: string }[]>`
    INSERT INTO outcomes (area_id,title,definition_of_done,status) VALUES (${area[0]!.id},'Outcome','Done','active') RETURNING id`;
  const project = await sql<{ id: string }[]>`
    INSERT INTO projects (outcome_id,title,status) VALUES (${outcome[0]!.id},'Project','active') RETURNING id`;
  projectId = project[0]!.id;
});

afterAll(async () => {
  await sql?.end();
});

async function createAction(title: string): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO actions (project_id,title,status,optimistic_minutes,expected_minutes,pessimistic_minutes,remaining_minutes,energy,minimum_session_minutes,maximum_session_minutes)
    VALUES (${projectId},${title},'active',30,60,90,60,'medium',15,90) RETURNING id`;
  return rows[0]!.id;
}

interface LogRow {
  id: string;
  event: string;
  recommendation_id: string | null;
  target_type: string | null;
  target_id: string | null;
  label: string | null;
  rank: number | null;
  rank_basis: string | null;
  candidates: OfferedCandidate[] | null;
  actor: string | null;
  command_id: string | null;
  detail: Record<string, unknown>;
}

const logRows = (event?: string) =>
  event
    ? sql<LogRow[]>`SELECT * FROM offer_log WHERE user_id=${userId} AND event=${event} ORDER BY occurred_at, id`
    : sql<LogRow[]>`SELECT * FROM offer_log WHERE user_id=${userId} ORDER BY occurred_at, id`;

/** A schema-valid engine result whose recommendation offers `actions` in order (first is the primary). */
function planResult(actions: { id: string; title: string; eligible?: boolean }[], minutes = 30) {
  calls += 1;
  const at = new Date(Date.now() + calls * 1000);
  const candidates = actions.map((action, index) => ({
    action: { id: action.id, title: action.title },
    totalScore: 100 - index,
    eligible: action.eligible ?? true,
    recommendedMinutes: minutes
  }));
  return {
    contractVersion: PLAN_FORECAST_CONTRACT_VERSION,
    requestId: crypto.randomUUID(),
    inputVersion: crypto.randomUUID(),
    engineVersion: "test-engine",
    calculatedAt: at.toISOString(),
    validUntil: new Date(at.getTime() + 3_600_000).toISOString(),
    derivedState: { sleepPlans: [], occurrences: [], routineSteps: [], commitmentRepeats: [] },
    schedule: {},
    recommendation: {
      primary: actions[0]
        ? { action: { id: actions[0].id, title: actions[0].title }, recommendedMinutes: minutes }
        : null,
      candidates,
      headline: "Next",
      explanation: "Because.",
      evidence: []
    },
    currentDirective: { kind: "none", title: "No suitable action", recommendedMinutes: 0 },
    upcomingDirectives: [],
    continuation: null
  } as unknown as PlanForecastResponse;
}

describe("the offered writer in persistPlanForecastResult", () => {
  it("writes one row with the primary and the top five, in the same transaction as the recommendation", async () => {
    const actions = await Promise.all(
      ["A", "B", "C", "D", "E", "F", "G"].map(createAction).map(async (id, i) => ({
        id: await id,
        title: "ABCDEFG"[i]!
      }))
    );
    await persistPlanForecastResult(sql, userId, planResult(actions));
    const rows = await logRows();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    const recommendations = await sql<{ id: string }[]>`SELECT id FROM recommendations WHERE user_id=${userId}`;
    expect(row).toMatchObject({
      event: "offered",
      recommendation_id: recommendations[0]!.id,
      target_type: "action",
      target_id: actions[0]!.id,
      label: "A",
      actor: "system",
      rank: null,
      command_id: null
    });
    expect(row.candidates).toHaveLength(5);
    expect(row.candidates!.map((c) => c.rank)).toEqual([1, 2, 3, 4, 5]);
    expect(row.candidates![0]).toMatchObject({
      targetType: "action",
      targetId: actions[0]!.id,
      eligible: true,
      minutes: 30
    });
    expect(row.detail).toMatchObject({ timezone: "Australia/Sydney" });
    expect(typeof row.detail.hash).toBe("string");
  });

  it("writes nothing for a replan that offers the same primary and top five, and a row when either changes", async () => {
    const a = await createAction("A");
    const b = await createAction("B");
    const c = await createAction("C");
    await persistPlanForecastResult(
      sql,
      userId,
      planResult([
        { id: a, title: "A" },
        { id: b, title: "B" }
      ])
    );
    await persistPlanForecastResult(
      sql,
      userId,
      planResult([
        { id: a, title: "A" },
        { id: b, title: "B" }
      ])
    );
    expect(await logRows("offered")).toHaveLength(1);
    // Same primary, different alternatives: a new offer.
    await persistPlanForecastResult(
      sql,
      userId,
      planResult([
        { id: a, title: "A" },
        { id: c, title: "C" }
      ])
    );
    expect(await logRows("offered")).toHaveLength(2);
    // Same targets, different minutes: not a new offer (minutes drift as time passes).
    await persistPlanForecastResult(
      sql,
      userId,
      planResult(
        [
          { id: a, title: "A" },
          { id: c, title: "C" }
        ],
        45
      )
    );
    expect(await logRows("offered")).toHaveLength(2);
    // Different primary.
    await persistPlanForecastResult(
      sql,
      userId,
      planResult(
        [
          { id: c, title: "C" },
          { id: a, title: "A" }
        ],
        45
      )
    );
    expect(await logRows("offered")).toHaveLength(3);
  });

  it("logs an offer of nothing once, then not again", async () => {
    await persistPlanForecastResult(sql, userId, planResult([]));
    await persistPlanForecastResult(sql, userId, planResult([]));
    const rows = await logRows("offered");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ target_type: "none", target_id: null, candidates: [] });
  });

  it("does not log a result that is not published (an older run), and rolls back with a failing publish", async () => {
    const a = await createAction("A");
    const newer = planResult([{ id: a, title: "A" }]);
    await persistPlanForecastResult(sql, userId, newer);
    const older = planResult([{ id: a, title: "A" }]);
    (older as unknown as { calculatedAt: string }).calculatedAt = new Date(Date.now() - 86_400_000).toISOString();
    expect(await persistPlanForecastResult(sql, userId, older)).toBe(false);
    expect(await logRows("offered")).toHaveLength(1);

    // A log insert that fails rolls the whole publish back: no recommendation survives.
    const b = await createAction("B");
    await sql`ALTER TABLE offer_log ADD CONSTRAINT offer_log_test_refuse CHECK (label IS DISTINCT FROM 'B')`;
    try {
      await expect(persistPlanForecastResult(sql, userId, planResult([{ id: b, title: "B" }]))).rejects.toThrow();
    } finally {
      await sql`ALTER TABLE offer_log DROP CONSTRAINT offer_log_test_refuse`;
    }
    expect(await logRows("offered")).toHaveLength(1);
    const recommendations = await sql<{ id: string }[]>`SELECT id FROM recommendations WHERE user_id=${userId}`;
    expect(recommendations).toHaveLength(1);
  });
});

describe("recordOutcome", () => {
  const candidate = (targetId: string, rank: number): OfferedCandidate => ({
    targetType: "action",
    targetId,
    executionOptionId: null,
    rank,
    score: 10,
    eligible: true,
    minutes: 30
  });

  it("takes the rank from the user's latest offered row, whatever recommendation the caller named", async () => {
    const first = await createAction("First");
    const second = await createAction("Second");
    await recordOffered(sql, userId, {
      recommendationId: crypto.randomUUID(),
      validUntil: new Date(Date.now() + 3_600_000),
      primary: { targetType: "action", targetId: first, executionOptionId: null, label: "First" },
      candidates: [candidate(first, 1), candidate(second, 2)],
      actor: "system"
    });
    const offered = (await logRows("offered"))[0]!;
    await recordOutcome(sql, userId, {
      event: "started",
      commandId: crypto.randomUUID(),
      targetType: "action",
      targetId: second,
      recommendationId: crypto.randomUUID(),
      label: "Second",
      actor: "claude"
    });
    const started = (await logRows("started"))[0]!;
    expect(started).toMatchObject({ rank: 2, rank_basis: "offered_row", actor: "claude", label: "Second" });
    expect(started.detail).toMatchObject({ offered_row_id: offered.id, timezone: "Australia/Sydney" });
    expect(started.detail.off_plan).toBeUndefined();
  });

  it("gives a target outside the top five a null rank and off_plan, and no offered row at all rank_basis none", async () => {
    const stranger = await createAction("Stranger");
    await recordOutcome(sql, userId, {
      event: "started",
      commandId: crypto.randomUUID(),
      targetType: "action",
      targetId: stranger,
      actor: "person"
    });
    expect((await logRows("started"))[0]).toMatchObject({ rank: null, rank_basis: "none" });

    const first = await createAction("First");
    await recordOffered(sql, userId, {
      recommendationId: crypto.randomUUID(),
      validUntil: new Date(Date.now() + 3_600_000),
      primary: { targetType: "action", targetId: first, executionOptionId: null, label: "First" },
      candidates: [candidate(first, 1)],
      actor: "system"
    });
    await recordOutcome(sql, userId, {
      event: "skipped",
      commandId: crypto.randomUUID(),
      targetType: "routine_step",
      targetId: crypto.randomUUID(),
      actor: "person"
    });
    const skipped = (await logRows("skipped"))[0]!;
    expect(skipped).toMatchObject({ rank: null, rank_basis: "offered_row" });
    expect(skipped.detail.off_plan).toBe(true);
  });

  it("is idempotent on (command id, event, target id): a replay adds nothing, a second target on the same command does", async () => {
    const one = await createAction("One");
    const two = await createAction("Two");
    const commandId = crypto.randomUUID();
    const write = (targetId: string, event: "did_not_start" | "blocked" = "did_not_start") =>
      recordOutcome(sql, userId, { event, commandId, targetType: "action", targetId, actor: "person" });
    await write(one);
    await write(one);
    expect(await logRows("did_not_start")).toHaveLength(1);
    // A catch-up settling several sessions reuses one command id: each target keeps its row.
    await write(two);
    expect(await logRows("did_not_start")).toHaveLength(2);
    await write(one, "blocked");
    expect(await logRows("blocked")).toHaveLength(1);
  });

  it("records a check-in answer without a rank", async () => {
    await recordOutcome(sql, userId, {
      event: "checked_in",
      commandId: crypto.randomUUID(),
      targetType: "check_in",
      targetId: crypto.randomUUID(),
      label: "Writing",
      actor: "person",
      detail: { status: "deviated", deviationCategory: "interruption" }
    });
    expect((await logRows("checked_in"))[0]).toMatchObject({ rank: null, rank_basis: null });
  });

  it("leaves no row when the surrounding transaction rolls back", async () => {
    const a = await createAction("A");
    await expect(
      sql.begin(async (tx) => {
        await recordOutcome(tx, userId, {
          event: "started",
          commandId: crypto.randomUUID(),
          targetType: "action",
          targetId: a,
          actor: "person"
        });
        throw new Error("command failed after the log insert");
      })
    ).rejects.toThrow("command failed");
    expect(await logRows()).toHaveLength(0);
  });

  it("refuses an event the table does not know", async () => {
    await expect(
      recordOutcome(sql, userId, {
        event: "dismissed" as never,
        commandId: crypto.randomUUID(),
        targetType: "action",
        targetId: crypto.randomUUID(),
        actor: "person"
      })
    ).rejects.toThrow();
  });
});

describe("retention and deletion leave the log alone", () => {
  it("planning retention deletes the recommendation but zero offer log rows", async () => {
    const a = await createAction("A");
    await persistPlanForecastResult(sql, userId, planResult([{ id: a, title: "A" }]));
    const b = await createAction("B");
    await persistPlanForecastResult(
      sql,
      userId,
      planResult([
        { id: a, title: "A" },
        { id: b, title: "B" }
      ])
    );
    await sql`UPDATE recommendations SET calculated_at=now() - interval '90 days', superseded_at=now() - interval '90 days'`;
    const before = await logRows();
    expect(before).toHaveLength(2);

    const counts = await pruneExpiredPlanningEvidence(sql, { ...defaultPlanningRetentionConfig, supersededPerUser: 0 });
    expect(counts.recommendations).toBeGreaterThan(0);
    expect(await sql`SELECT 1 FROM recommendations WHERE user_id=${userId}`).toHaveLength(0);
    expect(await logRows()).toEqual(before);
  });

  it("a row survives the deletion of its action", async () => {
    const a = await createAction("Doomed");
    await persistPlanForecastResult(sql, userId, planResult([{ id: a, title: "Doomed" }]));
    await recordOutcome(sql, userId, {
      event: "started",
      commandId: crypto.randomUUID(),
      targetType: "action",
      targetId: a,
      label: "Doomed",
      actor: "person"
    });
    await sql`DELETE FROM recommendations WHERE user_id=${userId}`;
    await sql`DELETE FROM actions WHERE id=${a}`;
    const rows = await logRows();
    expect(rows.map((row) => row.event)).toEqual(["offered", "started"]);
    expect(rows[1]).toMatchObject({ target_id: a, label: "Doomed" });
  });

  it("goes only with its user", async () => {
    const lone = (await sql<{ id: string }[]>`INSERT INTO users (display_name) VALUES ('Lone') RETURNING id`)[0]!.id;
    await recordOutcome(sql, lone, {
      event: "checked_in",
      commandId: crypto.randomUUID(),
      targetType: "check_in",
      targetId: crypto.randomUUID(),
      actor: "person"
    });
    expect(await sql`SELECT 1 FROM offer_log WHERE user_id=${lone}`).toHaveLength(1);
    await sql`DELETE FROM users WHERE id=${lone}`;
    expect(await sql`SELECT 1 FROM offer_log WHERE user_id=${lone}`).toHaveLength(0);
  });
});
