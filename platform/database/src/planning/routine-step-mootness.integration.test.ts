import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import { sweepMootRoutineSteps } from "./routine-step-mootness.js";
import { integrationDatabaseName } from "../operations/integration-database.js";

config({ path: resolve(process.cwd(), "../../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
// A database of its own for the same reason the occurrence, retention and routine-inheritance suites
// have one: these suites truncate, and two of them truncating the same database is an unreproducible
// flake.
const testDatabaseName = integrationDatabaseName(
  process.env.ROUTINE_MOOTNESS_TEST_DATABASE_NAME,
  "openrhen_routine_mootness"
);

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("ROUTINE_MOOTNESS_TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

const HOUR = 3_600_000;
const now = new Date();

let sql: postgres.Sql;
let userId: string;

/** Defaults to a fresh assertion (set right now) so every existing test keeps exercising the sweep's
 * "there is a trustworthy location" path without having to think about staleness. Pass `locationSetAt`
 * explicitly to simulate an assertion aging past `DEFAULT_LOCATION_STALE_AFTER_MINUTES`. */
async function setLocation(locationId: string | null, locationSetAt: Date | null = now) {
  await sql`
    UPDATE user_preferences
    SET current_situation=${sql.json({ locationId, locationSetAt: locationSetAt?.toISOString(), overrides: {}, carrying: {} } as never)}
    WHERE user_id=${userId}
  `;
}

async function scheduledTimesOf(stepId: string) {
  const rows = await sql<{ scheduled_start_at: Date | null; scheduled_end_at: Date | null }[]>`
    SELECT scheduled_start_at, scheduled_end_at FROM routine_steps WHERE id=${stepId}
  `;
  return rows[0];
}

async function createCommitment(input: {
  id: string;
  locationId?: string | null;
  startsAt?: Date;
  endsAt?: Date;
  status?: string;
  /** A recurring occurrence's shape once materialised: a live `recurrence_rule_id` reference, exactly
   * as `persistDerivedState` (plan-forecast-runtime.ts) writes one for a future occurrence. */
  recurrenceRuleId?: string | null;
}) {
  await sql`
    INSERT INTO commitments (id,user_id,title,starts_at,ends_at,status,location_id,recurrence_rule_id)
    VALUES (
      ${input.id},${userId},'Evening Workshop',
      ${input.startsAt ?? new Date(now.getTime() - 10 * 60_000)},
      ${input.endsAt ?? new Date(now.getTime() + 50 * 60_000)},
      ${input.status ?? "confirmed"},${input.locationId ?? null},${input.recurrenceRuleId ?? null}
    )
  `;
}

/**
 * `scheduledStartAt` matters now that the sweep's own commitment match is bounded by the earliest
 * scheduled start among a commitment's before-phase steps (its preparation window opening), not by the
 * commitment's own `starts_at` — a before-phase step with no scheduled start at all never opens any
 * window for its commitment, exactly like a step nobody has ever run the real scheduler over. Left
 * `null` (its true default) unless a test needs the window open or explicitly still closed.
 */
async function addStep(
  commitmentId: string,
  title: string,
  status = "pending",
  phase: "before" | "after" = "before",
  scheduledStartAt: Date | null = null
) {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO routine_steps (user_id,commitment_id,anchor_type,anchor_id,title,duration_minutes,sequence,timing_rule,phase,status,scheduled_start_at)
    VALUES (
      ${userId},${commitmentId},'commitment',${commitmentId},${title},10,
      (SELECT COALESCE(MAX(sequence),-1)+1 FROM routine_steps WHERE commitment_id=${commitmentId}),
      'contiguous',${phase},${status},${scheduledStartAt}
    ) RETURNING id
  `;
  return rows[0]!.id;
}

async function statusOf(stepId: string) {
  const rows = await sql<{ status: string }[]>`SELECT status FROM routine_steps WHERE id=${stepId}`;
  return rows[0]?.status;
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
  // This suite is allowed to clear only a database whose validated name ends in _test.
  await sql.unsafe("TRUNCATE TABLE users RESTART IDENTITY CASCADE");
  const users = await sql<{ id: string }[]>`
    INSERT INTO users (display_name) VALUES ('Mootness Fixture') RETURNING id
  `;
  userId = users[0]!.id;
  await sql`INSERT INTO user_preferences (user_id) VALUES (${userId})`;
});

afterAll(async () => {
  await sql?.end();
});

describe("sweepMootRoutineSteps (backstop)", () => {
  // A routine the scheduler has not placed yet has no window of its own. Requiring one would exclude
  // the commitment from the sweep entirely, which is the original complaint restored for exactly
  // those steps: already at College, still being asked to pack the bag. An underway commitment is past
  // the "prep has opened" line however its steps are scheduled.
  it("skips an unscheduled before-phase step once its commitment is underway at the asserted location", async () => {
    const commitmentId = crypto.randomUUID();
    await createCommitment({ id: commitmentId, locationId: "college" });
    const packBag = await addStep(commitmentId, "Pack Bag", "pending", "before", null);
    await setLocation("college");
    await sweepMootRoutineSteps(sql, userId, now);
    expect(await statusOf(packBag)).toBe("skipped");
  });

  it("leaves an unscheduled step alone while its commitment is still ahead", async () => {
    const commitmentId = crypto.randomUUID();
    await createCommitment({
      id: commitmentId,
      locationId: "college",
      startsAt: new Date(now.getTime() + 2 * HOUR),
      endsAt: new Date(now.getTime() + 3 * HOUR)
    });
    const packBag = await addStep(commitmentId, "Pack Bag", "pending", "before", null);
    await setLocation("college");
    await sweepMootRoutineSteps(sql, userId, now);
    expect(await statusOf(packBag)).toBe("pending");
  });
  it("does nothing when no location is asserted", async () => {
    const commitmentId = crypto.randomUUID();
    await createCommitment({ id: commitmentId, locationId: "college" });
    const stepId = await addStep(commitmentId, "Pack Bag");
    await sweepMootRoutineSteps(sql, userId, now);
    expect(await statusOf(stepId)).toBe("pending");
  });

  it("skips a pending before-phase step whose commitment's preparation window is already open at the asserted location, and leaves a step with a live session (`doing`) alone (finding 19)", async () => {
    const commitmentId = crypto.randomUUID();
    await createCommitment({ id: commitmentId, locationId: "college" });
    const opened = new Date(now.getTime() - 10 * 60_000);
    const packBag = await addStep(commitmentId, "Pack Bag", "pending", "before", opened);
    // `doing` means a session is open on this step — sweeping it out from under that session is what
    // let "did not start" resurrect an arrival-skipped step (finding 19; see `activity-commands.ts`).
    const brushTeeth = await addStep(commitmentId, "Brush Teeth", "doing", "before", opened);
    const alreadyDone = await addStep(commitmentId, "Already done", "completed", "before", opened);
    const unpack = await addStep(commitmentId, "Unpack", "pending", "after");
    await setLocation("college");
    await sweepMootRoutineSteps(sql, userId, now);
    expect(await statusOf(packBag)).toBe("skipped");
    expect(await statusOf(brushTeeth)).toBe("doing");
    expect(await statusOf(alreadyDone)).toBe("completed");
    // After-phase steps are never this sweep's business, same rule as the write-time skip.
    expect(await statusOf(unpack)).toBe("pending");
  });

  it("skips a before-phase step whose preparation window has opened even though the commitment's own starts_at has not arrived yet — arriving early, mid-prep", async () => {
    // The bound is the routine's own preparation window (earliest scheduled start among its
    // before-phase steps), not the commitment's own `starts_at`: prep happens *before* the commitment,
    // so someone who left early and arrived while still notionally "getting ready" should still have
    // that preparation retired, exactly as the read-time predicate (`routineStepMootness`,
    // engine/core/src/recommendation/routine-step-mootness.ts) now agrees it should.
    const commitmentId = crypto.randomUUID();
    await createCommitment({
      id: commitmentId,
      locationId: "college",
      startsAt: new Date(now.getTime() + 20 * 60_000),
      endsAt: new Date(now.getTime() + 80 * 60_000)
    });
    const packBag = await addStep(commitmentId, "Pack Bag", "pending", "before", new Date(now.getTime() - 5 * 60_000));
    await setLocation("college");
    await sweepMootRoutineSteps(sql, userId, now);
    expect(await statusOf(packBag)).toBe("skipped");
  });

  it("matches a recurring-occurrence-shaped commitment (a live recurrence_rule_id) exactly like a one-off one", async () => {
    // Verifying the coordinator's hypothesis for A recurring commitment's window
    // still has to be matched by location/status/time alone, since neither this sweep nor the
    // write-time skip filters on `recurrence_rule_id` at all. Confirmed live against the actual
    // incident's commitment too (it was already a fully materialised, standalone row by the time of
    // the incident) — this guards the query never growing an accidental dependency on that column.
    const ruleId = crypto.randomUUID();
    await sql`
      INSERT INTO commitment_recurrence_rules
        (id,user_id,title,timezone,start_date,interval_days,local_start_time,local_end_time,location_id)
      VALUES (${ruleId},${userId},'Evening Workshop','Australia/Sydney','2026-01-01',7,'09:00','17:00','college')
    `;
    const commitmentId = crypto.randomUUID();
    await createCommitment({ id: commitmentId, locationId: "college", recurrenceRuleId: ruleId });
    const packBag = await addStep(commitmentId, "Pack Bag", "pending", "before", new Date(now.getTime() - 10 * 60_000));
    await setLocation("college");
    await sweepMootRoutineSteps(sql, userId, now);
    expect(await statusOf(packBag)).toBe("skipped");
  });

  it("leaves a commitment at a different place, not yet open, cancelled, or tentative untouched", async () => {
    const elsewhere = crypto.randomUUID();
    const notYetOpen = crypto.randomUUID();
    const cancelled = crypto.randomUUID();
    const tentative = crypto.randomUUID();
    await createCommitment({ id: elsewhere, locationId: "other-place" });
    await createCommitment({
      id: notYetOpen,
      locationId: "college",
      startsAt: new Date(now.getTime() + 2 * HOUR),
      endsAt: new Date(now.getTime() + 3 * HOUR)
    });
    await createCommitment({ id: cancelled, locationId: "college", status: "cancelled" });
    await createCommitment({ id: tentative, locationId: "college", status: "tentative" });
    const elsewhereStep = await addStep(
      elsewhere,
      "Get ready",
      "pending",
      "before",
      new Date(now.getTime() - 10 * 60_000)
    );
    // Its own preparation window has not opened yet either — well before the commitment's starts_at.
    const notYetOpenStep = await addStep(
      notYetOpen,
      "Get ready",
      "pending",
      "before",
      new Date(now.getTime() + 110 * 60_000)
    );
    const cancelledStep = await addStep(
      cancelled,
      "Get ready",
      "pending",
      "before",
      new Date(now.getTime() - 10 * 60_000)
    );
    const tentativeStep = await addStep(
      tentative,
      "Get ready",
      "pending",
      "before",
      new Date(now.getTime() - 10 * 60_000)
    );
    await setLocation("college");
    await sweepMootRoutineSteps(sql, userId, now);
    expect(await statusOf(elsewhereStep)).toBe("pending");
    expect(await statusOf(notYetOpenStep)).toBe("pending");
    expect(await statusOf(cancelledStep)).toBe("pending");
    expect(await statusOf(tentativeStep)).toBe("pending");
  });

  it("is idempotent: a second sweep with nothing new to skip changes nothing", async () => {
    const commitmentId = crypto.randomUUID();
    await createCommitment({ id: commitmentId, locationId: "college" });
    const packBag = await addStep(commitmentId, "Pack Bag", "pending", "before", new Date(now.getTime() - 10 * 60_000));
    await setLocation("college");
    await sweepMootRoutineSteps(sql, userId, now);
    const versionAfterFirst = (
      await sql<{ version: number }[]>`SELECT version FROM routine_steps WHERE id=${packBag}`
    )[0]!.version;
    await sweepMootRoutineSteps(sql, userId, now);
    const versionAfterSecond = (
      await sql<{ version: number }[]>`SELECT version FROM routine_steps WHERE id=${packBag}`
    )[0]!.version;
    expect(await statusOf(packBag)).toBe("skipped");
    expect(versionAfterSecond).toBe(versionAfterFirst);
  });

  it("does nothing when the stored location assertion has gone stale (report: Monday's 'at College' skipping Tuesday's Pack Bag)", async () => {
    const commitmentId = crypto.randomUUID();
    await createCommitment({ id: commitmentId, locationId: "college" });
    const packBag = await addStep(commitmentId, "Pack Bag", "pending", "before", new Date(now.getTime() - 10 * 60_000));
    // Asserted well outside the default 480-minute window, exactly the "assertion from days ago"
    // shape that bug class covers — but read raw, never expired, before this fix.
    await setLocation("college", new Date(now.getTime() - 500 * 60_000));
    await sweepMootRoutineSteps(sql, userId, now);
    expect(await statusOf(packBag)).toBe("pending");
  });

  it("skips right up to the staleness boundary and no further — the constant is fixed in code, not a per-user setting", async () => {
    // `location_stale_after_minutes` used to be a per-user column, but nothing could ever write it (no
    // portal form, no CLI field) and it was always the same 480; dropped, so this boundary is now
    // `DEFAULT_LOCATION_STALE_AFTER_MINUTES` for every user, unconditionally.
    const commitmentId = crypto.randomUUID();
    await createCommitment({ id: commitmentId, locationId: "college" });
    const packBag = await addStep(commitmentId, "Pack Bag", "pending", "before", new Date(now.getTime() - 10 * 60_000));
    await setLocation("college", new Date(now.getTime() - 479 * 60_000));
    await sweepMootRoutineSteps(sql, userId, now);
    expect(await statusOf(packBag)).toBe("skipped");
  });

  it("does nothing when the stored assertion has no locationSetAt at all — an untimed assertion is not trusted enough to act on", async () => {
    const commitmentId = crypto.randomUUID();
    await createCommitment({ id: commitmentId, locationId: "college" });
    const packBag = await addStep(commitmentId, "Pack Bag", "pending", "before", new Date(now.getTime() - 10 * 60_000));
    await sql`
      UPDATE user_preferences
      SET current_situation=${sql.json({ locationId: "college", overrides: {}, carrying: {} } as never)}
      WHERE user_id=${userId}
    `;
    await sweepMootRoutineSteps(sql, userId, now);
    expect(await statusOf(packBag)).toBe("pending");
  });

  it("marks a before-phase step skipped and places nothing — the engine, not this sweep, places the surviving siblings on its next run", async () => {
    const startsAt = new Date(now.getTime() - 10 * 60_000);
    const endsAt = new Date(now.getTime() + 50 * 60_000);
    const commitmentId = crypto.randomUUID();
    await createCommitment({ id: commitmentId, locationId: "college", startsAt, endsAt });
    const packBag = await addStep(commitmentId, "Pack Bag", "pending", "before", startsAt);
    // Given a real placement to start with, so "unchanged" below is a meaningful assertion rather than
    // null staying null.
    const unpackScheduledAt = new Date(now.getTime() + 55 * 60_000);
    const unpack = await addStep(commitmentId, "Unpack", "pending", "after", unpackScheduledAt);
    await setLocation("college");
    await sweepMootRoutineSteps(sql, userId, now);
    expect(await statusOf(packBag)).toBe("skipped");
    // After-phase steps are never this sweep's business (same rule as the write-time skip), and the
    // sweep itself never reschedules anything any more — its own times are exactly as they were.
    expect(await scheduledTimesOf(unpack)).toEqual({
      scheduled_start_at: unpackScheduledAt,
      scheduled_end_at: null
    });
  });
});
