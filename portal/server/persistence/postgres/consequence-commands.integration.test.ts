import { describe, expect, it } from "vitest";
import {
  CONSEQUENCE_NEXT_CALL,
  CONSEQUENCE_QUESTION_TEXT,
  consequenceAnswerCall,
  formatAgentCall,
  rankConsequenceGroupCommandSchema,
  type ConsequenceGroupView,
  type RankConsequenceGroupCommand
} from "@openrhen/contracts";
import { createSeedState } from "@/state/portal-state";
import { runWithActor } from "@/server/agent-actor";
import { CommandConflictError, CommandIdReusedError, InvalidCommandError } from "./command-errors";
import { readNextConsequenceGroup, runRankConsequenceGroup } from "./consequence-commands";
import { ensureUser } from "./ensure-user";
import { fixedNow, setupStateStoreSuite, sql, unplannedStore as store } from "./state-store-harness";

/**
 * Ranking through the server command the portal card, `rhen rank` and an agent share: the group handed out (wording by
 * the person's local day, no private item for an agent), the answer recorded with the caller derived from the request,
 * the refit and the recalculation it triggers, the receipt, and the exact refusal text for a wrong group.
 */
setupStateStoreSuite("openrhen_consequence_commands");

// 2026-11-09 is an even day number (only_finish_one) and 2026-11-10 an odd one (most_regret_not_doing), in Brisbane (+10).
const MONDAY_LOCAL = new Date("2026-11-08T22:00:00Z"); // 2026-11-09 08:00 Brisbane
const TUESDAY_LOCAL = new Date("2026-11-09T22:00:00Z"); // 2026-11-10 08:00 Brisbane
const asAgent = <T>(fn: () => Promise<T>, claim?: { basis?: "stated" | "observed" | "inferred"; evidence?: string }) =>
  runWithActor("scribe", fn, undefined, claim);

let userId: string;
let titles: Record<string, string>;

async function arrange(projectCount = 4, timezone = "Australia/Brisbane") {
  await store.put(createSeedState(fixedNow));
  userId = await ensureUser(sql);
  await sql`UPDATE users SET timezone=${timezone} WHERE id=${userId}`;
  const outcomeId = (await store.get())!.projects[0]!.outcomeId!;
  // The seed's own projects are archived out of the way so the group is exactly the ones added here.
  await sql`UPDATE projects SET status = 'archived'`;
  titles = {};
  for (let i = 0; i < projectCount; i += 1) {
    const title = `Rank project ${i + 1}`;
    const id = (
      await sql<
        { id: string }[]
      >`INSERT INTO projects (outcome_id, title, consequence) VALUES (${outcomeId}, ${title}, ${3}) RETURNING id`
    )[0]!.id;
    titles[id] = title;
  }
}

const group = async (now: Date, pool?: "project" | "action"): Promise<ConsequenceGroupView> => {
  const view = await readNextConsequenceGroup(sql as never, { now, ...(pool ? { pool } : {}) });
  expect(view).not.toBeNull();
  return view!;
};

const command = (view: ConsequenceGroupView, overrides: Record<string, unknown> = {}): RankConsequenceGroupCommand =>
  rankConsequenceGroupCommandSchema.parse({
    commandId: crypto.randomUUID(),
    groupId: view.groupId,
    rankedIds: view.items.map((item) => item.id),
    ...overrides
  });
const run = (cmd: RankConsequenceGroupCommand, clock = MONDAY_LOCAL) =>
  runRankConsequenceGroup(sql as never, cmd, clock);
const refusal = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a refusal");
};
const comparisons = () => sql<
  { id: string; answered_by: string; basis: string; evidence: string | null; question_wording: string }[]
>`
  SELECT id, answered_by, basis, evidence, question_wording FROM consequence_comparisons ORDER BY answered_at`;

describe("the next group", () => {
  it("is numbered, shows each title and its own stars, and asks the question for the person's local day", async () => {
    await arrange();
    const monday = await group(MONDAY_LOCAL);
    expect(monday).toMatchObject({ pool: "project", wording: "only_finish_one", reissued: false });
    expect(monday.question).toBe(CONSEQUENCE_QUESTION_TEXT.only_finish_one);
    expect(monday.items.map((item) => item.n)).toEqual([1, 2, 3, 4]);
    expect(monday.items.map((item) => item.title).sort()).toEqual(Object.values(titles).sort());
    expect(monday.items.every((item) => item.stars === 3)).toBe(true);
    expect(monday.answerCall.arguments).toMatchObject({
      entityType: "comparison",
      fields: { groupId: monday.groupId, rankedIds: monday.items.map((item) => item.id) }
    });
  });

  it("asks the regret question on the next local day", async () => {
    await arrange();
    expect((await group(TUESDAY_LOCAL)).wording).toBe("most_regret_not_doing");
    expect((await group(TUESDAY_LOCAL)).question).toBe(CONSEQUENCE_QUESTION_TEXT.most_regret_not_doing);
  });

  it("uses the local date, not the UTC date: the same instant is a different day in another zone", async () => {
    await arrange(4, "Europe/London");
    // 22:00Z on 2026-11-09 is still 2026-11-09 in London (even day), but 2026-11-10 in Brisbane (see above).
    expect((await group(TUESDAY_LOCAL)).wording).toBe("only_finish_one");
  });

  it("hands out the same group again until it is answered, and null when nothing can be asked", async () => {
    await arrange();
    const first = await group(MONDAY_LOCAL);
    const again = await group(TUESDAY_LOCAL);
    expect(again).toMatchObject({ groupId: first.groupId, reissued: true, wording: "only_finish_one" });
    await run(command(first));
    expect(await readNextConsequenceGroup(sql as never, { now: MONDAY_LOCAL })).toBeNull();
    await arrange(1);
    expect(await readNextConsequenceGroup(sql as never, { now: MONDAY_LOCAL })).toBeNull();
  });

  it("never shows an agent a private item", async () => {
    await arrange();
    const privateId = Object.keys(titles)[0]!;
    await sql`UPDATE projects SET private = true WHERE id = ${privateId}`;
    const forAgent = await asAgent(() => group(MONDAY_LOCAL));
    expect(forAgent.items).toHaveLength(3);
    expect(forAgent.items.map((item) => item.id)).not.toContain(privateId);
    expect(JSON.stringify(forAgent)).not.toContain(titles[privateId]!);
    expect(forAgent.answerCall.arguments).not.toMatchObject({
      fields: { rankedIds: expect.arrayContaining([privateId]) }
    });
  });

  it("shows the person their private item, and an agent can neither see that group nor answer it", async () => {
    await arrange();
    const privateId = Object.keys(titles)[0]!;
    await sql`UPDATE projects SET private = true WHERE id = ${privateId}`;
    const forPerson = await group(MONDAY_LOCAL);
    expect(forPerson.items.map((item) => item.id)).toContain(privateId);
    // Its pairs are cooling, so there is nothing else to offer the agent, and above all not this group.
    expect(await asAgent(() => readNextConsequenceGroup(sql as never, { now: MONDAY_LOCAL }))).toBeNull();
    const refused = await refusal(asAgent(() => run(command(forPerson, { basis: "inferred" }))));
    expect(refused).toBeInstanceOf(CommandConflictError);
    expect(refused.message).toContain(`No group ${forPerson.groupId} was issued to you`);
    expect(refused.message).not.toContain(privateId);
    expect(await comparisons()).toHaveLength(0);
  });

  describe("refuses an agent without naming a private group or its items, and sends it to the read call", () => {
    const expectClean = (error: Error, ids: string[]) => {
      const text = JSON.stringify({ message: error.message, nextCall: (error as CommandConflictError).nextCall });
      for (const id of ids) expect(text).not.toContain(id);
      expect(error.message).toContain(`Next: ${formatAgentCall(CONSEQUENCE_NEXT_CALL)}`);
      expect((error as CommandConflictError).nextCall).toEqual(CONSEQUENCE_NEXT_CALL);
    };

    it("for a wrong group id", async () => {
      await arrange();
      const ids = Object.keys(titles);
      const view = await group(MONDAY_LOCAL);
      await sql`UPDATE projects SET private = true`;
      const refused = await refusal(asAgent(() => run(command(view, { groupId: "nope", basis: "inferred" }))));
      expect(refused).toBeInstanceOf(CommandConflictError);
      expectClean(refused, [...ids, view.groupId]);
    });

    it("for the real group with the wrong ids", async () => {
      await arrange();
      const ids = Object.keys(titles);
      const view = await group(MONDAY_LOCAL);
      await sql`UPDATE projects SET private = true`;
      const refused = await refusal(
        asAgent(() => run(command(view, { rankedIds: [view.items[0]!.id], basis: "inferred" })))
      );
      expectClean(refused, ids);
    });

    it("for a group the person already answered", async () => {
      await arrange();
      const ids = Object.keys(titles);
      const view = await group(MONDAY_LOCAL);
      await run(command(view));
      await sql`UPDATE projects SET private = true`;
      const refused = await refusal(asAgent(() => run(command(view, { basis: "inferred" }))));
      expectClean(refused, ids);
    });
  });
});

describe("answering", () => {
  it("records a person's answer as stated, refits, and enqueues the recalculation that updates Now", async () => {
    await arrange();
    const view = await group(MONDAY_LOCAL);
    const cmd = command(view, { basis: "inferred", evidence: "ignored for a person" });
    const jobsBefore = (await sql`SELECT 1 FROM jobs`).length;
    const { result } = await run(cmd);
    expect(result).toMatchObject({ by: "person", basis: "stated", replayed: false, groupId: view.groupId });
    expect(result.next).toContain("rhen_inbox");
    const [row] = await comparisons();
    expect(row).toMatchObject({ answered_by: "person", basis: "stated", question_wording: "only_finish_one" });

    const refined = await sql<
      { id: string; v: number }[]
    >`SELECT id, consequence_refined AS v FROM projects WHERE consequence_refined IS NOT NULL`;
    expect(refined.length).toBe(4);
    const best = refined.find((p) => p.id === view.items[0]!.id)!;
    const worst = refined.find((p) => p.id === view.items[3]!.id)!;
    expect(best.v).toBeGreaterThan(worst.v);
    expect((await store.get())!.projects.find((p) => p.id === best.id)!.consequenceRefined).toBe(best.v);

    // recordStateChange ran: a change-log row for the comparison and a recalculation job.
    const logged = (
      await sql<{ evidence: Record<string, unknown>; operation: string; entity_type: string }[]>`
        SELECT evidence, operation, entity_type FROM write_rows WHERE write_id = ${cmd.commandId}`
    )[0]!;
    expect(logged).toMatchObject({ operation: "rank", entity_type: "consequence_comparison" });
    expect(logged.evidence).toMatchObject({ by: "person", basis: "stated", groupId: view.groupId });
    expect((await sql`SELECT 1 FROM jobs`).length).toBeGreaterThan(jobsBefore);
  });

  it("replays the same command id as the same answer, and refuses the id reused for a different one", async () => {
    await arrange();
    const view = await group(MONDAY_LOCAL);
    const cmd = command(view);
    await run(cmd);
    const again = await run(cmd);
    expect(again.result.replayed).toBe(true);
    expect(await comparisons()).toHaveLength(1);
    const reordered = { ...cmd, rankedIds: [...cmd.rankedIds!].reverse() };
    expect(await refusal(run(reordered))).toBeInstanceOf(CommandIdReusedError);
  });

  it("records a tie, which moves nothing", async () => {
    await arrange();
    const view = await group(MONDAY_LOCAL);
    const { result } = await run(
      rankConsequenceGroupCommandSchema.parse({ commandId: crypto.randomUUID(), groupId: view.groupId, tie: true })
    );
    expect(result.replayed).toBe(false);
    expect((await sql`SELECT 1 FROM projects WHERE consequence_refined IS NOT NULL`).length).toBe(0);
  });

  it("takes an agent's basis and evidence from the command or its headers, and defaults to a guess", async () => {
    await arrange();
    const view = await group(MONDAY_LOCAL);
    const { result } = await asAgent(() => run(command(view)));
    expect(result).toMatchObject({ by: "agent", basis: "inferred" });
    const [row] = await comparisons();
    expect(row).toMatchObject({ answered_by: "agent", basis: "inferred" });
  });

  it("holds an agent's stated answer to the owner's words, naming the exact call to send", async () => {
    await arrange();
    const view = await group(MONDAY_LOCAL);
    const cmd = command(view, { basis: "stated" });
    const refused = await refusal(asAgent(() => run(cmd)));
    expect(refused).toBeInstanceOf(InvalidCommandError);
    expect(refused.message).toContain("needs the owner's own words as evidence");
    expect(refused.message).toContain("Nothing was changed. Next: rhen_save ");
    expect(refused.message).toContain(view.groupId);
    for (const item of view.items) expect(refused.message).toContain(item.id);
    expect((refused as InvalidCommandError).nextCall).toMatchObject({ tool: "rhen_save" });
    expect(await comparisons()).toHaveLength(0);
    expect((await sql`SELECT 1 FROM writes WHERE id = ${cmd.commandId}`).length).toBe(0);

    const ok = await asAgent(() => run({ ...cmd, evidence: "the Alpha one, then the others" }));
    expect(ok.result).toMatchObject({ by: "agent", basis: "stated" });
    expect((await comparisons())[0]!.evidence).toBe("the Alpha one, then the others");
  });

  it("refuses a wrong group id with the group that is waiting and the exact call to answer it", async () => {
    await arrange();
    const view = await group(MONDAY_LOCAL);
    const refused = await refusal(run(command(view, { groupId: "00000000-0000-4000-8000-000000000000" })));
    expect(refused).toBeInstanceOf(CommandConflictError);
    const ids = view.items.map((item) => item.id).sort();
    expect(refused.message).toBe(
      `No group 00000000-0000-4000-8000-000000000000 was issued to you. The group waiting for an answer is group ${view.groupId} (projects: ${ids.join(", ")}): answer that one with its groupId and exactly those ids. ` +
        `Nothing was changed. Next: ${formatAgentCall(consequenceAnswerCall(view.groupId, ids))}`
    );
    expect((refused as CommandConflictError).nextCall).toEqual(consequenceAnswerCall(view.groupId, ids));
  });

  it("refuses a group answered twice, and a ranking that is not the group's ids, each with the next call", async () => {
    await arrange();
    const view = await group(MONDAY_LOCAL);
    const short = await refusal(run(command(view, { rankedIds: view.items.slice(0, 3).map((i) => i.id) })));
    expect(short).toBeInstanceOf(InvalidCommandError);
    expect(short.message).toContain("rankedIds does not match");
    expect(short.message).toContain("Send exactly its 4 ids");
    expect(short.message).toContain("Nothing was changed. Next: rhen_save ");
    await run(command(view));
    const twice = await refusal(run(command(view)));
    expect(twice).toBeInstanceOf(CommandConflictError);
    expect(twice.message).toContain(`Group ${view.groupId} was already answered`);
    expect(twice.message).toContain(`Next: ${CONSEQUENCE_NEXT_CALL.tool} {"room":"compare"}`);
    expect((twice as CommandConflictError).nextCall).toEqual(CONSEQUENCE_NEXT_CALL);
    expect(await comparisons()).toHaveLength(1);
  });

  it("refuses a wording that is not the one the group was asked under", async () => {
    await arrange();
    const view = await group(MONDAY_LOCAL);
    const refused = await refusal(run(command(view, { wording: "most_regret_not_doing" })));
    expect(refused).toBeInstanceOf(InvalidCommandError);
    expect(refused.message).toContain('was asked as "only_finish_one"');
  });
});
