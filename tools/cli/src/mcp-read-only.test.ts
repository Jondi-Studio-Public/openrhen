import { describe, expect, it } from "vitest";
import { runCli } from "./cli.js";
import { buildLineContext, serveMcp } from "./commands/mcp.js";
import { commands } from "./registry.js";
import { fakeFetch, type RecordedCall } from "../test/fake-fetch.js";
import { fixtureNow, fixtureRawState } from "../test/fixture-state.js";

interface JsonRpcResponse {
  jsonrpc: string;
  id: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

function req(id: unknown, method: string, params?: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) });
}

async function send(
  lines: string[],
  options: { readOnly?: boolean; stateFile?: string } = {},
  routes: Parameters<typeof fakeFetch>[0] = {}
): Promise<{ parsed: JsonRpcResponse[]; calls: RecordedCall[] }> {
  const calls: RecordedCall[] = [];
  const fetchImpl = fakeFetch({ "/api/state": { body: { state: fixtureRawState() } }, ...routes }, calls);
  const written: string[] = [];
  await serveMcp({
    input: lines,
    write: (line) => written.push(line),
    runner: (argv, capture) =>
      runCli(argv, { ...capture, env: {}, fetchImpl, now: () => fixtureNow, readConfigFile: () => null }),
    readOnly: options.readOnly,
    stateFile: options.stateFile
  });
  return { parsed: written.map((line) => JSON.parse(line) as JsonRpcResponse), calls };
}

describe("mcp --read-only: the tool table", () => {
  it("lists no tool for a command whose mutates is true, iterating the whole registry", async () => {
    const { parsed } = await send([req(1, "tools/list")], { readOnly: true });
    const result = parsed[0]?.result as { tools: { name: string }[] };
    const names = new Set(result.tools.map((tool) => tool.name));
    for (const spec of commands) {
      if (spec.name === "mcp") continue;
      const toolName = `rhen_${spec.name.replace(/-/g, "_")}`;
      if (spec.mutates) expect(names.has(toolName)).toBe(false);
      else expect(names.has(toolName)).toBe(true);
    }
  });

  it("serves history but not span (which writes) under --read-only", async () => {
    const { parsed } = await send([req(1, "tools/list")], { readOnly: true });
    const result = parsed[0]?.result as { tools: { name: string }[] };
    const names = result.tools.map((tool) => tool.name);
    expect(names).toContain("rhen_history");
    expect(names).not.toContain("rhen_span");
  });

  it("without --read-only, mutating tools are listed as usual", async () => {
    const { parsed } = await send([req(1, "tools/list")]);
    const result = parsed[0]?.result as { tools: { name: string }[] };
    expect(result.tools.map((tool) => tool.name)).toContain("rhen_save");
  });
});

describe("mcp --read-only: calling a mutating tool by name anyway", () => {
  it("is refused with a clear error, not run", async () => {
    const { parsed, calls } = await send(
      [req(1, "tools/call", { name: "rhen_save", arguments: { entityType: "capture", set: ["text=hi"] } })],
      { readOnly: true }
    );
    expect(parsed[0]?.error).toBeUndefined();
    const result = parsed[0]?.result as {
      isError: boolean;
      content: { text: string }[];
      structuredContent: { error: { code: string; retryable: boolean } };
    };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("read-only");
    expect(result.structuredContent.error).toMatchObject({ code: "scope", retryable: false });
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("a non-mutating tool still runs normally under --read-only", async () => {
    const { parsed } = await send([req(1, "tools/call", { name: "rhen_status", arguments: {} })], {
      readOnly: true
    });
    const result = parsed[0]?.result as { isError: boolean };
    expect(result.isError).toBe(false);
  });
});

describe("mcp --read-only: the client never sends a mutating request", () => {
  it("no call across a whole session is ever POST/PUT/PATCH/DELETE", async () => {
    const { calls } = await send(
      [
        req(1, "tools/list"),
        req(2, "tools/call", { name: "rhen_status", arguments: {} }),
        req(3, "tools/call", { name: "rhen_list", arguments: { entity: "actions" } }),
        req(4, "tools/call", { name: "rhen_save", arguments: { entityType: "capture", set: ["text=hi"] } })
      ],
      { readOnly: true }
    );
    for (const call of calls) expect(call.method).toBe("GET");
  });
});

describe("mcp --state-file: served from a snapshot, no network at all", () => {
  it("a read tool call is answered without ever calling fetch", async () => {
    let fetchCalled = false;
    const written: string[] = [];
    await serveMcp({
      input: [req(1, "tools/call", { name: "rhen_list", arguments: { entity: "actions" } })],
      write: (line) => written.push(line),
      stateFile: "/snap.json",
      runner: (argv, capture) =>
        runCli(argv, {
          ...capture,
          env: {},
          fetchImpl: async () => {
            fetchCalled = true;
            throw new Error("must never be called");
          },
          now: () => fixtureNow,
          readConfigFile: () => null,
          readStateFile: () => JSON.stringify(fixtureRawState())
        })
    });
    expect(fetchCalled).toBe(false);
    const parsed = JSON.parse(written[0]!) as JsonRpcResponse;
    const result = parsed.result as { isError: boolean; content: { type: string; text: string }[] };
    expect(result.isError).toBe(false);
    const rows = JSON.parse(result.content[0]?.text ?? "[]") as { id: string }[];
    expect(rows.length).toBeGreaterThan(0);
  });

  it("tools/list still hides mutating tools when only --state-file is given (it implies --read-only)", async () => {
    const ctx = await buildLineContext({ stateFile: "/snap.json" });
    expect(ctx.readOnly).toBe(true);
    expect(ctx.tools.some((tool) => tool.name === "rhen_save")).toBe(false);
  });
});
