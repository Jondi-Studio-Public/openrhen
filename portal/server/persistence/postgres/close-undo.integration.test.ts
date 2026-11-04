import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import type { CloseEntityCommand, PlanningEntityCommand } from "@openrhen/contracts";
import { UNDO_VERB } from "@openrhen/contracts";
import { integrationDatabaseName } from "@openrhen/database";
import { runWithActor } from "@/server/agent-actor";
import { enforceAgentRequest } from "@/server/agent-enforcement";
import type { AgentPrincipal } from "@/server/agent-tokens";
import { closeEntity, storedIdFor } from "./close-commands";
import { ensureUser } from "./ensure-user";
import { saveEntity } from "./entity-commands";
import { runChangeset } from "./changeset-commands";
import { saveAction, saveProject } from "./project-commands";

/**
 * The write ledger marks a create (`evidence.created`), and an agent's close that takes its own create back
 * (`undoOfCommandId`) is verified against that mark: same actor, same row, recent, not touched by anyone else since,
 * at the version it was left at. Such a close needs no reason, is not counted by the brake and is stamped
 * `agent:<name>:undo` (archive-removals design section 3, plan WP2 and WP4).
 */
config({ path: resolve(process.cwd(), "../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(process.env.CLOSE_UNDO_TEST_DATABASE_NAME, "openrhen_close_undo");

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("CLOSE_UNDO_TEST_DATABASE_NAME must be an identifier ending in _test");
}
const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let userId: string;

const asAgent = <T>(run: () => Promise<T>, agent = "claude") =>
  runWithActor(agent, run, undefined, undefined, ["write:entity:*"]);
const asOwner = <T>(run: () => Promise<T>) => runWithActor(null, run);
const uuid = () => crypto.randomUUID();

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
  sql = postgres(testUrl.toString(), { max: 8, connect_timeout: 10, prepare: true });
  // The default stored-facts reader and proposal filer open the portal database from this.
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

// ---- creating each closable type through its real save handler ----

type Type = CloseEntityCommand["type"];
interface Made {
  type: Type;
  /** The id as sent, which the close tool takes. */
  id: string;
  commandId: string;
  version: number;
}

const entityCommand = (
  entityType: string,
  entity: Record<string, unknown>,
  commandId = uuid(),
  expectedVersion: number | null = null
) => ({ commandId, expectedVersion, type: "save_entity", entityType, entity }) as PlanningEntityCommand;

async function makeArea(run: typeof asAgent, name = `Area ${uuid()}`): Promise<Made> {
  const id = uuid();
  const command = entityCommand("area", { id, name, status: "active", sortOrder: 1 });
  await run(() => saveEntity(sql, command));
  return { type: "area", id, commandId: command.commandId!, version: 1 };
}
async function makeOutcome(run: typeof asAgent, areaId: string, status = "active"): Promise<Made> {
  const id = uuid();
  const command = entityCommand("outcome", {
    id,
    areaId,
    title: "Outcome",
    definitionOfDone: "Done",
    value: 3,
    status
  });
  await run(() => saveEntity(sql, command));
  return { type: "outcome", id, commandId: command.commandId!, version: 1 };
}
async function makeProject(run: typeof asAgent, outcomeId: string): Promise<Made> {
  const id = `project-${uuid()}`;
  const commandId = uuid();
  await run(() =>
    saveProject(sql, {
      commandId,
      expectedVersion: null,
      project: { id, outcomeId, title: "Project", status: "active", uncertainty: "some", consequence: 3 }
    } as never)
  );
  return { type: "project", id, commandId, version: 1 };
}
async function makeAction(run: typeof asAgent, projectId: string, status = "planned"): Promise<Made> {
  const id = `action-${uuid()}`;
  const commandId = uuid();
  await run(() =>
    saveAction(sql, {
      commandId,
      expectedVersion: null,
      action: {
        id,
        projectId,
        title: "Draft citations",
        status,
        optimisticMinutes: 30,
        expectedMinutes: 60,
        pessimisticMinutes: 90,
        remainingMinutes: 60,
        energy: "medium",
        minimumSessionMinutes: 15,
        maximumSessionMinutes: 90,
        splittable: true,
        setupMinutes: 0,
        importance: 3,
        consequence: 3,
        contexts: [],
        dependencyIds: []
      }
    } as never)
  );
  return { type: "action", id, commandId, version: 1 };
}
async function makeCommitment(run: typeof asAgent): Promise<Made> {
  const id = uuid();
  const command = entityCommand("commitment", {
    id,
    title: "Dentist",
    startsAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
    endsAt: new Date(Date.now() + 3 * 86_400_000 + 3_600_000).toISOString(),
    status: "confirmed",
    setupBeforeMinutes: 0,
    transitionAfterMinutes: 0
  });
  await run(() => saveEntity(sql, command));
  return { type: "commitment", id, commandId: command.commandId!, version: 1 };
}
async function makePreset(run: typeof asAgent): Promise<Made> {
  const id = uuid();
  const command = entityCommand("routine_preset", {
    id,
    name: "Morning " + id.slice(0, 4),
    activityName: "Morning",
    status: "active",
    steps: [
      {
        id: uuid(),
        title: "Wake",
        durationMinutes: 5,
        sequence: 0,
        timingRule: "contiguous",
        energy: "low",
        contexts: ["home"],
        dependencyIds: []
      }
    ]
  });
  await run(() => saveEntity(sql, command));
  return { type: "routine_preset", id, commandId: command.commandId!, version: 1 };
}
async function makeCondition(run: typeof asAgent, id = `Gym-${uuid().slice(0, 8)}`): Promise<Made> {
  const command = entityCommand("condition_definition", { id, name: `Gym ${id}`, kind: "capability" });
  await run(() => saveEntity(sql, command));
  return { type: "condition_definition", id, commandId: command.commandId!, version: 1 };
}

const TYPES: Type[] = ["area", "outcome", "project", "action", "commitment", "routine_preset", "condition_definition"];
async function make(type: Type, run: typeof asAgent): Promise<Made> {
  switch (type) {
    case "area":
      return makeArea(run);
    case "outcome":
      return makeOutcome(run, (await makeArea(run)).id);
    case "project":
      return makeProject(run, (await makeOutcome(run, (await makeArea(run)).id)).id);
    case "action":
      return makeAction(run, (await makeProject(run, (await makeOutcome(run, (await makeArea(run)).id)).id)).id);
    case "commitment":
      return makeCommitment(run);
    case "routine_preset":
      return makePreset(run);
    case "condition_definition":
      return makeCondition(run);
    default:
      throw new Error(`no maker for ${type}`);
  }
}

const TABLE: Record<string, string> = {
  area: "areas",
  outcome: "outcomes",
  project: "projects",
  action: "actions",
  commitment: "commitments",
  routine_preset: "routine_presets",
  condition_definition: "condition_definitions"
};
const stored = async (type: Type, id: string) =>
  (
    await sql.unsafe<{ status: string; version: number; closed_by: string | null; closed_reason: string | null }[]>(
      `SELECT status::text AS status, version, closed_by, closed_reason FROM ${TABLE[type]} WHERE id = $1`,
      [await storedIdFor(type, userId, id)]
    )
  )[0]!;

const undoCommand = (made: Made, extra: Partial<CloseEntityCommand> = {}) =>
  ({
    commandId: uuid(),
    type: made.type,
    id: made.id,
    verb: UNDO_VERB[made.type]!,
    do: "close",
    expectedVersion: made.version,
    undoOfCommandId: made.commandId,
    ...extra
  }) as CloseEntityCommand;

describe("the ledger marks a create", () => {
  for (const type of TYPES) {
    it(`marks a ${type} create and not its update`, async () => {
      const made = await make(type, asAgent);
      const rows = await sql<
        { entity_id: string; evidence: Record<string, unknown> }[]
      >`SELECT entity_id, evidence FROM write_rows WHERE write_id=${made.commandId} AND entity_type=${type}`;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.evidence.created).toBe(true);
      // the id the close tool resolves, so the undo finds the row (a condition id is lower-cased and trimmed)
      expect(rows[0]!.entity_id).toBe(await storedIdFor(type, userId, made.id));
    });
  }

  it("does not mark an update", async () => {
    const area = await makeArea(asAgent);
    const update = entityCommand("area", { id: area.id, name: "Renamed", status: "active", sortOrder: 1 }, uuid(), 1);
    await asAgent(() => saveEntity(sql, update));
    const rows = await sql<
      { evidence: Record<string, unknown> }[]
    >`SELECT evidence FROM write_rows WHERE write_id=${update.commandId!}`;
    expect(rows[0]!.evidence.created).toBeUndefined();
  });
});

describe("an agent takes back its own create", () => {
  it("closes it with no reason, stamps :undo, labels it and leaves it out of the count", async () => {
    for (const type of TYPES) {
      const made = await make(type, asAgent);
      const { closed } = await asAgent(() => closeEntity(sql, undoCommand(made)));
      expect(closed.status, type).toBe(UNDO_VERB[type] === "archive" ? "archived" : "cancelled");
      const row = await stored(type, made.id);
      expect(row.closed_by, type).toBe("agent:claude:undo");
      expect(row.closed_reason, type).toBe("undo of create");
    }
  });

  it("is refused for a create the owner confirmed", async () => {
    const id = uuid();
    const command = entityCommand("area", { id, name: `Confirmed ${uuid()}`, status: "active", sortOrder: 1 });
    await runWithActor("claude", () => saveEntity(sql, command), "owner");
    const made: Made = { type: "area", id, commandId: command.commandId!, version: 1 };
    await expect(asAgent(() => closeEntity(sql, undoCommand(made)))).rejects.toThrow(/reason/i);
  });

  it("is refused for another agent, the owner, an update, a close, and falls back to the ordinary rules", async () => {
    const made = await makeArea(asAgent);
    const ordinary = async (command: CloseEntityCommand, run = asAgent) => run(() => closeEntity(sql, command));
    // another agent's create: needs a reason
    await expect(ordinary(undoCommand(made), (fn) => asAgent(fn, "other"))).rejects.toThrow(/reason/i);
    // the owner's create undone by an agent
    const owned = await asOwner(() => makeArea(asOwner, "Owned"));
    await expect(ordinary(undoCommand(owned))).rejects.toThrow(/reason/i);
    // a command id that was an update, not a create
    const update = entityCommand(
      "area",
      { id: made.id, name: `Renamed ${uuid()}`, status: "active", sortOrder: 1 },
      uuid(),
      1
    );
    await asAgent(() => saveEntity(sql, update));
    await expect(
      ordinary(undoCommand(made, { undoOfCommandId: update.commandId!, expectedVersion: 2 }))
    ).rejects.toThrow(/reason/i);
    // a made-up command id
    await expect(ordinary(undoCommand(made, { undoOfCommandId: uuid(), expectedVersion: 2 }))).rejects.toThrow(
      /reason/i
    );
  });

  it("is refused after the owner edited the row, after version drift, past the day, and without a version", async () => {
    const owner = await makeArea(asAgent);
    await asOwner(() =>
      saveEntity(
        sql,
        entityCommand("area", { id: owner.id, name: `Mine ${uuid()}`, status: "active", sortOrder: 1 }, uuid(), 1)
      )
    );
    await expect(asAgent(() => closeEntity(sql, undoCommand(owner, { expectedVersion: 2 })))).rejects.toThrow(
      /reason/i
    );

    const drift = await makeArea(asAgent);
    await expect(asAgent(() => closeEntity(sql, undoCommand(drift, { expectedVersion: 5 })))).rejects.toThrow(
      /version|changed/i
    );

    const old = await makeArea(asAgent);
    await sql`UPDATE write_rows SET created_at = now() - interval '25 hours' WHERE write_id = ${old.commandId}`;
    await expect(asAgent(() => closeEntity(sql, undoCommand(old)))).rejects.toThrow(/reason/i);

    const bare = await makeArea(asAgent);
    await expect(asAgent(() => closeEntity(sql, undoCommand(bare, { expectedVersion: null })))).rejects.toThrow(
      /reason/i
    );
    // none of these closed anything
    for (const made of [owner, drift, old, bare]) expect((await stored("area", made.id)).status).toBe("active");
  });

  it("allows the agent's own later edits, and a retry with the same command id answers once", async () => {
    const made = await makeArea(asAgent);
    await asAgent(() =>
      saveEntity(
        sql,
        entityCommand("area", { id: made.id, name: `Again ${uuid()}`, status: "active", sortOrder: 1 }, uuid(), 1)
      )
    );
    const command = undoCommand(made, { expectedVersion: 2 });
    const first = await asAgent(() => closeEntity(sql, command));
    const second = await asAgent(() => closeEntity(sql, command));
    expect(second.closed.batch).toBe(first.closed.batch);
    expect(first.closed.version).toBe(3);
  });

  it("reopens through a restore of either verb, directly", async () => {
    const made = await makeOutcome(asAgent, (await makeArea(asAgent)).id, "done");
    // born done: archive-only, whatever verb the journal named
    const { closed } = await asAgent(() => closeEntity(sql, undoCommand(made, { verb: "cancel" })));
    expect(closed.status).toBe("archived");
    const back = await asAgent(() =>
      closeEntity(sql, {
        type: "outcome",
        id: made.id,
        verb: "cancel",
        do: "restore",
        expectedVersion: closed.version
      } as CloseEntityCommand)
    );
    expect(back.closed.status).toBe("done");
  });

  it("takes back a condition created with a capitalised id", async () => {
    const made = await makeCondition(asAgent, "Gym");
    const { closed } = await asAgent(() => closeEntity(sql, undoCommand(made)));
    expect(closed.status).toBe("archived");
  });
});

describe("25 creates then 25 undos through the route's enforcement", () => {
  const principal: AgentPrincipal = {
    name: "claude",
    source: "db",
    tokenId: "t1",
    scopes: ["area", "outcome", "project", "action", "commitment", "routine_preset", "condition_definition"].map(
      (type) => `write:entity:${type}`
    ),
    directWrites: {
      area: "on",
      outcome: "on",
      project: "on",
      action: "on",
      commitment: "on",
      routine_preset: "on",
      condition_definition: "on"
    }
  };
  async function send(body: Record<string, unknown>) {
    const request = new Request("http://portal.test/api/commands/close", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    const guard = await enforceAgentRequest(request, "/api/commands/close", principal, {
      basis: "stated",
      evidence: "asked"
    });
    if (guard !== null) return { status: guard.status, closed: undefined };
    const { closed } = await asAgent(() => closeEntity(sql, body as CloseEntityCommand));
    return { status: 200, closed };
  }

  it("applies every undo directly, with the hour already spent, and still holds an ordinary close", async () => {
    const writeId = uuid();
    await sql`INSERT INTO writes (id,user_id,command_type,actor) VALUES (${writeId},${userId},'close_entity','claude')`;
    await sql`INSERT INTO write_rows (write_id,user_id,entity_type,entity_id,operation,evidence) VALUES (${writeId},${userId},'action','seed','close',${sql.json({ closed: 20, counted: true } as never)})`;
    const made: Made[] = [];
    for (let i = 0; i < 25; i++) made.push(await make(TYPES[i % TYPES.length]!, asAgent));
    for (const m of made.reverse()) {
      const result = await send(undoCommand(m) as never);
      expect(result.status, `${m.type} ${m.id}`).toBe(200);
      expect((await stored(m.type, m.id)).closed_by).toBe("agent:claude:undo");
    }
    expect(await sql`SELECT 1 FROM agent_proposals`).toHaveLength(0);
    // the same close without the undo proof is held for the owner
    const extra = await makeArea(asAgent);
    const held = await send({ type: "area", id: extra.id, verb: "archive", do: "close", reason: "tidy" });
    expect(held.status).toBe(202);
  });

  it("restores an undo through the route directly (the redo)", async () => {
    const m = await makeArea(asAgent);
    const done = await send(undoCommand(m) as never);
    const back = await send({
      type: "area",
      id: m.id,
      verb: "cancel",
      do: "restore",
      expectedVersion: done.closed!.version
    });
    expect(back.status).toBe(200);
    expect((await stored("area", m.id)).status).toBe("active");
  });
});

describe("the save floor: an agent's save may not close a row", () => {
  const saveCmd = (m: Made, status: string, version: number, extra: Record<string, unknown> = {}) => {
    switch (m.type) {
      case "area":
        return entityCommand(
          "area",
          { id: m.id, name: `Floor ${uuid()}`, status, sortOrder: 1, ...extra },
          uuid(),
          version
        );
      case "outcome":
        return entityCommand(
          "outcome",
          { id: m.id, title: "Outcome", definitionOfDone: "Done", value: 3, status, ...extra },
          uuid(),
          version
        );
      default:
        throw new Error("not used");
    }
  };

  it("refuses open to closed for an area and names the close call with the real id and version", async () => {
    const area = await makeArea(asAgent);
    const err = await asAgent(() => saveEntity(sql, saveCmd(area, "archived", 1))).catch((e) => e);
    expect(err.message).toMatch(/refused/);
    expect(err.nextCall).toMatchObject({
      tool: "rhen_archive",
      arguments: { type: "area", id: area.id, do: "close", "expected-version": 1 }
    });
    expect((await stored("area", area.id)).status).toBe("active");
  });

  it("refuses a project and an action the same way, and a create born closed", async () => {
    const outcome = await makeOutcome(asAgent, (await makeArea(asAgent)).id);
    const project = await makeProject(asAgent, outcome.id);
    const err = await asAgent(() =>
      saveProject(sql, {
        commandId: uuid(),
        expectedVersion: 1,
        project: {
          id: project.id,
          outcomeId: outcome.id,
          title: "Project",
          status: "cancelled",
          uncertainty: "some",
          consequence: 3
        }
      } as never)
    ).catch((e) => e);
    expect(err.nextCall).toMatchObject({
      tool: "rhen_cancel",
      arguments: { type: "project", id: project.id, "expected-version": 1 }
    });
    const action = await makeAction(asAgent, project.id);
    const born = await asAgent(() =>
      saveAction(sql, {
        commandId: uuid(),
        expectedVersion: null,
        action: {
          id: "born-closed",
          projectId: project.id,
          title: "x",
          status: "cancelled",
          optimisticMinutes: 1,
          expectedMinutes: 1,
          pessimisticMinutes: 1,
          remainingMinutes: 1,
          energy: "low",
          minimumSessionMinutes: 5,
          maximumSessionMinutes: 5,
          splittable: true,
          setupMinutes: 0,
          importance: 3,
          consequence: 3,
          contexts: [],
          dependencyIds: []
        }
      } as never)
    ).catch((e) => e);
    expect(born.message).toMatch(/cannot be created already cancelled/);
    expect((await stored("action", action.id)).status).toBe("planned");
  });

  it("allows editing a closed row that keeps its status, refuses moving it between closed statuses", async () => {
    const areaId = (await makeArea(asAgent)).id;
    const outcome = await makeOutcome(asAgent, areaId);
    const { closed } = await asAgent(() =>
      closeEntity(sql, {
        type: "outcome",
        id: outcome.id,
        verb: "cancel",
        do: "close",
        reason: "x"
      } as CloseEntityCommand)
    );
    const retitled = entityCommand(
      "outcome",
      { id: outcome.id, areaId, title: "New title", definitionOfDone: "Done", value: 3, status: "cancelled" },
      uuid(),
      closed.version
    );
    await asAgent(() => saveEntity(sql, retitled));
    expect((await stored("outcome", outcome.id)).status).toBe("cancelled");
    const err = await asAgent(() =>
      saveEntity(
        sql,
        entityCommand(
          "outcome",
          { id: outcome.id, areaId, title: "New title", definitionOfDone: "Done", value: 3, status: "archived" },
          uuid(),
          closed.version + 1
        )
      )
    ).catch((e) => e);
    expect(err.nextCall).toMatchObject({ tool: "rhen_cancel", arguments: { do: "restore" } });
  });

  it("does not hold the owner or an owner-confirmed replay, and ignores closed columns in the body", async () => {
    const owner = await makeArea(asAgent);
    await asOwner(() => saveEntity(sql, saveCmd(owner, "archived", 1)));
    expect((await stored("area", owner.id)).status).toBe("archived");
    const confirmed = await makeArea(asAgent);
    await runWithActor("claude", () => saveEntity(sql, saveCmd(confirmed, "archived", 1)), "owner");
    expect((await stored("area", confirmed.id)).status).toBe("archived");
    const sneaky = await makeArea(asAgent);
    await asAgent(() =>
      saveEntity(sql, saveCmd(sneaky, "active", 1, { closedBy: "person", closed_by: "person", closedAt: "2020-01-01" }))
    );
    expect((await stored("area", sneaky.id)).closed_by).toBeNull();
  });

  it("refuses a closed status inside a changeset, whole, and through no other door", async () => {
    const outcome = await makeOutcome(asAgent, (await makeArea(asAgent)).id);
    const project = await makeProject(asAgent, outcome.id);
    const action = await makeAction(asAgent, project.id);
    const command = {
      commandId: uuid(),
      mode: "apply" as const,
      items: [
        {
          intent: 0,
          path: "/api/commands/action" as const,
          payload: {
            commandId: uuid(),
            expectedVersion: 1,
            action: {
              id: action.id,
              projectId: project.id,
              title: "Draft citations",
              status: "cancelled",
              optimisticMinutes: 30,
              expectedMinutes: 60,
              pessimisticMinutes: 90,
              remainingMinutes: 60,
              energy: "medium",
              minimumSessionMinutes: 15,
              maximumSessionMinutes: 90,
              splittable: true,
              setupMinutes: 0,
              importance: 3,
              consequence: 3,
              contexts: [],
              dependencyIds: []
            }
          }
        }
      ]
    };
    const result = await runWithActor(
      "claude",
      () => runChangeset(sql, command as never),
      undefined,
      undefined,
      ["write:entity:action"],
      { action: "on" }
    );
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toMatch(/rhen_cancel/);
    expect((await stored("action", action.id)).status).toBe("planned");
  });

  it("applies none of 25 saves that set status cancelled", async () => {
    const outcome = await makeOutcome(asAgent, (await makeArea(asAgent)).id);
    const project = await makeProject(asAgent, outcome.id);
    let refusedCount = 0;
    for (let i = 0; i < 25; i++) {
      const action = await makeAction(asAgent, project.id);
      await asAgent(() =>
        saveAction(sql, {
          commandId: uuid(),
          expectedVersion: 1,
          action: {
            id: action.id,
            projectId: project.id,
            title: "Draft citations",
            status: "cancelled",
            optimisticMinutes: 30,
            expectedMinutes: 60,
            pessimisticMinutes: 90,
            remainingMinutes: 60,
            energy: "medium",
            minimumSessionMinutes: 15,
            maximumSessionMinutes: 90,
            splittable: true,
            setupMinutes: 0,
            importance: 3,
            consequence: 3,
            contexts: [],
            dependencyIds: []
          }
        } as never)
      ).catch(() => (refusedCount += 1));
    }
    expect(refusedCount).toBe(25);
    expect(await sql`SELECT 1 FROM actions WHERE status='cancelled'`).toHaveLength(0);
  });
});

describe("the save floor: an agent's save may not reopen a closed row", () => {
  const actionBody = (id: string, projectId: string, status: string) => ({
    id,
    projectId,
    title: "Draft citations",
    status,
    optimisticMinutes: 30,
    expectedMinutes: 60,
    pessimisticMinutes: 90,
    remainingMinutes: 60,
    energy: "medium",
    minimumSessionMinutes: 15,
    maximumSessionMinutes: 90,
    splittable: true,
    setupMinutes: 0,
    importance: 3,
    consequence: 3,
    contexts: [],
    dependencyIds: []
  });
  const closeAction = async (run: typeof asAgent, id: string) =>
    (
      await run(() =>
        closeEntity(sql, { type: "action", id, verb: "cancel", do: "close", reason: "x" } as CloseEntityCommand)
      )
    ).closed;
  const setup = async () => {
    const outcome = await makeOutcome(asAgent, (await makeArea(asAgent)).id);
    const project = await makeProject(asAgent, outcome.id);
    return { outcome, project };
  };

  it("refuses a save of a cancelled action to planned and names the exact restore call", async () => {
    const { project } = await setup();
    const action = await makeAction(asAgent, project.id);
    const closed = await closeAction(asAgent, action.id);
    const err = await asAgent(() =>
      saveAction(sql, {
        commandId: uuid(),
        expectedVersion: closed.version,
        action: actionBody(action.id, project.id, "planned")
      } as never)
    ).catch((e) => e);
    expect(err.message).toMatch(/refused/);
    expect(err.nextCall).toMatchObject({
      tool: "rhen_cancel",
      arguments: { type: "action", id: action.id, do: "restore", "expected-version": closed.version }
    });
    expect((await stored("action", action.id)).status).toBe("cancelled");
  });

  it("refuses reopening a person-closed row by save, for an area and an outcome", async () => {
    const area = await makeArea(asAgent);
    await asOwner(() =>
      closeEntity(sql, {
        type: "area",
        id: area.id,
        verb: "archive",
        do: "close",
        reason: "mine"
      } as CloseEntityCommand)
    );
    const areaRow = await stored("area", area.id);
    const err = await asAgent(() =>
      saveEntity(
        sql,
        entityCommand(
          "area",
          { id: area.id, name: `Reopen ${uuid()}`, status: "active", sortOrder: 1 },
          uuid(),
          areaRow.version
        )
      )
    ).catch((e) => e);
    expect(err.nextCall).toMatchObject({
      tool: "rhen_archive",
      arguments: { type: "area", id: area.id, do: "restore", "expected-version": areaRow.version }
    });
    expect((await stored("area", area.id)).status).toBe("archived");
    const areaId = (await makeArea(asAgent)).id;
    const outcome = await makeOutcome(asAgent, areaId);
    const closed = (
      await asOwner(() =>
        closeEntity(sql, {
          type: "outcome",
          id: outcome.id,
          verb: "cancel",
          do: "close",
          reason: "mine"
        } as CloseEntityCommand)
      )
    ).closed;
    const err2 = await asAgent(() =>
      saveEntity(
        sql,
        entityCommand(
          "outcome",
          { id: outcome.id, areaId, title: "Outcome", definitionOfDone: "Done", value: 3, status: "active" },
          uuid(),
          closed.version
        )
      )
    ).catch((e) => e);
    expect(err2.nextCall).toMatchObject({ tool: "rhen_cancel", arguments: { do: "restore" } });
    expect((await stored("outcome", outcome.id)).status).toBe("cancelled");
  });

  it("refuses the same reopen inside a changeset and leaves the row closed", async () => {
    const { project } = await setup();
    const action = await makeAction(asAgent, project.id);
    const closed = await closeAction(asAgent, action.id);
    const result = await runWithActor(
      "claude",
      () =>
        runChangeset(sql, {
          commandId: uuid(),
          mode: "apply",
          items: [
            {
              intent: 0,
              path: "/api/commands/action",
              payload: {
                commandId: uuid(),
                expectedVersion: closed.version,
                action: actionBody(action.id, project.id, "planned")
              }
            }
          ]
        } as never),
      undefined,
      undefined,
      ["write:entity:action"],
      { action: "on" }
    );
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toMatch(/rhen_cancel/);
    expect(JSON.stringify(result)).toMatch(/restore/);
    expect((await stored("action", action.id)).status).toBe("cancelled");
  });

  it("applies none of 25 reopen saves, and still lets the owner and a confirmed replay reopen", async () => {
    const { project } = await setup();
    let refusedCount = 0;
    const ids: { id: string; version: number }[] = [];
    for (let i = 0; i < 25; i++) {
      const action = await makeAction(asAgent, project.id);
      ids.push({ id: action.id, version: (await closeAction(asOwner, action.id)).version });
    }
    for (const { id, version } of ids)
      await asAgent(() =>
        saveAction(sql, {
          commandId: uuid(),
          expectedVersion: version,
          action: actionBody(id, project.id, "planned")
        } as never)
      ).catch(() => (refusedCount += 1));
    expect(refusedCount).toBe(25);
    expect(await sql`SELECT 1 FROM actions WHERE status='cancelled'`).toHaveLength(25);
    const first = ids[0]!;
    await asOwner(() =>
      saveAction(sql, {
        commandId: uuid(),
        expectedVersion: first.version,
        action: actionBody(first.id, project.id, "planned")
      } as never)
    );
    expect((await stored("action", first.id)).status).toBe("planned");
    const second = ids[1]!;
    await runWithActor(
      "claude",
      () =>
        saveAction(sql, {
          commandId: uuid(),
          expectedVersion: second.version,
          action: actionBody(second.id, project.id, "planned")
        } as never),
      "owner"
    );
    expect((await stored("action", second.id)).status).toBe("planned");
  });
});

describe("the save floor reads the status the handler will write", () => {
  const closeAs = (run: typeof asAgent, type: Type, id: string, verb: "archive" | "cancel") =>
    run(() => closeEntity(sql, { type, id, verb, do: "close", reason: "x" } as CloseEntityCommand));
  const refusal = async (promise: Promise<unknown>) =>
    (await promise.then(() => undefined).catch((e) => e)) as Error & { nextCall?: unknown };

  it("refuses a padded closed status, with the row left as it was", async () => {
    const area = await makeArea(asAgent);
    const err = await refusal(
      asAgent(() =>
        saveEntity(
          sql,
          entityCommand("area", { id: area.id, name: `Pad ${uuid()}`, status: " archived", sortOrder: 1 }, uuid(), 1)
        )
      )
    );
    expect(err.nextCall).toMatchObject({ tool: "rhen_archive", arguments: { do: "close" } });
    expect((await stored("area", area.id)).status).toBe("active");
    const areaId = (await makeArea(asAgent)).id;
    const outcome = await makeOutcome(asAgent, areaId);
    const err2 = await refusal(
      asAgent(() =>
        saveEntity(
          sql,
          entityCommand(
            "outcome",
            { id: outcome.id, areaId, title: "O", definitionOfDone: "D", value: 3, status: "cancelled " },
            uuid(),
            1
          )
        )
      )
    );
    expect(err2.nextCall).toMatchObject({ tool: "rhen_cancel", arguments: { do: "close" } });
    expect((await stored("outcome", outcome.id)).status).toBe("active");
  });

  it("refuses a save that leaves the status out when the row is closed and the default would reopen it", async () => {
    const condition = await makeCondition(asAgent);
    await closeAs(asOwner, "condition_definition", condition.id, "archive");
    const stale = await stored("condition_definition", condition.id);
    const err = await refusal(
      asAgent(() =>
        saveEntity(
          sql,
          entityCommand(
            "condition_definition",
            { id: condition.id, name: `Gym ${condition.id}`, kind: "capability" },
            uuid(),
            stale.version
          )
        )
      )
    );
    expect(err.nextCall).toMatchObject({
      tool: "rhen_archive",
      arguments: { do: "restore", "expected-version": stale.version }
    });
    expect((await stored("condition_definition", condition.id)).status).toBe("archived");

    const preset = await makePreset(asAgent);
    await closeAs(asOwner, "routine_preset", preset.id, "archive");
    const presetRow = await stored("routine_preset", preset.id);
    const err2 = await refusal(
      asAgent(() =>
        saveEntity(
          sql,
          entityCommand(
            "routine_preset",
            { id: preset.id, name: "Morning x", activityName: "Morning", steps: [] },
            uuid(),
            presetRow.version
          )
        )
      )
    );
    expect(err2.nextCall).toMatchObject({ tool: "rhen_archive", arguments: { do: "restore" } });
    expect((await stored("routine_preset", preset.id)).status).toBe("archived");
  });

  const deliverableBody = (
    projectId: string,
    id: string,
    stepStatus: string | undefined,
    extra: Record<string, unknown> = {}
  ) => ({
    id,
    projectId,
    title: "Report",
    status: "ready",
    uncertainty: "some",
    importance: 3,
    consequence: 3,
    steps: [
      {
        id: "a",
        title: "Draft",
        ...(stepStatus === undefined ? {} : { status: stepStatus }),
        optimisticMinutes: 10,
        expectedMinutes: 20,
        pessimisticMinutes: 30,
        remainingMinutes: 20,
        energy: "low",
        minimumSessionMinutes: 10,
        maximumSessionMinutes: 30
      }
    ],
    criteria: [],
    blockers: [],
    ...extra
  });
  const stepStatus = async (deliverableId: string) =>
    (
      await sql<{ status: string }[]>`SELECT status::text AS status FROM actions WHERE deliverable_id=${deliverableId}`
    )[0]?.status;

  it("refuses a deliverable save that cancels, or reopens, a step", async () => {
    const { project } = await (async () => {
      const outcome = await makeOutcome(asAgent, (await makeArea(asAgent)).id);
      return { project: await makeProject(asAgent, outcome.id) };
    })();
    const id = uuid();
    await asOwner(() => saveEntity(sql, entityCommand("deliverable", deliverableBody(project.id, id, "planned"))));
    expect(await stepStatus(id)).toBe("planned");
    let v = (await sql<{ version: number }[]>`SELECT version FROM deliverables WHERE id=${id}`)[0]!.version;
    const err = await refusal(
      asAgent(() =>
        saveEntity(sql, entityCommand("deliverable", deliverableBody(project.id, id, "cancelled"), uuid(), v))
      )
    );
    expect(err.nextCall).toMatchObject({ tool: "rhen_cancel", arguments: { type: "action", do: "close" } });
    expect(await stepStatus(id)).toBe("planned");
    // a padded one
    const padded = await refusal(
      asAgent(() =>
        saveEntity(sql, entityCommand("deliverable", deliverableBody(project.id, id, "cancelled "), uuid(), v))
      )
    );
    expect(padded.message).toMatch(/refused/);
    expect(await stepStatus(id)).toBe("planned");
    // the owner closes the step; the agent's save that leaves the step status out would reopen it
    const stepRow = (
      await sql<{ id: string; version: number }[]>`SELECT id, version FROM actions WHERE deliverable_id=${id}`
    )[0]!;
    await closeAs(asOwner, "action", stepRow.id, "cancel");
    v = (await sql<{ version: number }[]>`SELECT version FROM deliverables WHERE id=${id}`)[0]!.version;
    for (const status of [undefined, "planned"]) {
      const reopen = await refusal(
        asAgent(() => saveEntity(sql, entityCommand("deliverable", deliverableBody(project.id, id, status), uuid(), v)))
      );
      expect(reopen.nextCall, String(status)).toMatchObject({ tool: "rhen_cancel", arguments: { do: "restore" } });
    }
    expect(await stepStatus(id)).toBe("cancelled");
    // a brand-new step born cancelled
    const born = await refusal(
      asAgent(() => saveEntity(sql, entityCommand("deliverable", deliverableBody(project.id, uuid(), "cancelled"))))
    );
    expect(born.message).toMatch(/cannot be created already cancelled/);
  });

  it("does not hold the owner when a deliverable save cancels a step", async () => {
    const outcome = await makeOutcome(asAgent, (await makeArea(asAgent)).id);
    const project = await makeProject(asAgent, outcome.id);
    const id = uuid();
    await asOwner(() => saveEntity(sql, entityCommand("deliverable", deliverableBody(project.id, id, "planned"))));
    const v = (await sql<{ version: number }[]>`SELECT version FROM deliverables WHERE id=${id}`)[0]!.version;
    await asOwner(() =>
      saveEntity(sql, entityCommand("deliverable", deliverableBody(project.id, id, "cancelled"), uuid(), v))
    );
    expect(await stepStatus(id)).toBe("cancelled");
  });
});

describe("the undo exemption", () => {
  it("never covers a deliverable (its steps would stay planned)", async () => {
    const outcome = await makeOutcome(asAgent, (await makeArea(asAgent)).id);
    const project = await makeProject(asAgent, outcome.id);
    const id = uuid();
    const command = entityCommand("deliverable", {
      id,
      projectId: project.id,
      title: "Report",
      status: "ready",
      uncertainty: "some",
      importance: 3,
      consequence: 3,
      steps: [],
      criteria: [],
      blockers: []
    });
    await asAgent(() => saveEntity(sql, command));
    const version = (await sql<{ version: number }[]>`SELECT version FROM deliverables WHERE id=${id}`)[0]!.version;
    await expect(
      asAgent(() =>
        closeEntity(sql, {
          commandId: uuid(),
          type: "deliverable",
          id,
          verb: "cancel",
          do: "close",
          expectedVersion: version,
          undoOfCommandId: command.commandId
        } as CloseEntityCommand)
      )
    ).rejects.toThrow(/reason/i);
  });

  it("is lost when the row changed through a path that leaves no ledger row of its own type", async () => {
    const area = await makeArea(asAgent);
    // the owner's edit through an activity, a session or a planner path bumps the version and writes no `area` row
    await sql`UPDATE areas SET version = version + 1 WHERE id = ${area.id}`;
    await expect(asAgent(() => closeEntity(sql, undoCommand(area, { expectedVersion: 2 })))).rejects.toThrow(/reason/i);
    // and a clean create still undoes
    const clean = await makeArea(asAgent);
    await asAgent(() => closeEntity(sql, undoCommand(clean)));
    expect((await stored("area", clean.id)).closed_by).toBe("agent:claude:undo");
  });

  it("records the version a create left in its ledger row", async () => {
    const area = await makeArea(asAgent);
    const [row] = await sql<
      { evidence: Record<string, unknown> }[]
    >`SELECT evidence FROM write_rows WHERE write_id=${area.commandId}`;
    expect(row!.evidence.createdVersion).toBe(1);
  });
});
