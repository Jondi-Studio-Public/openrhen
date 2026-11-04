import { describe, expect, it } from "vitest";
import { hardFloorReason } from "@openrhen/contracts";
import { createSeedState } from "@/state/portal-state";
import { runWithActor } from "@/server/agent-actor";
import { proposeAgentChange, resolveAgentProposal } from "@/server/agent-proposals/store";
import { ForbiddenCommandError } from "./command-errors";
import { fixedNow, setupStateStoreSuite, sql, store, unplannedStore } from "./state-store-harness";

/**
 * Dropping a Someday or Reference item is on the hard floor. `inbox-act kept drop` sends the same capture save
 * as ignoring a pending item, so the route applies it; the handler reads the stored row and refuses an agent. An
 * agent may still send a kept item back to review and ignore a pending one, and the owner may still drop it, directly
 * or by confirming an agent's proposal.
 */
setupStateStoreSuite("openrhen_kept_drop_floor");

const asAgent = <T>(fn: () => Promise<T>) => runWithActor("claude", fn);

async function kept(proposalType: string, status = "confirmed"): Promise<string> {
  await unplannedStore.put(createSeedState(fixedNow));
  const userId = (await sql<{ id: string }[]>`SELECT id FROM users LIMIT 1`)[0]!.id;
  const source = (
    await sql<{ id: string }[]>`
      INSERT INTO sources (user_id, source_type, external_id, captured_text)
      VALUES (${userId}, 'manual_capture', ${crypto.randomUUID()}, 'Learn the cello')
      RETURNING id`
  )[0]!.id;
  return (
    await sql<{ id: string }[]>`
      INSERT INTO captures (user_id, source_id, proposal_type, status, proposed_fields)
      VALUES (${userId}, ${source}, ${proposalType}, ${status}, ${sql.json({ text: "Learn the cello" } as never)})
      RETURNING id`
  )[0]!.id;
}

async function saveStatus(id: string, status: string) {
  const row = (
    await sql<{ version: number; proposal_type: string }[]>`
    SELECT version, proposal_type FROM captures WHERE id=${id}`
  )[0]!;
  await store.saveEntity({
    commandId: crypto.randomUUID(),
    expectedVersion: row.version,
    type: "save_entity",
    entityType: "capture",
    entity: {
      id,
      status,
      proposalType: row.proposal_type,
      proposedFields: { text: "Learn the cello" },
      reviewedAt: fixedNow.toISOString()
    }
  });
}

const statusOf = async (id: string) =>
  (await sql<{ status: string }[]>`SELECT status FROM captures WHERE id=${id}`)[0]!.status;

describe("an agent dropping a kept item", () => {
  it.each(["someday", "reference"])("is refused with the floor's text for a %s item", async (type) => {
    const id = await kept(type);
    const drop = asAgent(() => saveStatus(id, "ignored"));
    await expect(drop).rejects.toThrow(ForbiddenCommandError);
    await expect(asAgent(() => saveStatus(id, "ignored"))).rejects.toThrow(
      hardFloorReason({ tool: "inbox-act", room: "kept", action: "drop" }) as string
    );
    // Any other status takes it out of Someday & reference just the same.
    await expect(asAgent(() => saveStatus(id, "superseded"))).rejects.toThrow(ForbiddenCommandError);
    expect(await statusOf(id)).toBe("confirmed");
  });

  it("still lets an agent send a kept item back to review", async () => {
    const id = await kept("someday");
    await asAgent(() => saveStatus(id, "pending"));
    expect(await statusOf(id)).toBe("pending");
  });

  it("still lets an agent ignore a pending capture", async () => {
    const id = await kept("unclassified", "pending");
    await asAgent(() => saveStatus(id, "ignored"));
    expect(await statusOf(id)).toBe("ignored");
  });

  it("applies an agent's drop the owner confirms as a proposal", async () => {
    // With direct writes off the drop is filed as a proposal; confirming it replays the save with the agent set.
    const id = await kept("someday");
    const version = (await sql<{ version: number }[]>`SELECT version FROM captures WHERE id=${id}`)[0]!.version;
    const { proposal } = await proposeAgentChange(sql as never, "claude", {
      kind: "entity_command",
      summary: "Drop a kept item",
      payload: {
        command: "save_entity",
        body: {
          expectedVersion: version,
          entityType: "capture",
          entity: { id, status: "ignored", proposalType: "someday", proposedFields: { text: "Learn the cello" } }
        }
      },
      basis: "inferred"
    });
    expect(await statusOf(id)).toBe("confirmed");
    await resolveAgentProposal(sql as never, null, proposal.id, { decision: "confirm", revision: proposal.revision });
    expect(await statusOf(id)).toBe("ignored");
  });

  it("still lets the owner drop it", async () => {
    const id = await kept("reference");
    await saveStatus(id, "ignored");
    expect(await statusOf(id)).toBe("ignored");
  });
});
