import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import type { CloseEntityCommand } from "@openrhen/contracts";
import { integrationDatabaseName } from "@openrhen/database";
import { runWithActor } from "@/server/agent-actor";
import { enforceAgentRequest } from "@/server/agent-enforcement";
import type { AgentPrincipal } from "@/server/agent-tokens";
import { resolveAgentProposal } from "@/server/agent-proposals/store";
import { closeEntity } from "./close-commands";
import { CommandConflictError } from "./command-errors";
import { ensureUser } from "./ensure-user";

/**
 * An agent's archive, cancel and restore through the route's enforcement with its DEFAULT stored-facts path (no
 * injected facts): the decision reads the rows, files one `close_entity` proposal when the owner must decide, and a
 * confirm replays it as the owner (archive-removals design D7, D9, D10, D13; plan WP3 and WP4).
 */
config({ path: resolve(process.cwd(), "../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(
  process.env.CLOSE_ENFORCEMENT_TEST_DATABASE_NAME,
  "openrhen_close_enforcement"
);

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("CLOSE_ENFORCEMENT_TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let userId: string;

const asAgent = <T>(run: () => Promise<T>, agent = "claude") => runWithActor(agent, run);

beforeAll(async () => {
  const admin = postgres(adminUrl!, { max: 1, connect_timeout: 10 });
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
  sql = postgres(testUrl.toString(), { max: 8, connect_timeout: 10, fetch_types: false, prepare: true });
  // The default stored-facts reader and the default proposal filer open the portal database from this.
  process.env.DATABASE_URL = testUrl.toString();
}, 60_000);

beforeEach(async () => {
  await sql.unsafe(
    "TRUNCATE TABLE agent_proposals, writes, write_rows, jobs, sessions, routine_steps, commitment_recurrence_rules, commitments, deliverables, actions, projects, outcomes, areas, condition_definitions, routine_presets, entity_prerequisites RESTART IDENTITY CASCADE"
  );
  userId = await ensureUser(sql);
  await sql`INSERT INTO user_preferences (user_id) VALUES (${userId}) ON CONFLICT DO NOTHING`;
  await sql`UPDATE user_preferences SET home_location_id = NULL WHERE user_id = ${userId}`;
});

afterAll(async () => {
  await sql?.end();
});

// ---- seeding ----

const one = async (query: Promise<{ id: string }[]>) => (await query)[0]!.id;
const seedArea = () =>
  one(
    sql`INSERT INTO areas (user_id,name,status,sort_order) VALUES (${userId},${"Area " + crypto.randomUUID()},'active',0) RETURNING id`
  );
const seedOutcome = async () =>
  one(
    sql`INSERT INTO outcomes (area_id,title,definition_of_done,status) VALUES (${await seedArea()},'Outcome','Done','active') RETURNING id`
  );
const seedProject = async () =>
  one(
    sql`INSERT INTO projects (outcome_id,title,status) VALUES (${await seedOutcome()},'Project','active') RETURNING id`
  );
const seedAction = (projectId: string, status = "planned") =>
  one(sql`
    INSERT INTO actions (project_id,title,scheduling_mode,status,optimistic_minutes,expected_minutes,pessimistic_minutes,remaining_minutes,energy,minimum_session_minutes,maximum_session_minutes)
    VALUES (${projectId},'Draft citations','one_off',${status},30,60,90,60,'medium',15,90) RETURNING id`);
const seedCommitment = (shared = false) =>
  one(sql`
    INSERT INTO commitments (user_id,title,starts_at,ends_at,status,share_to_calendar)
    VALUES (${userId},'Dentist',now() + interval '3 days',now() + interval '3 days 1 hour','confirmed',${shared}) RETURNING id`);

const stored = async (table: string, id: string) =>
  (
    await sql.unsafe<{ status: string; closed_by: string | null; version: number }[]>(
      `SELECT status::text AS status, closed_by, version FROM ${table} WHERE id = $1`,
      [id]
    )
  )[0]!;
const proposals = () =>
  sql<{ id: string; kind: string; status: string; revision: number; payload: Record<string, unknown> }[]>`
    SELECT id, kind, status, revision, payload FROM agent_proposals ORDER BY created_at`;

// ---- the agent ----

const agent = (scopes: string[], directWrites: AgentPrincipal["directWrites"]): AgentPrincipal => ({
  name: "claude",
  source: "db",
  tokenId: "t1",
  scopes,
  directWrites
});
const ACTIONS = agent(["write:entity:action"], { action: "on" });

/** The route's guard with every default dependency, then, when it lets the call through, the handler as the agent. */
async function send(held: AgentPrincipal, body: Record<string, unknown>) {
  const request = new Request("http://portal.test/api/commands/close", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const guard = await enforceAgentRequest(request, "/api/commands/close", held, { basis: "stated", evidence: "asked" });
  if (guard !== null) return { guard, status: guard.status, applied: undefined };
  const applied = await asAgent(() =>
    closeEntity(sql as never, { commandId: crypto.randomUUID(), ...body } as CloseEntityCommand)
  );
  return { guard: null, status: 200, applied };
}
const closeOf = (type: string, id: string, extra: Record<string, unknown> = {}) => ({
  type,
  id,
  verb: type === "action" || type === "commitment" ? "cancel" : "archive",
  do: "close",
  reason: "no longer needed",
  ...extra
});
const confirm = async (proposal: { id: string; revision: number }) =>
  resolveAgentProposal(sql as never, null, proposal.id, { decision: "confirm", revision: proposal.revision });

describe("an agent's close through the default stored-facts path", () => {
  it("applies a plain close directly and stamps the agent", async () => {
    const action = await seedAction(await seedProject());
    const done = await send(ACTIONS, closeOf("action", action));
    expect(done.guard).toBeNull();
    expect(await stored("actions", action)).toMatchObject({ status: "cancelled", closed_by: "agent:claude" });
    expect(await proposals()).toHaveLength(0);
  });

  it("restores directly only what this agent closed itself", async () => {
    const mine = await seedAction(await seedProject());
    await send(ACTIONS, closeOf("action", mine));
    const version = (await stored("actions", mine)).version;
    const back = await send(ACTIONS, {
      type: "action",
      id: mine,
      verb: "cancel",
      do: "restore",
      expectedVersion: version
    });
    expect(back.guard).toBeNull();
    expect((await stored("actions", mine)).status).toBe("planned");

    const theirs = await seedAction(await seedProject());
    await closeEntity(sql as never, closeOf("action", theirs) as CloseEntityCommand);
    expect((await stored("actions", theirs)).closed_by).toBe("person");
    const held = await send(ACTIONS, {
      type: "action",
      id: theirs,
      verb: "cancel",
      do: "restore",
      expectedVersion: (await stored("actions", theirs)).version
    });
    expect(held.status).toBe(202);
    expect((await stored("actions", theirs)).status).toBe("cancelled");
    expect(await proposals()).toHaveLength(1);
  });

  it("files a restore of a row closed by anyone but this agent's own direct close", async () => {
    const closers: [string, string | null][] = [
      ["null", null],
      ["system", "system"],
      ["another agent", "agent:other"],
      ["its own confirmed close", "agent:claude:confirmed"]
    ];
    for (const [label, closedBy] of closers) {
      const action = await seedAction(await seedProject());
      await closeEntity(sql as never, closeOf("action", action) as CloseEntityCommand);
      await sql`UPDATE actions SET closed_by = ${closedBy} WHERE id = ${action}`;
      const held = await send(ACTIONS, {
        type: "action",
        id: action,
        verb: "cancel",
        do: "restore",
        expectedVersion: (await stored("actions", action)).version
      });
      expect(held.status, label).toBe(202);
      expect((await stored("actions", action)).status, label).toBe("cancelled");
    }
    expect(await proposals()).toHaveLength(closers.length);
  });

  it("leaves a restore of a missing or open row to the handler's refusal, not a proposal", async () => {
    const open = await seedAction(await seedProject());
    for (const id of [open, crypto.randomUUID()]) {
      const sent = await send(ACTIONS, { type: "action", id, verb: "cancel", do: "restore", expectedVersion: 1 }).catch(
        (error: unknown) => error
      );
      expect(sent, id).toBeInstanceOf(Error);
    }
    expect(await proposals()).toHaveLength(0);
  });

  it("files a shared commitment's cancel as one proposal; confirming it cancels it as the confirmed agent", async () => {
    const commitment = await seedCommitment(true);
    const held = await send(
      agent(["write:entity:commitment"], { commitment: "on" }),
      closeOf("commitment", commitment)
    );
    expect(held.status).toBe(202);
    expect((await stored("commitments", commitment)).status).toBe("confirmed");
    const [filed, ...rest] = await proposals();
    expect(rest).toHaveLength(0);
    expect(filed).toMatchObject({ kind: "close_entity", status: "pending" });
    // The same call again replaces the pending card instead of adding another.
    await send(agent(["write:entity:commitment"], { commitment: "on" }), closeOf("commitment", commitment));
    expect(await proposals()).toHaveLength(1);

    expect((await confirm(filed!)).status).toBe("confirmed");
    expect(await stored("commitments", commitment)).toMatchObject({
      status: "cancelled",
      closed_by: "agent:claude:confirmed"
    });
  });

  it("files a close that includes children as ONE proposal when the token cannot write a child type, and goes stale when the set changes", async () => {
    const project = await seedProject();
    const a1 = await seedAction(project);
    const a2 = await seedAction(project);
    const projectOnly = agent(["write:entity:project"], { project: "on" });
    const held = await send(projectOnly, closeOf("project", project, { includeChildren: true }));
    expect(held.status).toBe(202);
    const [filed, ...rest] = await proposals();
    expect(rest).toHaveLength(0);
    expect((filed!.payload.children as unknown[]).length).toBe(2);
    expect((await stored("projects", project)).status).toBe("active");

    // A third action appears after the decision: the pinned set is no longer the live one.
    await seedAction(project);
    await expect(confirm(filed!)).rejects.toMatchObject({ status: 409 });
    expect((await proposals())[0]!.status).toBe("stale");
    expect((await stored("projects", project)).status).toBe("active");
    expect((await stored("actions", a1)).status).toBe("planned");
    expect((await stored("actions", a2)).status).toBe("planned");
  });

  it("applies a close with children directly when the token writes every type it reaches", async () => {
    const project = await seedProject();
    const action = await seedAction(project);
    const both = agent(["write:entity:project", "write:entity:action"], { project: "on", action: "on" });
    const done = await send(both, closeOf("project", project, { includeChildren: true }));
    expect(done.guard).toBeNull();
    expect((await stored("actions", action)).status).toBe("cancelled");
    expect((await stored("projects", project)).closed_by).toBe("agent:claude");
  });

  it("confirms a held close with children as one batch, stamped confirmed, after the pinned set held", async () => {
    const project = await seedProject();
    const action = await seedAction(project);
    const held = await send(
      agent(["write:entity:project"], { project: "on" }),
      closeOf("project", project, { includeChildren: true })
    );
    expect(held.status).toBe(202);
    await confirm((await proposals())[0]!);
    expect(await stored("projects", project)).toMatchObject({
      status: "archived",
      closed_by: "agent:claude:confirmed"
    });
    expect(await stored("actions", action)).toMatchObject({ closed_by: "agent:claude:confirmed" });
  });

  it("files a call past 20 rows as one proposal even when the token may write everything", async () => {
    const project = await seedProject();
    for (let index = 0; index < 20; index += 1) await seedAction(project);
    const both = agent(["write:entity:project", "write:entity:action"], { project: "on", action: "on" });
    const held = await send(both, closeOf("project", project, { includeChildren: true }));
    expect(held.status).toBe(202);
    expect(await proposals()).toHaveLength(1);
    expect((await stored("projects", project)).status).toBe("active");
  });

  it("files a close for the owner when the stored rows cannot be read", async () => {
    const action = await seedAction(await seedProject());
    await sql`ALTER TABLE actions RENAME TO actions_unreadable`;
    try {
      const held = await send(ACTIONS, closeOf("action", action));
      expect(held.status).toBe(202);
    } finally {
      await sql`ALTER TABLE actions_unreadable RENAME TO actions`;
    }
    expect(await proposals()).toHaveLength(1);
    expect((await stored("actions", action)).status).toBe("planned");
  });

  it("re-checks in the handler: a call that reached it with something shared under it is refused, not applied", async () => {
    const commitment = await seedCommitment(true);
    await expect(
      asAgent(() => closeEntity(sql as never, closeOf("commitment", commitment) as CloseEntityCommand))
    ).rejects.toBeInstanceOf(CommandConflictError);
    expect((await stored("commitments", commitment)).status).toBe("confirmed");
  });
});
