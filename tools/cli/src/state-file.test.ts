import { describe, expect, it } from "vitest";
import { unreachableFetch, type RecordedCall } from "../test/fake-fetch.js";
import { fixtureNow, fixtureState } from "../test/fixture-state.js";
import { runCli, type CliIo } from "./cli.js";
import { EXIT } from "./errors.js";

/**
 * Exactly what `rhen state --json` (no `--key`) would print for the fixture: the normalised
 * document `getState()` returns, `planning` included — built from the real contract shape via
 * `fixtureState()` (`normaliseState` over `portalStateSchema`, throwing if the fixture were invalid),
 * not typed out by hand, so the snapshot stays valid as the contract evolves.
 */
function snapshotText(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify(fixtureState(overrides));
}

/** A `fetch` that fails the test immediately if `--state-file` ever reaches for the network. */
function fetchThatMustNeverRun(): typeof fetch {
  return unreachableFetch();
}

function io(overrides: Partial<CliIo> = {}): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
      env: {},
      fetchImpl: fetchThatMustNeverRun(),
      now: () => fixtureNow,
      readConfigFile: () => null,
      readStateFile: () => snapshotText(),
      ...overrides
    }
  };
}

describe("--state-file: no network is ever reached", () => {
  it("list <entity> --search --json is served from the snapshot", async () => {
    const { io: options, stdout } = io();
    const code = await runCli(
      ["list", "actions", "--search", "chapter", "--json", "--state-file", "/snap.json"],
      options
    );
    expect(code).toBe(EXIT.ok);
    const rows = JSON.parse(stdout[0] ?? "[]") as { id: string }[];
    expect(rows.map((row) => row.id)).toEqual(["action-draft"]);
  });

  it("show <type> <id> --json is served from the snapshot", async () => {
    const { io: options, stdout } = io();
    const code = await runCli(["show", "action", "action-draft", "--json", "--state-file", "/snap.json"], options);
    expect(code).toBe(EXIT.ok);
    const doc = JSON.parse(stdout[0] ?? "{}") as { item: { title: string } };
    expect(doc.item.title).toBe("Draft chapter 3");
  });

  it("list commitments --from --to --json is served from the snapshot", async () => {
    const { io: options, stdout } = io();
    const code = await runCli(
      ["list", "commitments", "--from", "2026-09-03", "--to", "2026-09-04", "--json", "--state-file", "/snap.json"],
      options
    );
    expect(code).toBe(EXIT.ok);
    const rows = JSON.parse(stdout[0] ?? "[]") as { id: string }[];
    expect(rows.map((row) => row.id)).toContain("commitment-gym");
  });

  it("list conditions --json is served from the snapshot", async () => {
    const { io: options, stdout } = io();
    const code = await runCli(["list", "conditions", "--json", "--state-file", "/snap.json"], options);
    expect(code).toBe(EXIT.ok);
    const rows = JSON.parse(stdout[0] ?? "[]") as { id: string }[];
    expect(rows.map((row) => row.id)).toContain("ctx-home");
  });

  it("state --json prints the whole snapshot document", async () => {
    const { io: options, stdout } = io();
    const code = await runCli(["state", "--state-file", "/snap.json"], options);
    expect(code).toBe(EXIT.ok);
    const parsed = JSON.parse(stdout[0] ?? "{}") as { actions: unknown[] };
    expect(Array.isArray(parsed.actions)).toBe(true);
  });

  it("--state-file implies --read-only: a mutating command is refused before any file or network read", async () => {
    const calls: string[] = [];
    const { io: options, stderr } = io({
      readStateFile: () => {
        calls.push("read");
        return snapshotText();
      }
    });
    const code = await runCli(["save", "action", "--state-file", "/snap.json"], options);
    expect(code).toBe(EXIT.usage);
    expect(stderr[0]).toContain("--state-file");
    expect(stderr[0]).toContain("read-only");
    expect(calls).toEqual([]); // the snapshot is never even loaded for a refused command
  });

  it("a missing or unreadable state file is a clear usage error, not a crash", async () => {
    const { io: options, stderr } = io({
      readStateFile: () => {
        throw new Error("ENOENT: no such file");
      }
    });
    const code = await runCli(["state", "--state-file", "/nope.json"], options);
    expect(code).toBe(EXIT.usage);
    expect(stderr[0]).toContain("/nope.json");
  });

  it("invalid JSON in the state file is a clear usage error", async () => {
    const { io: options, stderr } = io({ readStateFile: () => "not json" });
    const code = await runCli(["state", "--state-file", "/bad.json"], options);
    expect(code).toBe(EXIT.usage);
    expect(stderr[0]).toContain("not valid JSON");
  });

  it("status still works: its extra check-in fetch fails softly, not fatally", async () => {
    const { io: options, stdout } = io();
    const code = await runCli(["status", "--json", "--state-file", "/snap.json"], options);
    expect(code).toBe(EXIT.ok);
    const doc = JSON.parse(stdout[0] ?? "{}") as { checkIn: unknown };
    expect(doc.checkIn).toBeNull();
  });

  it("a read command that has no snapshot equivalent (changes) fails clearly rather than reaching the network", async () => {
    const { io: options, stderr } = io();
    const code = await runCli(["changes", "--state-file", "/snap.json"], options);
    expect(code).not.toBe(EXIT.ok);
    expect(stderr[0]).toContain("snapshot");
  });
});

describe("--read-only (no --state-file): refuses writes, still talks to the portal for reads", () => {
  it("a mutating command is refused without ever calling fetch", async () => {
    const calls: RecordedCall[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({
        method: (init?.method ?? "GET").toUpperCase(),
        path: new URL(typeof input === "string" ? input : input.toString()).pathname,
        url: String(input),
        headers: {},
        body: null
      });
      throw new Error("must never be called");
    };
    const { io: options, stderr } = io({ fetchImpl });
    const code = await runCli(["save", "action", "--read-only"], options);
    expect(code).toBe(EXIT.usage);
    expect(stderr[0]).toContain("read-only");
    expect(calls).toEqual([]);
  });

  it("mcp itself is exempt: --read-only never refuses `rhen mcp` before it runs", async () => {
    // mcp is offline and mutates:true (it can serve mutating tools by default); --read-only describes
    // the tool table it serves, not a write mcp itself is about to make, so it must not be refused by
    // the dispatcher. Asserted indirectly: an invalid --port reaches mcp's own validation instead of
    // being pre-empted by the dispatcher's "cannot run with --read-only" refusal.
    const { io: options, stderr } = io({ fetchImpl: fetchThatMustNeverRun() });
    const code = await runCli(["mcp", "--read-only", "--http", "--port", "notanumber"], options);
    expect(code).toBe(EXIT.usage);
    expect(stderr[0]).toContain("--port must be a whole number");
  });
});
