import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { integrationDatabaseName } from "@openrhen/database";
import { setupStateStoreSuite, sql, unplannedStore } from "./persistence/postgres/state-store-harness";
import { connectAgent, contractClock, contractSeedState, type AgentCall } from "./agent-contract-fixture";

/**
 * Ranking by an agent, through `/mcp` itself: the group is read from the compare room of `rhen_inbox`, answered with
 * `rhen_save` (entityType comparison), and the server holds the agent to the basis rules, hides private items, and names
 * the exact next call when the group is wrong. The server command itself is covered in
 * `persistence/postgres/consequence-commands.integration.test.ts`.
 */
const BASE = "openrhen_agent_consequence";
setupStateStoreSuite(BASE, { resetBetweenTests: false });

const clock = contractClock();
let call: AgentCall;
let previousDatabaseUrl: string | undefined;

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: clock.now });
  const url = new URL(process.env.POSTGRES_ADMIN_URL!);
  url.pathname = `/${integrationDatabaseName(process.env.TEST_DATABASE_NAME, BASE)}`;
  previousDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = url.toString();
  await sql.unsafe("TRUNCATE TABLE users, portal_state, jobs RESTART IDENTITY CASCADE");
  await unplannedStore.put(contractSeedState(clock));
  call = await connectAgent(clock);
}, 120_000);

afterAll(() => {
  vi.useRealTimers();
  if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previousDatabaseUrl;
});

interface Group {
  groupId: string;
  question: string;
  items: { n: number; id: string; title: string; stars: number }[];
  answerCall: { tool: string; arguments: Record<string, unknown> };
}
interface Room {
  room: string;
  count: number;
  items: { id: string; title: string; detail?: string; act?: string; data?: { group: Group } }[];
}

/** The inbox's compare room as an agent reads it: the fence around the list is dropped, the JSON inside is parsed. */
async function compareRoom(): Promise<{ room: Room; text: string }> {
  const outcome = await call("rhen_inbox", { room: "compare" });
  expect(outcome.isError, outcome.text).toBe(false);
  const start = outcome.text.indexOf("[");
  const rooms = JSON.parse(outcome.text.slice(start, outcome.text.lastIndexOf("]") + 1)) as Room[];
  expect(rooms).toHaveLength(1);
  return { room: rooms[0]!, text: outcome.text };
}

describe("an agent ranking through /mcp", () => {
  it("offers the group in rhen_inbox and never a private item", async () => {
    const family = (await unplannedStore.get())!.projects.find((p) => p.title === "Family")!;
    await sql`UPDATE projects SET private = true WHERE id = ${family.id}`;
    const { room, text } = await compareRoom();
    expect(room, text).toMatchObject({ room: "compare", count: 1 });
    const group = room.items[0]!.data!.group;
    expect(group.items.length).toBeGreaterThanOrEqual(2);
    expect(group.items.map((item) => item.id)).not.toContain(family.id);
    expect(text).not.toContain("Family");
    expect(group.answerCall.tool).toBe("rhen_save");
    expect(room.items[0]!.act).toContain("rhen_save");
    // asking again returns the same waiting group
    expect((await compareRoom()).room.items[0]!.data!.group.groupId).toBe(group.groupId);
  });

  it("refuses a stated answer without the owner's words, with the exact call that would work", async () => {
    const group = (await compareRoom()).room.items[0]!.data!.group;
    const ids = group.items.map((item) => item.id);
    const refused = await call("rhen_save", {
      entityType: "comparison",
      fields: { groupId: group.groupId, rankedIds: ids },
      basis: "stated"
    });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("needs the owner's own words as evidence");
    expect(refused.text).toContain("Nothing was changed. Next: rhen_save ");
    expect(refused.text).toContain(group.groupId);
  });

  it("names the waiting group when the answer is for a group that was never issued", async () => {
    const group = (await compareRoom()).room.items[0]!.data!.group;
    const refused = await call("rhen_save", {
      entityType: "comparison",
      fields: { groupId: "00000000-0000-4000-8000-000000000001", tie: true },
      basis: "inferred"
    });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("was issued to you");
    expect(refused.text).toContain(`group ${group.groupId}`);
  });

  it("records the answer with the owner's words, moves Now's inputs, and then refuses the same group twice", async () => {
    const group = (await compareRoom()).room.items[0]!.data!.group;
    const ids = group.items.map((item) => item.id);
    const jobs = (await sql`SELECT 1 FROM jobs`).length;
    const done = await call("rhen_save", {
      entityType: "comparison",
      fields: { groupId: group.groupId, rankedIds: [...ids].reverse() },
      basis: "stated",
      evidence: "Honestly the last one matters most, then the others"
    });
    expect(done.isError, done.text).toBe(false);
    expect(JSON.parse(done.text.split("\n")[0]!)).toMatchObject({
      by: "agent",
      basis: "stated",
      groupId: group.groupId,
      replayed: false
    });
    const [row] = await sql<
      { answered_by: string; basis: string; evidence: string }[]
    >`SELECT answered_by, basis, evidence FROM consequence_comparisons WHERE group_id = ${group.groupId}`;
    expect(row).toEqual({
      answered_by: "agent",
      basis: "stated",
      evidence: "Honestly the last one matters most, then the others"
    });
    expect((await sql`SELECT 1 FROM projects WHERE consequence_refined IS NOT NULL`).length).toBe(ids.length);
    expect((await sql`SELECT 1 FROM jobs`).length).toBeGreaterThan(jobs);

    const twice = await call("rhen_save", {
      entityType: "comparison",
      fields: { groupId: group.groupId, tie: true },
      basis: "inferred"
    });
    expect(twice.isError).toBe(true);
    expect(twice.text).toContain("was already answered");
    expect(twice.text).toContain("rhen_inbox");
  });
});
