import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import { enqueuePlanForecastJob, integrationDatabaseName } from "@openrhen/database";
import type { CheckInCommand, PlanForecastRequest } from "@openrhen/contracts";
import { CommandConflictError, InvalidCommandError } from "./command-errors";
import { runCheckInCommand } from "./check-in-commands";
import { readCheckInSummary, readCheckInTrail, readCurrentCheckIn } from "./readers/check-in-read";
import { ensureUser } from "./ensure-user";

type SingleAnswerCommand = Extract<CheckInCommand, { type: "answer_check_in" }>;
type BatchAnswerCommand = Extract<CheckInCommand, { type: "answer_check_ins" }>;

config({ path: resolve(process.cwd(), "../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(process.env.TEST_DATABASE_NAME, "openrhen_check_in_commands");

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let userId: string;

/** Inserts a `check_in` row directly, bypassing the scheduler — this suite is about the answer path. */
async function insertCheckIn(row: {
  status?: "pending" | "on_track" | "deviated" | "unknown" | "superseded";
  directiveKind?: string;
  directiveTargetId?: string | null;
  directiveTitle?: string;
  /** How far back `slot_at` lands, so ordering between rows inserted in the same test is unambiguous. */
  minutesAgo?: number;
  /** Set for a row that was answered rather than merely resolved — the difference 'unknown' hides. */
  answeredAt?: Date;
}): Promise<{ id: string; version: number }> {
  const slotAt = new Date(Date.now() - (row.minutesAgo ?? 0) * 60_000);
  const rows = await sql<{ id: string; version: number }[]>`
    INSERT INTO check_in (user_id, slot_at, directive_kind, directive_target_id, directive_title, status, answered_at)
    VALUES (${userId}, ${slotAt}, ${row.directiveKind ?? "action"}, ${row.directiveTargetId ?? null}, ${row.directiveTitle ?? "Write the report"}, ${row.status ?? "pending"}, ${row.answeredAt ?? null})
    RETURNING id, version
  `;
  return rows[0]!;
}

/** Inserts a minimal `sessions` row for a deliverable, the only target kind the trail reads. */
async function insertSession(row: { startedAt: Date; targetId?: string }): Promise<{ id: string; targetId: string }> {
  const targetId = row.targetId ?? crypto.randomUUID();
  const rows = await sql<{ id: string }[]>`
    INSERT INTO sessions (
      user_id, target_type, target_id, status, planned_started_at, planned_end_at, started_at,
      planned_minutes, remaining_before_minutes
    )
    VALUES (
      ${userId}, 'deliverable', ${targetId}, 'running', ${row.startedAt},
      ${new Date(row.startedAt.getTime() + 60 * 60_000)}, ${row.startedAt}, 60, 60
    )
    RETURNING id
  `;
  return { id: rows[0]!.id, targetId };
}

function answerCommand(
  overrides: Partial<SingleAnswerCommand> & Pick<SingleAnswerCommand, "checkInId" | "expectedVersion">
): SingleAnswerCommand {
  return {
    commandId: crypto.randomUUID(),
    type: "answer_check_in",
    status: "on_track",
    answerSource: "in_app_banner",
    ...overrides
  };
}

function batchAnswerCommand(
  overrides: Partial<BatchAnswerCommand> & Pick<BatchAnswerCommand, "checkInIds" | "upTo">
): BatchAnswerCommand {
  return {
    commandId: crypto.randomUUID(),
    type: "answer_check_ins",
    tail: { status: "unknown" },
    ...overrides
  };
}

beforeAll(async () => {
  const admin = postgres(adminUrl, { max: 1, connect_timeout: 10 });
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
    await migrate(drizzle(migrationSql), { migrationsFolder: resolve(process.cwd(), "../platform/database/drizzle") });
  } finally {
    await migrationSql.end();
  }
  sql = postgres(testUrl.toString(), { max: 5, connect_timeout: 10, fetch_types: false, prepare: true });
  userId = await ensureUser(sql);
}, 30_000);

beforeEach(async () => {
  await sql.unsafe("TRUNCATE TABLE check_in, writes, write_rows, sessions, session_segments, sleep_plans CASCADE");
});

afterAll(async () => {
  await sql?.end();
});

describe("runCheckInCommand", () => {
  it("records an on-track answer, stamping answered_at and the answer source", async () => {
    const row = await insertCheckIn({});
    await runCheckInCommand(sql, answerCommand({ checkInId: row.id, expectedVersion: row.version }));
    const stored = await sql<{ status: string; answered_at: Date | null; answer_source: string }[]>`
      SELECT status, answered_at, answer_source FROM check_in WHERE id=${row.id}
    `;
    expect(stored[0]).toMatchObject({ status: "on_track", answer_source: "in_app_banner" });
    expect(stored[0]!.answered_at).not.toBeNull();
  });

  it("records a deviated answer with its category, note and named task", async () => {
    const row = await insertCheckIn({});
    await runCheckInCommand(
      sql,
      answerCommand({
        checkInId: row.id,
        expectedVersion: row.version,
        status: "deviated",
        deviationCategory: "family",
        deviationNote: "Kid needed picking up",
        deviationTargetId: "action-42",
        answerSource: "sheet"
      })
    );
    const stored = await sql<
      { status: string; deviation_category: string; deviation_note: string; deviation_target_id: string }[]
    >`SELECT status, deviation_category, deviation_note, deviation_target_id FROM check_in WHERE id=${row.id}`;
    expect(stored[0]).toMatchObject({
      status: "deviated",
      deviation_category: "family",
      deviation_note: "Kid needed picking up",
      deviation_target_id: "action-42"
    });
  });

  it("can answer a catch-up ('unknown') slot after the fact", async () => {
    const row = await insertCheckIn({ status: "unknown" });
    await runCheckInCommand(
      sql,
      answerCommand({ checkInId: row.id, expectedVersion: row.version, status: "on_track" })
    );
    const stored = await sql<{ status: string }[]>`SELECT status FROM check_in WHERE id=${row.id}`;
    expect(stored[0]!.status).toBe("on_track");
  });

  it("refuses to answer a check-in that has already been answered", async () => {
    const row = await insertCheckIn({ status: "on_track" });
    await expect(
      runCheckInCommand(sql, answerCommand({ checkInId: row.id, expectedVersion: row.version }))
    ).rejects.toThrow(InvalidCommandError);
  });

  it("refuses to re-answer a slot already answered 'unsure'", async () => {
    // 'unsure' stores status 'unknown', which is also what a timeout stores. Only `answered_at`
    // separates "somebody said they didn't know" from "nobody said anything", so only `answered_at`
    // can decide whether the slot is still open.
    const row = await insertCheckIn({});
    await runCheckInCommand(sql, answerCommand({ checkInId: row.id, expectedVersion: row.version, status: "unknown" }));
    await expect(
      runCheckInCommand(sql, answerCommand({ checkInId: row.id, expectedVersion: row.version + 1 }))
    ).rejects.toThrow(InvalidCommandError);
  });

  it("still succeeds on a replayed commandId after an 'unsure' answer", async () => {
    const row = await insertCheckIn({});
    const command = answerCommand({ checkInId: row.id, expectedVersion: row.version, status: "unknown" });
    await runCheckInCommand(sql, command);
    await expect(runCheckInCommand(sql, command)).resolves.toBeTruthy();
    const stored = await sql<
      { status: string; version: number }[]
    >`SELECT status, version FROM check_in WHERE id=${row.id}`;
    expect(stored[0]).toMatchObject({ status: "unknown", version: row.version + 1 });
  });

  it("refuses to answer a superseded check-in", async () => {
    const row = await insertCheckIn({ status: "superseded" });
    await expect(
      runCheckInCommand(sql, answerCommand({ checkInId: row.id, expectedVersion: row.version }))
    ).rejects.toThrow(InvalidCommandError);
  });

  it("refuses a stale version", async () => {
    const row = await insertCheckIn({});
    await expect(
      runCheckInCommand(sql, answerCommand({ checkInId: row.id, expectedVersion: row.version + 1 }))
    ).rejects.toThrow(CommandConflictError);
  });

  it("is idempotent under the same commandId, never double-answering", async () => {
    const row = await insertCheckIn({});
    const command = answerCommand({ checkInId: row.id, expectedVersion: row.version });
    await runCheckInCommand(sql, command);
    await runCheckInCommand(sql, command);
    const stored = await sql<
      { status: string; version: number }[]
    >`SELECT status, version FROM check_in WHERE id=${row.id}`;
    expect(stored[0]).toMatchObject({ status: "on_track", version: row.version + 1 });
  });

  it("never touches planning_runs or enqueues a job — answering is record-only", async () => {
    const row = await insertCheckIn({});
    const jobsBefore = await sql`SELECT count(*)::int AS count FROM jobs`;
    await runCheckInCommand(sql, answerCommand({ checkInId: row.id, expectedVersion: row.version }));
    const jobsAfter = await sql`SELECT count(*)::int AS count FROM jobs`;
    expect(jobsAfter[0]!.count).toBe(jobsBefore[0]!.count);
  });

  it("writes no write_rows row for a single answer", async () => {
    const row = await insertCheckIn({});
    await runCheckInCommand(sql, answerCommand({ checkInId: row.id, expectedVersion: row.version }));
    const rows = await sql`SELECT count(*)::int AS count FROM write_rows WHERE user_id=${userId}`;
    expect(rows[0]!.count).toBe(0);
  });

  it("writes no write_rows row for a batch answer", async () => {
    const row = await insertCheckIn({ status: "unknown", minutesAgo: 30 });
    await runCheckInCommand(
      sql,
      batchAnswerCommand({ checkInIds: [row.id], upTo: new Date().toISOString(), tail: { status: "unknown" } })
    );
    const rows = await sql`SELECT count(*)::int AS count FROM write_rows WHERE user_id=${userId}`;
    expect(rows[0]!.count).toBe(0);
  });

  // Before this change, answering wrote a `write_rows` row. A `validity_boundary` job's worker check
  // (`stateChangedSince`) looks for a `write_rows` row newer than the state snapshot the job was
  // chained from — that row would have superseded the job. Answering must leave a pending boundary
  // job alone: no `write_rows` row means `stateChangedSince` finds nothing, and the job is never
  // claimed-and-superseded on that basis.
  it("leaves a pending validity_boundary job pending after an answer — it never becomes superseded evidence", async () => {
    const row = await insertCheckIn({});
    const stateCapturedAt = new Date(Date.now() - 60_000).toISOString();
    const request = { inputVersion: "test-input-1", calculatedAt: stateCapturedAt } as unknown as PlanForecastRequest;
    const jobId = await enqueuePlanForecastJob(sql, userId, request, "validity_boundary", new Date(0), stateCapturedAt);

    await runCheckInCommand(sql, answerCommand({ checkInId: row.id, expectedVersion: row.version }));

    const jobRows = await sql<{ status: string }[]>`SELECT status FROM jobs WHERE id=${jobId}`;
    expect(jobRows[0]!.status).toBe("pending");

    // The runtime's own supersession check, run directly: no write_rows row newer than the job's
    // captured state exists, so `stateChangedSince` would find nothing and the worker would not
    // supersede this job when it claims it.
    const changed = await sql<{ exists: boolean }[]>`
      SELECT EXISTS(SELECT 1 FROM write_rows WHERE user_id=${userId} AND created_at>${new Date(stateCapturedAt)}) AS exists
    `;
    expect(changed[0]!.exists).toBe(false);
  });
});

describe("readCurrentCheckIn", () => {
  it("surfaces a still-pending slot and stamps prompted_at on first read", async () => {
    const row = await insertCheckIn({ directiveTitle: "Write the report" });
    const first = await readCurrentCheckIn(sql, userId);
    expect(first).toMatchObject({ id: row.id, status: "pending", directiveTitle: "Write the report" });
    expect(first!.promptedAt).not.toBeNull();
  });

  it("surfaces the most recent unknown slot for catch-up", async () => {
    await insertCheckIn({ status: "unknown" });
    const current = await readCurrentCheckIn(sql, userId);
    expect(current?.status).toBe("unknown");
  });

  it("stops surfacing an unknown slot once it has been answered 'unsure'", async () => {
    const row = await insertCheckIn({});
    expect(await readCurrentCheckIn(sql, userId)).not.toBeNull();
    await runCheckInCommand(sql, answerCommand({ checkInId: row.id, expectedVersion: row.version, status: "unknown" }));
    expect(await readCurrentCheckIn(sql, userId)).toBeNull();
  });

  it("does not surface an unknown slot that carries an answered_at", async () => {
    await insertCheckIn({ status: "unknown", answeredAt: new Date() });
    expect(await readCurrentCheckIn(sql, userId)).toBeNull();
  });

  it("surfaces nothing once the latest slot is answered or superseded", async () => {
    await insertCheckIn({ status: "on_track" });
    expect(await readCurrentCheckIn(sql, userId)).toBeNull();
  });

  it("never surfaces an older unknown behind a more recent resolved slot", async () => {
    await insertCheckIn({ status: "unknown", minutesAgo: 30 });
    await insertCheckIn({ status: "on_track", minutesAgo: 0 });
    expect(await readCurrentCheckIn(sql, userId)).toBeNull();
  });

  // Behaviour contract, "Check-in sampling": "A missed pending slot surfaces once as a catch-up
  // prompt on return, never as a backlog." The scheduler's own timeout only ever flips the row it
  // times out, never anything older, so a run of missed slots that piled up while nothing answered
  // them can leave several unanswered 'unknown' rows in the table — this proves the read side still
  // collapses that history to the single most recent one, not a list of the ones that came before it.
  it("collapses several missed slots into the single most recent one, never a backlog", async () => {
    const oldest = await insertCheckIn({ status: "unknown", minutesAgo: 90, directiveTitle: "Draft the outline" });
    const middle = await insertCheckIn({ status: "unknown", minutesAgo: 60, directiveTitle: "Call the plumber" });
    const latest = await insertCheckIn({ status: "unknown", minutesAgo: 30, directiveTitle: "Pack the bag" });

    const current = await readCurrentCheckIn(sql, userId);

    expect(current).toMatchObject({ id: latest.id, status: "unknown", directiveTitle: "Pack the bag" });
    expect(current!.id).not.toBe(oldest.id);
    expect(current!.id).not.toBe(middle.id);
  });

  // A slot the scheduler has since moved past (a fresh 'pending' row) is what should be shown, even
  // though the earlier missed slot's row is still sitting there unanswered — the scheduler supersedes
  // only a 'pending' row on create, never an 'unknown' one, so the two rows genuinely coexist.
  it("shows a fresh pending slot over an older unresolved catch-up, not both", async () => {
    const missed = await insertCheckIn({ status: "unknown", minutesAgo: 45, directiveTitle: "Pack the bag" });
    const fresh = await insertCheckIn({ status: "pending", minutesAgo: 0, directiveTitle: "Start the drive" });

    const current = await readCurrentCheckIn(sql, userId);

    expect(current).toMatchObject({ id: fresh.id, status: "pending", directiveTitle: "Start the drive" });
    expect(current!.id).not.toBe(missed.id);
  });
});

describe("answer_check_ins (reconciliation batch)", () => {
  it("splits a trail at upTo: on_track at/before it, the tail answer after it", async () => {
    const before = await insertCheckIn({ status: "unknown", minutesAgo: 180 });
    const at = await insertCheckIn({ status: "unknown", minutesAgo: 120 });
    const after = await insertCheckIn({ status: "unknown", minutesAgo: 60 });
    const upTo = new Date(Date.now() - 120 * 60_000);
    await runCheckInCommand(
      sql,
      batchAnswerCommand({
        checkInIds: [before.id, at.id, after.id],
        upTo: upTo.toISOString(),
        tail: { status: "deviated", deviationCategory: "work", deviationNote: "kept working" }
      })
    );
    const rows = await sql<
      {
        id: string;
        status: string;
        deviation_category: string | null;
        deviation_note: string | null;
        answer_source: string | null;
      }[]
    >`SELECT id, status, deviation_category, deviation_note, answer_source FROM check_in WHERE id IN (${before.id}, ${at.id}, ${after.id})`;
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(before.id)).toMatchObject({ status: "on_track", answer_source: "session_reconciliation" });
    expect(byId.get(at.id)).toMatchObject({ status: "on_track", answer_source: "session_reconciliation" });
    expect(byId.get(after.id)).toMatchObject({
      status: "deviated",
      deviation_category: "work",
      deviation_note: "kept working",
      answer_source: "session_reconciliation"
    });
  });

  it("settles the whole trail on_track for the 'I was working the whole time' escape hatch", async () => {
    const a = await insertCheckIn({ status: "unknown", minutesAgo: 180 });
    const b = await insertCheckIn({ status: "unknown", minutesAgo: 60 });
    await runCheckInCommand(
      sql,
      batchAnswerCommand({ checkInIds: [a.id, b.id], upTo: new Date().toISOString(), tail: { status: "unknown" } })
    );
    const rows = await sql<{ status: string }[]>`SELECT status FROM check_in WHERE id IN (${a.id}, ${b.id})`;
    expect(rows.every((r) => r.status === "on_track")).toBe(true);
  });

  it("skips a row that is no longer unknown-and-unanswered, without failing the rest of the batch", async () => {
    const alreadyAnswered = await insertCheckIn({ status: "on_track" });
    const stillOpen = await insertCheckIn({ status: "unknown", minutesAgo: 30 });
    await runCheckInCommand(
      sql,
      batchAnswerCommand({
        checkInIds: [alreadyAnswered.id, stillOpen.id],
        upTo: new Date().toISOString(),
        tail: { status: "unknown" }
      })
    );
    const rows = await sql<{ id: string; status: string; answer_source: string | null }[]>`
      SELECT id, status, answer_source FROM check_in WHERE id IN (${alreadyAnswered.id}, ${stillOpen.id})
    `;
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(alreadyAnswered.id)).toMatchObject({ status: "on_track", answer_source: null });
    expect(byId.get(stillOpen.id)).toMatchObject({ status: "on_track", answer_source: "session_reconciliation" });
  });

  it("never touches planning_runs or enqueues a job — the batch answer is record-only too", async () => {
    const row = await insertCheckIn({ status: "unknown", minutesAgo: 30 });
    await runCheckInCommand(
      sql,
      batchAnswerCommand({ checkInIds: [row.id], upTo: new Date().toISOString(), tail: { status: "unknown" } })
    );
    const runs = await sql<
      { count: number }[]
    >`SELECT COUNT(*)::int AS count FROM planning_runs WHERE user_id=${userId}`;
    expect(runs[0]!.count).toBe(0);
  });
});

describe("readCheckInTrail", () => {
  it("returns only this session's unknown, unanswered rows, oldest first", async () => {
    const session = await insertSession({ startedAt: new Date(Date.now() - 4 * 60 * 60_000) });
    const oldest = await insertCheckIn({
      status: "unknown",
      minutesAgo: 180,
      directiveKind: "deliverable",
      directiveTargetId: session.targetId,
      directiveTitle: "Draft the report"
    });
    const newest = await insertCheckIn({
      status: "unknown",
      minutesAgo: 60,
      directiveKind: "deliverable",
      directiveTargetId: session.targetId,
      directiveTitle: "Draft the report"
    });
    // Not in the trail: answered, superseded, a different target, and a non-deliverable directive.
    await insertCheckIn({
      status: "on_track",
      minutesAgo: 150,
      directiveKind: "deliverable",
      directiveTargetId: session.targetId,
      answeredAt: new Date()
    });
    await insertCheckIn({
      status: "unknown",
      minutesAgo: 150,
      directiveKind: "deliverable",
      directiveTargetId: crypto.randomUUID()
    });
    await insertCheckIn({
      status: "unknown",
      minutesAgo: 150,
      directiveKind: "action",
      directiveTargetId: session.targetId
    });

    const trail = await readCheckInTrail(sql, userId, session.id);

    expect(trail!.rows.map((r) => r.id)).toEqual([oldest.id, newest.id]);
    expect(trail!.rows[0]).toMatchObject({ directiveTitle: "Draft the report" });
  });

  it("excludes a slot before the session started even if it matches the target", async () => {
    const startedAt = new Date(Date.now() - 60 * 60_000);
    const session = await insertSession({ startedAt });
    const tooOld = await insertCheckIn({
      status: "unknown",
      minutesAgo: 120,
      directiveKind: "deliverable",
      directiveTargetId: session.targetId
    });
    const inRange = await insertCheckIn({
      status: "unknown",
      minutesAgo: 30,
      directiveKind: "deliverable",
      directiveTargetId: session.targetId
    });
    const trail = await readCheckInTrail(sql, userId, session.id);
    expect(trail!.rows.map((r) => r.id)).toEqual([inRange.id]);
    expect(trail!.rows.map((r) => r.id)).not.toContain(tooOld.id);
  });

  it("returns null for a session id that does not belong to this user", async () => {
    const trail = await readCheckInTrail(sql, crypto.randomUUID(), crypto.randomUUID());
    expect(trail).toBeNull();
  });

  it("surfaces recorded sleep starts since the session began, ascending", async () => {
    const startedAt = new Date(Date.now() - 6 * 60 * 60_000);
    const session = await insertSession({ startedAt });
    const sleepStart = new Date(Date.now() - 3 * 60 * 60_000);
    await sql`
      INSERT INTO sleep_plans (
        user_id, planned_start_at, planned_wake_at, desired_minutes, allowed_minutes,
        explanation, actual_start_at, status
      )
      VALUES (
        ${userId}, ${sleepStart}, ${new Date(sleepStart.getTime() + 8 * 60 * 60_000)}, 480, 480,
        'test', ${sleepStart}, 'sleeping'
      )
    `;
    const trail = await readCheckInTrail(sql, userId, session.id);
    expect(trail!.sleepStarts).toEqual([sleepStart.toISOString()]);
  });
});

describe("readCheckInSummary", () => {
  it("tallies answered (on-track vs deviated) separately from missed", async () => {
    await insertCheckIn({ status: "on_track" });
    await insertCheckIn({ status: "on_track" });
    await insertCheckIn({ status: "deviated" });
    await insertCheckIn({ status: "unknown" });
    await insertCheckIn({ status: "pending" });
    const summary = await readCheckInSummary(sql, userId);
    expect(summary).toEqual({ answered: 3, onTrack: 2, deviated: 1, unknown: 1 });
  });
});
