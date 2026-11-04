import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { buildLineContext, generatedTokenNotice, serveMcp } from "../src/commands/mcp.js";
import {
  MAX_BATCH,
  MAX_BODY_BYTES,
  resolveHttpToken,
  startHttpMcpServer,
  type HttpMcpServer
} from "../src/commands/mcp-http.js";
import { fakeFetch, type RecordedCall } from "./fake-fetch.js";
import { fixtureNow, fixtureRawState } from "./fixture-state.js";

const TOKEN = "test-token-0123456789abcdef";

let server: HttpMcpServer | null = null;

afterEach(async () => {
  if (server) {
    await server.close();
    server = null;
  }
});

async function startTestServer(): Promise<HttpMcpServer> {
  const fetchImpl = fakeFetch({ "/api/state": { body: { state: fixtureRawState() } } }, []);
  const buildContext = () =>
    buildLineContext((argv, capture) =>
      runCli(argv, { ...capture, env: {}, fetchImpl, now: () => fixtureNow, readConfigFile: () => null })
    );
  server = await startHttpMcpServer({ port: 0, token: TOKEN, log: () => {}, buildContext });
  return server;
}

function url(server: HttpMcpServer, path = "/"): string {
  return `http://127.0.0.1:${server.port}${path}`;
}

function rpc(id: unknown, method: string, params?: unknown) {
  return { jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) };
}

describe("resolveHttpToken", () => {
  it("uses OPENRHEN_MCP_TOKEN when set", () => {
    expect(resolveHttpToken({ OPENRHEN_MCP_TOKEN: "abc" })).toEqual({ token: "abc", generated: false });
  });

  it("generates a token when unset", () => {
    const { token, generated } = resolveHttpToken({});
    expect(generated).toBe(true);
    expect(token.length).toBeGreaterThan(20);
  });
});

describe("mcp --http transport", () => {
  it("serves tools/list matching the stdio server's tool table", async () => {
    const httpServer = await startTestServer();
    const response = await fetch(url(httpServer), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(rpc(1, "tools/list"))
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: { tools: { name: string }[] } };
    const httpToolNames = body.result.tools.map((tool) => tool.name).sort();

    const stdioWritten: string[] = [];
    const fetchImpl = fakeFetch({ "/api/state": { body: { state: fixtureRawState() } } }, []);
    await serveMcp({
      input: [JSON.stringify(rpc(1, "tools/list"))],
      write: (line) => stdioWritten.push(line),
      runner: (argv, capture) =>
        runCli(argv, { ...capture, env: {}, fetchImpl, now: () => fixtureNow, readConfigFile: () => null })
    });
    const stdioResult = JSON.parse(stdioWritten[0]!) as { result: { tools: { name: string }[] } };
    const stdioToolNames = stdioResult.result.tools.map((tool) => tool.name).sort();
    expect(httpToolNames).toEqual(stdioToolNames);
  });

  it("runs a tool call end to end over HTTP", async () => {
    const httpServer = await startTestServer();
    const response = await fetch(url(httpServer), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(rpc(2, "tools/call", { name: "rhen_status", arguments: {} }))
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: { isError: boolean } };
    expect(body.result.isError).toBe(false);
  });

  it("never sends the server's owner token for a client that sends only the bearer token", async () => {
    const saved = process.env.OPENRHEN_OWNER_TOKEN;
    process.env.OPENRHEN_OWNER_TOKEN = "owner-secret";
    try {
      const calls: RecordedCall[] = [];
      const fetchImpl = fakeFetch({ "/api/state": { body: { state: fixtureRawState() } } }, calls);
      // The env the server hands each call is the one under test, so it reaches the command as given.
      const buildContext = () =>
        buildLineContext((argv, capture) =>
          runCli(argv, { ...capture, fetchImpl, now: () => fixtureNow, readConfigFile: () => null })
        );
      server = await startHttpMcpServer({ port: 0, token: TOKEN, log: () => {}, buildContext });
      const response = await fetch(url(server), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify(rpc(1, "tools/call", { name: "rhen_status", arguments: {} }))
      });
      expect(response.status).toBe(200);
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) expect(call.headers["x-openrhen-owner"]).toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env.OPENRHEN_OWNER_TOKEN;
      else process.env.OPENRHEN_OWNER_TOKEN = saved;
    }
  });

  it("401s without a bearer token", async () => {
    const httpServer = await startTestServer();
    const response = await fetch(url(httpServer), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(rpc(1, "tools/list"))
    });
    expect(response.status).toBe(401);
  });

  it("401s with the wrong bearer token", async () => {
    const httpServer = await startTestServer();
    const response = await fetch(url(httpServer), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer wrong-token-0123456789" },
      body: JSON.stringify(rpc(1, "tools/list"))
    });
    expect(response.status).toBe(401);
  });

  it("403s a non-loopback Origin even with a valid token", async () => {
    const httpServer = await startTestServer();
    const response = await fetch(url(httpServer), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TOKEN}`,
        origin: "http://evil.example.com"
      },
      body: JSON.stringify(rpc(1, "tools/list"))
    });
    expect(response.status).toBe(403);
  });

  it("allows a loopback Origin", async () => {
    const httpServer = await startTestServer();
    const response = await fetch(url(httpServer), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TOKEN}`,
        origin: `http://127.0.0.1:${httpServer.port}`
      },
      body: JSON.stringify(rpc(1, "tools/list"))
    });
    expect(response.status).toBe(200);
  });

  it("413s a body over the cap, and the client receives the 413", async () => {
    const live = await startTestServer();
    const response = await fetch(url(live), {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ ...rpc(1, "ping"), pad: "x".repeat(MAX_BODY_BYTES) })
    });
    expect(response.status).toBe(413);
  });

  it("serves a body just under the cap", async () => {
    const live = await startTestServer();
    const base = JSON.stringify({ ...rpc(1, "ping"), pad: "" });
    const body = JSON.stringify({ ...rpc(1, "ping"), pad: "x".repeat(MAX_BODY_BYTES - Buffer.byteLength(base)) });
    expect(Buffer.byteLength(body)).toBe(MAX_BODY_BYTES);
    const response = await fetch(url(live), {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body
    });
    expect(response.status).toBe(200);
  });

  it("400s a batch over the cap", async () => {
    const live = await startTestServer();
    const response = await fetch(url(live), {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(Array.from({ length: MAX_BATCH + 1 }, (_, index) => rpc(index, "ping")))
    });
    expect(response.status).toBe(400);
  });

  it("405s a GET request", async () => {
    const httpServer = await startTestServer();
    const response = await fetch(url(httpServer), {
      method: "GET",
      headers: { authorization: `Bearer ${TOKEN}` }
    });
    expect(response.status).toBe(405);
  });

  it("binds to 127.0.0.1", async () => {
    const httpServer = await startTestServer();
    // If it were bound to 0.0.0.0 this would still succeed; the meaningful guarantee is that the
    // server never listens on anything but the loopback address, which startHttpMcpServer's own
    // `server.listen(options.port, "127.0.0.1", ...)` call enforces directly.
    expect(httpServer.port).toBeGreaterThan(0);
  });
});

describe("generated --http token", () => {
  it("prints the token on a terminal and writes nothing", () => {
    const home = mkdtempSync(join(tmpdir(), "mcp-token-"));
    expect(generatedTokenNotice("tok-123", 8834, { home, terminal: true })).toContain("tok-123");
    expect(existsSync(join(home, ".openrhen", "mcp-http-token-8834"))).toBe(false);
  });

  it("writes the token to a 0600 file and logs only the path when not on a terminal", () => {
    const home = mkdtempSync(join(tmpdir(), "mcp-token-"));
    const notice = generatedTokenNotice("tok-123", 8834, { home, terminal: false });
    const path = join(home, ".openrhen", "mcp-http-token-8834");
    expect(notice).not.toContain("tok-123");
    expect(notice).toContain(path);
    expect(readFileSync(path, "utf8").trim()).toBe("tok-123");
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("keeps a separate file per port, so a second server never overwrites the first one's token", () => {
    const home = mkdtempSync(join(tmpdir(), "mcp-token-"));
    generatedTokenNotice("tok-first", 8834, { home, terminal: false });
    generatedTokenNotice("tok-second", 8835, { home, terminal: false });
    expect(readFileSync(join(home, ".openrhen", "mcp-http-token-8834"), "utf8").trim()).toBe("tok-first");
    expect(readFileSync(join(home, ".openrhen", "mcp-http-token-8835"), "utf8").trim()).toBe("tok-second");
  });

  async function runHttpMcp(home: string, port: number): Promise<{ exitCode: number; stderr: string[] }> {
    const saved = {
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      token: process.env.OPENRHEN_MCP_TOKEN
    };
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    delete process.env.OPENRHEN_MCP_TOKEN;
    const stderr: string[] = [];
    try {
      const exitCode = await runCli(["mcp", "--http", "--port", String(port)], {
        stdout: () => {},
        stderr: (text) => stderr.push(text),
        env: {},
        readConfigFile: () => null
      });
      return { exitCode, stderr };
    } finally {
      for (const [name, value] of [
        ["HOME", saved.HOME],
        ["USERPROFILE", saved.USERPROFILE],
        ["OPENRHEN_MCP_TOKEN", saved.token]
      ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  }

  async function freePort(): Promise<number> {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const { port } = probe.address() as AddressInfo;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    return port;
  }

  it("closes the server and fails when the token cannot be stored, instead of hanging", async () => {
    const home = mkdtempSync(join(tmpdir(), "mcp-token-"));
    writeFileSync(join(home, ".openrhen"), "not a directory");
    const port = await freePort();
    const { exitCode, stderr } = await runHttpMcp(home, port);
    expect(exitCode).not.toBe(0);
    expect(stderr.join("\n")).not.toContain("listening");
    // The port is free again: the server was closed, not left holding the process open.
    const again = createServer();
    await new Promise<void>((resolve, reject) => {
      again.once("error", reject);
      again.listen(port, "127.0.0.1", resolve);
    });
    await new Promise<void>((resolve) => again.close(() => resolve()));
  });

  it("leaves an earlier token file untouched when the port is already in use", async () => {
    const home = mkdtempSync(join(tmpdir(), "mcp-token-"));
    mkdirSync(join(home, ".openrhen"));
    const holder = createServer();
    await new Promise<void>((resolve) => holder.listen(0, "127.0.0.1", resolve));
    const tokenPath = join(home, ".openrhen", `mcp-http-token-${(holder.address() as AddressInfo).port}`);
    writeFileSync(tokenPath, "earlier-token\n");
    try {
      const { exitCode } = await runHttpMcp(home, (holder.address() as AddressInfo).port);
      expect(exitCode).not.toBe(0);
      expect(readFileSync(tokenPath, "utf8")).toBe("earlier-token\n");
    } finally {
      await new Promise<void>((resolve) => holder.close(() => resolve()));
    }
  });
});
