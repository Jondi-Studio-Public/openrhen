import { planningEntityCommandSchema } from "@openrhen/contracts";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { EXIT } from "../src/errors.js";
import { memoryJournal, type Journal } from "../src/undo-journal.js";
import { fakeFetch, type RecordedCall } from "./fake-fetch.js";
import { fixtureNow, fixtureRawState } from "./fixture-state.js";

interface Run {
  exitCode: number;
  stdout: string;
  stderr: string;
  calls: RecordedCall[];
}

/** The fixture with the gym session at a stored version, and the plan reported as still recalculating. */
function stateWith(awaitingRecalculation: boolean): Record<string, unknown> {
  const raw = fixtureRawState();
  raw.commitments = (raw.commitments as Record<string, unknown>[]).map((item) =>
    item.id === "commitment-gym" ? { ...item, version: 4 } : item
  );
  raw.planning = { ...(raw.planning as Record<string, unknown>), awaitingRecalculation };
  return raw;
}

async function run(
  argv: string[],
  raw: Record<string, unknown>,
  journal: Journal = memoryJournal(),
  routes: Parameters<typeof fakeFetch>[0] = {}
): Promise<Run> {
  const calls: RecordedCall[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const exitCode = await runCli(argv, {
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    env: {},
    readConfigFile: () => null,
    now: () => fixtureNow,
    journal,
    fetchImpl: fakeFetch(
      { "/api/state": { body: { state: raw } }, "/api/commands/entity": { body: { state: raw } }, ...routes },
      calls
    )
  });
  return { exitCode, stdout: out.join("\n"), stderr: err.join("\n"), calls };
}

const posted = (calls: RecordedCall[]) =>
  calls.filter((call) => call.method === "POST").map((call) => call.body as Record<string, unknown>);

describe("free", () => {
  it("sends id and free alone, at the version it read, as a commitment save", async () => {
    const { exitCode, calls } = await run(["free", "commitment-gym", "--json"], stateWith(false));
    expect(exitCode).toBe(EXIT.ok);
    const [body] = posted(calls);
    expect(body).toMatchObject({
      type: "save_entity",
      entityType: "commitment",
      expectedVersion: 4,
      entity: { id: "commitment-gym", free: true }
    });
    expect(Object.keys(body!.entity as object).sort()).toEqual(["free", "id"]);
    expect(planningEntityCommandSchema.safeParse(body).success).toBe(true);
  });

  it("finds the commitment by its exact title", async () => {
    const { exitCode, calls } = await run(["free", "Gym session", "--json"], stateWith(false));
    expect(exitCode).toBe(EXIT.ok);
    expect((posted(calls)[0]!.entity as Record<string, unknown>).id).toBe("commitment-gym");
  });

  it("says it applied, that nothing was ended, and names rhen_status as the next call", async () => {
    const { stdout } = await run(["free", "commitment-gym", "--json"], stateWith(false));
    const answer = JSON.parse(stdout) as Record<string, unknown>;
    expect(answer).toMatchObject({ applied: true, awaitingRecalculation: false, nextCall: "rhen_status {}" });
    expect(String(answer.placement)).toContain("Nothing was ended, finished, moved or cancelled");
    expect(String(answer.placement)).toContain("rhen_status {}");
    expect(String(answer.placement)).toContain('"free":false');
  });

  it("reports awaitingRecalculation while the plan is still being recalculated", async () => {
    const { stdout } = await run(["free", "commitment-gym", "--json"], stateWith(true));
    const answer = JSON.parse(stdout) as Record<string, unknown>;
    expect(answer.awaitingRecalculation).toBe(true);
    expect(String(answer.placement)).toContain("awaitingRecalculation is true");
    expect(String(answer.placement)).toContain("rhen_status {}");
    expect(String(answer.placement)).toContain("rhen_recalculate {}");
  });

  it("--undo sends free false", async () => {
    const { exitCode, calls } = await run(["free", "commitment-gym", "--undo", "--json"], stateWith(false));
    expect(exitCode).toBe(EXIT.ok);
    expect(posted(calls)[0]!.entity).toEqual({ id: "commitment-gym", free: false });
  });

  it("is journaled, and undo sends the opposite statement", async () => {
    const journal = memoryJournal();
    const raw = stateWith(false);
    // A portal that bumps the commitment's version on every applied statement, as the real one does.
    const bump = () => {
      const gym = (raw.commitments as Record<string, unknown>[]).find((item) => item.id === "commitment-gym")!;
      gym.version = (gym.version as number) + 1;
      return { body: { state: raw } };
    };
    const first = await run(["free", "commitment-gym", "--json"], raw, journal, { "/api/commands/entity": bump });
    expect(first.exitCode).toBe(EXIT.ok);
    const undone = await run(["undo", "--json"], raw, journal, { "/api/commands/entity": bump });
    expect(undone.exitCode).toBe(EXIT.ok);
    const sent = posted(undone.calls).at(-1)!;
    expect(sent.entity).toEqual({ id: "commitment-gym", free: false });
    expect(sent.expectedVersion).toBe(5);
  });

  it("refuses an unknown commitment and posts nothing", async () => {
    const { exitCode, calls } = await run(["free", "nowhere"], stateWith(false));
    expect(exitCode).toBe(EXIT.notFound);
    expect(posted(calls)).toHaveLength(0);
  });
});

describe("save commitment with free", () => {
  it("refuses free sent with another field, and posts nothing", async () => {
    const { exitCode, stderr, calls } = await run(
      ["save", "commitment", "--fields", '{"id":"commitment-gym","free":true,"title":"Other"}'],
      stateWith(false)
    );
    expect(exitCode).toBe(EXIT.validation);
    expect(stderr).toContain("free is a statement on its own");
    expect(posted(calls)).toHaveLength(0);
  });

  it("refuses a free that is not a boolean", async () => {
    const { exitCode } = await run(
      ["save", "commitment", "--fields", '{"id":"commitment-gym","free":"yes"}'],
      stateWith(false)
    );
    expect(exitCode).toBe(EXIT.validation);
  });

  it("refuses free with no id, naming where the id is", async () => {
    const { exitCode, stderr } = await run(["save", "commitment", "--fields", '{"free":true}'], stateWith(false));
    expect(exitCode).toBe(EXIT.notFound);
    expect(stderr).toContain("give its id");
  });

  it("sends free:false as an undo of an earlier free", async () => {
    const { calls } = await run(
      ["save", "commitment", "--fields", '{"id":"commitment-gym","free":false}', "--json"],
      stateWith(false)
    );
    expect(posted(calls)[0]!.entity).toEqual({ id: "commitment-gym", free: false });
  });
});
