import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { fileURLToPath } from "node:url";
import { allDirectWritesOn, contractsExtensions } from "@openrhen/contracts";
import { agentCaptureRefusal } from "@/server/persistence/postgres/entity-extensions";
import { integrationDatabaseName } from "@openrhen/database";
import { ensureUser } from "@/server/persistence/postgres/ensure-user";
import { databaseJournalStore, runCliWithAgentJournal } from "./agent-journal-runner";
import type { AgentPrincipal } from "./agent-tokens";
import { fakeWorld } from "./mcp-test-support";

/**
 * The agent's undo journal on `/mcp` against the real write ledger: a write on one call
 * is undone on a later one from the ledger, and the owner's undo by id finds it. Self-contained `_test` database.
 */
config({ path: fileURLToPath(new URL("../../.env", import.meta.url)), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(
  process.env.AGENT_JOURNAL_RUNNER_TEST_DATABASE_NAME,
  "openrhen_agent_journal_runner"
);

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("AGENT_JOURNAL_RUNNER_TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let previousDatabaseUrl: string | undefined;

const principal = (directWrites: AgentPrincipal["directWrites"] = { area: "on" }): AgentPrincipal => ({
  name: "companion",
  source: "db",
  tokenId: "t1",
  scopes: ["read:plan", "write:entity", "write:undo"],
  directWrites
});
const inbound = () => new Request("https://portal.test/mcp", { method: "POST", headers: { host: "portal.test" } });

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
      migrationsFolder: fileURLToPath(new URL("../../platform/database/drizzle", import.meta.url))
    });
  } finally {
    await migrationSql.end();
  }
  sql = postgres(testUrl.toString(), { max: 5, connect_timeout: 10, fetch_types: false, prepare: true });
  // The portal's own stores (journal, proposals) reach the database through DATABASE_URL.
  previousDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = testUrl.toString();
}, 30_000);

beforeEach(async () => {
  await sql.unsafe("TRUNCATE TABLE writes, write_rows, agent_proposals RESTART IDENTITY CASCADE");
  await ensureUser(sql);
});

afterAll(async () => {
  if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previousDatabaseUrl;
  await sql?.end();
});

async function run(
  world: Awaited<ReturnType<typeof fakeWorld>>,
  argv: string[],
  actor: Parameters<typeof runCliWithAgentJournal>[0]["actor"] = { kind: "agent", principal: principal() }
) {
  const store = await databaseJournalStore();
  expect(store).toBeDefined();
  return runCliWithAgentJournal({
    argv,
    actor,
    inbound: inbound(),
    loadRoute: world.loadRoute,
    agent: "companion",
    store
  });
}

/**
 * The whole chain for a write the portal snapshots, through the real route table and the real database: an agent's
 * check-in answer and session start are journaled as server-checked entries, `undo`/`redo` post them to the real
 * `/api/commands/revert`, and the rows really go back and forward. Nothing is stubbed below the route wrapper.
 */
describe("a snapshotted agent write, undone through the real revert route", () => {
  const snapshotAgent: AgentPrincipal = {
    name: "companion",
    source: "db",
    tokenId: "t1",
    scopes: ["read:plan", "write:check-in", "write:session", "write:undo", "write:inbox"],
    directWrites: { area: "on", action: "on" }
  };
  // No `loadRoute`: the generated route table, so the real routes and the real revert handler run.
  const go = async (argv: string[], actor: Parameters<typeof run>[2] = { kind: "agent", principal: snapshotAgent }) =>
    runCliWithAgentJournal({
      argv,
      actor,
      inbound: inbound(),
      agent: "companion",
      store: await databaseJournalStore()
    });
  // The agent's journal as `undo` reads it: its server-checked entries are the ledger's (`writes` by actor).
  const journal = async () => (await databaseJournalStore())!.load("companion");

  beforeEach(async () => {
    await sql.unsafe(
      "TRUNCATE TABLE check_in, writes, write_rows, planning_runs, session_segments, sessions, actions, projects, outcomes, areas, captures, sources CASCADE"
    );
  });

  /** The minimal current plan a session `start` needs (`requireCurrentPlanForecast`). */
  const storePlanningRun = async (userId: string, actionId: string) => {
    const now = new Date();
    const validUntil = new Date(now.getTime() + 3_600_000).toISOString();
    await sql`
      INSERT INTO planning_runs (user_id,request_id,input_version,contract_version,engine_version,calculated_at,valid_until,result)
      VALUES (
        ${userId},${crypto.randomUUID()},'v1','1','v1',${now},${validUntil},
        ${sql.json({
          contractVersion: "1",
          requestId: crypto.randomUUID(),
          inputVersion: "v1",
          engineVersion: "v1",
          calculatedAt: now.toISOString(),
          validUntil,
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
      )`;
  };

  const seedCheckIn = async () => {
    const userId = await ensureUser(sql);
    return (
      await sql<{ id: string }[]>`
        INSERT INTO check_in (user_id, slot_at, directive_kind, directive_target_id, directive_title, status)
        VALUES (${userId}, now(), 'action', ${null}, 'Write the report', 'pending')
        RETURNING id`
    )[0]!.id;
  };
  const checkInStatus = async (id: string) =>
    (await sql<{ status: string }[]>`SELECT status FROM check_in WHERE id=${id}`)[0]!.status;

  it("answers a check-in, undoes it from the stored journal, and redoes it", async () => {
    const id = await seedCheckIn();
    const answered = await go(["check-in", "on-track", "--json"]);
    expect(answered.exitCode, answered.stderr.join("\n")).toBe(0);
    expect(await checkInStatus(id)).toBe("on_track");
    const entries = await journal();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      serverChecked: true,
      status: "applied",
      undo: { path: "/api/commands/revert", payload: { direction: "undo" } }
    });
    // The entry is the ledger's: it is named by the write, and the stored journal got none.
    expect(entries[0]!.id).toBe(entries[0]!.target.id);
    const snapshots = await sql<{ command_id: string; state: string }[]>`
      SELECT id AS command_id, state FROM writes WHERE images IS NOT NULL`;
    expect(snapshots).toEqual([expect.objectContaining({ state: "applied" })]);
    expect(entries[0]!.target.id).toBe(snapshots[0]!.command_id);

    const undone = await go(["undo", "--json"]);
    expect(undone.exitCode, undone.stderr.join("\n")).toBe(0);
    expect(await checkInStatus(id)).toBe("pending");
    expect((await journal())[0]).toMatchObject({ status: "undone" });
    expect((await sql<{ state: string }[]>`SELECT state FROM writes WHERE images IS NOT NULL`)[0]!.state).toBe(
      "undone"
    );

    const redone = await go(["undo", "--redo", "--json"]);
    expect(redone.exitCode, redone.stderr.join("\n")).toBe(0);
    expect(await checkInStatus(id)).toBe("on_track");
    expect((await journal())[0]).toMatchObject({ status: "applied" });
  });

  it("records when the person woke as a direct write, undoes it, and still files any other settings field", async () => {
    const wakeAgent = {
      kind: "agent" as const,
      principal: {
        ...snapshotAgent,
        scopes: ["read:plan", "write:entity", "write:undo"],
        directWrites: { sleep_log_entry: "on" as const }
      }
    };
    const userId = await ensureUser(sql);
    await sql`TRUNCATE TABLE agent_proposals`;
    await sql`UPDATE user_preferences SET last_woke_at='2026-10-06T22:00:00.000Z' WHERE user_id=${userId}`;
    const lastWoke = async () =>
      (
        await sql<{ at: Date | null }[]>`SELECT last_woke_at AS at FROM user_preferences WHERE user_id=${userId}`
      )[0]!.at?.toISOString();
    const wake = new Date(Date.now() - 60 * 60_000).toISOString();

    const saved = await go(["save", `--set=lastWokeAt=${wake}`, "--json", "--", "settings"], wakeAgent);
    expect(saved.exitCode, saved.stderr.join("\n")).toBe(0);
    expect(saved.stdout.join("\n")).not.toMatch(/Filed as proposal/);
    expect(await lastWoke()).toBe(wake);

    const undone = await go(["undo", "--json"], wakeAgent);
    expect(undone.exitCode, undone.stderr.join("\n")).toBe(0);
    expect(await lastWoke()).toBe("2026-10-06T22:00:00.000Z");

    // A plan preference applies directly only for a token with every class on: this one is filed, and told so.
    const other = await go(["save", "--set=desiredSleepMinutes=420", "--json", "--", "settings"], wakeAgent);
    expect(other.exitCode, other.stderr.join("\n")).toBe(0);
    expect(other.stdout.join("\n")).toMatch(/Filed as proposal/);
    expect(await sql`SELECT 1 FROM agent_proposals`).toHaveLength(1);
  });

  it("changes a plan preference directly for an all-on token and undoes it; timezone stays the person's", async () => {
    const allOn = {
      kind: "agent" as const,
      principal: {
        ...snapshotAgent,
        scopes: ["read:plan", "write:entity", "write:undo"],
        directWrites: allDirectWritesOn()
      }
    };
    const userId = await ensureUser(sql);
    await sql`TRUNCATE TABLE agent_proposals`;
    await sql`UPDATE user_preferences SET desired_sleep_minutes=480 WHERE user_id=${userId}`;
    const desired = async () =>
      (await sql<{ m: number }[]>`SELECT desired_sleep_minutes AS m FROM user_preferences WHERE user_id=${userId}`)[0]!
        .m;

    const saved = await go(["save", "--set=desiredSleepMinutes=420", "--json", "--", "settings"], allOn);
    expect(saved.exitCode, saved.stderr.join("\n")).toBe(0);
    expect(saved.stdout.join("\n")).not.toMatch(/Filed as proposal/);
    expect(await desired()).toBe(420);
    const undone = await go(["undo", "--json"], allOn);
    expect(undone.exitCode, undone.stderr.join("\n")).toBe(0);
    expect(await desired()).toBe(480);

    // A field that was unset comes back unset: the state leaves it out, and the undo restates it as null.
    await sql`UPDATE user_preferences SET default_transport_mode=NULL WHERE user_id=${userId}`;
    const transport = async () =>
      (
        await sql<
          { mode: string | null }[]
        >`SELECT default_transport_mode AS mode FROM user_preferences WHERE user_id=${userId}`
      )[0]!.mode;
    const mode = await go(["save", "--set=defaultTransportMode=bike", "--json", "--", "settings"], allOn);
    expect(mode.exitCode, mode.stderr.join("\n")).toBe(0);
    expect(await transport()).toBe("bike");
    const modeUndone = await go(["undo", "--json"], allOn);
    expect(modeUndone.exitCode, modeUndone.stderr.join("\n")).toBe(0);
    expect(await transport()).toBeNull();

    const timezone = await go(["save", "--set=timezone=Europe/London", "--json", "--", "settings"], allOn);
    expect(timezone.exitCode, timezone.stderr.join("\n")).toBe(0);
    expect(timezone.stdout.join("\n")).toMatch(/Filed as proposal/);
    expect(await sql`SELECT 1 FROM agent_proposals`).toHaveLength(1);
  });

  it("refuses the undo with exit 3 when the row changed since, and refuses the agent's --force", async () => {
    const id = await seedCheckIn();
    await go(["check-in", "on-track", "--json"]);
    await sql`UPDATE check_in SET deviation_note = 'edited by hand', version = version + 1 WHERE id = ${id}`;
    const refused = await go(["undo", "--json"]);
    expect(refused.exitCode).toBe(3);
    expect(await checkInStatus(id)).toBe("on_track");
    expect((await journal())[0]).toMatchObject({ status: "applied" });
    // Forcing over the person's change is theirs alone (the owner's Agent changes list), never the agent's.
    const forced = await go(["undo", "--force", "--json"]);
    expect(forced.exitCode).not.toBe(0);
    expect(await checkInStatus(id)).toBe("on_track");
  });

  it("starts a session, undoes it, and redoes it", async () => {
    const userId = await ensureUser(sql);
    const [area] = await sql<{ id: string }[]>`
      INSERT INTO areas (user_id,name,status,sort_order) VALUES (${userId},'Area e2e','active',0) RETURNING id`;
    const [outcome] = await sql<{ id: string }[]>`
      INSERT INTO outcomes (area_id,title,definition_of_done,status) VALUES (${area!.id},'Outcome','Done','active') RETURNING id`;
    const [project] = await sql<{ id: string }[]>`
      INSERT INTO projects (outcome_id,title,status) VALUES (${outcome!.id},'Project','active') RETURNING id`;
    const [action] = await sql<{ id: string }[]>`
      INSERT INTO actions (project_id,title,scheduling_mode,status,optimistic_minutes,expected_minutes,pessimistic_minutes,remaining_minutes,energy,minimum_session_minutes,maximum_session_minutes)
      VALUES (${project!.id},'Draft citations','one_off','active',30,60,90,60,'medium',15,90) RETURNING id`;
    await storePlanningRun(userId, action!.id);
    await sql`UPDATE user_preferences SET last_woke_at=${new Date(Date.now() - 8 * 3_600_000)} WHERE user_id=${userId}`;
    const started = await go(["session", "start", `--action=${action!.id}`, "--minutes=30", "--json"]);
    expect(started.exitCode, started.stdout.join("\n")).toBe(0);
    const count = async () => (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM sessions`)[0]!.n;
    expect(await count()).toBe(1);
    expect((await journal())[0]).toMatchObject({ serverChecked: true, status: "applied" });

    const undone = await go(["undo", "--json"]);
    expect(undone.exitCode, undone.stderr.join("\n")).toBe(0);
    expect(await count()).toBe(0);
    const redone = await go(["undo", "--redo", "--json"]);
    expect(redone.exitCode, redone.stderr.join("\n")).toBe(0);
    expect(await count()).toBe(1);
  });

  /** An area, outcome and project for the capture to land in, and a pending capture from `sourceType`. */
  const seedCapture = async (sourceType = "manual_capture") => {
    const userId = await ensureUser(sql);
    const [area] = await sql<{ id: string }[]>`
      INSERT INTO areas (user_id,name,status,sort_order) VALUES (${userId},'Area inbox','active',0) RETURNING id`;
    const [outcome] = await sql<{ id: string }[]>`
      INSERT INTO outcomes (area_id,title,definition_of_done,status) VALUES (${area!.id},'Outcome','Done','active') RETURNING id`;
    const [project] = await sql<{ id: string }[]>`
      INSERT INTO projects (outcome_id,title,status) VALUES (${outcome!.id},'Project','active') RETURNING id`;
    const [source] = await sql<{ id: string }[]>`
      INSERT INTO sources (user_id,source_type,external_id,title,captured_text)
      VALUES (${userId},${sourceType},${crypto.randomUUID()},'Draft the report','Draft the report') RETURNING id`;
    const [proposal] = await sql<{ id: string }[]>`
      INSERT INTO captures (user_id,source_id,proposal_type,status,proposed_fields)
      VALUES (${userId},${source!.id},'unclassified','pending',${sql.json({ text: "Draft the report" } as never)}) RETURNING id`;
    return { projectId: project!.id, proposalId: proposal!.id };
  };
  const proposalStatus = async (id: string) =>
    (await sql<{ status: string }[]>`SELECT status FROM captures WHERE id=${id}`)[0]!.status;
  const actionCount = async (id: string) =>
    (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM actions WHERE id=${id}`)[0]!.n;

  it("confirms a captured item, undoes it from the stored journal, and redoes it", async () => {
    const { projectId, proposalId } = await seedCapture();
    const confirmed = await go([
      "inbox-act",
      "captured",
      "confirm",
      proposalId,
      "--type=action",
      `--set=projectId=${projectId}`,
      "--json"
    ]);
    expect(confirmed.exitCode, confirmed.stderr.join("\n") + confirmed.stdout.join("\n")).toBe(0);
    expect(await actionCount(proposalId)).toBe(1);
    expect(await proposalStatus(proposalId)).toBe("confirmed");
    const entries = await journal();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      serverChecked: true,
      status: "applied",
      undo: { path: "/api/commands/revert", payload: { direction: "undo" } }
    });
    const snapshots = await sql<{ command_id: string; kind: string }[]>`
      SELECT id AS command_id, kind FROM writes WHERE images IS NOT NULL`;
    expect(snapshots).toEqual([expect.objectContaining({ kind: "confirm" })]);
    expect(entries[0]!.target.id).toBe(snapshots[0]!.command_id);

    const undone = await go(["undo", "--json"]);
    expect(undone.exitCode, undone.stderr.join("\n")).toBe(0);
    expect(await actionCount(proposalId)).toBe(0);
    expect(await proposalStatus(proposalId)).toBe("pending");
    expect((await journal())[0]).toMatchObject({ status: "undone" });

    const redone = await go(["undo", "--redo", "--json"]);
    expect(redone.exitCode, redone.stderr.join("\n")).toBe(0);
    expect(await actionCount(proposalId)).toBe(1);
    expect(await proposalStatus(proposalId)).toBe("confirmed");
  });

  // The sources a feature adds whose captures are the person's alone to confirm (none in the OpenRhen export).
  const otherPeopleSources = contractsExtensions()
    .flatMap((extension) => Object.keys(extension.sourceIds ?? {}))
    .filter((sourceType) => agentCaptureRefusal(sourceType, "confirm") !== undefined);
  it.each(otherPeopleSources)(
    "refuses a capture from the %s source, leaving it pending and journaling nothing",
    async (sourceType) => {
      const { projectId, proposalId } = await seedCapture(sourceType);
      const refused = await go([
        "inbox-act",
        "captured",
        "confirm",
        proposalId,
        "--type=action",
        `--set=projectId=${projectId}`,
        "--json"
      ]);
      expect(refused.exitCode).not.toBe(0);
      expect([...refused.stdout, ...refused.stderr].join("\n")).toMatch(new RegExp(sourceType));
      expect(await actionCount(proposalId)).toBe(0);
      expect(await proposalStatus(proposalId)).toBe("pending");
      expect(await journal()).toHaveLength(0);
    }
  );

  it("lets the owner undo such an entry by id, and puts it back", async () => {
    const id = await seedCheckIn();
    await go(["check-in", "on-track", "--json"]);
    const entryId = (await journal())[0]!.id;
    const undone = await go(["undo", `--id=${entryId}`, "--any-owner", "--json"], { kind: "owner" });
    expect(undone.exitCode, undone.stderr.join("\n")).toBe(0);
    expect(await checkInStatus(id)).toBe("pending");
    expect((await journal())[0]).toMatchObject({ status: "undone" });
    const redone = await go(["undo", `--id=${entryId}`, "--any-owner", "--redo", "--json"], { kind: "owner" });
    expect(redone.exitCode, redone.stderr.join("\n")).toBe(0);
    expect(await checkInStatus(id)).toBe("on_track");
  });

  it("undoes and redoes through the owner's Agent changes route, and says why when the row was edited", async () => {
    const { POST } = await import("@/app/api/agent-changes/[id]/undo/route");
    const door = (entryId: string, body: Record<string, unknown> = {}) =>
      POST(
        new Request(`http://localhost/api/agent-changes/${entryId}/undo`, {
          method: "POST",
          headers: { "content-type": "application/json", host: "localhost" },
          body: JSON.stringify(body)
        }),
        { params: Promise.resolve({ id: entryId }) }
      );
    const id = await seedCheckIn();
    await go(["check-in", "on-track", "--json"]);
    const entryId = (await journal())[0]!.id;

    const undone = await door(entryId);
    expect(undone.status, JSON.stringify(await undone.clone().json())).toBe(200);
    expect(await checkInStatus(id)).toBe("pending");
    const redone = await door(entryId, { redo: true });
    expect(redone.status, JSON.stringify(await redone.clone().json())).toBe(200);
    expect(await checkInStatus(id)).toBe("on_track");

    await sql`UPDATE check_in SET deviation_note = 'edited by hand', version = version + 1 WHERE id = ${id}`;
    const refused = await door(entryId);
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toMatch(/changed after the agent's write/);
    expect(await checkInStatus(id)).toBe("on_track");
    expect((await door(entryId, { force: true })).status).toBe(200);
    expect(await checkInStatus(id)).toBe("pending");
  });
});
