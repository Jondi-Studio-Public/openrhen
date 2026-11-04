import { describe, expect, it } from "vitest";
import { stretchCommandSchema, type StretchCommand, type StretchResult } from "@openrhen/contracts";
import { createSeedState } from "@/state/portal-state";
import { runWithActor } from "@/server/agent-actor";
import { proposeAgentChange, resolveAgentProposal } from "@/server/agent-proposals/store";
import { CommandConflictError, CommandIdReusedError, InvalidCommandError } from "./command-errors";
import { ensureUser } from "./ensure-user";
import { runStretchCommand } from "./stretch-command";
import { runRevertCommand } from "./write-revert";
import { fixedNow, setupStateStoreSuite, sql, unplannedStore } from "./state-store-harness";

/**
 * Stretch answers (`stretch-command.ts`): accepting is judged against the newest published plan run, `until` is the
 * server's, the exact offer sentence and the quoted yes reach the change log, and one undo takes back only the
 * `stretch` key of the situation. Plan runs here are rows the test writes; nothing drains the planning queue.
 */
setupStateStoreSuite("openrhen_stretch_command");

const NOW = new Date(fixedNow);
const minutes = (count: number) => new Date(NOW.getTime() + count * 60_000);
const asAgent = <T>(fn: () => Promise<T>) => runWithActor("companion", fn);

let userId: string;

const OFFER = {
  actionId: "act-1",
  title: "Unit 3 reading",
  declaredEnergy: "low",
  requiredEnergy: "high",
  energyGap: 2,
  minutes: 45,
  cappedAtMinutes: 45,
  reason: "at_risk_external",
  externalDeadlineAt: minutes(30 * 60).toISOString(),
  latestSafeStartAt: null
};

/** A published run (the newest, unsuperseded) carrying `offer`, calculated `calculatedMinutesAgo` before NOW. */
async function publishRun(offer: Record<string, unknown> | null = OFFER, calculatedMinutesAgo = 5) {
  const calculatedAt = minutes(-calculatedMinutesAgo);
  const validUntil = minutes(60);
  await sql`UPDATE planning_runs SET superseded_at=now() WHERE user_id=${userId} AND superseded_at IS NULL`;
  await sql`
    INSERT INTO planning_runs (user_id,request_id,input_version,contract_version,engine_version,calculated_at,valid_until,result)
    VALUES (
      ${userId},${crypto.randomUUID()},'v1','1','v1',${calculatedAt},${validUntil},
      ${sql.json({
        contractVersion: "1",
        requestId: crypto.randomUUID(),
        inputVersion: "v1",
        engineVersion: "v1",
        calculatedAt: calculatedAt.toISOString(),
        validUntil: validUntil.toISOString(),
        derivedState: {
          sleepPlans: [],
          occurrences: [],
          routineSteps: [],
          commitmentRepeats: [],
          commitmentTimelines: [],
          stepPlacements: []
        },
        schedule: {},
        recommendation: offer ? { stretchOffer: offer } : {},
        currentDirective: { kind: "sleep", targetId: "s", title: "Sleep", recommendedMinutes: 480 },
        upcomingDirectives: [],
        continuation: null
      } as never)}
    )`;
}

const preferences = async () =>
  (
    await sql<
      { current_situation: Record<string, any>; version: number }[]
    >`SELECT current_situation, version FROM user_preferences WHERE user_id=${userId}`
  )[0]!;
const situation = async () => (await preferences()).current_situation;
const patchSituation = (patch: Record<string, unknown>) =>
  sql`UPDATE user_preferences SET current_situation=COALESCE(current_situation,'{}'::jsonb) || ${sql.json(patch as never)}::jsonb WHERE user_id=${userId}`;

function command(overrides: Record<string, unknown> = {}): StretchCommand {
  return stretchCommandSchema.parse({
    commandId: crypto.randomUUID(),
    choice: "accept",
    actionId: OFFER.actionId,
    ...overrides
  });
}
const STATED = { basis: "stated", evidence: "Yes, give me the 45 minutes." } as const;
const run = (cmd: StretchCommand, clock: Date = NOW) => runStretchCommand(sql as never, cmd, clock);
const writes = async (commandId: string) =>
  (await sql`SELECT 1 FROM writes WHERE id=${commandId} AND user_id=${userId}`).length;
const evidenceOf = async (commandId: string) =>
  (
    await sql<{ evidence: Record<string, any>; operation: string }[]>`
      SELECT evidence, operation FROM write_rows WHERE write_id=${commandId} AND user_id=${userId}`
  )[0]!;
const revert = (target: string, direction: "undo" | "redo" = "undo") =>
  runRevertCommand(sql as never, { commandId: crypto.randomUUID(), target, direction });

async function arrange(partial: Record<string, unknown> = {}) {
  await unplannedStore.put(createSeedState(fixedNow));
  userId = await ensureUser(sql);
  await sql`UPDATE users SET timezone='Australia/Sydney' WHERE id=${userId}`;
  await sql`UPDATE user_preferences SET current_situation=${sql.json({
    locationId: null,
    energySetAt: minutes(-60).toISOString(),
    ...partial
  } as never)}`;
  await publishRun();
}

/** Asserts a refusal changed nothing: same situation, same version, no receipt for the command id. */
async function expectRefusedUnchanged(cmd: StretchCommand, error: new (...args: never[]) => Error, text: RegExp) {
  const before = await preferences();
  const rejection = await run(cmd).then(
    () => null,
    (caught: unknown) => caught as Error
  );
  expect(rejection).toBeInstanceOf(error);
  expect(rejection!.message).toMatch(text);
  expect(await preferences()).toEqual(before);
  expect(await writes(cmd.commandId)).toBe(0);
  return rejection!;
}
const NEXT_STATUS = "Next: call rhen_status; tell the person about a stretch only if its answer shows stretchOffer.";

describe("accepting a stretch", () => {
  it("records the stretch for the person with the end set by the server, from the run's title and minutes", async () => {
    await arrange({ locationId: "home" });
    const before = await preferences();
    // A client-supplied end or length is not part of the command and is never read.
    const cmd = { ...command(), until: "2099-01-01T00:00:00.000Z", minutes: 999, title: "Other" } as StretchCommand;
    const { result } = await run(cmd);
    expect(result).toMatchObject({
      outcome: "accepted",
      by: "person",
      actionId: "act-1",
      title: "Unit 3 reading",
      minutes: 45,
      until: minutes(45).toISOString(),
      revertible: cmd.commandId
    });
    expect(result.next).toContain("Stretch started: Unit 3 reading until");
    const after = await preferences();
    expect(after.version).toBe(before.version + 1);
    expect(after.current_situation).toMatchObject({
      locationId: "home",
      energySetAt: before.current_situation.energySetAt,
      stretch: {
        accepted: [
          {
            actionId: "act-1",
            title: "Unit 3 reading",
            acceptedAt: NOW.toISOString(),
            until: minutes(45).toISOString(),
            minutes: 45,
            by: "person"
          }
        ],
        declined: []
      }
    });
    const logged = await evidenceOf(cmd.commandId);
    expect(logged.operation).toBe("stretch_accept");
    expect(logged.evidence).toMatchObject({ by: "person", basis: "inferred", offer: { actionId: "act-1" } });
    expect(logged.evidence.offerText).toBe(result.offerText);
    expect(logged.evidence).not.toHaveProperty("statedEvidence");
  });

  it("refuses an agent that has not been told by the person, and writes nothing", async () => {
    await arrange();
    const cmd = command();
    const before = await preferences();
    await expect(asAgent(() => run(cmd))).rejects.toThrow(InvalidCommandError);
    await expect(asAgent(() => run(cmd))).rejects.toThrow(/^Only the person can say yes or no to a stretch\./);
    expect(await preferences()).toEqual(before);
    expect(await writes(cmd.commandId)).toBe(0);
  });

  it("lets an agent accept on the person's word: by agent, with the offer text and the quote in the change log", async () => {
    await arrange();
    const cmd = command(STATED);
    const { result } = await asAgent(() => run(cmd));
    expect(result).toMatchObject({ by: "agent", outcome: "accepted" });
    expect((await situation()).stretch.accepted[0]).toMatchObject({ actionId: "act-1", by: "agent" });
    const logged = await evidenceOf(cmd.commandId);
    expect(logged.evidence).toMatchObject({
      by: "agent",
      actor: "companion",
      basis: "stated",
      statedEvidence: "Yes, give me the 45 minutes."
    });
    expect(logged.evidence.offerText).toContain("Unit 3 reading has an outside deadline");
    expect(logged.evidence.offerText).toContain("up to 45 minutes");
    expect(logged.evidence.offerText).toContain("Both are reasonable.");
    expect(logged.evidence.offerText).not.toMatch(/anyway/i);
  });

  it("replays the same command id with the same answer and writes it once", async () => {
    await arrange();
    const cmd = command();
    const first = await run(cmd);
    const again = await run(cmd, minutes(5));
    expect(again.result).toEqual(first.result);
    expect((await situation()).stretch.accepted).toHaveLength(1);
    expect(await sql`SELECT 1 FROM writes WHERE id=${cmd.commandId}`).toHaveLength(1);
    expect(await sql`SELECT 1 FROM write_rows WHERE write_id=${cmd.commandId}`).toHaveLength(1);
  });

  it("refuses a command id reused for a different answer", async () => {
    await arrange();
    const cmd = command();
    await run(cmd);
    await expect(run({ ...cmd, choice: "decline" })).rejects.toThrow(CommandIdReusedError);
    await expect(run({ ...cmd, actionId: "act-2" })).rejects.toThrow(CommandIdReusedError);
    expect((await situation()).stretch.accepted).toHaveLength(1);
  });
});

describe("refusals write nothing and end with the exact next call", () => {
  it("says there is no offer when the newest run carries none", async () => {
    await arrange();
    await publishRun(null);
    const error = await expectRefusedUnchanged(command(), CommandConflictError, /^There is no stretch offer now/);
    expect(error.message).toContain(`Nothing was changed. ${NEXT_STATUS}`);
    expect((error as CommandConflictError).nextCall).toMatchObject({ tool: "rhen_status" });
  });

  it("uses the newest run, not an older one that still had the offer", async () => {
    await arrange();
    await publishRun(OFFER, 30);
    await publishRun(null, 5);
    await expectRefusedUnchanged(command(), CommandConflictError, /There is no stretch offer now/);
  });

  it("names the action on offer when the answer is for another", async () => {
    await arrange();
    const error = await expectRefusedUnchanged(
      command({ actionId: "act-2" }),
      CommandConflictError,
      /The stretch on offer now is for "Unit 3 reading" \(act-1\), not act-2\./
    );
    expect(error.message).toContain("NEW command-id");
  });

  it("refuses when the run is older than the energy the person declared", async () => {
    await arrange({ energySetAt: minutes(-2).toISOString() });
    await publishRun(OFFER, 5);
    await expectRefusedUnchanged(command(), CommandConflictError, /has not caught up with the energy/);
  });

  it("refuses an action declined today, and every stretch after no stretches tonight", async () => {
    await arrange({ stretch: { accepted: [], declined: [{ actionId: "act-1", at: minutes(-30).toISOString() }] } });
    await expectRefusedUnchanged(command(), CommandConflictError, /declined this stretch today/);
    await patchSituation({ stretch: { accepted: [], declined: [], declinedAllAt: minutes(-30).toISOString() } });
    await expectRefusedUnchanged(command(), CommandConflictError, /no stretches tonight/);
  });

  it("refuses a stretch already running for the action, naming when it ends", async () => {
    await arrange({
      stretch: {
        accepted: [
          {
            actionId: "act-1",
            title: "Unit 3 reading",
            acceptedAt: minutes(-10).toISOString(),
            until: minutes(35).toISOString(),
            minutes: 45,
            by: "person"
          }
        ],
        declined: []
      }
    });
    await expectRefusedUnchanged(command(), CommandConflictError, /already running until \d\d:\d\d/);
  });

  it("refuses when there is no published plan run at all", async () => {
    await arrange();
    await sql`DELETE FROM planning_runs WHERE user_id=${userId}`;
    await expectRefusedUnchanged(command(), InvalidCommandError, /No Plan and Forecast Engine result/);
  });
});

describe("declining", () => {
  it("records a decline for the action without reading the plan, replacing an earlier one for it", async () => {
    await arrange();
    await sql`DELETE FROM planning_runs WHERE user_id=${userId}`;
    const cmd = command({ choice: "decline" });
    const { result } = await run(cmd);
    expect(result).toMatchObject({ outcome: "declined", actionId: "act-1", by: "person" });
    expect((await situation()).stretch).toEqual({
      accepted: [],
      declined: [{ actionId: "act-1", at: NOW.toISOString() }]
    });
    expect((await evidenceOf(cmd.commandId)).operation).toBe("stretch_decline");
    await run(command({ choice: "decline" }), minutes(10));
    expect((await situation()).stretch.declined).toEqual([{ actionId: "act-1", at: minutes(10).toISOString() }]);
  });

  it("needs the person's word from an agent, but lets decline_all be inferred", async () => {
    await arrange();
    await expect(asAgent(() => run(command({ choice: "decline" })))).rejects.toThrow(InvalidCommandError);
    await asAgent(() => run(command({ choice: "decline", ...STATED })));
    expect((await situation()).stretch.declined).toHaveLength(1);
    const all = command({ choice: "decline_all", actionId: undefined });
    const { result } = await asAgent(() => run(all));
    expect(result).toMatchObject({ outcome: "declined_all", by: "agent" });
    expect(result.next).toBe("No stretches until tomorrow; do not raise it again.");
    expect((await situation()).stretch.declinedAllAt).toBe(NOW.toISOString());
  });

  it("prunes on every stretch write: old loans, stale declines and an old no-stretches-tonight go", async () => {
    const days = (count: number) => new Date(NOW.getTime() - count * 86_400_000).toISOString();
    await arrange({
      stretch: {
        accepted: [
          { actionId: "old", title: "Old", acceptedAt: days(9), until: days(8), minutes: 30, by: "person" },
          { actionId: "recent", title: "Recent", acceptedAt: days(3), until: days(3), minutes: 30, by: "person" }
        ],
        declined: [
          { actionId: "stale", at: days(3) },
          { actionId: "yesterday", at: days(1) }
        ],
        declinedAllAt: days(3)
      }
    });
    await run(command({ choice: "decline", actionId: "fresh" }));
    const stretch = (await situation()).stretch;
    expect(stretch.accepted.map((record: { actionId: string }) => record.actionId)).toEqual(["recent"]);
    expect(stretch.declined.map((entry: { actionId: string }) => entry.actionId)).toEqual(["yesterday", "fresh"]);
    expect(stretch).not.toHaveProperty("declinedAllAt");
  });
});

describe("undo", () => {
  it("puts back a situation without stretch for an agent's accept, and redo brings it back", async () => {
    await arrange({ locationId: "home" });
    const cmd = command(STATED);
    await asAgent(() => run(cmd));
    expect((await situation()).stretch).toBeDefined();
    await asAgent(() => revert(cmd.commandId));
    const undone = await situation();
    expect(undone).not.toHaveProperty("stretch");
    expect(undone).toMatchObject({ locationId: "home" });
    await asAgent(() => revert(cmd.commandId, "redo"));
    expect((await situation()).stretch.accepted[0]).toMatchObject({ actionId: "act-1", by: "agent" });
  });

  it("undoes an agent's decline: the offer comes back", async () => {
    await arrange();
    const cmd = command({ choice: "decline", ...STATED });
    await asAgent(() => run(cmd));
    await asAgent(() => revert(cmd.commandId));
    expect(await situation()).not.toHaveProperty("stretch");
  });

  it("still works after a phone location ping and an unrelated save, and keeps what they wrote", async () => {
    await arrange({ locationId: "home" });
    const cmd = command(STATED);
    await asAgent(() => run(cmd));
    const energySetAt = (await situation()).energySetAt;
    // The phone reports a place (no version bump), and the person saves something else (version bump).
    await patchSituation({ locationId: "campus", locationSetAt: minutes(20).toISOString() });
    await sql`UPDATE user_preferences SET version=version+1`;
    await patchSituation({ carrying: { laptop: true } });
    await asAgent(() => revert(cmd.commandId));
    const undone = await situation();
    expect(undone).not.toHaveProperty("stretch");
    expect(undone).toMatchObject({
      locationId: "campus",
      locationSetAt: minutes(20).toISOString(),
      energySetAt,
      carrying: { laptop: true }
    });
  });

  it("is refused once a later stretch answer has changed the stretch record", async () => {
    await arrange();
    const accept = command(STATED);
    await asAgent(() => run(accept));
    await run(command({ choice: "decline_all", actionId: undefined }), minutes(1));
    await expect(asAgent(() => revert(accept.commandId))).rejects.toThrow(/was changed after the agent's write/);
    expect((await situation()).stretch.accepted).toHaveLength(1);
  });

  it("lets the owner revert a person's own accept", async () => {
    await arrange({ locationId: "home" });
    const cmd = command();
    await run(cmd);
    const snapshot = await sql<
      { kind: string; state: string }[]
    >`SELECT kind, state FROM writes WHERE id=${cmd.commandId}`;
    expect(snapshot[0]).toMatchObject({ kind: "stretch", state: "applied" });
    await revert(cmd.commandId);
    const undone = await situation();
    expect(undone).not.toHaveProperty("stretch");
    expect(undone.locationId).toBe("home");
  });

  it("names the write as a stretch answer and keeps the rest of the settings row out of its image", async () => {
    await arrange();
    const cmd = command();
    await run(cmd);
    const [row] = await sql<
      { images: { table: string; before: Record<string, unknown>; after: Record<string, unknown> }[] }[]
    >`
      SELECT images FROM writes WHERE id=${cmd.commandId}`;
    const image = row!.images[0]!;
    expect(image.table).toBe("user_preferences");
    expect(Object.keys(image.after).sort()).toEqual(["stretch", "updated_at", "user_id", "version"]);
    expect(image.before.stretch).toBeNull();
  });
});

describe("nothing else can plant a stretch", () => {
  it("ignores a stretch inside a confirmed availability proposal", async () => {
    await arrange({ locationId: null });
    const planted = {
      accepted: [
        {
          actionId: "act-9",
          title: "Planted",
          acceptedAt: NOW.toISOString(),
          until: minutes(600).toISOString(),
          minutes: 600,
          by: "agent"
        }
      ],
      declined: []
    };
    const version = (await preferences()).version;
    const { proposal } = await proposeAgentChange(sql as never, "claude", {
      kind: "entity_command",
      summary: "Say energy",
      payload: {
        command: "save_entity",
        body: {
          expectedVersion: version,
          entityType: "current_availability",
          entity: { currentEnergy: "medium", assertedConditions: [], currentSituation: { stretch: planted } }
        }
      },
      basis: "inferred"
    });
    await resolveAgentProposal(sql as never, null, proposal.id, { decision: "confirm", revision: proposal.revision });
    expect((await preferences()).version).toBeGreaterThan(version);
    expect(await situation()).not.toHaveProperty("stretch");
  });

  it("keeps the stored stretch when the owner saves availability with a different one", async () => {
    await arrange();
    const { result } = await run(command());
    const entityCommand = {
      commandId: crypto.randomUUID(),
      expectedVersion: (await preferences()).version,
      type: "save_entity" as const,
      entityType: "current_availability" as const,
      entity: {
        currentEnergy: "low",
        assertedConditions: [],
        currentSituation: { stretch: { accepted: [], declined: [] } }
      }
    };
    await unplannedStore.saveEntity(entityCommand as never);
    expect((await situation()).stretch.accepted.map((record: { actionId: string }) => record.actionId)).toEqual([
      (result as StretchResult).actionId
    ]);
  });
});
