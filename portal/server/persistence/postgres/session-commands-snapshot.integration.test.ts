import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { fileURLToPath } from "node:url";
import { integrationDatabaseName } from "@openrhen/database";
import { runWithActor } from "@/server/agent-actor";
import { CommandConflictError } from "./command-errors";
import { ensureUser } from "./ensure-user";
import { runSessionCommand } from "./session-commands";
import { runRevertCommand } from "./write-revert";
import type { SnapshotRow } from "./write-snapshot";

/**
 * An agent's session write keeps a row snapshot so it can be undone afterwards (the design notes,
 * "Undo after"): start, pause, finish on a plain action, on a recurring occurrence and on a cadence action, and
 * block each store the rows they changed, as they were and as the write left them. The person's own write stores
 * none. The first groups assert the snapshot's contents; the last puts the rows back through `runRevertCommand`.
 * Self-contained `_test` database, the same pattern as `action-session-backfill.integration.test.ts`.
 */
config({ path: fileURLToPath(new URL("../../../../.env", import.meta.url)), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(
  process.env.SESSION_SNAPSHOT_TEST_DATABASE_NAME,
  "openrhen_session_snapshot"
);

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("SESSION_SNAPSHOT_TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let userId: string;

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);
const asAgent = <T>(run: () => Promise<T>) => runWithActor("claude", run);

type Image = Record<string, unknown>;

async function createAction(
  schedulingMode: "one_off" | "recurring" | "cadence" = "one_off"
): Promise<{ actionId: string; version: number }> {
  const area = await sql<
    { id: string }[]
  >`INSERT INTO areas (user_id,name,status,sort_order) VALUES (${userId},${"Area " + crypto.randomUUID()},'active',0) RETURNING id`;
  const outcome = await sql<
    { id: string }[]
  >`INSERT INTO outcomes (area_id,title,definition_of_done,status) VALUES (${area[0]!.id},'Outcome','Done','active') RETURNING id`;
  const project = await sql<
    { id: string }[]
  >`INSERT INTO projects (outcome_id,title,status) VALUES (${outcome[0]!.id},'Project','active') RETURNING id`;
  const action = await sql<{ id: string; version: number }[]>`
    INSERT INTO actions (project_id,title,scheduling_mode,status,optimistic_minutes,expected_minutes,pessimistic_minutes,remaining_minutes,energy,minimum_session_minutes,maximum_session_minutes)
    VALUES (${project[0]!.id},'Draft citations',${schedulingMode},'active',30,60,90,60,'medium',15,90)
    RETURNING id, version
  `;
  return { actionId: action[0]!.id, version: action[0]!.version };
}

/**
 * A recurrence rule; `total_minutes` makes the series close at `targetMinutes`. A windowed rule (recurring) gets one
 * window; a cadence rule carries none, which the portal state refuses.
 */
async function createRule(
  actionId: string,
  completion: { mode: "manual" } | { mode: "total_minutes"; targetMinutes: number },
  windowed = true
): Promise<{ ruleId: string; windowId: string }> {
  const rule = await sql<{ id: string }[]>`
    INSERT INTO action_recurrence_rules (action_id,timezone,start_date,interval_days,completion_mode,target_total_minutes)
    VALUES (${actionId},'Australia/Sydney','2026-01-01',1,${completion.mode},${completion.mode === "total_minutes" ? completion.targetMinutes : null})
    RETURNING id
  `;
  if (!windowed) return { ruleId: rule[0]!.id, windowId: "" };
  const window = await sql<{ id: string }[]>`
    INSERT INTO action_recurrence_windows (rule_id,name,anchor,local_start_time,local_end_time)
    VALUES (${rule[0]!.id},'Anytime','local_time','00:00','23:59') RETURNING id
  `;
  return { ruleId: rule[0]!.id, windowId: window[0]!.id };
}

async function createOccurrence(
  actionId: string,
  ruleId: string,
  windowId: string,
  localDate: string,
  starts: Date,
  ends: Date
): Promise<string> {
  const id = `occ-${crypto.randomUUID()}`;
  await sql`
    INSERT INTO action_occurrences (id,action_id,rule_id,window_id,local_date,window_starts_at,window_ends_at,anchor_source)
    VALUES (${id},${actionId},${ruleId},${windowId},${localDate},${starts},${ends},'local_time')
  `;
  return id;
}

/** A running (or paused) action session with one open (or closed) segment, as a start leaves it. */
async function createActionSession(
  actionId: string,
  occurrenceId: string | null,
  state: "running" | "paused" = "running"
): Promise<{ id: string; version: number; segmentId: string }> {
  const id = crypto.randomUUID();
  const startedAt = minutesAgo(30);
  await sql`
    INSERT INTO sessions (id,user_id,action_id,occurrence_id,status,planned_started_at,planned_end_at,started_at,planned_minutes,remaining_before_minutes,paused_remaining_seconds,started_by)
    VALUES (${id},${userId},${actionId},${occurrenceId},${state},${startedAt},${new Date(Date.now() + 30 * 60_000)},${startedAt},60,60,${state === "paused" ? 1800 : null},'claude')
  `;
  const segment = await sql<{ id: string }[]>`
    INSERT INTO session_segments (session_id,started_at,ended_at) VALUES (${id},${startedAt},${state === "paused" ? minutesAgo(5) : null}) RETURNING id
  `;
  const rows = await sql<{ version: number }[]>`SELECT version FROM sessions WHERE id=${id}`;
  return { id, version: rows[0]!.version, segmentId: segment[0]!.id };
}

/** The minimal current plan the action `start` needs (`requireCurrentPlanForecast`). */
async function storePlanningRun(actionId: string): Promise<void> {
  const now = new Date();
  await sql`
    INSERT INTO planning_runs (user_id,request_id,input_version,contract_version,engine_version,calculated_at,valid_until,result)
    VALUES (
      ${userId},${crypto.randomUUID()},'v1','1','v1',${now},${new Date(now.getTime() + 3_600_000)},
      ${sql.json({
        contractVersion: "1",
        requestId: crypto.randomUUID(),
        inputVersion: "v1",
        engineVersion: "v1",
        calculatedAt: now.toISOString(),
        validUntil: new Date(now.getTime() + 3_600_000).toISOString(),
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
        currentDirective: { kind: "action", targetId: actionId, title: "Draft citations", recommendedMinutes: 30 },
        upcomingDirectives: [],
        continuation: null
      } as never)}
    )
  `;
}

interface StoredSnapshot {
  agent: string;
  kind: string;
  state: string;
  rows: SnapshotRow[];
}

async function snapshotOf(commandId: string): Promise<StoredSnapshot | undefined> {
  const found = await sql<StoredSnapshot[]>`
    SELECT actor AS agent,kind,state,images AS rows FROM writes WHERE user_id=${userId} AND id=${commandId} AND images IS NOT NULL`;
  return found[0];
}

function rowsOf(snapshot: StoredSnapshot | undefined, table: string): SnapshotRow[] {
  expect(snapshot).toBeDefined();
  return snapshot!.rows.filter((row) => row.table === table);
}

/** The one snapshot row of `table`, which the write must have recorded exactly once. */
function only(snapshot: StoredSnapshot | undefined, table: string): SnapshotRow {
  const rows = rowsOf(snapshot, table);
  expect(rows, `${table} rows in the snapshot`).toHaveLength(1);
  return rows[0]!;
}

const tablesOf = (snapshot: StoredSnapshot | undefined) => [...new Set(snapshot!.rows.map((row) => row.table))].sort();

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
    "TRUNCATE TABLE writes, write_rows, planning_runs, action_cadence_completions, session_segments, sessions, action_occurrences, action_recurrence_windows, action_recurrence_rules, actions, projects, outcomes, areas RESTART IDENTITY CASCADE"
  );
  await sql`UPDATE user_preferences SET last_woke_at=${minutesAgo(8 * 60)} WHERE user_id=${userId}`;
});

afterAll(async () => {
  await sql?.end();
});

describe("start", () => {
  it("stores the new session and segment as inserted and the action's before-image", async () => {
    const { actionId, version } = await createAction();
    await storePlanningRun(actionId);
    const commandId = crypto.randomUUID();
    await asAgent(() =>
      runSessionCommand(sql, {
        commandId,
        type: "start",
        actionId,
        expectedVersion: version,
        plannedMinutes: 30
      })
    );
    const snapshot = await snapshotOf(commandId);
    expect(snapshot).toMatchObject({ agent: "claude", kind: "session", state: "applied" });
    expect(tablesOf(snapshot)).toEqual(["actions", "session_segments", "sessions"]);

    const session = only(snapshot, "sessions");
    expect(session.id).toBe(commandId);
    expect(session.before).toBeNull();
    expect(session.after).toMatchObject({
      id: commandId,
      status: "running",
      action_id: actionId,
      started_by: "claude"
    });

    const segment = only(snapshot, "session_segments");
    expect(segment.before).toBeNull();
    expect(segment.after).toMatchObject({ id: segment.id, session_id: commandId, ended_at: null });

    const action = only(snapshot, "actions");
    expect(action.id).toBe(actionId);
    expect(action.before).toMatchObject({ status: "active", version });
    expect(action.after).toMatchObject({ status: "doing", version: version + 1 });
  });

  it("stores no snapshot for the person's own start", async () => {
    const { actionId, version } = await createAction();
    await storePlanningRun(actionId);
    const commandId = crypto.randomUUID();
    await runSessionCommand(sql, { commandId, type: "start", actionId, expectedVersion: version, plannedMinutes: 30 });
    expect(await snapshotOf(commandId)).toBeUndefined();
    const sessions = await sql`SELECT id FROM sessions WHERE id=${commandId}`;
    expect(sessions).toHaveLength(1);
  });
});

describe("pause", () => {
  it("stores the session and its closed segment, each as it was and as it is now", async () => {
    const { actionId } = await createAction();
    const session = await createActionSession(actionId, null);
    const commandId = crypto.randomUUID();
    await asAgent(() =>
      runSessionCommand(sql, {
        commandId,
        type: "pause",
        sessionId: session.id,
        expectedVersion: session.version
      })
    );
    const snapshot = await snapshotOf(commandId);
    expect(snapshot?.kind).toBe("session");
    expect(tablesOf(snapshot)).toEqual(["session_segments", "sessions"]);

    const stored = only(snapshot, "sessions");
    expect(stored.id).toBe(session.id);
    expect(stored.before).toMatchObject({
      status: "running",
      version: session.version,
      paused_remaining_seconds: null
    });
    expect(stored.after).toMatchObject({ status: "paused", version: session.version + 1 });
    expect((stored.after as Image).paused_remaining_seconds).toBeGreaterThan(0);

    const segment = only(snapshot, "session_segments");
    expect(segment.id).toBe(session.segmentId);
    expect((segment.before as Image).ended_at).toBeNull();
    expect((segment.after as Image).ended_at).not.toBeNull();
  });
});

describe("finish completed", () => {
  it("on a plain action stores the session, its segment and the action", async () => {
    const { actionId, version } = await createAction();
    const session = await createActionSession(actionId, null);
    const commandId = crypto.randomUUID();
    await asAgent(() =>
      runSessionCommand(sql, {
        commandId,
        type: "finish",
        sessionId: session.id,
        expectedVersion: session.version,
        outcome: "completed"
      })
    );
    const snapshot = await snapshotOf(commandId);
    expect(tablesOf(snapshot)).toEqual(["actions", "session_segments", "sessions"]);

    const stored = only(snapshot, "sessions");
    expect(stored.before).toMatchObject({ status: "running", ended_at: null, active_minutes: 0 });
    expect(stored.after).toMatchObject({ status: "completed", remaining_after_minutes: 0 });
    expect((stored.after as Image).ended_at).not.toBeNull();
    expect((stored.after as Image).active_minutes).toBeGreaterThan(0);

    const segment = only(snapshot, "session_segments");
    expect(segment.id).toBe(session.segmentId);
    expect((segment.before as Image).ended_at).toBeNull();
    expect((segment.after as Image).ended_at).not.toBeNull();

    const action = only(snapshot, "actions");
    expect(action.id).toBe(actionId);
    expect(action.before).toMatchObject({ status: "active", version, remaining_minutes: 60, completed_at: null });
    expect(action.after).toMatchObject({ status: "done", version: version + 1, remaining_minutes: 0 });
    expect((action.after as Image).completed_at).not.toBeNull();
  });

  it("stops calling the remaining effort assumed, since the session has now set it, and keeps the rest", async () => {
    const { actionId } = await createAction();
    await sql`UPDATE actions SET assumed_fields=ARRAY['expectedMinutes','remainingMinutes'] WHERE id=${actionId}`;
    const session = await createActionSession(actionId, null);
    await runSessionCommand(sql, {
      commandId: crypto.randomUUID(),
      type: "finish",
      sessionId: session.id,
      expectedVersion: session.version,
      outcome: "completed"
    });
    const rows = await sql<
      { assumed_fields: string[] }[]
    >`SELECT to_jsonb(assumed_fields) AS assumed_fields FROM actions WHERE id=${actionId}`;
    expect(rows[0]?.assumed_fields).toEqual(["expectedMinutes"]);
  });

  // A finish that states nothing about what is left carries the old figure over: it stays a default if it was one,
  // and keeps the age it had (effort age). Each path has its own UPDATE: the one-off action's and the cadence one's.
  it.each([
    ["one_off", "unsure"],
    ["one_off", "block"],
    ["one_off", "did_not_start"],
    ["cadence", "unsure"],
    ["cadence", "block"],
    ["cadence", "did_not_start"]
  ] as const)(
    "on a %s action, %s keeps a defaulted remaining effort assumed and its date as it was",
    async (mode, ending) => {
      const { actionId } = await createAction(mode);
      const month = new Date(Date.now() - 30 * 24 * 60 * 60_000);
      await sql`UPDATE actions SET assumed_fields=ARRAY['expectedMinutes','remainingMinutes'], remaining_set_at=${month} WHERE id=${actionId}`;
      const session = await createActionSession(actionId, null);
      const base = { commandId: crypto.randomUUID(), sessionId: session.id, expectedVersion: session.version };
      await runSessionCommand(
        sql,
        ending === "unsure"
          ? { ...base, type: "finish", outcome: "unsure" }
          : ending === "block"
            ? { ...base, type: "block", actionStatus: "waiting", reason: "waiting_on_someone" }
            : { ...base, type: "did_not_start" }
      );
      const rows = await sql<
        { assumed_fields: string[]; remaining_set_at: Date }[]
      >`SELECT to_jsonb(assumed_fields) AS assumed_fields, remaining_set_at FROM actions WHERE id=${actionId}`;
      expect(rows[0]?.assumed_fields).toEqual(["expectedMinutes", "remainingMinutes"]);
      expect(rows[0]?.remaining_set_at.toISOString()).toBe(month.toISOString());
    }
  );

  it("on a cadence action, a finish that says what is left stops calling it assumed and dates it now", async () => {
    const { actionId } = await createAction("cadence");
    await sql`UPDATE actions SET assumed_fields=ARRAY['remainingMinutes'], remaining_set_at=${new Date(Date.now() - 30 * 24 * 60 * 60_000)} WHERE id=${actionId}`;
    const session = await createActionSession(actionId, null);
    const before = Date.now();
    await runSessionCommand(sql, {
      commandId: crypto.randomUUID(),
      type: "finish",
      sessionId: session.id,
      expectedVersion: session.version,
      outcome: "progress",
      remainingMinutes: 20
    });
    const rows = await sql<
      { assumed_fields: string[]; remaining_set_at: Date }[]
    >`SELECT to_jsonb(assumed_fields) AS assumed_fields, remaining_set_at FROM actions WHERE id=${actionId}`;
    expect(rows[0]?.assumed_fields).toEqual([]);
    expect(rows[0]?.remaining_set_at.getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  it("on a recurring occurrence that meets the series goal also stores the rule and the cancelled pending occurrences", async () => {
    const { actionId, version } = await createAction("recurring");
    const { ruleId, windowId } = await createRule(actionId, { mode: "total_minutes", targetMinutes: 10 });
    const worked = await createOccurrence(
      actionId,
      ruleId,
      windowId,
      "2026-10-26",
      minutesAgo(120),
      new Date(Date.now() + 3_600_000)
    );
    const later = await createOccurrence(
      actionId,
      ruleId,
      windowId,
      "2026-10-27",
      new Date(Date.now() + 3_600_000),
      new Date(Date.now() + 7_200_000)
    );
    const session = await createActionSession(actionId, worked);
    const commandId = crypto.randomUUID();
    await asAgent(() =>
      runSessionCommand(sql, {
        commandId,
        type: "finish",
        sessionId: session.id,
        expectedVersion: session.version,
        outcome: "completed"
      })
    );
    const snapshot = await snapshotOf(commandId);
    expect(tablesOf(snapshot)).toEqual([
      "action_occurrences",
      "action_recurrence_rules",
      "actions",
      "session_segments",
      "sessions"
    ]);

    const occurrences = rowsOf(snapshot, "action_occurrences");
    const byId = new Map(occurrences.map((row) => [row.id, row]));
    expect([...byId.keys()].sort()).toEqual([later, worked].sort());
    expect(byId.get(worked)!.before).toMatchObject({ status: "pending", completed_at: null });
    expect(byId.get(worked)!.after).toMatchObject({ status: "completed" });
    expect(byId.get(later)!.before).toMatchObject({ status: "pending" });
    expect(byId.get(later)!.after).toMatchObject({ status: "cancelled" });

    const rule = only(snapshot, "action_recurrence_rules");
    expect(rule.id).toBe(ruleId);
    expect(rule.before).toMatchObject({ accumulated_minutes: 0, completed_at: null });
    expect((rule.after as Image).accumulated_minutes).toBeGreaterThanOrEqual(10);
    expect((rule.after as Image).completed_at).not.toBeNull();

    const action = only(snapshot, "actions");
    expect(action.before).toMatchObject({ status: "active", version });
    expect(action.after).toMatchObject({ status: "done", version: version + 2 });
  });

  it("on a recurring occurrence whose series stays open stores just the occurrence, the action and the rule", async () => {
    const { actionId } = await createAction("recurring");
    const { ruleId, windowId } = await createRule(actionId, { mode: "total_minutes", targetMinutes: 600 });
    const worked = await createOccurrence(
      actionId,
      ruleId,
      windowId,
      "2026-10-26",
      minutesAgo(120),
      new Date(Date.now() + 3_600_000)
    );
    const session = await createActionSession(actionId, worked);
    const commandId = crypto.randomUUID();
    await asAgent(() =>
      runSessionCommand(sql, {
        commandId,
        type: "finish",
        sessionId: session.id,
        expectedVersion: session.version,
        outcome: "completed"
      })
    );
    const snapshot = await snapshotOf(commandId);
    const occurrence = only(snapshot, "action_occurrences");
    expect(occurrence.id).toBe(worked);
    expect(occurrence.before).toMatchObject({ status: "pending" });
    expect(occurrence.after).toMatchObject({ status: "completed" });
    const rule = only(snapshot, "action_recurrence_rules");
    expect(rule.before).toMatchObject({ accumulated_minutes: 0 });
    expect((rule.after as Image).accumulated_minutes).toBeGreaterThan(0);
    expect((rule.after as Image).completed_at).toBeNull();
    const action = only(snapshot, "actions");
    expect(action.after).toMatchObject({ status: "active" });
    expect((action.after as Image).last_worked_at).not.toBeNull();
  });

  it("on a cadence action stores the new completion row as inserted, and the action reset", async () => {
    const { actionId, version } = await createAction("cadence");
    const { ruleId } = await createRule(actionId, { mode: "manual" }, false);
    await sql`UPDATE actions SET remaining_minutes=5 WHERE id=${actionId}`;
    const session = await createActionSession(actionId, null);
    const commandId = crypto.randomUUID();
    await asAgent(() =>
      runSessionCommand(sql, {
        commandId,
        type: "finish",
        sessionId: session.id,
        expectedVersion: session.version,
        outcome: "completed"
      })
    );
    const snapshot = await snapshotOf(commandId);
    expect(tablesOf(snapshot)).toEqual(["action_cadence_completions", "actions", "session_segments", "sessions"]);

    const completion = only(snapshot, "action_cadence_completions");
    expect(completion.before).toBeNull();
    expect(completion.after).toMatchObject({
      id: completion.id,
      rule_id: ruleId,
      session_id: session.id,
      source: "session"
    });
    const stored = await sql<{ id: string }[]>`SELECT id FROM action_cadence_completions WHERE rule_id=${ruleId}`;
    expect(stored.map((row) => row.id)).toEqual([completion.id]);

    const action = only(snapshot, "actions");
    expect(action.before).toMatchObject({ status: "active", remaining_minutes: 5, version });
    expect(action.after).toMatchObject({ status: "active", remaining_minutes: 60, version: version + 1 });
  });

  it("stores no snapshot for the person's own finish", async () => {
    const { actionId } = await createAction();
    const session = await createActionSession(actionId, null);
    const commandId = crypto.randomUUID();
    await runSessionCommand(sql, {
      commandId,
      type: "finish",
      sessionId: session.id,
      expectedVersion: session.version,
      outcome: "completed"
    });
    expect(await snapshotOf(commandId)).toBeUndefined();
    const ended = await sql<{ status: string }[]>`SELECT status FROM sessions WHERE id=${session.id}`;
    expect(ended[0]!.status).toBe("completed");
  });
});

describe("block", () => {
  it("stores the session, its segment and the action with the blocked status", async () => {
    const { actionId, version } = await createAction();
    const session = await createActionSession(actionId, null);
    const commandId = crypto.randomUUID();
    await asAgent(() =>
      runSessionCommand(sql, {
        commandId,
        type: "block",
        sessionId: session.id,
        expectedVersion: session.version,
        actionStatus: "waiting",
        reason: "waiting_on_someone"
      })
    );
    const snapshot = await snapshotOf(commandId);
    expect(tablesOf(snapshot)).toEqual(["actions", "session_segments", "sessions"]);

    const stored = only(snapshot, "sessions");
    expect(stored.before).toMatchObject({ status: "running", blocking_reason: null });
    expect(stored.after).toMatchObject({ status: "blocked", blocking_reason: "waiting_on_someone" });

    const segment = only(snapshot, "session_segments");
    expect((segment.before as Image).ended_at).toBeNull();
    expect((segment.after as Image).ended_at).not.toBeNull();

    const action = only(snapshot, "actions");
    expect(action.before).toMatchObject({ status: "active", version });
    expect(action.after).toMatchObject({ status: "waiting", version: version + 1 });
  });
});

describe("reverting a session write", () => {
  const revert = (target: string, direction: "undo" | "redo", force?: boolean) =>
    asAgent(() =>
      runRevertCommand(sql, {
        commandId: crypto.randomUUID(),
        target,
        direction,
        ...(force === undefined ? {} : { force })
      })
    );

  const readAction = async (id: string) =>
    (
      await sql<{ status: string; version: number; remaining_minutes: number; completed_at: Date | null }[]>`
      SELECT status, version, remaining_minutes, completed_at FROM actions WHERE id=${id}`
    )[0]!;
  const readSession = async (id: string) =>
    (
      await sql<
        {
          status: string;
          version: number;
          ended_at: Date | null;
          paused_remaining_seconds: number | null;
          blocking_reason: string | null;
        }[]
      >`SELECT status, version, ended_at, paused_remaining_seconds, blocking_reason FROM sessions WHERE id=${id}`
    )[0];
  const readSegments = (sessionId: string) =>
    sql<
      { id: string; ended_at: Date | null }[]
    >`SELECT id, ended_at FROM session_segments WHERE session_id=${sessionId} ORDER BY started_at`;

  async function agentStarts() {
    const { actionId, version } = await createAction();
    await storePlanningRun(actionId);
    const commandId = crypto.randomUUID();
    await asAgent(() =>
      runSessionCommand(sql, { commandId, type: "start", actionId, expectedVersion: version, plannedMinutes: 30 })
    );
    return { actionId, version, commandId };
  }

  it("undoes a start, session and segment gone and the action back with its version bumped, and redoes it", async () => {
    const { actionId, version, commandId } = await agentStarts();
    expect(await readAction(actionId)).toMatchObject({ status: "doing", version: version + 1 });

    await revert(commandId, "undo");
    expect(await readSession(commandId)).toBeUndefined();
    expect(await readSegments(commandId)).toHaveLength(0);
    expect(await readAction(actionId)).toMatchObject({ status: "active", version: version + 2 });
    expect((await snapshotOf(commandId))?.state).toBe("undone");

    await revert(commandId, "redo");
    expect(await readSession(commandId)).toMatchObject({ status: "running", ended_at: null });
    expect(await readSegments(commandId)).toHaveLength(1);
    expect(await readAction(actionId)).toMatchObject({ status: "doing", version: version + 3 });
    expect((await snapshotOf(commandId))?.state).toBe("applied");
  });

  it("undoes a pause, the session running again with its segment open", async () => {
    const { actionId } = await createAction();
    const session = await createActionSession(actionId, null);
    const commandId = crypto.randomUUID();
    await asAgent(() =>
      runSessionCommand(sql, { commandId, type: "pause", sessionId: session.id, expectedVersion: session.version })
    );
    expect(await readSession(session.id)).toMatchObject({ status: "paused" });

    await revert(commandId, "undo");
    expect(await readSession(session.id)).toMatchObject({
      status: "running",
      paused_remaining_seconds: null,
      version: session.version + 2
    });
    const segments = await readSegments(session.id);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ id: session.segmentId, ended_at: null });
  });

  it("undoes a finish completed on a plain action, the session open and the action active with its minutes", async () => {
    const { actionId, version } = await createAction();
    const session = await createActionSession(actionId, null);
    const commandId = crypto.randomUUID();
    await asAgent(() =>
      runSessionCommand(sql, {
        commandId,
        type: "finish",
        sessionId: session.id,
        expectedVersion: session.version,
        outcome: "completed"
      })
    );
    expect(await readAction(actionId)).toMatchObject({ status: "done", remaining_minutes: 0 });

    await revert(commandId, "undo");
    expect(await readSession(session.id)).toMatchObject({ status: "running", ended_at: null });
    expect((await readSegments(session.id))[0]).toMatchObject({ ended_at: null });
    expect(await readAction(actionId)).toMatchObject({
      status: "active",
      remaining_minutes: 60,
      completed_at: null,
      version: version + 2
    });
  });

  it("undoes a finish with a chosen end on a session awaiting feedback, the segment's end put back", async () => {
    const { actionId } = await createAction();
    // Paused leaves one closed segment, which is how a checkpoint leaves a running one.
    const session = await createActionSession(actionId, null, "paused");
    await sql`UPDATE sessions SET status='awaiting_feedback', paused_remaining_seconds=NULL, feedback_requested_at=${new Date()} WHERE id=${session.id}`;
    const closedAt = (await readSegments(session.id))[0]!.ended_at!;
    const commandId = crypto.randomUUID();
    await asAgent(() =>
      runSessionCommand(sql, {
        commandId,
        type: "finish",
        sessionId: session.id,
        expectedVersion: session.version,
        outcome: "completed",
        endedAt: minutesAgo(10).toISOString()
      })
    );
    expect(await readSession(session.id)).toMatchObject({ status: "completed" });
    expect((await readSegments(session.id))[0]!.ended_at!.getTime()).toBeLessThan(closedAt.getTime());

    await revert(commandId, "undo");
    expect(await readSession(session.id)).toMatchObject({ status: "awaiting_feedback", ended_at: null });
    expect((await readSegments(session.id))[0]!.ended_at).toEqual(closedAt);
  });

  it("undoes a finish completed on a cadence action, the completion row gone and the action reset back", async () => {
    const { actionId, version } = await createAction("cadence");
    const { ruleId } = await createRule(actionId, { mode: "manual" }, false);
    await sql`UPDATE actions SET remaining_minutes=5 WHERE id=${actionId}`;
    const session = await createActionSession(actionId, null);
    const commandId = crypto.randomUUID();
    await asAgent(() =>
      runSessionCommand(sql, {
        commandId,
        type: "finish",
        sessionId: session.id,
        expectedVersion: session.version,
        outcome: "completed"
      })
    );
    expect(await sql`SELECT id FROM action_cadence_completions WHERE rule_id=${ruleId}`).toHaveLength(1);
    expect(await readAction(actionId)).toMatchObject({ remaining_minutes: 60 });

    await revert(commandId, "undo");
    expect(await sql`SELECT id FROM action_cadence_completions WHERE rule_id=${ruleId}`).toHaveLength(0);
    expect(await readAction(actionId)).toMatchObject({ status: "active", remaining_minutes: 5, version: version + 2 });
    expect(await readSession(session.id)).toMatchObject({ status: "running", ended_at: null });

    await revert(commandId, "redo");
    expect(await sql`SELECT id FROM action_cadence_completions WHERE rule_id=${ruleId}`).toHaveLength(1);
    expect(await readAction(actionId)).toMatchObject({ remaining_minutes: 60 });
  });

  it("refuses a redo when that day's cadence completion has been logged another way since", async () => {
    const { actionId } = await createAction("cadence");
    const { ruleId } = await createRule(actionId, { mode: "manual" }, false);
    const session = await createActionSession(actionId, null);
    const commandId = crypto.randomUUID();
    await asAgent(() =>
      runSessionCommand(sql, {
        commandId,
        type: "finish",
        sessionId: session.id,
        expectedVersion: session.version,
        outcome: "completed"
      })
    );
    const [logged] = await sql<{ local_date: string }[]>`
      SELECT local_date::text FROM action_cadence_completions WHERE rule_id=${ruleId}`;
    await revert(commandId, "undo");
    // Another source logs the same day's completion (one per rule and day).
    await sql`INSERT INTO action_cadence_completions (action_id, rule_id, completed_at, local_date, minutes, source)
      VALUES (${actionId}, ${ruleId}, now(), ${logged!.local_date}, 10, 'manual')`;
    await expect(revert(commandId, "redo")).rejects.toThrow(CommandConflictError);
    expect(await sql`SELECT id FROM action_cadence_completions WHERE rule_id=${ruleId}`).toHaveLength(1);
    expect(await readSession(session.id)).toMatchObject({ status: "running", ended_at: null });
  });

  it("undoes a finish that met a recurring series' goal, the rule, the action and the occurrences restored", async () => {
    const { actionId, version } = await createAction("recurring");
    const { ruleId, windowId } = await createRule(actionId, { mode: "total_minutes", targetMinutes: 10 });
    const worked = await createOccurrence(
      actionId,
      ruleId,
      windowId,
      "2026-10-26",
      minutesAgo(120),
      new Date(Date.now() + 3_600_000)
    );
    const later = await createOccurrence(
      actionId,
      ruleId,
      windowId,
      "2026-10-27",
      new Date(Date.now() + 3_600_000),
      new Date(Date.now() + 7_200_000)
    );
    const session = await createActionSession(actionId, worked);
    const commandId = crypto.randomUUID();
    await asAgent(() =>
      runSessionCommand(sql, {
        commandId,
        type: "finish",
        sessionId: session.id,
        expectedVersion: session.version,
        outcome: "completed"
      })
    );
    const statuses = async () =>
      Object.fromEntries(
        (
          await sql<{ id: string; status: string }[]>`SELECT id, status FROM action_occurrences WHERE rule_id=${ruleId}`
        ).map((row) => [row.id, row.status])
      );
    expect(await statuses()).toEqual({ [worked]: "completed", [later]: "cancelled" });

    await revert(commandId, "undo");
    expect(await statuses()).toEqual({ [worked]: "pending", [later]: "pending" });
    const rule = await sql`SELECT accumulated_minutes, completed_at FROM action_recurrence_rules WHERE id=${ruleId}`;
    expect(rule[0]).toMatchObject({ accumulated_minutes: 0, completed_at: null });
    expect(await readAction(actionId)).toMatchObject({ status: "active", completed_at: null });
    expect((await readAction(actionId)).version).toBeGreaterThan(version);
    expect(await readSession(session.id)).toMatchObject({ status: "running", ended_at: null });

    await revert(commandId, "redo");
    expect(await statuses()).toEqual({ [worked]: "completed", [later]: "cancelled" });
    expect(await readAction(actionId)).toMatchObject({ status: "done" });
  });

  it("undoes a recurring finish after the replan rewrote the occurrence's window and updated_at", async () => {
    const { actionId } = await createAction("recurring");
    const { ruleId, windowId } = await createRule(actionId, { mode: "manual" });
    const worked = await createOccurrence(
      actionId,
      ruleId,
      windowId,
      "2026-10-26",
      minutesAgo(120),
      new Date(Date.now() + 3_600_000)
    );
    const session = await createActionSession(actionId, worked);
    const commandId = crypto.randomUUID();
    await asAgent(() =>
      runSessionCommand(sql, {
        commandId,
        type: "finish",
        sessionId: session.id,
        expectedVersion: session.version,
        outcome: "completed"
      })
    );
    // The replan after every write re-derives the window and touches these columns without a version bump.
    await sql`UPDATE action_occurrences SET window_starts_at=window_starts_at + interval '5 minutes', window_ends_at=window_ends_at + interval '5 minutes', updated_at=now() + interval '1 second' WHERE id=${worked}`;
    await sql`UPDATE actions SET updated_at=now() + interval '1 second' WHERE id=${actionId}`;

    await revert(commandId, "undo");
    const occurrence = await sql`SELECT status, completed_at FROM action_occurrences WHERE id=${worked}`;
    expect(occurrence[0]).toMatchObject({ status: "pending", completed_at: null });
    expect(await readSession(session.id)).toMatchObject({ status: "running", ended_at: null });
    expect(await readAction(actionId)).toMatchObject({ status: "active" });
  });

  it("undoes a block, the session open again and the action active", async () => {
    const { actionId, version } = await createAction();
    const session = await createActionSession(actionId, null);
    const commandId = crypto.randomUUID();
    await asAgent(() =>
      runSessionCommand(sql, {
        commandId,
        type: "block",
        sessionId: session.id,
        expectedVersion: session.version,
        actionStatus: "waiting",
        reason: "waiting_on_someone"
      })
    );
    expect(await readAction(actionId)).toMatchObject({ status: "waiting" });

    await revert(commandId, "undo");
    expect(await readSession(session.id)).toMatchObject({ status: "running", ended_at: null, blocking_reason: null });
    expect((await readSegments(session.id))[0]).toMatchObject({ ended_at: null });
    expect(await readAction(actionId)).toMatchObject({ status: "active", version: version + 2 });
  });

  it("refuses to undo a finish once the person has started another session, changing nothing", async () => {
    const { actionId } = await createAction();
    const session = await createActionSession(actionId, null);
    const commandId = crypto.randomUUID();
    await asAgent(() =>
      runSessionCommand(sql, {
        commandId,
        type: "finish",
        sessionId: session.id,
        expectedVersion: session.version,
        outcome: "completed"
      })
    );
    const other = await createAction();
    await storePlanningRun(other.actionId);
    const otherSession = crypto.randomUUID();
    await runSessionCommand(sql, {
      commandId: otherSession,
      type: "start",
      actionId: other.actionId,
      expectedVersion: other.version,
      plannedMinutes: 30
    });
    const finished = await readSession(session.id);
    const action = await readAction(actionId);

    await expect(revert(commandId, "undo")).rejects.toThrow(CommandConflictError);
    await expect(
      runWithActor(null, () =>
        runRevertCommand(sql, { commandId: crypto.randomUUID(), target: commandId, direction: "undo", force: true })
      )
    ).rejects.toThrow(CommandConflictError);

    expect(await readSession(session.id)).toEqual(finished);
    expect(await readAction(actionId)).toEqual(action);
    expect(await readSession(otherSession)).toMatchObject({ status: "running" });
    expect((await snapshotOf(commandId))?.state).toBe("applied");
  });
});
