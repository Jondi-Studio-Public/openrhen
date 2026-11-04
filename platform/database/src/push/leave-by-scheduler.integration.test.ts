import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import { runLeaveByTick } from "./leave-by-scheduler.js";
import { integrationDatabaseName } from "../operations/integration-database.js";

config({ path: resolve(process.cwd(), "../../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(
  process.env.LEAVE_BY_SCHEDULER_TEST_DATABASE_NAME,
  "openrhen_leave_by_scheduler"
);

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("LEAVE_BY_SCHEDULER_TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let userId: string;
let homeId: string;
let dentistId: string;

const startsAt = new Date("2026-09-26T08:30:00.000Z");
const leaveBy = new Date("2026-09-26T08:00:00.000Z");

async function createLocation(id: string, name: string) {
  await sql`
    INSERT INTO condition_definitions (user_id, id, name, kind, latitude, longitude)
    VALUES (${userId}, ${id}, ${name}, 'location', -33.8, 151.2)
  `;
}

async function createCommitment(id: string, status = "confirmed", commitmentStartsAt: Date = startsAt) {
  await sql`
    INSERT INTO commitments (id, user_id, title, starts_at, ends_at, status, location_id)
    VALUES (${id}, ${userId}, 'Dentist', ${commitmentStartsAt}, ${new Date(commitmentStartsAt.getTime() + 1_800_000)}, ${status}, ${dentistId})
  `;
}

async function storePlanningRun(
  commitmentId: string,
  options: { originAssumed?: boolean; leaveByOverride?: Date } = {}
) {
  const legLeaveBy = options.leaveByOverride ?? leaveBy;
  await sql`
    INSERT INTO planning_runs (user_id,request_id,input_version,contract_version,engine_version,calculated_at,valid_until,result)
    VALUES (
      ${userId},${crypto.randomUUID()},'v1','v1','v1',${new Date()},${new Date(Date.now() + 3_600_000)},
      ${sql.json({
        derivedState: {
          commitmentTimelines: [
            {
              id: commitmentId,
              setupStartsAt: new Date(legLeaveBy.getTime() - 600_000).toISOString(),
              leaveBy: legLeaveBy.toISOString(),
              arriveBy: new Date(startsAt.getTime() - 120_000).toISOString(),
              startsAt: startsAt.toISOString(),
              endsAt: new Date(startsAt.getTime() + 1_800_000).toISOString(),
              effectiveEndsAt: new Date(startsAt.getTime() + 1_800_000).toISOString(),
              freeAt: new Date(startsAt.getTime() + 1_800_000).toISOString(),
              protectedUntil: new Date(startsAt.getTime() + 1_800_000).toISOString(),
              overtime: false,
              latenessMatters: true,
              journeyBefore: {
                fromLocationId: homeId,
                toLocationId: dentistId,
                mode: "car",
                minutes: 28,
                typicalMinutes: 22,
                source: "typical",
                sampleCount: 5,
                ...(options.originAssumed ? { originAssumed: true } : {})
              }
            }
          ]
        }
      } as never)}
    )
  `;
}

async function setSituation(fields: {
  locationId: string | null;
  locationSetAt?: Date;
  underway?: { commitmentId: string; occurrenceStartsAt: string; fromLocationId: string; departedAt: string } | null;
}) {
  await sql`
    UPDATE user_preferences SET current_situation=${sql.json({
      locationId: fields.locationId,
      locationSetAt: (fields.locationSetAt ?? new Date()).toISOString(),
      overrides: {},
      carrying: {},
      ...(fields.underway !== undefined ? { underway: fields.underway } : {})
    } as never)}
    WHERE user_id=${userId}
  `;
}

async function outboxRows() {
  return sql<
    { kind: string; status: string; dedupe_key: string; payload: { title: string; body: string; renotify?: boolean } }[]
  >`
    SELECT kind, status, dedupe_key, payload FROM push_outbox WHERE user_id=${userId} ORDER BY created_at
  `;
}

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
  const users = await sql<
    { id: string }[]
  >`INSERT INTO users (display_name, timezone) VALUES ('Leave-by Fixture', 'Australia/Sydney') RETURNING id`;
  userId = users[0]!.id;
  homeId = "home";
  dentistId = "dentist";
  await sql`INSERT INTO user_preferences (user_id, home_location_id) VALUES (${userId}, ${homeId})`;
  await createLocation(homeId, "Home");
  await createLocation(dentistId, "Dentist");
  await setSituation({ locationId: homeId });
});

afterAll(async () => {
  await sql?.end();
});

describe("runLeaveByTick", () => {
  it("enqueues a reminder at the remind slot with a confirmed origin", async () => {
    const commitmentId = crypto.randomUUID();
    await createCommitment(commitmentId);
    await storePlanningRun(commitmentId);

    await runLeaveByTick(sql, userId, new Date("2026-09-26T07:52:00.000Z"));

    const rows = await outboxRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "reminder", status: "pending" });
    // The lead reminder has nothing earlier on screen to re-alert over.
    expect(rows[0]!.payload.renotify).toBeFalsy();
  });

  it("enqueues assumed_origin instead when the journey's origin is assumed", async () => {
    const commitmentId = crypto.randomUUID();
    await createCommitment(commitmentId);
    await storePlanningRun(commitmentId, { originAssumed: true });

    await runLeaveByTick(sql, userId, new Date("2026-09-26T07:52:00.000Z"));

    const rows = await outboxRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("assumed_origin");
  });

  it("a double tick inserts once (unique dedupe_key)", async () => {
    const commitmentId = crypto.randomUUID();
    await createCommitment(commitmentId);
    await storePlanningRun(commitmentId);

    await runLeaveByTick(sql, userId, new Date("2026-09-26T07:52:00.000Z"));
    await runLeaveByTick(sql, userId, new Date("2026-09-26T07:53:00.000Z"));

    const rows = await outboxRows();
    expect(rows).toHaveLength(1);
  });

  it("sends the reminder at once when the tick first sees the lead slot already past", async () => {
    const commitmentId = crypto.randomUUID();
    await createCommitment(commitmentId);
    await storePlanningRun(commitmentId);

    // 07:59, one minute before leaveBy (08:00) — well past the 07:50 remind slot, still before leaveBy.
    await runLeaveByTick(sql, userId, new Date("2026-09-26T07:59:00.000Z"));

    const rows = await outboxRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("reminder");
  });

  it("enqueues due once leave-by arrives with a confirmed origin", async () => {
    const commitmentId = crypto.randomUUID();
    await createCommitment(commitmentId);
    await storePlanningRun(commitmentId);

    await runLeaveByTick(sql, userId, new Date("2026-09-26T07:52:00.000Z"));
    await runLeaveByTick(sql, userId, new Date("2026-09-26T08:00:30.000Z"));

    const rows = await outboxRows();
    const kinds = rows.map((row) => row.kind).sort();
    expect(kinds).toEqual(["due", "reminder"]);
    const due = rows.find((row) => row.kind === "due")!;
    // renotify is required on the at-leave-by prompt so it re-alerts over the reminder already shown
    // (design "On-screen replacement"), and its body names the commitment's own start (08:30 UTC ==
    // 18:30 AEST), not the leg's leave-by time (08:00 UTC == 18:00 AEST).
    expect(due.payload.renotify).toBe(true);
    expect(due.payload.body).toBe("Arrive by 18:30");
  });

  it("cancels pending rows once On my way is recorded (underway)", async () => {
    const commitmentId = crypto.randomUUID();
    await createCommitment(commitmentId);
    await storePlanningRun(commitmentId);

    await runLeaveByTick(sql, userId, new Date("2026-09-26T07:52:00.000Z"));
    expect((await outboxRows())[0]!.status).toBe("pending");

    await setSituation({
      locationId: homeId,
      underway: {
        commitmentId,
        occurrenceStartsAt: startsAt.toISOString(),
        fromLocationId: homeId,
        departedAt: new Date("2026-09-26T07:56:00.000Z").toISOString()
      }
    });
    await runLeaveByTick(sql, userId, new Date("2026-09-26T07:58:00.000Z"));

    const rows = await outboxRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("cancelled");
  });

  it("enqueues earlier with renotify true once leave-by has moved 5+ min earlier than announced", async () => {
    const commitmentId = crypto.randomUUID();
    await createCommitment(commitmentId);
    await storePlanningRun(commitmentId); // leaveBy 08:00 UTC, announced by the reminder below

    await runLeaveByTick(sql, userId, new Date("2026-09-26T07:52:00.000Z"));
    expect((await outboxRows()).map((row) => row.kind)).toEqual(["reminder"]);

    // A later plan moves leaveBy 10 minutes earlier, to 07:50 — past the ≥5 min threshold. Only one
    // current (non-superseded) planning run may exist per user, so retire the first before storing it.
    await sql`UPDATE planning_runs SET superseded_at=now() WHERE user_id=${userId}`;
    await storePlanningRun(commitmentId, { leaveByOverride: new Date("2026-09-26T07:50:00.000Z") });
    await runLeaveByTick(sql, userId, new Date("2026-09-26T07:53:00.000Z"));

    const rows = await outboxRows();
    const earlier = rows.find((row) => row.kind === "earlier");
    expect(earlier).toBeDefined();
    expect(earlier!.payload.renotify).toBe(true);
    expect(earlier!.payload.title).toBe("Leave 10 min earlier, by 17:50 for Dentist");
  });

  it("cancels pending rows for a cancelled commitment", async () => {
    const commitmentId = crypto.randomUUID();
    await createCommitment(commitmentId);
    await storePlanningRun(commitmentId);
    await runLeaveByTick(sql, userId, new Date("2026-09-26T07:52:00.000Z"));

    await sql`UPDATE commitments SET status='cancelled' WHERE id=${commitmentId}`;
    await runLeaveByTick(sql, userId, new Date("2026-09-26T07:53:00.000Z"));

    const rows = await outboxRows();
    expect(rows[0]!.status).toBe("cancelled");
  });

  it("does nothing when the latest plan has no eligible journeys", async () => {
    const commitmentId = crypto.randomUUID();
    await createCommitment(commitmentId);
    await sql`
      INSERT INTO planning_runs (user_id,request_id,input_version,contract_version,engine_version,calculated_at,valid_until,result)
      VALUES (${userId},${crypto.randomUUID()},'v1','v1','v1',${new Date()},${new Date(Date.now() + 3_600_000)},
        ${sql.json({ derivedState: { commitmentTimelines: [] } } as never)})
    `;
    await runLeaveByTick(sql, userId, new Date("2026-09-26T07:52:00.000Z"));
    expect(await outboxRows()).toHaveLength(0);
  });
});
