import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { EXIT } from "../src/errors.js";
import { memoryJournal, type Journal } from "../src/undo-journal.js";
import { fakeFetch, type RecordedCall } from "./fake-fetch.js";
import { fixtureActiveSession, fixtureNow, fixtureRawState } from "./fixture-state.js";

/**
 * Sessions, check-ins and catch-up settles an agent makes are reverted by the portal from rows it saved
 * (`/api/commands/revert`), so their journal entries are `serverChecked`: the CLI sends the stored request with a
 * fresh command id and leaves the version checks to the portal.
 */

interface Run {
  exitCode: number;
  stdout: string;
  stderr: string;
  calls: RecordedCall[];
}

const RUNNING = fixtureActiveSession().activeSession as Record<string, unknown>;
const raw = { ...fixtureRawState(), activeSession: { ...RUNNING, version: 4 } };
const CHECK_IN_ID = "e9f6ac30-f59f-4852-a65b-d3074da3b090";
const VERDICTS = '[{"entryId":"occurrence:o1","verdict":"done"}]';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Routes = Parameters<typeof fakeFetch>[0];

/** A portal that answers each agent write with `revertible` set to the write's command id (when `revertible`). */
function portal(options: { revertible?: boolean; revert?: Routes[string] } = {}): Routes {
  const revertible = options.revertible ?? true;
  const answer = (call: RecordedCall) => ({
    body: { state: raw, ...(revertible ? { revertible: (call.body as { commandId: string }).commandId } : {}) }
  });
  return {
    "/api/state": { body: { state: raw } },
    "/api/check-ins/current": { body: { checkIn: { id: CHECK_IN_ID, version: 3, status: "pending" } } },
    "/api/commands/session": answer,
    "/api/commands/entity": answer,
    "/api/commands/check-in": answer,
    "/api/commands/catch-up-settle": (call) => ({
      body: {
        result: { results: [{ entryId: "occurrence:o1", outcome: "applied" }], closed: false, remaining: 1 },
        state: raw,
        ...(revertible ? { revertible: (call.body as { commandId: string }).commandId } : {})
      }
    }),
    "/api/commands/revert": options.revert ?? { body: { state: raw } }
  };
}

async function run(
  argv: string[],
  journal: Journal,
  routes: Routes,
  options: { agent?: string; byOwner?: boolean; remote?: boolean } = {}
): Promise<Run> {
  const calls: RecordedCall[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const exitCode = await runCli(options.agent ? [...argv, "--agent", options.agent] : argv, {
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    env: {},
    readConfigFile: () => null,
    now: () => fixtureNow,
    journal,
    byOwner: options.byOwner,
    remote: options.remote,
    fetchImpl: fakeFetch(routes, calls)
  });
  return { exitCode, stdout: out.join("\n"), stderr: err.join("\n"), calls };
}

const posts = (calls: RecordedCall[]) => calls.filter((call) => call.method === "POST");

describe("journaling a write the portal can revert", () => {
  it("records a serverChecked entry for a session write answered with revertible", async () => {
    const journal = memoryJournal();
    const result = await run(["session", "pause"], journal, portal(), { agent: "alice" });
    expect(result.exitCode).toBe(EXIT.ok);
    const sent = posts(result.calls)[0]!.body as { commandId: string };
    const [entry] = journal.read();
    expect(entry).toMatchObject({
      status: "applied",
      owner: "agent:alice",
      serverChecked: true,
      undo: { path: "/api/commands/revert", payload: { target: sent.commandId, direction: "undo" } },
      redo: { path: "/api/commands/revert", payload: { target: sent.commandId, direction: "redo" } },
      target: { stateKey: "revert", id: sent.commandId }
    });
    expect(entry).not.toHaveProperty("version");
    expect(result.stderr).toContain("undo with `rhen undo`");
  });

  it("records nothing when the answer does not say the write is revertible", async () => {
    const journal = memoryJournal();
    const result = await run(["session", "pause"], journal, portal({ revertible: false }));
    expect(result.exitCode).toBe(EXIT.ok);
    expect(journal.read()).toEqual([]);
    expect(result.stderr).not.toContain("rhen undo");
  });

  it("records a check-in answer", async () => {
    const journal = memoryJournal();
    const result = await run(["check-in", "on-track"], journal, portal(), { agent: "alice" });
    expect(result.exitCode).toBe(EXIT.ok);
    expect(journal.read()).toHaveLength(1);
    expect(journal.read()[0]).toMatchObject({ serverChecked: true, label: expect.stringContaining("check-in") });
    const none = memoryJournal();
    await run(["check-in", "on-track"], none, portal({ revertible: false }));
    expect(none.read()).toEqual([]);
  });

  it("records an applied catch-up settle, but not a proposal or an answer without revertible", async () => {
    const journal = memoryJournal();
    const applied = await run(["catch-up-settle", "--verdicts-json", VERDICTS], journal, portal(), {
      agent: "alice"
    });
    expect(applied.exitCode).toBe(EXIT.ok);
    expect(applied.stdout).toContain("Settled: 1 applied. 1 still unsettled.");
    expect(journal.read()).toHaveLength(1);
    const sent = posts(applied.calls)[0]!.body as { commandId: string };
    expect(journal.read()[0]).toMatchObject({
      serverChecked: true,
      owner: "agent:alice",
      target: { stateKey: "revert", id: sent.commandId }
    });
    expect(applied.stderr).toContain("undo with `rhen undo`");

    const proposal = memoryJournal();
    const held = await run(["catch-up-settle", "--verdicts-json", VERDICTS], proposal, {
      ...portal(),
      "/api/commands/catch-up-settle": {
        status: 202,
        body: { proposal: { id: "prop-1", status: "pending", summary: "Settle 1" }, outcome: "created" }
      }
    });
    expect(held.exitCode).toBe(EXIT.ok);
    expect(proposal.read()).toEqual([]);

    const owners = memoryJournal();
    await run(["catch-up-settle", "--verdicts-json", VERDICTS], owners, portal({ revertible: false }));
    expect(owners.read()).toEqual([]);
  });
});

describe("a save the portal kept rows for", () => {
  const SAVE = ["save", "area", "--id", "area-home", "--set", "name=Garden"];

  it("is journaled as server-checked, not restated, when the answer says revertible", async () => {
    const journal = memoryJournal();
    const result = await run(SAVE, journal, portal(), { agent: "alice" });
    expect(result.exitCode, result.stderr).toBe(EXIT.ok);
    const sent = posts(result.calls)[0]!.body as { commandId: string };
    expect(journal.read()).toHaveLength(1);
    expect(journal.read()[0]).toMatchObject({
      serverChecked: true,
      undo: { path: "/api/commands/revert", payload: { target: sent.commandId, direction: "undo" } }
    });
  });

  it("is still restated from the record as it was when the answer is not revertible", async () => {
    const journal = memoryJournal();
    const result = await run(SAVE, journal, portal({ revertible: false }), { agent: "alice" });
    expect(result.exitCode, result.stderr).toBe(EXIT.ok);
    expect(journal.read()).toHaveLength(1);
    expect(journal.read()[0]).not.toHaveProperty("serverChecked");
    expect(journal.read()[0]!.undo.path).toBe("/api/commands/entity");
  });
});

describe("undo and redo of a serverChecked entry", () => {
  const setup = async (routes: Routes = portal()) => {
    const journal = memoryJournal();
    await run(["session", "pause"], journal, routes, { agent: "alice" });
    const target = journal.read()[0]!.target.id!;
    const go = (
      argv: string[],
      options: { agent?: string; byOwner?: boolean; remote?: boolean } = { agent: "alice" }
    ) => run(argv, journal, routes, options);
    return { journal, target, go };
  };

  it("sends the revert payload with a fresh command id, reads no state, and marks the entry undone", async () => {
    const { journal, target, go } = await setup();
    const result = await go(["undo"]);
    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.calls.filter((call) => call.method === "GET")).toEqual([]);
    const [revert] = posts(result.calls);
    expect(revert?.path).toBe("/api/commands/revert");
    const body = revert!.body as Record<string, unknown>;
    expect(body).toEqual({ target, direction: "undo", commandId: expect.stringMatching(UUID_RE) });
    expect(body.commandId).not.toBe(target);
    expect(journal.read()[0]).toMatchObject({ status: "undone", undoSeq: 1 });
    expect(result.stdout).toContain("Undone:");
  });

  it("redoes it with direction redo, and a second undo works again", async () => {
    const { journal, target, go } = await setup();
    await go(["undo"]);
    const redone = await go(["undo", "--redo"]);
    expect(redone.exitCode).toBe(EXIT.ok);
    expect(posts(redone.calls)[0]!.body).toEqual({
      target,
      direction: "redo",
      commandId: expect.stringMatching(UUID_RE)
    });
    expect(journal.read()[0]).toMatchObject({ status: "applied" });
    expect(journal.read()[0]).not.toHaveProperty("undoSeq");
    expect((await go(["undo"])).exitCode).toBe(EXIT.ok);
    expect(journal.read()[0]?.status).toBe("undone");
  });

  it("passes force only when --force is given", async () => {
    const { go } = await setup();
    const plain = await go(["undo", "--dry-run"]);
    expect(posts(plain.calls)).toHaveLength(0);
    expect(plain.stdout).not.toContain("force");
    const forced = await go(["undo", "--force"]);
    expect(forced.exitCode).toBe(EXIT.ok);
    expect(posts(forced.calls)[0]!.body).toMatchObject({ direction: "undo", force: true });
  });

  it("maps a 409 to the conflict exit code with the portal's text, leaving the entry applied", async () => {
    const text = "session was changed after the agent's write, so undoing it would overwrite that change.";
    const { journal, go } = await setup(portal({ revert: { status: 409, body: { error: text } } }));
    const result = await go(["undo"]);
    expect(result.exitCode).toBe(EXIT.conflict);
    expect(result.stderr).toContain(text);
    expect(result.stderr).toContain("--force");
    expect(journal.read()[0]?.status).toBe("applied");
  });

  it("names what a remote agent can do instead of --force, and a local user keeps the hint", async () => {
    const text = "This save was changed after the agent's write, so undoing it would overwrite that change.";
    const routes = portal({ revert: { status: 409, body: { error: text } } });
    const { go } = await setup(routes);
    const remote = await go(["undo"], { agent: "alice", remote: true });
    expect(remote.exitCode).toBe(EXIT.conflict);
    expect(remote.stderr).toContain(text);
    expect(remote.stderr).toContain("Ask the owner to undo it from Review > Agent changes, or make a fresh save.");
    expect(remote.stderr).not.toContain("--force");
    const local = await go(["undo"], { agent: "alice" });
    expect(local.stderr).toContain("--force");
    expect(local.stderr).not.toContain("Review > Agent changes");
  });

  it("does not repeat the owner advice the portal already gave a remote agent", async () => {
    const text = "That changed since. Ask the owner to undo it from Review > Agent changes, or make a fresh save.";
    const { go } = await setup(portal({ revert: { status: 409, body: { error: text } } }));
    const remote = await go(["undo"], { agent: "alice", remote: true });
    expect(remote.stderr.match(/Review > Agent changes/g)).toHaveLength(1);
  });

  it("maps a 404 to not found and marks the entry superseded", async () => {
    const { journal, go } = await setup(portal({ revert: { status: 404, body: { error: "Nothing to revert." } } }));
    const result = await go(["undo"]);
    expect(result.exitCode).toBe(EXIT.notFound);
    expect(result.stderr).toContain("superseded");
    expect(journal.read()[0]?.status).toBe("superseded");
  });

  it("maps a 403 to a usage error and leaves the entry applied", async () => {
    const { journal, go } = await setup(portal({ revert: { status: 403, body: { error: "Not your write." } } }));
    const result = await go(["undo"]);
    expect(result.exitCode).toBe(EXIT.usage);
    expect(result.stderr).toContain("Not your write.");
    expect(journal.read()[0]?.status).toBe("applied");
  });

  it("keeps the owner check, and lets the owner reverse any entry with --any-owner --id", async () => {
    const { journal, go } = await setup();
    const id = journal.read()[0]!.id;
    const refused = await go(["undo"], { agent: "bob" });
    expect(refused.exitCode).toBe(EXIT.usage);
    expect(posts(refused.calls)).toHaveLength(0);

    const byOwner = await go(["undo", "--any-owner", "--id", id], { byOwner: true });
    expect(byOwner.exitCode).toBe(EXIT.ok);
    expect(journal.read()[0]).toMatchObject({ status: "undone", undoneBy: "owner" });
    // The agent cannot take back what the person undid.
    expect((await go(["undo", "--redo"])).exitCode).toBe(EXIT.notFound);
    const redone = await go(["undo", "--redo", "--any-owner", "--id", id], { byOwner: true });
    expect(redone.exitCode).toBe(EXIT.ok);
    expect(journal.read()[0]?.status).toBe("applied");
    expect(journal.read()[0]).not.toHaveProperty("undoneBy");
  });
});
