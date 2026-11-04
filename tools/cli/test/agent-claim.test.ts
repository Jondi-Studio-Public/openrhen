import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { EXIT } from "../src/errors.js";
import { buildLineContext, handleLine } from "../src/commands/mcp.js";
import { fakeFetch, type RecordedCall } from "./fake-fetch.js";
import { fixtureNow, fixtureRawState } from "./fixture-state.js";

const BASIS = "x-openrhen-basis";
const EVIDENCE = "x-openrhen-evidence";

async function run(argv: string[]) {
  const calls: RecordedCall[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runCli(argv, {
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
    env: {},
    readConfigFile: () => null,
    now: () => fixtureNow,
    fetchImpl: fakeFetch(
      {
        "/api/state": { body: { state: fixtureRawState() } },
        "/api/commands/entity": { body: { state: fixtureRawState() } },
        "/api/agent-proposals": { body: { proposal: { id: "p1" } } }
      },
      calls
    )
  });
  return { exitCode, stdout: stdout.join("\n"), stderr: stderr.join("\n"), calls };
}

describe("--basis and --evidence", () => {
  it("are sent as headers on a write, and not on the reads around it", async () => {
    const out = await run([
      "capture",
      "Ring the plumber",
      "--basis",
      "stated",
      "--evidence",
      "ring the plumber",
      "--json"
    ]);
    expect(out.exitCode).toBe(EXIT.ok);
    const post = out.calls.find((call) => call.method === "POST")!;
    expect(post.headers[BASIS]).toBe("stated");
    expect(post.headers[EVIDENCE]).toBe("ring%20the%20plumber");
    for (const call of out.calls.filter((c) => c.method === "GET")) {
      expect(call.headers[BASIS]).toBeUndefined();
      expect(call.headers[EVIDENCE]).toBeUndefined();
    }
  });

  it("sends nothing when neither is given", async () => {
    const out = await run(["capture", "Ring the plumber", "--json"]);
    const post = out.calls.find((call) => call.method === "POST")!;
    expect(post.headers[BASIS]).toBeUndefined();
    expect(post.headers[EVIDENCE]).toBeUndefined();
  });

  it("encodes evidence that is not Latin-1, and trims it", async () => {
    const out = await run(["capture", "x", "--basis", "Stated", "--evidence", "  金曜日 🙂  ", "--json"]);
    const post = out.calls.find((call) => call.method === "POST")!;
    expect(post.headers[BASIS]).toBe("stated");
    expect(decodeURIComponent(post.headers[EVIDENCE]!)).toBe("金曜日 🙂");
  });

  it("refuses a bad basis, long evidence and control characters before any request", async () => {
    for (const args of [
      ["--basis", "guess"],
      ["--evidence", "x".repeat(301)],
      ["--evidence", "line one\nline two"]
    ]) {
      const out = await run(["capture", "x", ...args, "--json"]);
      expect(out.exitCode, args.join(" ")).toBe(EXIT.usage);
      expect(out.calls).toEqual([]);
    }
  });

  it("applies only to commands that change portal state", async () => {
    const out = await run(["status", "--basis", "stated", "--json"]);
    expect(out.exitCode).toBe(EXIT.usage);
    expect(out.stdout).toContain("only apply to commands that change portal state");
    expect(out.calls).toEqual([]);
  });

  it("leaves `propose`'s own basis and evidence in its body, not in headers", async () => {
    const out = await run([
      "propose",
      "entity_command",
      "--summary",
      "Move it",
      "--payload-json",
      '{"command":"save_entity","body":{}}',
      "--basis",
      "stated",
      "--evidence",
      "move it",
      "--agent",
      "scribe",
      "--json"
    ]);
    const post = out.calls.find((call) => call.method === "POST");
    expect(post?.body).toMatchObject({ basis: "stated", evidence: "move it" });
    expect(post?.headers[BASIS]).toBeUndefined();
    expect(post?.headers[EVIDENCE]).toBeUndefined();
  });

  it("is not read from `changes --evidence`, which is its own switch", async () => {
    const out = await run(["changes", "--evidence", "--json"]);
    for (const call of out.calls) expect(call.headers[EVIDENCE]).toBeUndefined();
  });
});

describe("basis and evidence over MCP", () => {
  it("are forwarded onto the dispatched command line", async () => {
    const seen: string[][] = [];
    const ctx = await buildLineContext(async (argv, capture) => {
      seen.push([...argv]);
      capture.stdout("{}");
      return 0;
    });
    await handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "rhen_capture", arguments: { text: "x", basis: "stated", evidence: "x please" } }
      }),
      ctx
    );
    expect(seen[0]).toContain("--basis=stated");
    expect(seen[0]).toContain("--evidence=x please");
  });
});
