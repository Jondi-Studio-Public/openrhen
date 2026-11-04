import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { buildLineContext, handleLine, serveMcp } from "../src/commands/mcp.js";
import { startHttpMcpServer } from "../src/commands/mcp-http.js";
import { EXIT } from "../src/errors.js";
import { fakeFetch, type RecordedCall } from "./fake-fetch.js";
import { fixtureNow, fixtureRawState } from "./fixture-state.js";

interface Run {
  exitCode: number;
  stdout: string;
  stderr: string;
  calls: RecordedCall[];
}

async function run(
  argv: string[],
  routes: Parameters<typeof fakeFetch>[0] = {},
  env: NodeJS.ProcessEnv = {}
): Promise<Run> {
  const calls: RecordedCall[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runCli(argv, {
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
    env,
    readConfigFile: () => null,
    now: () => fixtureNow,
    fetchImpl: fakeFetch(
      {
        "/api/state": { body: { state: fixtureRawState() } },
        "/api/check-ins/current": { body: { checkIn: null } },
        "/api/commands/entity": { body: { state: fixtureRawState() } },
        ...routes
      },
      calls
    )
  });
  return { exitCode, stdout: stdout.join("\n"), stderr: stderr.join("\n"), calls };
}

const HEADER = "x-openrhen-agent";

describe("agent name header", () => {
  it("is sent on GET and POST when --agent is set, lower-cased", async () => {
    const get = await run(["list", "actions", "--agent", "Mark", "--json"]);
    expect(get.exitCode).toBe(EXIT.ok);
    expect(get.calls.length).toBeGreaterThan(0);
    for (const call of get.calls) expect(call.headers[HEADER]).toBe("mark");

    const post = await run(["capture", "Ring the plumber", "--agent", "mark", "--json"]);
    expect(post.calls.some((call) => call.method === "POST")).toBe(true);
    for (const call of post.calls) expect(call.headers[HEADER]).toBe("mark");
  });

  it("falls back to OPENRHEN_AGENT, and the flag wins over it", async () => {
    const fromEnv = await run(["list", "actions", "--json"], {}, { OPENRHEN_AGENT: "envbot" });
    for (const call of fromEnv.calls) expect(call.headers[HEADER]).toBe("envbot");
    const flagged = await run(["list", "actions", "--agent", "flagbot", "--json"], {}, { OPENRHEN_AGENT: "envbot" });
    for (const call of flagged.calls) expect(call.headers[HEADER]).toBe("flagbot");
  });

  it("is absent when no name is set", async () => {
    const { calls } = await run(["list", "actions", "--json"]);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call.headers[HEADER]).toBeUndefined();
  });

  it.each(["", "has space", "UPPER!", "a".repeat(33), "dot.ted"])("refuses the invalid name %j", async (name) => {
    const { exitCode, calls } = await run(["list", "actions", `--agent=${name}`]);
    expect(exitCode).toBe(EXIT.usage);
    expect(calls).toHaveLength(0);
  });

  it.each(["system", "human", "SYSTEM"])("refuses the reserved name %s", async (name) => {
    const { exitCode, stderr, calls } = await run(["list", "actions", "--agent", name]);
    expect(exitCode).toBe(EXIT.usage);
    expect(stderr).toContain("reserved");
    expect(calls).toHaveLength(0);
  });

  it("refuses an invalid OPENRHEN_AGENT", async () => {
    const { exitCode, stderr } = await run(["list", "actions"], {}, { OPENRHEN_AGENT: "no good" });
    expect(exitCode).toBe(EXIT.usage);
    expect(stderr).toContain("OPENRHEN_AGENT");
  });
});

async function toolCall(
  ctxOptions: Parameters<typeof buildLineContext>[0],
  name: string,
  args: Record<string, unknown>
): Promise<void> {
  const ctx = await buildLineContext(ctxOptions);
  await handleLine(
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    ctx
  );
}

describe("mcp --agent", () => {
  it("forwards --agent onto every dispatched command over stdio", async () => {
    const argvs: string[][] = [];
    const lines: string[] = [];
    const requests = ["rhen_status", "rhen_list"].map((name, index) =>
      JSON.stringify({
        jsonrpc: "2.0",
        id: index,
        method: "tools/call",
        params: { name, arguments: name === "rhen_list" ? { entity: "actions" } : {} }
      })
    );
    await serveMcp({
      input: requests,
      write: (line) => lines.push(line),
      agent: "mark",
      runner: async (argv) => {
        argvs.push(argv);
        return 0;
      }
    });
    expect(argvs).toHaveLength(2);
    for (const argv of argvs) {
      const at = argv.indexOf("--agent");
      expect(argv.slice(at, at + 2)).toEqual(["--agent", "mark"]);
      // Before any `--`, so it is the server's option and never a positional.
      if (argv.includes("--")) expect(at).toBeLessThan(argv.indexOf("--"));
    }
  });

  it("forwards nothing when no agent is set", async () => {
    const argvs: string[][] = [];
    await toolCall({ runner: async (argv) => (argvs.push(argv), 0) }, "rhen_status", {});
    expect(argvs[0]).not.toContain("--agent");
  });

  it("keeps the changes filter instead of overriding it with the caller's name", async () => {
    const argvs: string[][] = [];
    await toolCall({ agent: "mark", runner: async (argv) => (argvs.push(argv), 0) }, "rhen_changes", {
      agent: "human"
    });
    expect(argvs[0]?.filter((token) => token === "--agent" || token.startsWith("--agent="))).toHaveLength(1);
    expect(argvs[0]).toContain("--agent=human");
  });

  it("refuses --agent with --http, and refuses a bad or reserved stdio name", async () => {
    const http = await run(["mcp", "--http", "--agent", "mark"]);
    expect(http.exitCode).toBe(EXIT.usage);
    expect(http.stderr).toContain("X-OpenRhen-Agent");
    expect((await run(["mcp", "--agent", "system"])).exitCode).toBe(EXIT.usage);
    expect((await run(["mcp", "--agent", "bad name"])).exitCode).toBe(EXIT.usage);
  });
});

describe("mcp --http X-OpenRhen-Agent", () => {
  async function post(port: number, headers: Record<string, string>): Promise<number> {
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      headers: { authorization: "Bearer t0ken", "content-type": "application/json", ...headers },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "rhen_status", arguments: {} }
      })
    });
    await response.text();
    return response.status;
  }

  it("carries the request's own name into the dispatched commands, and 400s a bad one", async () => {
    const argvs: string[][] = [];
    const server = await startHttpMcpServer({
      port: 0,
      token: "t0ken",
      log: () => undefined,
      buildContext: () => buildLineContext({ runner: async (argv) => (argvs.push(argv), 0) })
    });
    try {
      expect(await post(server.port, { "X-OpenRhen-Agent": "Remote-1" })).toBe(200);
      expect(await post(server.port, {})).toBe(200);
      expect(await post(server.port, { "X-OpenRhen-Agent": "bad name" })).toBe(400);
      expect(await post(server.port, { "X-OpenRhen-Agent": "system" })).toBe(400);
    } finally {
      await server.close();
    }
    expect(argvs).toHaveLength(2);
    expect(argvs[0]?.slice(-2)).toEqual(["--agent", "remote-1"]);
    expect(argvs[1]).not.toContain("--agent");
  });
});

describe("changes", () => {
  const rows = {
    changes: [
      {
        id: "c2",
        at: "2026-09-04T08:00:00.000Z",
        entityType: "action",
        entityId: "action-1",
        operation: "update",
        actor: "mark",
        commandId: "cmd-2",
        beforeRecorded: true
      },
      {
        id: "c1",
        at: "2026-09-04T07:00:00.000Z",
        entityType: "capture",
        entityId: "capture-1",
        operation: "create",
        actor: null,
        commandId: "cmd-1",
        beforeRecorded: false
      }
    ],
    cursor: "2026-09-04T07:00:00.000Z|c1"
  };
  const changesCall = (calls: RecordedCall[]) => {
    const call = calls.find((entry) => entry.path === "/api/changes");
    expect(call).toBeDefined();
    return new URL(call?.url ?? "");
  };

  it("builds the query string from its options", async () => {
    const { exitCode, calls } = await run(
      [
        "changes",
        "--since",
        "-1d",
        "--agent",
        "Mark",
        "--entity",
        "action",
        "--limit",
        "5",
        "--before",
        "cur|1",
        "--evidence",
        "--json"
      ],
      { "/api/changes": { body: rows } }
    );
    expect(exitCode).toBe(EXIT.ok);
    const url = changesCall(calls);
    expect(url.searchParams.get("since")).toBe(new Date(fixtureNow.getTime() - 86_400_000).toISOString());
    expect(url.searchParams.get("agent")).toBe("mark");
    expect(url.searchParams.get("entity")).toBe("action");
    expect(url.searchParams.get("limit")).toBe("5");
    expect(url.searchParams.get("before")).toBe("cur|1");
    expect(url.searchParams.get("evidence")).toBe("1");
    expect(url.searchParams.has("count")).toBe(false);
    // --agent filters here; it must not also name the caller.
    for (const call of calls) expect(call.headers[HEADER]).toBeUndefined();
  });

  it("defaults to 20 rows and sends the count form", async () => {
    const plain = await run(["changes", "--json"], { "/api/changes": { body: rows } });
    expect(changesCall(plain.calls).searchParams.get("limit")).toBe("20");
    const counted = await run(["changes", "--count", "--by", "agent", "--json"], {
      "/api/changes": { body: { total: 0, counts: [] } }
    });
    const url = changesCall(counted.calls);
    expect(url.searchParams.get("count")).toBe("1");
    expect(url.searchParams.get("by")).toBe("agent");
    expect(url.searchParams.has("limit")).toBe(false);
  });

  it("renders rows as a table with human for a null actor, and prints JSON", async () => {
    const table = await run(["changes"], { "/api/changes": { body: rows } });
    expect(table.exitCode).toBe(EXIT.ok);
    expect(table.stdout).toMatch(/at\s+actor\s+operation\s+entityType\s+entityId/);
    expect(table.stdout).toMatch(/mark\s+update\s+action\s+action-1/);
    expect(table.stdout).toMatch(/human\s+create\s+capture\s+capture-1/);
    expect(table.stdout).toContain("--before 2026-09-04T07:00:00.000Z|c1");
    const json = await run(["changes", "--json"], { "/api/changes": { body: rows } });
    const parsed = JSON.parse(json.stdout) as { changes: { id: string; actor: string | null }[]; cursor: string };
    expect(parsed.changes.map((row) => row.id)).toEqual(["c2", "c1"]);
    expect(parsed.changes[1]?.actor).toBeNull();
  });

  it("renders counts", async () => {
    const body = {
      total: 3,
      counts: [
        { value: "mark", count: 2 },
        { value: "human", count: 1 }
      ]
    };
    const table = await run(["changes", "--count", "--by", "agent"], { "/api/changes": { body } });
    expect(table.stdout).toMatch(/value\s+count/);
    expect(table.stdout).toMatch(/mark\s+2/);
    const json = await run(["changes", "--count", "--json"], { "/api/changes": { body } });
    expect(JSON.parse(json.stdout)).toEqual(body);
  });

  it("refuses --state-file, --by without --count, a bad --by and an oversize --limit", async () => {
    const stderr: string[] = [];
    const exitCode = await runCli(["changes", "--state-file", "snapshot.json"], {
      stdout: () => undefined,
      stderr: (text) => stderr.push(text),
      env: {},
      now: () => fixtureNow,
      readStateFile: () => JSON.stringify(fixtureRawState())
    });
    expect(exitCode).toBe(EXIT.usage);
    expect(stderr.join("\n")).toContain("live portal");
    expect((await run(["changes", "--by", "agent"])).exitCode).toBe(EXIT.usage);
    expect((await run(["changes", "--count", "--by", "colour"])).exitCode).toBe(EXIT.usage);
    expect((await run(["changes", "--limit", "201"])).exitCode).toBe(EXIT.usage);
  });
});
