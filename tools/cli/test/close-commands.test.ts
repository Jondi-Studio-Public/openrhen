import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { EXIT } from "../src/errors.js";
import { memoryJournal } from "../src/undo-journal.js";
import { fakeFetch, type RecordedCall } from "./fake-fetch.js";
import { fixtureNow, fixtureRawState } from "./fixture-state.js";

const RESULT = {
  type: "project",
  id: "project-thesis",
  do: "close",
  verb: "archive",
  status: "archived",
  version: 6,
  batch: "b1",
  restore: {
    tool: "rhen_archive",
    arguments: { type: "project", id: "project-thesis", do: "restore", "expected-version": 6 }
  },
  cascaded: [],
  skipped: [],
  dependents: []
};

async function run(command: "archive" | "cancel", argv: string[], mcp = false) {
  const calls: RecordedCall[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const raw = fixtureRawState();
  raw.projects = (raw.projects as Record<string, unknown>[]).map((project) => ({ ...project, version: 4 }));
  const exitCode = await runCli([command, ...argv], {
    stdout: (text: string) => out.push(text),
    stderr: (text: string) => err.push(text),
    env: {},
    readConfigFile: () => null,
    now: () => fixtureNow,
    journal: memoryJournal(),
    mcp,
    fetchImpl: fakeFetch(
      { "/api/state": { body: { state: raw } }, "/api/commands/close": { body: { state: raw, closed: RESULT } } },
      calls
    )
  });
  return { exitCode, stdout: out.join("\n"), stderr: err.join("\n"), calls };
}
const posts = (calls: RecordedCall[]) => calls.filter((call) => call.method === "POST");
const dry = async (command: "archive" | "cancel", argv: string[]) => {
  const result = await run(command, [...argv, "--dry-run"]);
  return { ...result, payload: (JSON.parse(result.stdout) as { payload: Record<string, unknown> }).payload };
};

describe("archive and cancel send one close command", () => {
  it.each([
    ["archive", "area", "area-study", "area"],
    ["archive", "project", "project-thesis", "project"],
    ["archive", "outcome", "outcome-degree", "outcome"],
    ["cancel", "action", "action-draft", "action"],
    ["cancel", "commitment", "commitment-dentist", "commitment"]
  ] as const)("%s %s resolves the id and posts type, verb and do", async (verb, type, id, wireType) => {
    const { payload } = await dry(verb, [type, id, "close", "--reason", "finished"]);
    expect(payload).toMatchObject({ type: wireType, verb, do: "close", reason: "finished" });
    expect(typeof payload.id).toBe("string");
  });

  it("finds a row by exact title and sends the id it is stored under", async () => {
    const { payload } = await dry("archive", ["project", "Thesis", "close"]);
    expect(payload).toMatchObject({ id: "project-thesis" });
  });

  it("accepts the aliases a person says for a condition", async () => {
    for (const alias of ["place", "contact", "capability", "preset"]) {
      const { exitCode, stderr } = await run("archive", [alias, "nothing-here", "close", "--dry-run"]);
      // Resolved as a kind (so not "unknown type"); the row itself is missing in the fixture.
      expect(stderr, alias).not.toMatch(/Unknown type|cannot be archived/);
      expect(exitCode, alias).toBe(EXIT.notFound);
    }
  });

  it("passes expected-version and include-children through", async () => {
    const { payload } = await dry("archive", [
      "project",
      "project-thesis",
      "close",
      "--expected-version",
      "4",
      "--include-children",
      "--reason",
      "done"
    ]);
    expect(payload).toMatchObject({ expectedVersion: 4, includeChildren: true, reason: "done" });
  });

  it("--restore is sugar for do restore and sends the row's version", async () => {
    const { payload } = await dry("archive", ["project", "project-thesis", "--restore"]);
    expect(payload).toMatchObject({ do: "restore", verb: "archive" });
    expect(typeof payload.expectedVersion).toBe("number");
  });

  it("never defaults do to close", async () => {
    const neither = await run("archive", ["project", "project-thesis", "--dry-run"]);
    expect(neither.exitCode).toBe(EXIT.usage);
    expect(neither.stderr).toMatch(/close or restore/);
    const both = await run("archive", ["project", "project-thesis", "close", "--restore", "--dry-run"]);
    expect(both.exitCode).toBe(EXIT.usage);
    expect(posts(both.calls)).toHaveLength(0);
  });

  it("names the other tool when the type belongs to it", async () => {
    const cancelled = await run("archive", ["commitment", "commitment-dentist", "close"]);
    expect(cancelled.exitCode).toBe(EXIT.usage);
    expect(cancelled.stderr).toContain("rhen_cancel");
    const archived = await run("cancel", ["routine_preset", "x", "close"]);
    expect(archived.exitCode).toBe(EXIT.usage);
    expect(archived.stderr).toContain("rhen_archive");
    expect(posts(archived.calls)).toHaveLength(0);
  });

  it("prints the result and the restore call, as a tool call for an MCP agent", async () => {
    const shell = await run("archive", ["project", "project-thesis", "close", "--reason", "done"]);
    expect(shell.exitCode).toBe(EXIT.ok);
    expect(shell.stdout).toContain("rhen archive project project-thesis --restore");
    const mcp = await run("archive", ["project", "project-thesis", "close", "--reason", "done"], true);
    expect(mcp.stdout).toContain("rhen_archive");
    expect(mcp.stdout).toMatch(/"do":"restore"/);
    expect(mcp.stdout).not.toContain("--restore");
  });

  it("--json returns the portal's result", async () => {
    const { stdout } = await run("archive", ["project", "project-thesis", "close", "--reason", "done", "--json"]);
    expect(JSON.parse(stdout)).toMatchObject({ closed: { status: "archived", version: 6 } });
  });
});
