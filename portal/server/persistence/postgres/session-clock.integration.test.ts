import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { fileURLToPath } from "node:url";
import { integrationDatabaseName } from "@openrhen/database";
import { ensureUser } from "./ensure-user";
import { runActivityCommand } from "./activity-commands";

/**
 * Session commands when the wall clock steps backwards between two of them (NTP, or WSL
 * resyncing with its Windows host). `vi.setSystemTime` moves only `Date`, so the fixture's segment is
 * stamped at real now and the command then runs a second "earlier". Each command must still save, with
 * every segment ending after it starts (`session_segments_time_check`) and never overlapping the last.
 * Self-contained `_test` database, the same pattern as `activity-commands-ended-at.integration.test.ts`.
 */
// Resolved from this file rather than from `process.cwd()`, so the one `.env` is found whether the
// suite is collected from `portal/` or from the repository root.
config({ path: fileURLToPath(new URL("../../../../.env", import.meta.url)), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(
  process.env.SESSION_CLOCK_TEST_DATABASE_NAME,
  "openrhen_session_clock"
);

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("SESSION_CLOCK_TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let userId: string;

const STEP_BACK_MS = 1_000;

async function createCommitment(): Promise<string> {
  const id = crypto.randomUUID();
  await sql`
    INSERT INTO commitments (id,user_id,title,starts_at,ends_at,status)
    VALUES (${id},${userId},'Work',${new Date(Date.now() - 3_600_000)},${new Date(Date.now() + 3_600_000)},'confirmed')
  `;
  return id;
}

/** A session whose latest segment boundary is real now: open when running, just closed when paused. */
async function createSession(
  status: "running" | "paused",
  target: "fixed_commitment"
): Promise<{ id: string; version: number; boundary: Date }> {
  const id = crypto.randomUUID();
  const startedAt = new Date(Date.now() - 60_000);
  const boundary = new Date();
  const targetId = await createCommitment();
  await sql`
    INSERT INTO sessions (id,user_id,target_type,target_id,target_title,status,planned_started_at,planned_end_at,started_at,planned_minutes,remaining_before_minutes,paused_remaining_seconds)
    VALUES (${id},${userId},${target},${targetId},'Fixture session',${status},${startedAt},${new Date(Date.now() + 3_600_000)},${startedAt},60,0,${status === "paused" ? 1800 : null})
  `;
  if (status === "running") await sql`INSERT INTO session_segments (session_id,started_at) VALUES (${id},${boundary})`;
  else await sql`INSERT INTO session_segments (session_id,started_at,ended_at) VALUES (${id},${startedAt},${boundary})`;
  const rows = await sql<{ version: number }[]>`SELECT version FROM sessions WHERE id=${id}`;
  return { id, version: rows[0]!.version, boundary };
}

function stepClockBack(): void {
  vi.setSystemTime(new Date(Date.now() - STEP_BACK_MS));
}

async function segments(sessionId: string): Promise<{ started_at: Date; ended_at: Date | null }[]> {
  return sql<
    { started_at: Date; ended_at: Date | null }[]
  >`SELECT started_at,ended_at FROM session_segments WHERE session_id=${sessionId} ORDER BY started_at`;
}

/** Every closed segment ends after it starts, and each one starts no earlier than the last ended. */
function expectOrdered(rows: { started_at: Date; ended_at: Date | null }[]): void {
  rows.forEach((row, index) => {
    if (row.ended_at) expect(row.ended_at.getTime()).toBeGreaterThan(row.started_at.getTime());
    const previous = rows[index - 1];
    if (previous?.ended_at) expect(row.started_at.getTime()).toBeGreaterThanOrEqual(previous.ended_at.getTime());
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
  sql = postgres(testUrl.toString(), { max: 5, connect_timeout: 10, fetch_types: false, prepare: true });
  userId = await ensureUser(sql);
}, 30_000);

beforeEach(async () => {
  await sql.unsafe(
    "TRUNCATE TABLE writes, write_rows, session_segments, sessions, routine_steps, commitments RESTART IDENTITY CASCADE"
  );
});

afterAll(async () => {
  await sql?.end();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a backward clock step between session commands", () => {
  it("pauses an activity whose open segment started after the stepped-back now", async () => {
    const session = await createSession("running", "fixed_commitment");
    stepClockBack();
    await runActivityCommand(sql, {
      commandId: crypto.randomUUID(),
      expectedVersion: session.version,
      type: "pause_activity",
      sessionId: session.id
    });
    const rows = await segments(session.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ended_at!.getTime()).toBe(session.boundary.getTime() + 1);
  });

  it("resumes a paused activity after its last close, not before it", async () => {
    const session = await createSession("paused", "fixed_commitment");
    stepClockBack();
    await runActivityCommand(sql, {
      commandId: crypto.randomUUID(),
      expectedVersion: session.version,
      type: "resume_activity",
      sessionId: session.id
    });
    const rows = await segments(session.id);
    expect(rows).toHaveLength(2);
    expectOrdered(rows);
    expect(rows[1]!.ended_at).toBeNull();
  });

  it("finishes an activity, closing its segment and the session after the segment's start", async () => {
    const session = await createSession("running", "fixed_commitment");
    stepClockBack();
    await runActivityCommand(sql, {
      commandId: crypto.randomUUID(),
      expectedVersion: session.version,
      type: "finish_activity",
      sessionId: session.id,
      outcome: "completed"
    });
    const rows = await segments(session.id);
    expectOrdered(rows);
    const ended = await sql<
      { status: string; ended_at: Date }[]
    >`SELECT status,ended_at FROM sessions WHERE id=${session.id}`;
    expect(ended[0]!.status).toBe("completed");
    expect(ended[0]!.ended_at.getTime()).toBe(rows[0]!.ended_at!.getTime());
  });

  it("uses the wall clock unchanged when it has not stepped back", async () => {
    const session = await createSession("running", "fixed_commitment");
    vi.setSystemTime(new Date(Date.now() + 60_000));
    const now = Date.now();
    await runActivityCommand(sql, {
      commandId: crypto.randomUUID(),
      expectedVersion: session.version,
      type: "pause_activity",
      sessionId: session.id
    });
    const rows = await segments(session.id);
    expect(rows[0]!.ended_at!.getTime()).toBe(now);
  });
});
