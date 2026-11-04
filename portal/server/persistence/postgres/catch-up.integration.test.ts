import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import { integrationDatabaseName } from "@openrhen/database";
import { settleCatchUpCommandSchema, type SettleCatchUpCommand } from "@openrhen/contracts";
import { runWithActor } from "@/server/agent-actor";
import { ensureUser } from "./ensure-user";
import { queueCatchUpNudge, readCatchUpLedger, settleCatchUp } from "./catch-up";
import { CommandConflictError } from "./command-errors";
import { runRevertCommand } from "./write-revert";
import { proposeAgentChange, resolveAgentProposal } from "@/server/agent-proposals/store";

/**
 * Catch-up: the ledger's sources and bounds, each verdict's effect, the
 * switch, per-entry conflicts, bulk expansion, idempotent retry and closing the window.
 */
config({ path: resolve(process.cwd(), "../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(process.env.TEST_DATABASE_NAME, "rhen_catch_up");

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let userId: string;

const NOW = new Date("2026-10-18T12:00:00Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000);
const daysAhead = (days: number) => new Date(NOW.getTime() + days * 86_400_000);

async function createProject(
  title: string,
  dates: { internal?: Date; external?: Date } = {}
): Promise<{ projectId: string }> {
  const area = await sql<
    { id: string }[]
  >`INSERT INTO areas (user_id,name,status,sort_order) VALUES (${userId},${"Area " + crypto.randomUUID()},'active',0) RETURNING id`;
  const outcome = await sql<
    { id: string }[]
  >`INSERT INTO outcomes (area_id,title,definition_of_done,status) VALUES (${area[0]!.id},'Outcome','Done','active') RETURNING id`;
  const project = await sql<{ id: string }[]>`
    INSERT INTO projects (outcome_id,title,status,internal_deadline_at,external_deadline_at)
    VALUES (${outcome[0]!.id},${title},'active',${dates.internal ?? null},${dates.external ?? null}) RETURNING id`;
  return { projectId: project[0]!.id };
}

/** A recurring action in a project with one occurrence whose window closed `endedDaysAgo` days ago. */
async function createOccurrence(projectId: string, endedDaysAgo: number, localDate = "2026-10-10"): Promise<string> {
  const action = await sql<{ id: string }[]>`
    INSERT INTO actions (project_id,title,scheduling_mode,status,optimistic_minutes,expected_minutes,pessimistic_minutes,remaining_minutes,energy,minimum_session_minutes,maximum_session_minutes)
    VALUES (${projectId},'Stretch','recurring','active',5,10,15,10,'low',5,15) RETURNING id`;
  const rule = await sql<{ id: string }[]>`
    INSERT INTO action_recurrence_rules (action_id,timezone,start_date,interval_days,completion_mode)
    VALUES (${action[0]!.id},'UTC','2026-01-01',1,'manual') RETURNING id`;
  const window = await sql<{ id: string }[]>`
    INSERT INTO action_recurrence_windows (rule_id,name,anchor,local_start_time,local_end_time)
    VALUES (${rule[0]!.id},'Day','local_time','08:00','20:00') RETURNING id`;
  const id = `occ-${crypto.randomUUID()}`;
  const ends = daysAgo(endedDaysAgo);
  await sql`
    INSERT INTO action_occurrences (id,action_id,rule_id,window_id,local_date,window_starts_at,window_ends_at,anchor_source)
    VALUES (${id},${action[0]!.id},${rule[0]!.id},${window[0]!.id},${localDate},${new Date(ends.getTime() - 3_600_000)},${ends},'local_time')`;
  return id;
}

function command(overrides: Partial<SettleCatchUpCommand> & Pick<SettleCatchUpCommand, "verdicts">) {
  return settleCatchUpCommandSchema.parse({ commandId: crypto.randomUUID(), ...overrides });
}

const occurrenceStatus = async (id: string) =>
  (await sql<{ status: string }[]>`SELECT status FROM action_occurrences WHERE id=${id}`)[0]!.status;
const projectRow = async (id: string) =>
  (
    await sql<
      { status: string; version: number; internal_deadline_at: Date | null; external_deadline_at: Date | null }[]
    >`SELECT status,version,internal_deadline_at,external_deadline_at FROM projects WHERE id=${id}`
  )[0]!;

interface StoredRow {
  table: string;
  id: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

/** The snapshot an agent's settle stored under its commandId, or null when it stored none. */
async function storedSnapshot(commandId: string) {
  const found = await sql<
    { agent: string; kind: string; state: string; rows: StoredRow[] }[]
  >`SELECT actor AS agent,kind,state,images AS rows FROM writes WHERE user_id=${userId} AND id=${commandId} AND images IS NOT NULL`;
  return found[0] ?? null;
}

/** Runs a settle as the named agent, the way a request carrying the agent header does. */
const settleAsAgent = (cmd: SettleCatchUpCommand) =>
  runWithActor("companion", () => settleCatchUp(sql as never, cmd, NOW));

beforeAll(async () => {
  const admin = postgres(adminUrl, { max: 1, connect_timeout: 10 });
  try {
    const existing = await admin<{ exists: boolean }[]>`
      SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = ${testDatabaseName}) AS exists`;
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
  await sql.unsafe(
    "TRUNCATE TABLE writes, write_rows, catch_up_runs, action_occurrences, action_recurrence_windows, action_recurrence_rules, actions, projects, outcomes, areas, plan_map_switches, push_outbox RESTART IDENTITY CASCADE"
  );
});

afterAll(async () => {
  await sql?.end();
});

describe("catch-up ledger", () => {
  it("lists lapsed self-set and external dates and closed occurrences, not live or settled work", async () => {
    const stale = await createProject("Stale", { internal: daysAgo(3) });
    const overdue = await createProject("Overdue", { external: daysAgo(1) });
    await createProject("Live", { internal: daysAhead(4) });
    await createProject("Both", { internal: daysAgo(2), external: daysAhead(5) });
    const open = await createOccurrence(stale.projectId, 2);
    const settled = await createOccurrence(stale.projectId, 3);
    await sql`UPDATE action_occurrences SET status='completed' WHERE id=${settled}`;
    await createOccurrence(stale.projectId, 45); // beyond the 30-day look-back

    const ledger = await readCatchUpLedger(sql as never, { now: NOW });
    const ids = ledger.entries.map((entry) => entry.id).sort();
    expect(ids).toEqual([`occurrence:${open}`, `deadline:${stale.projectId}`, `deadline:${overdue.projectId}`].sort());
    expect(ledger.staleDates).toBe(1);
    expect(ledger.unsettled).toBe(3);
    expect(ledger.entries.find((entry) => entry.id === `deadline:${overdue.projectId}`)?.kind).toBe(
      "external_deadline"
    );
    expect(ledger.entries.find((entry) => entry.id === `deadline:${stale.projectId}`)?.kind).toBe("self_set_deadline");
  });

  it("is due after 36 quiet hours and not before", async () => {
    await createProject("Stale", { internal: daysAgo(3) });
    await sql`INSERT INTO catch_up_runs (user_id,window_until,closed_at) VALUES (${userId},${daysAgo(1)},${new Date(NOW.getTime() - 20 * 3_600_000)})`;
    expect((await readCatchUpLedger(sql as never, { now: NOW })).due).toBe(false);
    await sql`UPDATE catch_up_runs SET closed_at=${new Date(NOW.getTime() - 40 * 3_600_000)}`;
    expect((await readCatchUpLedger(sql as never, { now: NOW })).due).toBe(true);
  });

  it("queues one nudge push per away window and another for a new absence", async () => {
    await createProject("Stale", { internal: daysAgo(3) });
    const closedAt = daysAgo(2);
    await sql`INSERT INTO catch_up_runs (user_id,window_until,closed_at) VALUES (${userId},${daysAgo(3)},${closedAt})`;
    const first = await queueCatchUpNudge(sql as never, userId, NOW);
    expect(first).toEqual({ due: true, queued: true });
    expect(await queueCatchUpNudge(sql as never, userId, new Date(NOW.getTime() + 3_600_000))).toEqual({
      due: true,
      queued: false
    });
    const rows = await sql<{ kind: string; status: string; dedupe_key: string; payload: Record<string, string> }[]>`
      SELECT kind, status, dedupe_key, payload FROM push_outbox`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "test",
      status: "pending",
      dedupe_key: `catch-up-due:${closedAt.toISOString()}`
    });
    expect(rows[0]!.payload).toMatchObject({
      title: "Your plan is waiting",
      body: "You've been away 2 days. 1 thing to settle.",
      url: "/catch-up",
      tag: rows[0]!.dedupe_key
    });
    // A later absence starts a new window and sends again.
    await sql`INSERT INTO catch_up_runs (user_id,window_until,closed_at) VALUES (${userId},${NOW},${daysAhead(1)})`;
    expect(await queueCatchUpNudge(sql as never, userId, daysAhead(4))).toEqual({ due: true, queued: true });
  });

  it("holds the nudge for the person's wake time when the night sweep queues it", async () => {
    await createProject("Stale", { internal: daysAgo(3) });
    await sql`INSERT INTO catch_up_runs (user_id,window_until,closed_at) VALUES (${userId},${daysAgo(3)},${daysAgo(2)})`;
    const [before] = await sql<{ timezone: string }[]>`SELECT timezone FROM users WHERE id=${userId}`;
    await sql`UPDATE users SET timezone='UTC' WHERE id=${userId}`;
    const [prefs] = await sql<{ wake: string | null }[]>`
      SELECT to_char(preferred_wake_time, 'HH24:MI') AS wake FROM user_preferences WHERE user_id=${userId}`;
    const night = new Date("2026-10-18T03:30:00Z");
    expect(await queueCatchUpNudge(sql as never, userId, night)).toEqual({ due: true, queued: true });
    const [row] = await sql<{ next_attempt_at: Date; expires_at: Date }[]>`
      SELECT next_attempt_at, expires_at FROM push_outbox`;
    const wake = new Date(`2026-10-18T${prefs?.wake ?? "08:00"}:00Z`);
    expect(row!.next_attempt_at.toISOString()).toBe(wake.toISOString());
    expect(row!.expires_at.getTime() - wake.getTime()).toBe(3 * 86_400_000);
    await sql`UPDATE users SET timezone=${before!.timezone} WHERE id=${userId}`;
  });

  it("queues nothing when the catch-up is not due or nothing is unsettled", async () => {
    await createProject("Stale", { internal: daysAgo(3) });
    await sql`INSERT INTO catch_up_runs (user_id,window_until,closed_at) VALUES (${userId},${daysAgo(1)},${new Date(NOW.getTime() - 20 * 3_600_000)})`;
    expect(await queueCatchUpNudge(sql as never, userId, NOW)).toEqual({ due: false, queued: false });
    await sql`UPDATE projects SET internal_deadline_at=${daysAhead(5)}`;
    await sql`UPDATE catch_up_runs SET closed_at=${daysAgo(5)}`;
    expect(await queueCatchUpNudge(sql as never, userId, NOW)).toEqual({ due: false, queued: false });
    expect((await sql`SELECT 1 FROM push_outbox`).length).toBe(0);
  });

  it("cancels a held nudge once the person is back", async () => {
    await createProject("Stale", { internal: daysAgo(3) });
    await sql`INSERT INTO catch_up_runs (user_id,window_until,closed_at) VALUES (${userId},${daysAgo(3)},${daysAgo(2)})`;
    expect(await queueCatchUpNudge(sql as never, userId, NOW)).toEqual({ due: true, queued: true });
    // Still away: reading the ledger leaves the push alone.
    await readCatchUpLedger(sql as never, { now: NOW });
    expect((await sql<{ status: string }[]>`SELECT status FROM push_outbox`)[0]!.status).toBe("pending");
    // Activity resumes, so the window closes and the next read cancels the push.
    await sql`INSERT INTO catch_up_runs (user_id,window_until,closed_at) VALUES (${userId},${NOW},${NOW})`;
    await readCatchUpLedger(sql as never, { now: NOW });
    expect((await sql<{ status: string }[]>`SELECT status FROM push_outbox`)[0]!.status).toBe("cancelled");
  });

  it("does not nudge again for a window older than the outbox keeps its record", async () => {
    await createProject("Stale", { internal: daysAgo(40) });
    await sql`INSERT INTO catch_up_runs (user_id,window_until,closed_at) VALUES (${userId},${daysAgo(40)},${daysAgo(30)})`;
    expect(await queueCatchUpNudge(sql as never, userId, NOW)).toEqual({ due: true, queued: false });
    expect((await sql`SELECT 1 FROM push_outbox`).length).toBe(0);
  });

  it("ignores machine writes when measuring the quiet window", async () => {
    await createProject("Stale", { internal: daysAgo(3) });
    await sql`INSERT INTO catch_up_runs (user_id,window_until,closed_at) VALUES (${userId},${daysAgo(1)},${daysAgo(2)})`;
    const log = (entityType: string, operation: string) =>
      sql`WITH w AS (INSERT INTO writes (id,user_id,command_type,created_at) VALUES (gen_random_uuid(),${userId},${entityType},${new Date(NOW.getTime() - 3_600_000)}) RETURNING id) INSERT INTO write_rows (write_id,user_id,entity_type,operation,created_at) SELECT id,${userId},${entityType},${operation},${new Date(NOW.getTime() - 3_600_000)} FROM w`;
    await log("import_batch", "commit");
    await log("current_situation", "observe");
    await log("journey_samples", "measure");
    await log("project", "route_create");
    expect((await readCatchUpLedger(sql as never, { now: NOW })).due).toBe(true);
    await log("project", "update");
    expect((await readCatchUpLedger(sql as never, { now: NOW })).due).toBe(false);
  });

  it("pages and reports what remains", async () => {
    const { projectId } = await createProject("Busy");
    for (let day = 0; day < 55; day++) await createOccurrence(projectId, 1 + day / 100, "2026-10-17");
    const first = await readCatchUpLedger(sql as never, { now: NOW });
    expect(first.entries).toHaveLength(50);
    expect(first.remaining).toBe(5);
    const second = await readCatchUpLedger(sql as never, { now: NOW, offset: 50 });
    expect(second.entries).toHaveLength(5);
    expect(second.remaining).toBe(0);
  });
});

describe("settleCatchUp", () => {
  it("applies every occurrence verdict", async () => {
    const { projectId } = await createProject("P");
    const [done, skipped, dropped, pending] = [
      await createOccurrence(projectId, 2),
      await createOccurrence(projectId, 2),
      await createOccurrence(projectId, 2),
      await createOccurrence(projectId, 2)
    ];
    const result = await settleCatchUp(
      sql as never,
      command({
        verdicts: [
          { entryId: `occurrence:${done}`, verdict: "done", at: daysAgo(2).toISOString() },
          { entryId: `occurrence:${skipped}`, verdict: "skipped" },
          { entryId: `occurrence:${dropped}`, verdict: "dropped" },
          { entryId: `occurrence:${pending}`, verdict: "pending" }
        ]
      }),
      NOW
    );
    expect(result.results.map((entry) => entry.outcome)).toEqual(["applied", "applied", "applied", "unchanged"]);
    expect(await occurrenceStatus(done)).toBe("completed");
    expect(await occurrenceStatus(skipped)).toBe("missed");
    expect(await occurrenceStatus(dropped)).toBe("cancelled");
    expect(await occurrenceStatus(pending)).toBe("pending");
    expect(result.remaining).toBe(1);
    const log = await sql<{ entity_type: string; operation: string }[]>`SELECT entity_type,operation FROM write_rows`;
    expect(log).toEqual([{ entity_type: "catch_up", operation: "settle" }]);
  });

  it("refuses a future completion time", async () => {
    const { projectId } = await createProject("P");
    const occurrence = await createOccurrence(projectId, 2);
    const result = await settleCatchUp(
      sql as never,
      command({ verdicts: [{ entryId: `occurrence:${occurrence}`, verdict: "done", at: daysAhead(1).toISOString() }] }),
      NOW
    );
    expect(result.results[0]).toMatchObject({ outcome: "invalid" });
    expect(await occurrenceStatus(occurrence)).toBe("pending");
  });

  it("settles a lapsed self-set date: clear, move, done, dropped", async () => {
    const clear = await createProject("Clear", { internal: daysAgo(3) });
    const move = await createProject("Move", { internal: daysAgo(3) });
    const finish = await createProject("Finish", { internal: daysAgo(3) });
    const drop = await createProject("Drop", { internal: daysAgo(3) });
    const newDate = daysAhead(14);
    const result = await settleCatchUp(
      sql as never,
      command({
        verdicts: [
          { entryId: `deadline:${clear.projectId}`, verdict: "skipped" },
          { entryId: `deadline:${move.projectId}`, verdict: "pending", moveTo: newDate.toISOString() },
          { entryId: `deadline:${finish.projectId}`, verdict: "done" },
          { entryId: `deadline:${drop.projectId}`, verdict: "dropped" }
        ],
        closeWindow: true
      }),
      NOW
    );
    expect(result.results.every((entry) => entry.outcome === "applied")).toBe(true);
    expect(result.closed).toBe(true);
    expect((await projectRow(clear.projectId)).internal_deadline_at).toBeNull();
    expect((await projectRow(move.projectId)).internal_deadline_at?.toISOString()).toBe(newDate.toISOString());
    expect((await projectRow(finish.projectId)).status).toBe("done");
    expect((await projectRow(drop.projectId)).status).toBe("paused");
    const runs = await sql<{ closed_by: string | null }[]>`SELECT closed_by FROM catch_up_runs`;
    expect(runs).toHaveLength(1);
    expect((await readCatchUpLedger(sql as never, { now: NOW })).unsettled).toBe(0);
  });

  it("will not clear an external date, and extends it with moveTo", async () => {
    const { projectId } = await createProject("Ext", { external: daysAgo(1) });
    const refused = await settleCatchUp(
      sql as never,
      command({ verdicts: [{ entryId: `deadline:${projectId}`, verdict: "skipped" }] }),
      NOW
    );
    expect(refused.results[0]).toMatchObject({ outcome: "invalid" });
    const extended = await settleCatchUp(
      sql as never,
      command({
        verdicts: [{ entryId: `deadline:${projectId}`, verdict: "pending", moveTo: daysAhead(7).toISOString() }]
      }),
      NOW
    );
    expect(extended.results[0]).toMatchObject({ outcome: "applied" });
    expect((await projectRow(projectId)).external_deadline_at?.getTime()).toBe(daysAhead(7).getTime());
  });

  it("reports a conflict per entry and applies the rest", async () => {
    const { projectId } = await createProject("P", { internal: daysAgo(3) });
    const occurrence = await createOccurrence(projectId, 2);
    const version = (await projectRow(projectId)).version;
    await sql`UPDATE action_occurrences SET status='completed' WHERE id=${occurrence}`;
    await sql`UPDATE projects SET version=version+1 WHERE id=${projectId}`;
    const fresh = await createOccurrence(projectId, 2);
    const result = await settleCatchUp(
      sql as never,
      command({
        verdicts: [
          { entryId: `occurrence:${occurrence}`, verdict: "skipped" },
          { entryId: `deadline:${projectId}`, verdict: "done", version },
          { entryId: `occurrence:${fresh}`, verdict: "skipped" }
        ]
      }),
      NOW
    );
    expect(result.results.map((entry) => entry.outcome)).toEqual(["conflict", "conflict", "applied"]);
    expect((await projectRow(projectId)).status).toBe("active");
    expect(await occurrenceStatus(fresh)).toBe("missed");
  });

  it("expands bulk shortcuts and keeps closeWindow shut while entries remain", async () => {
    const a = await createProject("A", { internal: daysAgo(3) });
    const b = await createProject("B");
    const one = await createOccurrence(a.projectId, 2, "2026-10-16");
    const two = await createOccurrence(b.projectId, 2, "2026-10-16");
    const other = await createOccurrence(b.projectId, 5, "2026-10-13");
    const result = await settleCatchUp(
      sql as never,
      command({ verdicts: [{ bulk: "all_skipped", day: "2026-10-16" }], closeWindow: true }),
      NOW
    );
    expect(result.closed).toBe(false);
    expect(result.remaining).toBe(2); // the older occurrence and the stale date
    expect(await occurrenceStatus(one)).toBe("missed");
    expect(await occurrenceStatus(two)).toBe("missed");
    expect(await occurrenceStatus(other)).toBe("pending");
    const dropped = await settleCatchUp(
      sql as never,
      command({ verdicts: [{ bulk: "all_dropped", projectId: a.projectId }] }),
      NOW
    );
    expect(dropped.results.map((entry) => entry.outcome)).toEqual(["applied"]);
    expect((await projectRow(a.projectId)).status).toBe("paused");
  });

  it("replays idempotently", async () => {
    const { projectId } = await createProject("P");
    const occurrence = await createOccurrence(projectId, 2);
    const same = command({ verdicts: [{ entryId: `occurrence:${occurrence}`, verdict: "skipped" }] });
    await settleCatchUp(sql as never, same, NOW);
    const first = await settleCatchUp(sql as never, same, NOW);
    const replay = await settleCatchUp(sql as never, same, NOW);
    expect(replay.results).toEqual(first.results);
    expect(replay.results.map((entry) => entry.outcome)).toEqual(["applied"]);
    expect(await sql`SELECT 1 FROM write_rows`).toHaveLength(1);
  });

  it("stamps an agent-confirmed settle with the agent and a before-image", async () => {
    const { projectId } = await createProject("P", { internal: daysAgo(3) });
    await runWithActor(
      "companion",
      () =>
        settleCatchUp(
          sql as never,
          command({ verdicts: [{ entryId: `deadline:${projectId}`, verdict: "dropped" }] }),
          NOW
        ),
      "owner"
    );
    const log = await sql<
      { actor: string | null; evidence: Record<string, unknown> }[]
    >`SELECT w.actor,r.evidence FROM write_rows r JOIN writes w ON w.id=r.write_id`;
    expect(log[0]!.actor).toBe("companion");
    expect(log[0]!.evidence.confirmedBy).toBe("owner");
    expect(log[0]!.evidence.before).toMatchObject({ projects: [expect.objectContaining({ status: "active" })] });
  });
});

describe("an agent's settle", () => {
  it("is applied only when the person confirms it, attributed to the agent", async () => {
    const { projectId } = await createProject("P");
    const occurrence = await createOccurrence(projectId, 2);
    const { proposal } = await proposeAgentChange(sql as never, "companion", {
      kind: "settle_catch_up",
      summary: "Settle 1 catch-up entry",
      payload: {
        verdicts: [{ entryId: `occurrence:${occurrence}`, verdict: "skipped" }],
        closeWindow: false,
        basis: "inferred"
      },
      basis: "inferred"
    });
    expect(await occurrenceStatus(occurrence)).toBe("pending");
    await resolveAgentProposal(sql as never, null, proposal.id, { decision: "confirm", revision: proposal.revision });
    expect(await occurrenceStatus(occurrence)).toBe("missed");
    const log = await sql<
      { actor: string | null }[]
    >`SELECT w.actor FROM write_rows r JOIN writes w ON w.id=r.write_id WHERE r.entity_type='catch_up'`;
    expect(log[0]!.actor).toBe("companion");
  });

  it("goes stale when everything in it was already settled", async () => {
    const { projectId } = await createProject("P");
    const occurrence = await createOccurrence(projectId, 2);
    const { proposal } = await proposeAgentChange(sql as never, "companion", {
      kind: "settle_catch_up",
      summary: "Settle 1 catch-up entry",
      payload: {
        verdicts: [{ entryId: `occurrence:${occurrence}`, verdict: "skipped" }],
        closeWindow: false,
        basis: "inferred"
      },
      basis: "inferred"
    });
    await sql`UPDATE action_occurrences SET status='completed' WHERE id=${occurrence}`;
    await expect(
      resolveAgentProposal(sql as never, null, proposal.id, { decision: "confirm", revision: proposal.revision })
    ).rejects.toMatchObject({
      status: 409
    });
  });
});

describe("an agent's settle is snapshotted", () => {
  it("snapshots a done occurrence verdict: the one row, pending before, completed after", async () => {
    const { projectId } = await createProject("P");
    const occurrence = await createOccurrence(projectId, 2);
    const cmd = command({
      verdicts: [{ entryId: `occurrence:${occurrence}`, verdict: "done", at: daysAgo(2).toISOString() }]
    });
    await settleAsAgent(cmd);
    const snapshot = (await storedSnapshot(cmd.commandId))!;
    expect(snapshot).toMatchObject({ agent: "companion", kind: "catch_up", state: "applied" });
    expect(snapshot.rows).toHaveLength(1);
    const [row] = snapshot.rows;
    expect(row).toMatchObject({ table: "action_occurrences", id: occurrence });
    expect(row!.before).toMatchObject({ id: occurrence, status: "pending", completed_at: null });
    expect(row!.after).toMatchObject({ id: occurrence, status: "completed" });
    expect(new Date(row!.after!.completed_at as string).getTime()).toBe(daysAgo(2).getTime());
  });

  it("snapshots a dropped project verdict: active before, paused after, version bumped", async () => {
    const { projectId } = await createProject("P", { internal: daysAgo(3) });
    const cmd = command({ verdicts: [{ entryId: `deadline:${projectId}`, verdict: "dropped" }] });
    await settleAsAgent(cmd);
    const snapshot = (await storedSnapshot(cmd.commandId))!;
    expect(snapshot.rows).toHaveLength(1);
    const [row] = snapshot.rows;
    expect(row).toMatchObject({ table: "projects", id: projectId });
    expect(row!.before).toMatchObject({ status: "active" });
    expect(row!.after).toMatchObject({ status: "paused" });
    expect(row!.after!.version).toBe((row!.before!.version as number) + 1);
  });

  it("snapshots a self-set date that is skipped: the date before, null after", async () => {
    const { projectId } = await createProject("P", { internal: daysAgo(3) });
    const cmd = command({ verdicts: [{ entryId: `deadline:${projectId}`, verdict: "skipped" }] });
    await settleAsAgent(cmd);
    const [row] = (await storedSnapshot(cmd.commandId))!.rows;
    expect(row).toMatchObject({ table: "projects", id: projectId });
    expect(new Date(row!.before!.internal_deadline_at as string).getTime()).toBe(daysAgo(3).getTime());
    expect(row!.after!.internal_deadline_at).toBeNull();
    expect(row!.after!.status).toBe("active");
  });

  it("snapshots a deadline moved with moveTo", async () => {
    const { projectId } = await createProject("P", { internal: daysAgo(3) });
    const newDate = daysAhead(14);
    const cmd = command({
      verdicts: [{ entryId: `deadline:${projectId}`, verdict: "pending", moveTo: newDate.toISOString() }]
    });
    await settleAsAgent(cmd);
    const [row] = (await storedSnapshot(cmd.commandId))!.rows;
    expect(row).toMatchObject({ table: "projects", id: projectId });
    expect(new Date(row!.before!.internal_deadline_at as string).getTime()).toBe(daysAgo(3).getTime());
    expect(new Date(row!.after!.internal_deadline_at as string).getTime()).toBe(newDate.getTime());
  });

  it("snapshots every occurrence a bulk all_skipped settles, and none it left alone", async () => {
    const a = await createProject("A");
    const first = await createOccurrence(a.projectId, 2, "2026-10-16");
    const second = await createOccurrence(a.projectId, 2, "2026-10-16");
    const older = await createOccurrence(a.projectId, 5, "2026-10-13");
    const cmd = command({ verdicts: [{ bulk: "all_skipped", day: "2026-10-16" }] });
    await settleAsAgent(cmd);
    const snapshot = (await storedSnapshot(cmd.commandId))!;
    expect(snapshot.rows.map((row) => row.id).sort()).toEqual([first, second].sort());
    for (const row of snapshot.rows) {
      expect(row.table).toBe("action_occurrences");
      expect(row.before).toMatchObject({ status: "pending" });
      expect(row.after).toMatchObject({ status: "missed" });
    }
    expect(snapshot.rows.map((row) => row.id)).not.toContain(older);
  });

  it("snapshots the run row a closing settle inserts, with no before-image", async () => {
    const { projectId } = await createProject("P");
    const occurrence = await createOccurrence(projectId, 2);
    const cmd = command({
      verdicts: [{ entryId: `occurrence:${occurrence}`, verdict: "skipped" }],
      closeWindow: true
    });
    const result = await settleAsAgent(cmd);
    expect(result.closed).toBe(true);
    const snapshot = (await storedSnapshot(cmd.commandId))!;
    const runs = await sql<{ id: string }[]>`SELECT id::text AS id FROM catch_up_runs`;
    expect(runs).toHaveLength(1);
    const run = snapshot.rows.find((row) => row.table === "catch_up_runs")!;
    expect(run).toMatchObject({ id: runs[0]!.id, before: null });
    expect(run.after).toMatchObject({ id: runs[0]!.id, user_id: userId, closed_by: "companion" });
    expect(snapshot.rows.find((row) => row.table === "action_occurrences")).toMatchObject({
      id: occurrence,
      before: { status: "pending" },
      after: { status: "missed" }
    });
  });

  it("stores one snapshot for a mixed settle and nothing for a settle that changed nothing", async () => {
    const { projectId } = await createProject("P", { internal: daysAgo(3) });
    const occurrence = await createOccurrence(projectId, 2);
    const mixed = command({
      verdicts: [
        { entryId: `occurrence:${occurrence}`, verdict: "skipped" },
        { entryId: `deadline:${projectId}`, verdict: "done" }
      ]
    });
    await settleAsAgent(mixed);
    expect((await storedSnapshot(mixed.commandId))!.rows.map((row) => row.table).sort()).toEqual([
      "action_occurrences",
      "projects"
    ]);
    const nothing = command({ verdicts: [{ entryId: `occurrence:${occurrence}`, verdict: "skipped" }] });
    await settleAsAgent(nothing);
    expect(await storedSnapshot(nothing.commandId)).toBeNull();
  });

  it("stores no snapshot for the owner's own settle", async () => {
    const { projectId } = await createProject("P", { internal: daysAgo(3) });
    const occurrence = await createOccurrence(projectId, 2);
    const cmd = command({
      verdicts: [
        { entryId: `occurrence:${occurrence}`, verdict: "skipped" },
        { entryId: `deadline:${projectId}`, verdict: "dropped" }
      ],
      closeWindow: true
    });
    const result = await runWithActor(null, () => settleCatchUp(sql as never, cmd, NOW));
    expect(result.closed).toBe(true);
    expect(await storedSnapshot(cmd.commandId)).toBeNull();
    expect(await sql`SELECT 1 FROM writes WHERE images IS NOT NULL`).toHaveLength(0);
  });
});

describe("undoing an agent's settle", () => {
  const revert = (target: string, direction: "undo" | "redo") => ({
    commandId: crypto.randomUUID(),
    target,
    direction
  });
  const revertAsAgent = (target: string, direction: "undo" | "redo") =>
    runWithActor("companion", () => runRevertCommand(sql as never, revert(target, direction)));
  const occurrenceRow = async (id: string) =>
    (
      await sql<
        { status: string; completed_at: Date | null }[]
      >`SELECT status,completed_at FROM action_occurrences WHERE id=${id}`
    )[0]!;

  it("undoes a done occurrence verdict and redoes it", async () => {
    const { projectId } = await createProject("P");
    const occurrence = await createOccurrence(projectId, 2);
    const cmd = command({
      verdicts: [{ entryId: `occurrence:${occurrence}`, verdict: "done", at: daysAgo(2).toISOString() }]
    });
    await settleAsAgent(cmd);
    expect((await occurrenceRow(occurrence)).status).toBe("completed");

    await revertAsAgent(cmd.commandId, "undo");
    expect(await occurrenceRow(occurrence)).toMatchObject({ status: "pending", completed_at: null });
    expect((await storedSnapshot(cmd.commandId))!.state).toBe("undone");
    expect((await readCatchUpLedger(sql as never, { now: NOW })).entries.map((entry) => entry.id)).toContain(
      `occurrence:${occurrence}`
    );

    await revertAsAgent(cmd.commandId, "redo");
    const redone = await occurrenceRow(occurrence);
    expect(redone.status).toBe("completed");
    expect(redone.completed_at?.getTime()).toBe(daysAgo(2).getTime());
    expect((await storedSnapshot(cmd.commandId))!.state).toBe("applied");
  });

  it("undoes a dropped project", async () => {
    const { projectId } = await createProject("P", { internal: daysAgo(3) });
    const cmd = command({ verdicts: [{ entryId: `deadline:${projectId}`, verdict: "dropped" }] });
    await settleAsAgent(cmd);
    const settled = await projectRow(projectId);
    expect(settled.status).toBe("paused");
    await revertAsAgent(cmd.commandId, "undo");
    const restored = await projectRow(projectId);
    expect(restored.status).toBe("active");
    expect(restored.internal_deadline_at?.getTime()).toBe(daysAgo(3).getTime());
    // The version moves on so a client holding the old one notices the change.
    expect(restored.version).toBeGreaterThan(settled.version);
  });

  it("still undoes after the replan rewrote the project's ratios and the occurrence's window", async () => {
    const { projectId } = await createProject("P", { internal: daysAgo(3) });
    const occurrence = await createOccurrence(projectId, 2);
    const cmd = command({
      verdicts: [
        { entryId: `occurrence:${occurrence}`, verdict: "done", at: daysAgo(2).toISOString() },
        { entryId: `deadline:${projectId}`, verdict: "dropped" }
      ]
    });
    await settleAsAgent(cmd);
    // What the recalculation every write enqueues does to these rows (completion-ratios.ts, plan-forecast-runtime.ts).
    await sql`UPDATE projects SET actual_completion_ratio=0.4, required_completion_ratio=0.6, forecast_started_at=now(), baseline_estimate_minutes=90, updated_at=now() + interval '1 minute' WHERE id=${projectId}`;
    await sql`UPDATE action_occurrences SET window_ends_at=window_ends_at + interval '5 minutes', updated_at=now() + interval '1 minute' WHERE id=${occurrence}`;
    await revertAsAgent(cmd.commandId, "undo");
    expect((await projectRow(projectId)).status).toBe("active");
    expect((await occurrenceRow(occurrence)).status).toBe("pending");
    // The planner's own columns are left for the next recalculation, not put back.
    const [ratios] = await sql<
      { actual_completion_ratio: number | string }[]
    >`SELECT actual_completion_ratio FROM projects WHERE id=${projectId}`;
    expect(Number(ratios!.actual_completion_ratio)).toBe(0.4);
  });

  it("undoes a moved deadline", async () => {
    const { projectId } = await createProject("P", { internal: daysAgo(3) });
    const cmd = command({
      verdicts: [{ entryId: `deadline:${projectId}`, verdict: "pending", moveTo: daysAhead(14).toISOString() }]
    });
    await settleAsAgent(cmd);
    expect((await projectRow(projectId)).internal_deadline_at?.getTime()).toBe(daysAhead(14).getTime());
    await revertAsAgent(cmd.commandId, "undo");
    expect((await projectRow(projectId)).internal_deadline_at?.getTime()).toBe(daysAgo(3).getTime());
  });

  it("undoes a bulk all_skipped: every occurrence is pending again", async () => {
    const { projectId } = await createProject("P");
    const ids = [
      await createOccurrence(projectId, 2, "2026-10-16"),
      await createOccurrence(projectId, 2, "2026-10-16"),
      await createOccurrence(projectId, 2, "2026-10-16")
    ];
    const cmd = command({ verdicts: [{ bulk: "all_skipped", day: "2026-10-16" }] });
    await settleAsAgent(cmd);
    for (const id of ids) expect(await occurrenceStatus(id)).toBe("missed");
    await revertAsAgent(cmd.commandId, "undo");
    for (const id of ids) expect(await occurrenceStatus(id)).toBe("pending");
  });

  it("undoes a closing settle: the run row is gone, the window reopens and the entries are listed again", async () => {
    const { projectId } = await createProject("P", { internal: daysAgo(3) });
    const occurrence = await createOccurrence(projectId, 2);
    const cmd = command({
      verdicts: [
        { entryId: `occurrence:${occurrence}`, verdict: "skipped" },
        { entryId: `deadline:${projectId}`, verdict: "dropped" }
      ],
      closeWindow: true
    });
    const before = await readCatchUpLedger(sql as never, { now: NOW });
    expect(before.since).toBeNull();
    expect((await settleAsAgent(cmd)).closed).toBe(true);
    expect(await sql`SELECT 1 FROM catch_up_runs`).toHaveLength(1);
    expect((await readCatchUpLedger(sql as never, { now: NOW })).unsettled).toBe(0);

    await revertAsAgent(cmd.commandId, "undo");
    expect(await sql`SELECT 1 FROM catch_up_runs`).toHaveLength(0);
    const reopened = await readCatchUpLedger(sql as never, { now: NOW });
    expect(reopened.since).toBeNull();
    expect(reopened.entries.map((entry) => entry.id).sort()).toEqual(
      [`occurrence:${occurrence}`, `deadline:${projectId}`].sort()
    );
    expect(await occurrenceStatus(occurrence)).toBe("pending");
    expect((await projectRow(projectId)).status).toBe("active");

    await revertAsAgent(cmd.commandId, "redo");
    expect(await sql`SELECT 1 FROM catch_up_runs`).toHaveLength(1);
    expect(await occurrenceStatus(occurrence)).toBe("missed");
    expect((await projectRow(projectId)).status).toBe("paused");
    expect((await readCatchUpLedger(sql as never, { now: NOW })).unsettled).toBe(0);
  });

  it("refuses to undo once the person edited a project since, and changes nothing", async () => {
    const a = await createProject("A", { internal: daysAgo(3) });
    const b = await createProject("B", { internal: daysAgo(3) });
    const occurrence = await createOccurrence(a.projectId, 2);
    const cmd = command({
      verdicts: [
        { entryId: `occurrence:${occurrence}`, verdict: "skipped" },
        { entryId: `deadline:${a.projectId}`, verdict: "dropped" },
        { entryId: `deadline:${b.projectId}`, verdict: "dropped" }
      ]
    });
    await settleAsAgent(cmd);
    await sql`UPDATE projects SET title='Renamed by hand', version=version+1 WHERE id=${b.projectId}`;
    const snapshotBefore = await storedSnapshot(cmd.commandId);

    await expect(revertAsAgent(cmd.commandId, "undo")).rejects.toBeInstanceOf(CommandConflictError);

    expect(await occurrenceStatus(occurrence)).toBe("missed");
    expect((await projectRow(a.projectId)).status).toBe("paused");
    expect((await projectRow(b.projectId)).status).toBe("paused");
    expect(await storedSnapshot(cmd.commandId)).toEqual(snapshotBefore);
  });
});
