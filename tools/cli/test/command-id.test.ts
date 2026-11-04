import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { buildLineContext, handleLine } from "../src/commands/mcp.js";
import { EXIT } from "../src/errors.js";
import { commands } from "../src/registry.js";
import type { CommandContext, ParsedArgs } from "../src/command.js";
import { deriveCommandId, stampCommandId } from "../src/write.js";
import { fakeFetch, type RecordedCall } from "./fake-fetch.js";
import { fixtureNow, fixtureRawState } from "./fixture-state.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const GIVEN_ID = "5b1f3c1e-0f7a-4c52-9d0e-6a1d4f0b2a11";

interface Run {
  exitCode: number;
  stdout: string;
  stderr: string;
  calls: RecordedCall[];
}

/** `capture` posts to /api/commands/entity; `attempts` decides what each POST does (an Error is thrown, a number is an HTTP status). */
async function capture(argv: string[], attempts: (Error | number)[] = []): Promise<Run> {
  const calls: RecordedCall[] = [];
  const base = fakeFetch(
    {
      "/api/state": { body: { state: fixtureRawState() } },
      "/api/commands/entity": () => {
        const next = attempts[calls.filter((call) => call.method === "POST").length - 1];
        return typeof next === "number"
          ? { status: next, body: { error: `http ${next}` } }
          : { body: { state: fixtureRawState() } };
      }
    },
    calls
  );
  const fetchImpl: typeof fetch = async (input, init) => {
    const response = await base(input, init);
    const posts = calls.filter((call) => call.method === "POST").length;
    const planned = init?.method === "POST" ? attempts[posts - 1] : undefined;
    if (planned instanceof Error) throw planned;
    return response;
  };
  let stdout = "";
  let stderr = "";
  const exitCode = await runCli(["capture", "buy milk", ...argv], {
    stdout: (text) => (stdout += `${text}\n`),
    stderr: (text) => (stderr += `${text}\n`),
    env: {},
    readConfigFile: () => null,
    now: () => fixtureNow,
    fetchImpl
  });
  return { exitCode, stdout, stderr, calls };
}

const posts = (run: Run) => run.calls.filter((call) => call.method === "POST");
const idOf = (call: RecordedCall) => (call.body as { commandId: string }).commandId;
const timeout = () => Object.assign(new Error("The operation timed out."), { name: "TimeoutError" });

describe("write retry", () => {
  it("retries once with the same commandId and body after a timeout", async () => {
    const run = await capture([], [timeout()]);
    expect(run.exitCode).toBe(EXIT.ok);
    const sent = posts(run);
    expect(sent).toHaveLength(2);
    expect(idOf(sent[0]!)).toMatch(UUID);
    expect(sent[1]!.body).toEqual(sent[0]!.body);
  });

  it("retries after a connection failure too", async () => {
    const run = await capture([], [new TypeError("fetch failed")]);
    expect(run.exitCode).toBe(EXIT.ok);
    expect(posts(run)).toHaveLength(2);
  });

  it.each([400, 409, 500, 503])("does not retry an HTTP %i answer", async (status) => {
    const run = await capture([], [status]);
    expect(run.exitCode).not.toBe(EXIT.ok);
    expect(posts(run)).toHaveLength(1);
  });

  it("names the command id and how to repeat it when both attempts get no answer", async () => {
    const run = await capture([], [timeout(), timeout()]);
    expect(run.exitCode).toBe(EXIT.unavailable);
    expect(posts(run)).toHaveLength(2);
    const id = idOf(posts(run)[0]!);
    expect(run.stderr).toContain("did not answer within");
    expect(run.stderr).toContain(`command id ${id}`);
    expect(run.stderr).toContain(`repeat with --command-id ${id} to apply it at most once`);
  });

  it("puts the command id in the --json error as commandId", async () => {
    const run = await capture(["--json"], [timeout(), timeout()]);
    const id = idOf(posts(run)[0]!);
    expect(JSON.parse(run.stdout)).toMatchObject({ exitCode: EXIT.unavailable, commandId: id });
  });

  it("does not retry a read", async () => {
    let gets = 0;
    const exitCode = await runCli(["status"], {
      stdout: () => {},
      stderr: () => {},
      env: {},
      readConfigFile: () => null,
      now: () => fixtureNow,
      fetchImpl: async () => {
        gets += 1;
        throw new TypeError("fetch failed");
      }
    });
    expect(exitCode).toBe(EXIT.unavailable);
    expect(gets).toBe(1);
  });
});

describe("--command-id", () => {
  it("sends the key as the commandId, on retries too", async () => {
    const run = await capture(["--command-id", GIVEN_ID.toUpperCase()], [timeout()]);
    expect(run.exitCode).toBe(EXIT.ok);
    expect(posts(run).map(idOf)).toEqual([GIVEN_ID, GIVEN_ID]);
  });

  it("two invocations with the same key send the same commandId", async () => {
    const first = await capture(["--command-id", GIVEN_ID]);
    const second = await capture(["--command-id", GIVEN_ID]);
    expect(idOf(posts(first)[0]!)).toBe(idOf(posts(second)[0]!));
  });

  it("says nothing new was saved when the portal kept an earlier command under the same id", async () => {
    // The fixture state never holds "buy milk", which is what a replay of a different capture returns.
    const run = await capture(["--command-id", GIVEN_ID]);
    expect(run.exitCode).toBe(EXIT.ok);
    expect(run.stdout).toContain("Nothing new was saved");
    expect(run.stdout).not.toContain("Captured.");
  });

  it("rejects a key that is not a uuid, before any request", async () => {
    const run = await capture(["--command-id", "my-key"]);
    expect(run.exitCode).toBe(EXIT.usage);
    expect(run.stderr).toContain("--command-id must be a uuid");
    expect(run.calls).toHaveLength(0);
  });

  it("is refused on a command that only reads", async () => {
    const run = await runCli(["status", "--command-id", GIVEN_ID], {
      stdout: () => {},
      stderr: () => {},
      env: {},
      readConfigFile: () => null,
      fetchImpl: fakeFetch({})
    });
    expect(run).toBe(EXIT.usage);
  });

  it("shows the keyed commandId in --dry-run", async () => {
    const run = await capture(["--command-id", GIVEN_ID, "--dry-run"]);
    expect(posts(run)).toHaveLength(0);
    expect(run.stdout).toContain(GIVEN_ID);
  });

  it("derives distinct, stable ids from a key", () => {
    const a = deriveCommandId(GIVEN_ID, "write-1");
    expect(a).toMatch(UUID);
    expect(a).toBe(deriveCommandId(GIVEN_ID, "write-1"));
    expect(a).not.toBe(deriveCommandId(GIVEN_ID, "write-2"));
    expect(a[14]).toBe("5");
  });
});

describe("--command-id over MCP", () => {
  it("is in the input schema of every mutating tool and no read-only one", async () => {
    const ctx = await buildLineContext();
    const response = JSON.parse(
      (await handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }), ctx)) ?? "{}"
    ) as {
      result: { tools: { name: string; inputSchema: { properties: Record<string, unknown> } }[] };
    };
    const mutating = new Set(
      commands
        .filter((spec) => spec.mutates && spec.name !== "mcp" && !spec.ownerOnly)
        .map((spec) => `rhen_${spec.name.replace(/-/g, "_")}`)
    );
    expect(mutating.size).toBeGreaterThan(5);
    for (const tool of response.result.tools)
      expect("command-id" in tool.inputSchema.properties, tool.name).toBe(mutating.has(tool.name));
  });

  it("forwards the key onto the dispatched command line", async () => {
    const seen: string[][] = [];
    const ctx = await buildLineContext(async (argv, capture) => {
      seen.push([...argv]);
      capture.stdout("{}");
      return 0;
    });
    const request = (args: Record<string, unknown>) =>
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "rhen_capture", arguments: args }
      });
    await handleLine(request({ text: "x", "command-id": GIVEN_ID }), ctx);
    expect(seen[0]).toContain(`--command-id=${GIVEN_ID}`);
  });
});

describe("multi-write commands", () => {
  const stamp = (key: string | undefined, count: number, suffixes: (string | undefined)[] = []) => {
    const context = {} as CommandContext;
    const args: ParsedArgs = { positionals: [], values: key ? { "command-id": key } : {} };
    return Array.from({ length: count }, (_, index) => {
      const { payload } = stampCommandId(context, args, { commandId: "original" }, suffixes[index]);
      return payload.commandId as string;
    });
  };

  it("uses the key for the first write and derives the rest from it, the same on every repeat", () => {
    const ids = stamp(GIVEN_ID, 3);
    expect(ids[0]).toBe(GIVEN_ID);
    expect(new Set(ids).size).toBe(3);
    expect(stamp(GIVEN_ID, 3)).toEqual(ids);
  });

  it("derives by name when the writes have stable names", () => {
    const ids = stamp(GIVEN_ID, 2, ["row-a", "row-b"]);
    expect(stamp(GIVEN_ID, 2, ["row-b", "row-a"])).toEqual([ids[1], ids[0]]);
  });

  it("mints one key per invocation when none is given", () => {
    const [first, second] = stamp(undefined, 2);
    expect(first).toMatch(UUID);
    expect(second).toBe(deriveCommandId(first!, "write-1"));
  });
});

describe("a new record the caller left to the portal", () => {
  const stamp = (payload: Record<string, unknown>) =>
    stampCommandId({} as CommandContext, { positionals: [], values: { "command-id": GIVEN_ID } }, payload).payload;

  it.each(["entity", "action", "project"])("follows the key when the %s is keyed by its command id", (key) => {
    const stamped = stamp({ commandId: "minted", [key]: { id: "minted", title: "Call mum" } });
    expect(stamped.commandId).toBe(GIVEN_ID);
    expect(stamped[key]).toEqual({ id: GIVEN_ID, title: "Call mum" });
  });

  it.each(["entity", "action", "project"])("leaves a chosen %s id alone", (key) => {
    const stamped = stamp({ commandId: "minted", [key]: { id: "action-call-mum", title: "Call mum" } });
    expect(stamped.commandId).toBe(GIVEN_ID);
    expect(stamped[key]).toEqual({ id: "action-call-mum", title: "Call mum" });
  });
});
