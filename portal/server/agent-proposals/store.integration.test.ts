import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { fileURLToPath } from "node:url";
import { integrationDatabaseName } from "@openrhen/database";
import type { ProposeAgentChange } from "@openrhen/contracts";
import { runWithActor } from "@/server/agent-actor";
import { ensureUser } from "@/server/persistence/postgres/ensure-user";
import { saveProject } from "@/server/persistence/postgres/project-commands";
import { AgentProposalError } from "./errors";
import { proposalApplier, registerProposalApplier } from "./appliers";
import { listAgentProposals, proposeAgentChange, resolveAgentProposal } from "./store";

/**
 * The agent proposal store: the pending cap, coalescing,
 * idempotency, expiry, owner-only resolution, the stale check and an attributed confirm. Self-contained
 * `_test` database, the same pattern as `agent-audit.integration.test.ts`.
 */
config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(
  process.env.AGENT_PROPOSALS_TEST_DATABASE_NAME,
  "openrhen_agent_proposals"
);

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("AGENT_PROPOSALS_TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let userId: string;
let outcomeId: string;

const project = (id: string, title: string) => ({
  id,
  outcomeId,
  title,
  status: "active" as const,
  uncertainty: "some" as const,
  consequence: 3
});

/** A proposal to save a project, written against `expectedVersion`. */
const proposal = (id: string, title: string, expectedVersion: number | null, extra: Partial<ProposeAgentChange> = {}) =>
  ({
    kind: "entity_command",
    summary: `Rename to ${title}`,
    payload: { command: "save_project", body: { expectedVersion, project: project(id, title) } },
    basis: "inferred",
    ...extra
  }) as ProposeAgentChange;

/** The owner's decision on the revision the card would show now (the stored one), unless a test names another. */
const owner = async (id: string, decision: "confirm" | "reject" = "confirm", revision?: number) =>
  resolveAgentProposal(sql, null, id, {
    decision,
    revision:
      revision ??
      (await sql<{ revision: number }[]>`SELECT revision FROM agent_proposals WHERE id=${id}`)[0]?.revision ??
      1
  });

const refusal = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AgentProposalError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
};

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
      migrationsFolder: fileURLToPath(new URL("../../../platform/database/drizzle", import.meta.url))
    });
  } finally {
    await migrationSql.end();
  }
  sql = postgres(testUrl.toString(), { max: 5, connect_timeout: 10, fetch_types: false, prepare: true });
  userId = await ensureUser(sql);
}, 30_000);

beforeEach(async () => {
  await sql.unsafe(
    "TRUNCATE TABLE agent_proposals, writes, write_rows, projects, outcomes, areas RESTART IDENTITY CASCADE"
  );
  const area = await sql<{ id: string }[]>`
    INSERT INTO areas (user_id,name,status,sort_order) VALUES (${userId},'Proposals','active',1) RETURNING id`;
  const outcome = await sql<{ id: string }[]>`
    INSERT INTO outcomes (area_id,title,definition_of_done) VALUES (${area[0]!.id},'Outcome','Done') RETURNING id`;
  outcomeId = outcome[0]!.id;
});

afterAll(async () => {
  await sql?.end();
});

describe("proposeAgentChange", () => {
  it("refuses a kind with no applier at propose time", async () => {
    const error = await refusal(
      proposeAgentChange(sql, "scribe", { ...proposal("p1", "One", null), kind: "nonsense" })
    );
    expect(error.status).toBe(400);
  });

  it("answers 409 when a commandId is already another proposal's id", async () => {
    const commandId = crypto.randomUUID();
    await proposeAgentChange(sql, "scribe", proposal("p1", "One", null, { commandId }));
    const error = await refusal(proposeAgentChange(sql, "other", proposal("p2", "Two", null, { commandId })));
    expect(error.status).toBe(409);
  });

  it("lets the version the payload names win over the agent's own targetVersions", async () => {
    const { proposal: stored } = await proposeAgentChange(
      sql,
      "scribe",
      proposal("p1", "One", null, { targetVersions: { "project:p1": 99 } })
    );
    expect(stored.targetVersions).toEqual({ "project:p1": null });
  });

  it("stores a pending proposal with its hash, basis, evidence and the version it was written against", async () => {
    const { proposal: stored, outcome } = await proposeAgentChange(
      sql,
      "scribe",
      proposal("p1", "One", null, { basis: "stated", evidence: "call it One" })
    );
    expect(outcome).toBe("created");
    expect(stored).toMatchObject({
      agent: "scribe",
      status: "pending",
      basis: "stated",
      evidence: "call it One",
      targetVersions: { "project:p1": null },
      revision: 1
    });
    const [row] = await sql<{ payload_hash: string }[]>`SELECT payload_hash FROM agent_proposals WHERE id=${stored.id}`;
    expect(row!.payload_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses a request with no agent identity", async () => {
    const error = await refusal(proposeAgentChange(sql, null, proposal("p1", "One", null)));
    expect(error.status).toBe(400);
    expect(error.message).toContain("no agent name");
  });

  it("refuses a payload its applier rejects", async () => {
    const error = await refusal(
      proposeAgentChange(sql, "scribe", { ...proposal("p1", "One", null), payload: { command: "nope", body: {} } })
    );
    expect(error.status).toBe(400);
  });

  it("returns the existing row for an identical pending payload and for a retried command id", async () => {
    const first = await proposeAgentChange(sql, "scribe", proposal("p1", "One", null));
    const same = await proposeAgentChange(sql, "scribe", proposal("p1", "One", null));
    expect(same.outcome).toBe("existing");
    expect(same.proposal.id).toBe(first.proposal.id);

    const commandId = crypto.randomUUID();
    const keyed = await proposeAgentChange(sql, "scribe", proposal("p2", "Two", null, { commandId }));
    const retried = await proposeAgentChange(sql, "scribe", proposal("p2", "Two changed", null, { commandId }));
    expect(retried).toMatchObject({ outcome: "existing", proposal: { id: keyed.proposal.id } });
    expect((await listAgentProposals(sql, userId, { agent: "scribe" })).length).toBe(2);
  });

  it("returns the old card unchanged when a corrected save reuses the first call's commandId", async () => {
    const commandId = crypto.randomUUID();
    const first = await proposeAgentChange(
      sql,
      "scribe",
      proposal("p1", "One", null, { commandId, coalesceKey: "rename" })
    );
    const corrected = await proposeAgentChange(
      sql,
      "scribe",
      proposal("p1", "Uno", null, { commandId, coalesceKey: "rename" })
    );
    expect(corrected).toMatchObject({ outcome: "existing", proposal: { id: first.proposal.id, revision: 1 } });
    expect((await listAgentProposals(sql, userId, { agent: "scribe" })).length).toBe(1);
    const fresh = await proposeAgentChange(sql, "scribe", proposal("p1", "Uno", null, { coalesceKey: "rename" }));
    expect(fresh.proposal.revision).toBe(2);
  });

  it("does not treat another agent's identical payload as the same proposal", async () => {
    const mine = await proposeAgentChange(sql, "scribe", proposal("p1", "One", null));
    const theirs = await proposeAgentChange(sql, "other", proposal("p1", "One", null));
    expect(theirs.outcome).toBe("created");
    expect(theirs.proposal.id).not.toBe(mine.proposal.id);
  });

  it("coalesces on the key: latest wins, created_at kept, revision counted", async () => {
    const first = await proposeAgentChange(sql, "scribe", proposal("p1", "One", null, { coalesceKey: "rename" }));
    await sql`UPDATE agent_proposals SET created_at = created_at - interval '2 days' WHERE id=${first.proposal.id}`;
    const before = (await listAgentProposals(sql, userId))[0]!;
    const second = await proposeAgentChange(
      sql,
      "scribe",
      proposal("p1", "Uno", null, { coalesceKey: "rename", summary: "Rename to Uno" })
    );
    expect(second.outcome).toBe("coalesced");
    expect(second.proposal).toMatchObject({ id: first.proposal.id, summary: "Rename to Uno", revision: 2 });
    expect(second.proposal.createdAt).toBe(before.createdAt);
    expect(new Date(second.proposal.updatedAt).getTime()).toBeGreaterThan(new Date(before.createdAt).getTime());
    expect((second.proposal.payload as { body: { project: { title: string } } }).body.project.title).toBe("Uno");
    expect(await listAgentProposals(sql, userId)).toHaveLength(1);
    // Another agent's same key is its own proposal.
    expect(
      (await proposeAgentChange(sql, "other", proposal("p1", "Eins", null, { coalesceKey: "rename" }))).outcome
    ).toBe("created");
  });

  it("starts a new proposal under a key once the earlier one was decided", async () => {
    const first = await proposeAgentChange(sql, "scribe", proposal("p1", "One", null, { coalesceKey: "rename" }));
    await owner(first.proposal.id, "reject");
    const again = await proposeAgentChange(sql, "scribe", proposal("p1", "Uno", null, { coalesceKey: "rename" }));
    expect(again.outcome).toBe("created");
    expect(again.proposal.id).not.toBe(first.proposal.id);
  });

  it("refuses the 51st pending proposal with a 429, and still coalesces or repeats when at the cap", async () => {
    for (let index = 0; index < 49; index += 1)
      await proposeAgentChange(sql, "scribe", proposal(`p${index}`, `T${index}`, null));
    await proposeAgentChange(sql, "scribe", proposal("last", "Last", null, { coalesceKey: "last" }));
    const error = await refusal(proposeAgentChange(sql, "scribe", proposal("over", "Over", null)));
    expect(error.status).toBe(429);
    expect(error.message).toContain("50 proposals");
    expect(await listAgentProposals(sql, userId, { agent: "scribe", limit: 200 })).toHaveLength(50);
    expect(
      (await proposeAgentChange(sql, "scribe", proposal("last", "Last2", null, { coalesceKey: "last" }))).outcome
    ).toBe("coalesced");
    expect((await proposeAgentChange(sql, "scribe", proposal("p0", "T0", null))).outcome).toBe("existing");
    // The cap is per agent.
    expect((await proposeAgentChange(sql, "other", proposal("over", "Over", null))).outcome).toBe("created");
  });

  it("frees capacity as proposals are decided", async () => {
    const ids: string[] = [];
    for (let index = 0; index < 50; index += 1)
      ids.push((await proposeAgentChange(sql, "scribe", proposal(`p${index}`, `T${index}`, null))).proposal.id);
    await owner(ids[0]!, "reject");
    expect((await proposeAgentChange(sql, "scribe", proposal("next", "Next", null))).outcome).toBe("created");
  });
});

describe("listAgentProposals", () => {
  it("filters by status and agent, newest first, and caps the page", async () => {
    const a = await proposeAgentChange(sql, "scribe", proposal("p1", "One", null));
    await proposeAgentChange(sql, "scribe", proposal("p2", "Two", null));
    await proposeAgentChange(sql, "other", proposal("p3", "Three", null));
    await owner(a.proposal.id, "reject");
    expect((await listAgentProposals(sql, userId, { status: "rejected" })).map((row) => row.id)).toEqual([
      a.proposal.id
    ]);
    expect(await listAgentProposals(sql, userId, { agent: "scribe", status: "pending" })).toHaveLength(1);
    expect(await listAgentProposals(sql, userId, { limit: 2 })).toHaveLength(2);
    expect((await listAgentProposals(sql, userId))[0]!.summary).toBe("Rename to Three");
  });

  it("expires a pending proposal older than 14 days when read, and leaves a fresh one", async () => {
    const old = await proposeAgentChange(sql, "scribe", proposal("p1", "One", null));
    const fresh = await proposeAgentChange(sql, "scribe", proposal("p2", "Two", null));
    await sql`UPDATE agent_proposals SET created_at = now() - interval '15 days' WHERE id=${old.proposal.id}`;
    const rows = await listAgentProposals(sql, userId);
    expect(rows.find((row) => row.id === old.proposal.id)).toMatchObject({ status: "expired", resolvedBy: "system" });
    expect(rows.find((row) => row.id === fresh.proposal.id)?.status).toBe("pending");
    expect((await refusal(owner(old.proposal.id))).status).toBe(409);
  });
});

describe("resolveAgentProposal", () => {
  it("is owner-only: any agent identity is refused with 403 and nothing changes", async () => {
    const { proposal: stored } = await proposeAgentChange(sql, "scribe", proposal("p1", "One", null));
    for (const caller of ["scribe", "other"]) {
      const error = await refusal(resolveAgentProposal(sql, caller, stored.id, { decision: "confirm", revision: 1 }));
      expect(error.status).toBe(403);
    }
    expect((await listAgentProposals(sql, userId))[0]!.status).toBe("pending");
    expect(await sql`SELECT 1 FROM projects`).toHaveLength(0);
  });

  it("reject records who, when and why, and applies nothing", async () => {
    const { proposal: stored } = await proposeAgentChange(sql, "scribe", proposal("p1", "One", null));
    const rejected = await resolveAgentProposal(sql, null, stored.id, { decision: "reject", note: "Not this week" });
    expect(rejected).toMatchObject({ status: "rejected", resolvedBy: "owner", resolutionNote: "Not this week" });
    expect(rejected.resolvedAt).not.toBeNull();
    expect(await sql`SELECT 1 FROM projects`).toHaveLength(0);
    expect((await refusal(owner(stored.id))).status).toBe(409);
  });

  it("refuses a confirm of a revision the agent has since replaced, and applies neither", async () => {
    const shown = await proposeAgentChange(sql, "scribe", proposal("p1", "Shown", null, { coalesceKey: "swap" }));
    const swapped = await proposeAgentChange(sql, "scribe", proposal("p1", "Swapped", null, { coalesceKey: "swap" }));
    expect(swapped.outcome).toBe("coalesced");
    const error = await refusal(owner(shown.proposal.id, "confirm", shown.proposal.revision));
    expect(error.status).toBe(409);
    expect(error.extra).toMatchObject({ changed: true, proposal: { revision: 2, status: "pending" } });
    expect(await sql`SELECT 1 FROM projects`).toHaveLength(0);
    expect((await owner(shown.proposal.id, "confirm", 2)).status).toBe("confirmed");
    expect((await sql<{ title: string }[]>`SELECT title FROM projects`)[0]!.title).toBe("Swapped");
  });

  it("writes a revision swapped in while an earlier one applied, instead of replaying the earlier receipt", async () => {
    const first = await proposeAgentChange(sql, "scribe", proposal("p1", "One", null, { coalesceKey: "race" }));
    // A confirm of revision 1 has read the row and is applying it...
    await runWithActor("scribe", () =>
      proposalApplier("entity_command")!.apply(
        { sql, userId },
        { ...first.proposal, targetVersions: first.proposal.targetVersions, revision: 1 }
      )
    );
    // ...when the agent coalesces revision 2 in, which stays pending once revision 1 settles.
    await proposeAgentChange(sql, "scribe", proposal("p1", "Two", 1, { coalesceKey: "race" }));
    expect((await owner(first.proposal.id, "confirm", 2)).status).toBe("confirmed");
    expect((await sql<{ title: string }[]>`SELECT title FROM projects`)[0]!.title).toBe("Two");
  });

  it("confirm replays the command, attributed to the agent with confirmedBy owner", async () => {
    const { proposal: stored } = await proposeAgentChange(sql, "scribe", proposal("p1", "Proposed title", null));
    const confirmed = await owner(stored.id);
    expect(confirmed).toMatchObject({ status: "confirmed", resolvedBy: "owner" });
    const projects = await sql<{ title: string; version: number }[]>`SELECT title, version FROM projects`;
    expect(projects).toEqual([{ title: "Proposed title", version: 1 }]);
    const [log] = await sql<
      { actor: string | null; evidence: Record<string, unknown> }[]
    >`SELECT w.actor, r.evidence FROM write_rows r JOIN writes w ON w.id=r.write_id WHERE r.entity_type='project'`;
    expect(log!.actor).toBe("scribe");
    expect(log!.evidence.confirmedBy).toBe("owner");
  });

  it("confirm of an update applies when the record is still at the proposed version", async () => {
    await runWithActor(null, () =>
      saveProject(sql, { commandId: crypto.randomUUID(), expectedVersion: null, project: project("p1", "Original") })
    );
    const { proposal: stored } = await proposeAgentChange(sql, "scribe", proposal("p1", "Renamed", 1));
    expect((await owner(stored.id)).status).toBe("confirmed");
    expect((await sql<{ title: string; version: number }[]>`SELECT title, version FROM projects`)[0]).toEqual({
      title: "Renamed",
      version: 2
    });
  });

  it("marks the proposal stale and applies nothing when the record changed since", async () => {
    await saveProject(sql, {
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      project: project("p1", "Original")
    });
    const { proposal: stored } = await proposeAgentChange(sql, "scribe", proposal("p1", "Agent title", 1));
    await saveProject(sql, {
      commandId: crypto.randomUUID(),
      expectedVersion: 1,
      project: project("p1", "Edited by hand")
    });

    const error = await refusal(owner(stored.id));
    expect(error.status).toBe(409);
    expect(error.extra).toMatchObject({
      stale: true,
      conflicts: [{ entity: "project:p1", proposedAgainst: 1, current: 2 }]
    });
    expect((await sql<{ title: string }[]>`SELECT title FROM projects`)[0]!.title).toBe("Edited by hand");
    expect((await listAgentProposals(sql, userId))[0]).toMatchObject({ status: "stale", resolvedBy: "owner" });
  });

  it("marks a create stale when the record appeared since", async () => {
    const { proposal: stored } = await proposeAgentChange(sql, "scribe", proposal("p1", "Agent title", null));
    await saveProject(sql, {
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      project: project("p1", "By hand")
    });
    const error = await refusal(owner(stored.id));
    expect(error.extra).toMatchObject({ stale: true });
    expect((await sql<{ title: string }[]>`SELECT title FROM projects`)[0]!.title).toBe("By hand");
  });

  it("answers 422 for an unknown kind and leaves the row pending", async () => {
    // Proposing an unknown kind is refused, so a row of one (an applier gone after a rollback) is inserted directly.
    const id = crypto.randomUUID();
    await sql`
      INSERT INTO agent_proposals (id, user_id, agent, kind, summary, payload, payload_hash, basis)
      VALUES (${id}, ${userId}, 'scribe', 'from_the_future', 'Something this portal cannot apply', ${sql.json({ anything: true })}, 'hash', 'inferred')`;
    const error = await refusal(owner(id));
    expect(error.status).toBe(422);
    expect((await listAgentProposals(sql, userId))[0]!.status).toBe("pending");
    // Once an applier is registered the same row confirms.
    registerProposalApplier("from_the_future", async () => "applied");
    expect((await owner(id)).status).toBe("confirmed");
  });

  it("answers 404 for an unknown id", async () => {
    expect((await refusal(owner(crypto.randomUUID()))).status).toBe(404);
  });
});

describe("shadow proposals and batches", () => {
  it("records that a held-back direct write would have applied", async () => {
    const { proposal: stored } = await proposeAgentChange(sql, "scribe", {
      ...proposal("p1", "One", null),
      shadow: true
    });
    expect(stored.shadow).toBe(true);
    const plain = await proposeAgentChange(sql, "scribe", proposal("p2", "Two", null));
    expect(plain.proposal.shadow).toBeUndefined();
    expect((await listAgentProposals(sql, userId, { agent: "scribe" })).filter((row) => row.shadow)).toHaveLength(1);
  });

  it("holds a bulk write as one proposal and applies every row on one confirm", async () => {
    const rows = ["p1", "p2", "p3"].map((id) => ({
      command: "save_project",
      body: { expectedVersion: null, project: project(id, `Project ${id}`) }
    }));
    const { proposal: stored } = await proposeAgentChange(sql, "scribe", {
      kind: "entity_command_batch",
      summary: "Create 3 projects",
      payload: { commands: rows },
      basis: "inferred"
    });
    expect(stored.targetVersions).toEqual({ "project:p1": null, "project:p2": null, "project:p3": null });
    expect((await owner(stored.id)).status).toBe("confirmed");
    const titles = await sql<
      { title: string }[]
    >`SELECT title FROM projects WHERE outcome_id=${outcomeId} ORDER BY title`;
    expect(titles.map((row) => row.title)).toEqual(["Project p1", "Project p2", "Project p3"]);
    expect(await sql`SELECT 1 FROM write_rows r JOIN writes w ON w.id=r.write_id WHERE w.actor='scribe'`).toHaveLength(
      3
    );
  });

  it("refuses a batch with a row that has no expectedVersion", async () => {
    const error = await refusal(
      proposeAgentChange(sql, "scribe", {
        kind: "entity_command_batch",
        summary: "x",
        payload: { commands: [{ command: "save_project", body: { project: project("p1", "One") } }] },
        basis: "inferred"
      })
    );
    expect(error.status).toBe(400);
    expect(error.message).toContain("commands[0]");
  });
});
