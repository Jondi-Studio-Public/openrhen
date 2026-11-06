import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { buildLineContext } from "../src/commands/mcp.js";
import { startHttpMcpServer } from "../src/commands/mcp-http.js";
import { EXIT } from "../src/errors.js";
import { fakeFetch, type RecordedCall } from "./fake-fetch.js";
import { fixtureNow, fixtureRawState } from "./fixture-state.js";

const HEADER = "x-openrhen-token";
const SECRET = "tok_s3cret_value";

async function run(argv: string[], routes: Parameters<typeof fakeFetch>[0] = {}, env: NodeJS.ProcessEnv = {}) {
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

describe("agent token header", () => {
  it("is sent on GET and POST from OPENRHEN_TOKEN, trimmed", async () => {
    const env = { OPENRHEN_TOKEN: `  ${SECRET}\n` };
    const get = await run(["list", "actions", "--json"], {}, env);
    expect(get.calls.length).toBeGreaterThan(0);
    for (const call of get.calls) expect(call.headers[HEADER]).toBe(SECRET);
    const post = await run(["capture", "Ring the plumber", "--json"], {}, env);
    expect(post.calls.some((call) => call.method === "POST")).toBe(true);
    for (const call of post.calls) expect(call.headers[HEADER]).toBe(SECRET);
  });

  it("is absent when unset or empty", async () => {
    for (const env of [{}, { OPENRHEN_TOKEN: "   " }]) {
      const { calls } = await run(["list", "actions", "--json"], {}, env);
      for (const call of calls) expect(call.headers[HEADER]).toBeUndefined();
    }
  });

  it("never appears in dry-run output", async () => {
    const { stdout, stderr, calls } = await run(
      ["capture", "Ring the plumber", "--dry-run"],
      {},
      { OPENRHEN_TOKEN: SECRET }
    );
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
    expect(stdout + stderr).not.toContain(SECRET);
  });

  it("surfaces a 401 plainly without the token", async () => {
    const r = await run(
      ["list", "actions"],
      { "/api/state": { status: 401, body: { error: `Invalid agent token ${SECRET}` } } },
      { OPENRHEN_TOKEN: SECRET }
    );
    expect(r.exitCode).toBe(EXIT.usage);
    expect(r.stderr).toContain("Invalid agent token");
    expect(r.stderr).not.toContain(SECRET);
  });

  it("marks a 401 as an auth failure in the JSON error, so an agent stops instead of retrying", async () => {
    const r = await run(
      ["list", "actions", "--json"],
      { "/api/state": { status: 401, body: { error: "The agent token is not recognised." } } },
      { OPENRHEN_TOKEN: SECRET }
    );
    expect(JSON.parse(r.stderr || r.stdout)).toMatchObject({ code: "auth", exitCode: EXIT.usage });
  });

  it("surfaces a 403 with the portal's message and the scope hint", async () => {
    const r = await run(
      ["capture", "Ring the plumber"],
      { "/api/commands/entity": { status: 403, body: { error: "Agent mark may not write here." } } },
      { OPENRHEN_TOKEN: SECRET }
    );
    expect(r.exitCode).toBe(EXIT.usage);
    expect(r.stderr).toContain("Agent mark may not write here.");
    expect(r.stderr).toContain("not allowed to write");
    expect(r.stderr).not.toContain(SECRET);
  });

  it("leaves a floor refusal that already names the person without the generic hint", async () => {
    const r = await run(
      ["capture", "Ring the plumber"],
      {
        "/api/commands/entity": {
          status: 403,
          body: { error: "outward message: only the person creates a draft." }
        }
      },
      { OPENRHEN_TOKEN: SECRET }
    );
    expect(r.exitCode).toBe(EXIT.usage);
    expect(r.stderr).toContain("only the person creates a draft");
    expect(r.stderr).not.toContain("not allowed to write");
  });

  it("is refused plainly on a 401 with no token too", async () => {
    const r = await run(["list", "actions"], { "/api/state": { status: 401, body: { error: "Token required." } } });
    expect(r.exitCode).toBe(EXIT.usage);
    expect(r.stderr).toContain("Token required.");
  });
});

describe("mcp --http per-request token", () => {
  it("reaches the portal call for that request only, and the server env token does not leak", async () => {
    const calls: RecordedCall[] = [];
    const previous = process.env.OPENRHEN_TOKEN;
    process.env.OPENRHEN_TOKEN = "server-env-token";
    const argvs: string[][] = [];
    const server = await startHttpMcpServer({
      port: 0,
      token: "t0ken",
      log: () => undefined,
      buildContext: () =>
        buildLineContext({
          runner: async (argv, capture) => {
            argvs.push(argv);
            return runCli(argv, {
              ...capture,
              readConfigFile: () => null,
              now: () => fixtureNow,
              fetchImpl: fakeFetch({ "/api/state": { body: { state: fixtureRawState() } } }, calls)
            });
          }
        })
    });
    const post = async (headers: Record<string, string>) => {
      const response = await fetch(`http://127.0.0.1:${server.port}/`, {
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
    };
    try {
      await post({ "X-OpenRhen-Token": "agent-a" });
      await post({});
      await post({ "X-OpenRhen-Token": "agent-b" });
    } finally {
      await server.close();
      if (previous === undefined) delete process.env.OPENRHEN_TOKEN;
      else process.env.OPENRHEN_TOKEN = previous;
    }
    const seen = calls.map((call) => call.headers[HEADER]);
    expect(seen).toContain("agent-a");
    expect(seen).toContain("agent-b");
    expect(seen).not.toContain("server-env-token");
    expect(seen).toContain(undefined);
    expect(argvs.flat().join(" ")).not.toMatch(/agent-a|agent-b|server-env-token/);
  });

  it("does not lend the server's OPENRHEN_AGENT to a request that names none", async () => {
    const calls: RecordedCall[] = [];
    const previous = process.env.OPENRHEN_AGENT;
    process.env.OPENRHEN_AGENT = "server-agent";
    const server = await startHttpMcpServer({
      port: 0,
      token: "t0ken",
      log: () => undefined,
      buildContext: () =>
        buildLineContext({
          runner: async (argv, capture) =>
            runCli(argv, {
              ...capture,
              readConfigFile: () => null,
              now: () => fixtureNow,
              fetchImpl: fakeFetch({ "/api/state": { body: { state: fixtureRawState() } } }, calls)
            })
        })
    });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/`, {
        method: "POST",
        headers: { authorization: "Bearer t0ken", "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "rhen_status", arguments: {} }
        })
      });
      await response.text();
    } finally {
      await server.close();
      if (previous === undefined) delete process.env.OPENRHEN_AGENT;
      else process.env.OPENRHEN_AGENT = previous;
    }
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.map((call) => call.headers["x-openrhen-agent"] ?? call.headers["X-OpenRhen-Agent"])).not.toContain(
      "server-agent"
    );
  });
});
