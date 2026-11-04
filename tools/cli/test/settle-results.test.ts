import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { fakeFetch, type RecordedCall } from "./fake-fetch.js";
import { fixtureNow, fixtureRawState } from "./fixture-state.js";

const GIVEN = "5b1f3c1e-0f7a-4c52-9d0e-6a1d4f0b2a11";

async function run(argv: string[], routes: Parameters<typeof fakeFetch>[0] = {}, raw = fixtureRawState()) {
  const calls: RecordedCall[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runCli([...argv, "--json"], {
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
    env: {},
    readConfigFile: () => null,
    now: () => fixtureNow,
    fetchImpl: fakeFetch({ "/api/state": { body: { state: raw } }, ...routes }, calls)
  });
  return { exitCode, stdout: stdout.join("\n"), stderr: stderr.join("\n"), calls };
}

const settleRoute = "/api/commands/catch-up-settle";
const bigState = { settings: { padding: "x".repeat(3000) } };
const answer = (results: unknown[]) => ({
  body: { result: { results, closed: false, remaining: 1 }, state: bigState }
});

describe("F24 catch-up-settle reports an invalid verdict as an error", () => {
  it("fails a stale wake settled without at, says rhen_wake or done with at, and omits the state", async () => {
    const { exitCode, stdout } = await run(
      ["catch-up-settle", "--verdicts-json", '[{"entryId":"wake","verdict":"done"}]'],
      { [settleRoute]: answer([{ entryId: "wake", outcome: "invalid", message: "Say when the person woke (`at`)." }]) }
    );
    expect(exitCode).not.toBe(0);
    expect(stdout.length).toBeLessThan(2500);
    expect(stdout).not.toContain("xxxxx");
    const error = JSON.parse(stdout).error as string;
    expect(error).toContain('"wake"');
    expect(error).toContain("rhen_wake");
    expect(error).toContain('"verdict":"done"');
    expect(error).toContain('"at"');
  });

  it("fails an unknown entry id and names rhen_catch_up", async () => {
    const { exitCode, stdout } = await run(
      ["catch-up-settle", "--verdicts-json", '[{"entryId":"nope","verdict":"done"}]'],
      { [settleRoute]: answer([{ entryId: "nope", outcome: "invalid", message: "Unknown entry id." }]) }
    );
    expect(exitCode).not.toBe(0);
    const error = JSON.parse(stdout).error as string;
    expect(error).toContain('"nope"');
    expect(error).toContain("rhen_catch_up");
  });

  it("still succeeds when every verdict applied", async () => {
    const { exitCode } = await run(
      ["catch-up-settle", "--verdicts-json", '[{"entryId":"occurrence:o1","verdict":"done"}]'],
      { [settleRoute]: answer([{ entryId: "occurrence:o1", outcome: "applied" }]) }
    );
    expect(exitCode).toBe(0);
  });
});

describe("F25b all_dropped without a project uses the MCP argument name", () => {
  it("bulk form says pass project, not a schema path", async () => {
    const { exitCode, stdout } = await run(["catch-up-settle", "--bulk", "all_dropped"]);
    expect(exitCode).not.toBe(0);
    const error = JSON.parse(stdout).error as string;
    expect(error).not.toContain("verdicts.0.projectId");
    expect(error).toContain("project");
    expect(error).toContain("rhen_list");
  });

  it("the verdicts-json form says projectId inside the verdict", async () => {
    const { exitCode, stdout } = await run(["catch-up-settle", "--verdicts-json", '[{"bulk":"all_dropped"}]']);
    expect(exitCode).not.toBe(0);
    expect(JSON.parse(stdout).error).not.toContain("verdicts.0.projectId");
  });
});

describe("F3 a save says whether it applied or was filed", () => {
  it("an applied save carries applied: true", async () => {
    const raw = fixtureRawState();
    const { exitCode, stdout } = await run(
      ["save", "capture", "--set", "text=Buy milk"],
      {
        "/api/commands/entity": (call) => {
          const entity = (call.body as { entity: Record<string, unknown>; commandId: string }).entity;
          const id = (call.body as { commandId: string }).commandId;
          return {
            body: {
              state: {
                ...raw,
                captures: [...(raw.captures as unknown[]), { id, status: "pending", version: 1, ...entity }]
              }
            }
          };
        }
      },
      raw
    );
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ applied: true, text: "Buy milk", version: 1 });
  });

  it("a filed save carries applied: false and the proposal id", async () => {
    const { stdout } = await run(["save", "capture", "--set", "text=Buy milk"], {
      "/api/commands/entity": { status: 202, body: { proposal: { id: "prop-1", status: "pending" } } }
    });
    expect(JSON.parse(stdout)).toMatchObject({ filedAsProposal: true, applied: false, proposalId: "prop-1" });
  });

  it("capture says applied: true too", async () => {
    const raw = fixtureRawState();
    const { stdout } = await run(
      ["capture", "Buy milk"],
      {
        "/api/commands/entity": () => ({
          body: {
            state: {
              ...raw,
              captures: [
                ...(raw.captures as unknown[]),
                { id: "c-new", text: "Buy milk", status: "pending", version: 1 }
              ]
            }
          }
        })
      },
      raw
    );
    expect(JSON.parse(stdout)).toMatchObject({ applied: true, id: "c-new" });
  });
});

describe("F16 span add returns the saved span", () => {
  it("returns id and version even when the answer's state lacks the span", async () => {
    const { exitCode, stdout } = await run(
      ["span", "add", "--title", "Trip", "--start", "2026-09-10", "--end", "2026-09-12", "--command-id", GIVEN],
      { "/api/commands/entity": () => ({ body: { state: { ...fixtureRawState(), spans: [] } } }) },
      { ...fixtureRawState(), spans: [] }
    );
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      applied: true,
      id: GIVEN,
      version: 1,
      title: "Trip",
      startDate: "2026-09-10",
      endDate: "2026-09-12"
    });
  });
});

describe("F4 a replayed command id is reported as a replay", () => {
  it("save: returns the original record and says it was not applied again", async () => {
    const raw = fixtureRawState();
    const stored = { id: GIVEN, text: "Buy milk", status: "pending", version: 1 };
    const state = { ...raw, captures: [...(raw.captures as unknown[]), stored] };
    const { exitCode, stdout } = await run(
      ["save", "capture", "--set", "text=Buy milk", "--command-id", GIVEN],
      { "/api/commands/entity": { body: { state } } },
      state
    );
    expect(exitCode).toBe(0);
    const out = JSON.parse(stdout);
    expect(out).toMatchObject({ replayed: true, applied: false, id: GIVEN, version: 1, text: "Buy milk" });
    expect(out.message).toMatch(/replay/i);
    expect(out.message).toContain("nothing was written again");
  });

  it("capture: same", async () => {
    const raw = fixtureRawState();
    const stored = { id: GIVEN, text: "Buy milk", status: "pending", version: 1 };
    const state = { ...raw, captures: [...(raw.captures as unknown[]), stored] };
    const { stdout } = await run(
      ["capture", "Buy milk", "--command-id", GIVEN],
      { "/api/commands/entity": { body: { state } } },
      state
    );
    expect(JSON.parse(stdout)).toMatchObject({ replayed: true, applied: false, id: GIVEN });
  });
});

describe("catch-up-settle reports a conflict as an error", () => {
  const verdicts = '[{"entryId":"occurrence:o1","verdict":"done"}]';
  const conflict = {
    entryId: "occurrence:o1",
    outcome: "conflict",
    message: "The entry changed after the ledger was read."
  };

  it("fails when the only problem is a conflict, naming the entry, the reason and the exact next call", async () => {
    const { exitCode, stdout } = await run(["catch-up-settle", "--verdicts-json", verdicts], {
      [settleRoute]: answer([conflict])
    });
    expect(exitCode).not.toBe(0);
    const document = JSON.parse(stdout) as { error: string; details: { results: unknown[] }; nextCall?: unknown };
    expect(document.error).toContain('"occurrence:o1"');
    expect(document.error).toContain("changed");
    expect(document.error).toContain("The entry changed after the ledger was read.");
    expect(document.error).toContain("rhen_catch_up");
    expect(document.error).toContain("new command-id");
    expect(document.nextCall).toMatchObject({ tool: "rhen_catch_up", arguments: {} });
    expect(document.details.results).toHaveLength(1);
    expect(stdout).not.toContain("xxxxx");
  });

  it("with an applied verdict beside it, says the applied one stays settled", async () => {
    const { exitCode, stdout } = await run(["catch-up-settle", "--verdicts-json", verdicts], {
      [settleRoute]: answer([{ entryId: "occurrence:o2", outcome: "applied" }, conflict])
    });
    expect(exitCode).not.toBe(0);
    const document = JSON.parse(stdout) as { error: string; nextCall?: unknown };
    expect(document.error).toContain("1 others were settled and stay settled");
    expect(document.nextCall).toMatchObject({ tool: "rhen_catch_up", arguments: {} });
  });
});
