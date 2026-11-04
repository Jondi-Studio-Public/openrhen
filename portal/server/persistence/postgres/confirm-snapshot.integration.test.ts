import { describe, expect, it } from "vitest";
import { contractsExtensions } from "@openrhen/contracts";
import { agentCaptureRefusal } from "./entity-extensions";
import { createSeedState } from "@/state/portal-state";
import { runWithActor } from "@/server/agent-actor";
import { proposeAgentChange, resolveAgentProposal } from "@/server/agent-proposals/store";
import { CommandConflictError, ForbiddenCommandError } from "./command-errors";
import { runRevertCommand } from "./write-revert";
import type { SnapshotRow } from "./write-snapshot";
import { fixedNow, setupStateStoreSuite, sql, store, unplannedStore } from "./state-store-harness";

/**
 * An agent's confirm of an Inbox item (`capture_review`) keeps a row snapshot so it can
 * be undone and redone. The confirm creates rows in several
 * tables, including the link tables that have no `id` (composite keys), and flips the proposal; undo deletes what
 * it made and reopens the proposal, and refuses once something it made was edited. The person's own confirm keeps
 * no snapshot, and an agent may not confirm or ignore a capture from another person's source (one a feature registers).
 */
setupStateStoreSuite("openrhen_confirm_snapshot");

type Rec = Record<string, any>;

const asAgent = <T>(fn: () => Promise<T>, agent = "claude") => runWithActor(agent, fn);

async function seed() {
  await unplannedStore.put(createSeedState(fixedNow));
  const project = (await sql<{ id: string }[]>`SELECT id FROM projects ORDER BY title LIMIT 1`)[0]!;
  const actions = await sql<{ id: string; version: number }[]>`
    SELECT id,version FROM actions WHERE deliverable_id IS NULL ORDER BY title LIMIT 2`;
  const userId = (await sql<{ id: string }[]>`SELECT id FROM users LIMIT 1`)[0]!.id;
  return { project, action: actions[0]!, otherAction: actions[1]!, userId };
}

/** A pending proposal and the source it came from. */
async function proposal(
  userId: string,
  options: { sourceType?: string; text?: string; externalId?: string } = {}
): Promise<string> {
  const text = options.text ?? "Draft the report";
  const source = (
    await sql<{ id: string }[]>`
      INSERT INTO sources (user_id, source_type, external_id, title, captured_text)
      VALUES (${userId}, ${options.sourceType ?? "manual_capture"}, ${options.externalId ?? crypto.randomUUID()}, 'Subject', ${text})
      RETURNING id`
  )[0]!.id;
  return (
    await sql<{ id: string }[]>`
      INSERT INTO captures (user_id, source_id, proposal_type, status, proposed_fields)
      VALUES (${userId}, ${source}, 'unclassified', 'pending', ${sql.json({ text } as never)})
      RETURNING id`
  )[0]!.id;
}

async function confirm(id: string, entity: Rec, commandId = crypto.randomUUID()) {
  const row = (await sql<{ version: number }[]>`SELECT version FROM captures WHERE id=${id}`)[0]!;
  await store.saveEntity({
    commandId,
    expectedVersion: row.version,
    type: "save_entity",
    entityType: "capture_review",
    entity: { id, ...entity }
  });
  return commandId;
}

const confirmAction = (projectId: string, id: string, commandId?: string) =>
  confirm(
    id,
    {
      proposalType: "action",
      draft: { title: "Draft the report", projectId, expectedMinutes: 30, pessimisticMinutes: 45, energy: "medium" }
    },
    commandId
  );

const revert = (target: string, direction: "undo" | "redo", force = false) =>
  runRevertCommand(sql, { commandId: crypto.randomUUID(), target, direction, ...(force ? { force: true } : {}) });

const snapshotOf = async (commandId: string) =>
  (
    await sql<{ agent: string; kind: string; state: string; rows: SnapshotRow[] }[]>`
      SELECT actor AS agent, kind, state, images AS rows FROM writes WHERE id=${commandId} AND images IS NOT NULL`
  )[0];

const count = async (query: PromiseLike<readonly unknown[]>) => (await query).length;
const proposalRow = async (id: string) =>
  (
    await sql<Rec[]>`SELECT status, proposal_type, proposed_fields, version, reviewed_at FROM captures WHERE id=${id}`
  )[0]!;

describe("an agent's confirm of a captured item", () => {
  it("is snapshotted; undo removes the action and reopens the proposal, and redo brings both back", async () => {
    const { project, userId } = await seed();
    const id = await proposal(userId);
    const before = await proposalRow(id);
    const commandId = await asAgent(() => confirmAction(project.id, id));

    expect(await count(sql`SELECT 1 FROM actions WHERE id=${id}`)).toBe(1);
    expect((await proposalRow(id)).status).toBe("confirmed");
    const snapshot = await snapshotOf(commandId);
    expect(snapshot).toMatchObject({ agent: "claude", kind: "confirm", state: "applied" });
    expect(snapshot!.rows.map((row) => `${row.table}:${row.before ? "updated" : "created"}`).sort()).toEqual([
      "actions:created",
      "captures:updated"
    ]);
    // The mail-derived text stays out of write_rows; it lives in the snapshot's row images, as in the live tables.
    const log = await sql<{ evidence: unknown }[]>`SELECT evidence FROM write_rows WHERE write_id=${commandId}`;
    expect(JSON.stringify(log)).not.toContain("Draft the report");

    // The planner has run since (the store recalculates): its output points at the new action.
    const recommendation = (
      await sql<{ id: string }[]>`
        INSERT INTO recommendations (user_id, input_version, kind, primary_action_id, target_type, target_id, headline, explanation, superseded_at)
        VALUES (${userId}, 'v1', 'work', ${id}, 'action', ${id}, 'Do it', 'Because', now())
        RETURNING id`
    )[0]!.id;
    await sql`INSERT INTO recommendation_candidates (recommendation_id, action_id, target_type, target_id, rank, total_score, score_components, eligible, exclusion_reasons)
      VALUES (${recommendation}, ${id}, 'action', ${id}, 1, 1, '{}'::jsonb, true, '[]'::jsonb)`;

    await asAgent(() => revert(commandId, "undo"));
    expect(await count(sql`SELECT 1 FROM actions WHERE id=${id}`)).toBe(0);
    const reopened = await proposalRow(id);
    expect(reopened).toMatchObject({ status: "pending", proposal_type: "unclassified", reviewed_at: null });
    expect(reopened.proposed_fields).toEqual(before.proposed_fields);
    expect(await count(sql`SELECT 1 FROM recommendation_candidates WHERE action_id=${id}`)).toBe(0);
    expect(
      (await sql<Rec[]>`SELECT primary_action_id FROM recommendations WHERE id=${recommendation}`)[0]!.primary_action_id
    ).toBeNull();
    expect((await snapshotOf(commandId))!.state).toBe("undone");

    await asAgent(() => revert(commandId, "redo"));
    expect(await count(sql`SELECT 1 FROM actions WHERE id=${id} AND title='Draft the report'`)).toBe(1);
    expect((await proposalRow(id)).status).toBe("confirmed");
    // And back once more: redo left the images the next undo checks against.
    await asAgent(() => revert(commandId, "undo"));
    expect(await count(sql`SELECT 1 FROM actions WHERE id=${id}`)).toBe(0);
    expect((await proposalRow(id)).status).toBe("pending");
  });

  it("keeps no snapshot for the person's own confirm", async () => {
    const { project, userId } = await seed();
    const id = await proposal(userId);
    const commandId = await confirmAction(project.id, id);
    expect(await snapshotOf(commandId)).toBeUndefined();
    expect(await count(sql`SELECT 1 FROM actions WHERE id=${id}`)).toBe(1);
  });

  it("undoes a confirmed deliverable with its source link (a composite key) and redoes it", async () => {
    const { project, userId } = await seed();
    const id = await proposal(userId);
    const commandId = await asAgent(() =>
      confirm(id, { proposalType: "deliverable", draft: { title: "Assessment 3", projectId: project.id } })
    );
    expect(await count(sql`SELECT 1 FROM deliverable_sources WHERE deliverable_id=${id}`)).toBe(1);
    const link = (await snapshotOf(commandId))!.rows.find((row) => row.table === "deliverable_sources")!;
    expect(JSON.parse(link.id)).toEqual([id, expect.any(String)]);

    await asAgent(() => revert(commandId, "undo"));
    expect(await count(sql`SELECT 1 FROM deliverables WHERE id=${id}`)).toBe(0);
    expect(await count(sql`SELECT 1 FROM deliverable_sources WHERE deliverable_id=${id}`)).toBe(0);
    expect((await proposalRow(id)).status).toBe("pending");

    await asAgent(() => revert(commandId, "redo"));
    expect(await count(sql`SELECT 1 FROM deliverables WHERE id=${id}`)).toBe(1);
    expect(await count(sql`SELECT 1 FROM deliverable_sources WHERE deliverable_id=${id}`)).toBe(1);
  });

  it("refuses to undo once the created action was edited, and the owner can force it", async () => {
    const { project, userId } = await seed();
    const id = await proposal(userId);
    const commandId = await asAgent(() => confirmAction(project.id, id));
    await sql`UPDATE actions SET title='Edited by the person', version=version+1 WHERE id=${id}`;

    await expect(asAgent(() => revert(commandId, "undo"))).rejects.toThrow(CommandConflictError);
    expect(await count(sql`SELECT 1 FROM actions WHERE id=${id}`)).toBe(1);
    expect((await proposalRow(id)).status).toBe("confirmed");
    await expect(asAgent(() => revert(commandId, "undo", true))).rejects.toThrow(ForbiddenCommandError);

    await revert(commandId, "undo", true);
    expect(await count(sql`SELECT 1 FROM actions WHERE id=${id}`)).toBe(0);
    expect((await proposalRow(id)).status).toBe("pending");
  });

  it("refuses to undo while a session was started on the created action, instead of failing", async () => {
    const { project, userId } = await seed();
    const id = await proposal(userId);
    const commandId = await asAgent(() => confirmAction(project.id, id));
    await sql`INSERT INTO sessions (user_id, action_id, status, planned_started_at, planned_end_at, started_at, ended_at, planned_minutes, remaining_before_minutes)
      VALUES (${userId}, ${id}, 'completed', now() - interval '20 minutes', now() - interval '10 minutes', now() - interval '20 minutes', now() - interval '10 minutes', 10, 30)`;
    await expect(asAgent(() => revert(commandId, "undo"))).rejects.toThrow(CommandConflictError);
    expect(await count(sql`SELECT 1 FROM actions WHERE id=${id}`)).toBe(1);
  });

  it("only the agent that confirmed (or the owner) can undo it", async () => {
    const { project, userId } = await seed();
    const id = await proposal(userId);
    const commandId = await asAgent(() => confirmAction(project.id, id), "claude");
    await expect(asAgent(() => revert(commandId, "undo"), "other-agent")).rejects.toThrow(ForbiddenCommandError);
    await revert(commandId, "undo");
    expect((await proposalRow(id)).status).toBe("pending");
  });
});

describe("a write the owner confirmed from an agent's proposal", () => {
  /** The confirm path: the agent is the recorded actor and the owner confirmed (`resolveAgentProposal`). */
  const ownerConfirmed = (projectId: string, id: string) =>
    runWithActor("claude", () => confirmAction(projectId, id), "owner");

  it("cannot be undone or redone by the agent, with a refusal that names the owner, but the owner can", async () => {
    const { project, userId } = await seed();
    const id = await proposal(userId);
    const commandId = await ownerConfirmed(project.id, id);
    expect(await snapshotOf(commandId)).toMatchObject({ agent: "claude", state: "applied" });

    const refusal = asAgent(() => revert(commandId, "undo"));
    await expect(refusal).rejects.toThrow(ForbiddenCommandError);
    await expect(asAgent(() => revert(commandId, "undo"))).rejects.toThrow(/owner confirmed/);
    await expect(asAgent(() => revert(commandId, "undo"))).rejects.toThrow(/Review > Agent changes/);
    expect(await count(sql`SELECT 1 FROM actions WHERE id=${id}`)).toBe(1);

    await revert(commandId, "undo");
    expect(await count(sql`SELECT 1 FROM actions WHERE id=${id}`)).toBe(0);
    await expect(asAgent(() => revert(commandId, "redo"))).rejects.toThrow(ForbiddenCommandError);
    await revert(commandId, "redo");
    expect(await count(sql`SELECT 1 FROM actions WHERE id=${id}`)).toBe(1);
  });
});

// The sources a feature adds whose captures are the person's alone to confirm (none in the OpenRhen export).
const OTHER_PEOPLE_SOURCES = contractsExtensions()
  .flatMap((extension) => Object.keys(extension.sourceIds ?? {}))
  .filter((sourceType) => agentCaptureRefusal(sourceType, "confirm") !== undefined);

describe.each(OTHER_PEOPLE_SOURCES)("a capture from the %s source", (sourceType) => {
  it("is refused to an agent and still confirmable by the owner", async () => {
    const { project, userId } = await seed();
    const id = await proposal(userId, { sourceType });
    const commandId = crypto.randomUUID();
    await expect(asAgent(() => confirmAction(project.id, id, commandId))).rejects.toThrow(ForbiddenCommandError);
    await expect(asAgent(() => confirmAction(project.id, id, commandId))).rejects.toThrow(new RegExp(sourceType));
    expect(await count(sql`SELECT 1 FROM actions WHERE id=${id}`)).toBe(0);
    expect((await proposalRow(id)).status).toBe("pending");
    expect(await snapshotOf(commandId)).toBeUndefined();

    await confirmAction(project.id, id);
    expect((await proposalRow(id)).status).toBe("confirmed");
    expect(await count(sql`SELECT 1 FROM actions WHERE id=${id}`)).toBe(1);
  });
  it("cannot be ignored by an agent, which would tell the sender it was declined; the owner still can", async () => {
    const { userId } = await seed();
    const id = await proposal(userId, { sourceType });
    const ignore = async () => {
      const row = await proposalRow(id);
      await store.saveEntity({
        commandId: crypto.randomUUID(),
        expectedVersion: row.version as number,
        type: "save_entity",
        entityType: "capture",
        entity: { id, status: "ignored", proposalType: "unclassified", proposedFields: row.proposed_fields }
      });
    };
    await expect(asAgent(ignore)).rejects.toThrow(ForbiddenCommandError);
    expect((await proposalRow(id)).status).toBe("pending");

    // The person confirming the agent's proposal to ignore it replays under the agent's name, and goes through.
    const row = await proposalRow(id);
    const body = {
      commandId: crypto.randomUUID(),
      expectedVersion: row.version as number,
      type: "save_entity",
      entityType: "capture",
      entity: { id, status: "ignored", proposalType: "unclassified", proposedFields: row.proposed_fields }
    };
    const { proposal: filed } = await proposeAgentChange(sql as never, "claude", {
      kind: "entity_command",
      summary: "Ignore the sender's capture",
      payload: { command: "save_entity", body },
      basis: "inferred"
    });
    await resolveAgentProposal(sql as never, null, filed.id, { decision: "confirm", revision: filed.revision });
    expect((await proposalRow(id)).status).toBe("ignored");
  });

  it("the person can still ignore it themselves", async () => {
    const { userId } = await seed();
    const id = await proposal(userId, { sourceType });
    const row = await proposalRow(id);
    await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: row.version as number,
      type: "save_entity",
      entityType: "capture",
      entity: { id, status: "ignored", proposalType: "unclassified", proposedFields: row.proposed_fields }
    });
    expect((await proposalRow(id)).status).toBe("ignored");
  });
});

describe("an agent ignoring a capture", () => {
  it("an agent may still ignore a capture that did not come from another person", async () => {
    const { userId } = await seed();
    const id = await proposal(userId);
    const row = await proposalRow(id);
    await asAgent(() =>
      store.saveEntity({
        commandId: crypto.randomUUID(),
        expectedVersion: row.version as number,
        type: "save_entity",
        entityType: "capture",
        entity: { id, status: "ignored", proposalType: "unclassified", proposedFields: row.proposed_fields }
      })
    );
    expect((await proposalRow(id)).status).toBe("ignored");
  });
});

describe("undoing a confirmed project after the plan caught up", () => {
  it("removes the forecast the replan wrote for it, then the project", async () => {
    const { userId } = await seed();
    const outcome = (await sql<{ id: string }[]>`SELECT id FROM outcomes ORDER BY title LIMIT 1`)[0]!;
    const id = await proposal(userId, { text: "Plan the garden" });
    const deadline = new Date(fixedNow.getTime() + 30 * 86_400_000).toISOString();
    // `store` replans after the write, as the portal does.
    const commandId = await asAgent(() =>
      confirm(id, {
        proposalType: "project",
        draft: { title: "Plan the garden", outcomeId: outcome.id, externalDeadlineAt: deadline }
      })
    );
    const created = (await sql<{ id: string }[]>`SELECT id FROM projects WHERE title='Plan the garden'`)[0]!;
    expect(await count(sql`SELECT 1 FROM forecast_snapshots WHERE project_id=${created.id}`)).toBeGreaterThan(0);
    await asAgent(() => revert(commandId, "undo"));
    expect(await count(sql`SELECT 1 FROM projects WHERE id=${created.id}`)).toBe(0);
    expect(await count(sql`SELECT 1 FROM forecast_snapshots WHERE project_id=${created.id}`)).toBe(0);
    expect((await proposalRow(id)).status).toBe("pending");
  });
});
