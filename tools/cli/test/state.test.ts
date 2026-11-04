import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { EXIT } from "../src/errors.js";
import { fakeFetch, type RecordedCall } from "./fake-fetch.js";
import { fixtureNow, fixtureRawState } from "./fixture-state.js";

interface Run {
  exitCode: number;
  stdout: string;
  stderr: string;
  calls: RecordedCall[];
}

async function runState(argv: readonly string[], remote = false): Promise<Run> {
  const calls: RecordedCall[] = [];
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const exitCode = await runCli(argv, {
    stdout: (text) => stdoutLines.push(text),
    stderr: (text) => stderrLines.push(text),
    env: {},
    readConfigFile: () => null,
    now: () => fixtureNow,
    ...(remote ? { remote } : {}),
    fetchImpl: fakeFetch({ "/api/state": { body: { state: fixtureRawState() } } }, calls)
  });
  return { exitCode, stdout: stdoutLines.join("\n"), stderr: stderrLines.join("\n"), calls };
}

describe("state over the remote endpoint", () => {
  it("refuses a call with no key and names the tool to use", async () => {
    const { exitCode, stderr, calls } = await runState(["state"], true);
    expect(exitCode).toBe(EXIT.usage);
    expect(stderr).toContain("rhen_status");
    expect(stderr).toContain("rhen_history");
    expect(calls).toHaveLength(0);
  });

  it("answers a small key, compact", async () => {
    const { exitCode, stdout } = await runState(["state", "--key", "actions", "--json"], true);
    expect(exitCode).toBe(EXIT.ok);
    expect(stdout).not.toContain("\n");
    expect(Array.isArray(JSON.parse(stdout))).toBe(true);
  });

  it("refuses a key whose answer is over 64 KB", async () => {
    const calls: RecordedCall[] = [];
    const stderr: string[] = [];
    const big = { ...fixtureRawState(), actions: [{ id: "a", notes: "x".repeat(70_000) }] };
    const exitCode = await runCli(["state", "--key", "actions"], {
      stdout: () => undefined,
      stderr: (text) => stderr.push(text),
      env: {},
      readConfigFile: () => null,
      now: () => fixtureNow,
      remote: true,
      fetchImpl: fakeFetch({ "/api/state": { body: { state: big } } }, calls)
    });
    expect(exitCode).toBe(EXIT.usage);
    expect(stderr.join("\n")).toMatch(/over 64 KB.*rhen_list/s);
  });

  it("leaves the local CLI alone: no key is allowed", async () => {
    const { exitCode, stdout } = await runState(["state"]);
    expect(exitCode).toBe(EXIT.ok);
    expect(stdout.length).toBeGreaterThan(1000);
  });
});

describe("state", () => {
  it("prints the whole state as compact JSON by default", async () => {
    const { exitCode, stdout } = await runState(["state"]);
    expect(exitCode).toBe(EXIT.ok);
    expect(stdout).not.toContain("\n");
    const parsed = JSON.parse(stdout) as { actions: unknown[] };
    expect(Array.isArray(parsed.actions)).toBe(true);
  });

  it("--pretty indents the JSON", async () => {
    const { stdout } = await runState(["state", "--pretty"]);
    expect(stdout).toContain("\n");
    expect(JSON.parse(stdout)).toBeTruthy();
  });

  it("--key actions prints just that array", async () => {
    const { stdout } = await runState(["state", "--key", "actions"]);
    const parsed = JSON.parse(stdout) as unknown[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(4);
  });

  it("--key tasks (an alias of actions) resolves the same entity", async () => {
    const { stdout } = await runState(["state", "--key", "tasks"]);
    const parsed = JSON.parse(stdout) as unknown[];
    expect(parsed).toHaveLength(4);
  });

  it("--key planning prints the planning document", async () => {
    const { stdout } = await runState(["state", "--key", "planning"]);
    const parsed = JSON.parse(stdout) as { status: string };
    expect(parsed.status).toBe("current");
  });

  it("--key nope is a usage error listing the valid keys", async () => {
    const { exitCode, stderr } = await runState(["state", "--key", "nope"]);
    expect(exitCode).toBe(EXIT.usage);
    expect(stderr).toContain("nope");
    expect(stderr).toContain("actions");
  });

  it("a valid but absent key (planning, once removed from the fixture) prints null", async () => {
    const calls: RecordedCall[] = [];
    const stdoutLines: string[] = [];
    const raw = fixtureRawState();
    delete raw.planning;
    const exitCode = await runCli(["state", "--key", "planning"], {
      stdout: (text) => stdoutLines.push(text),
      stderr: () => {},
      env: {},
      readConfigFile: () => null,
      now: () => fixtureNow,
      fetchImpl: fakeFetch({ "/api/state": { body: { state: raw } } }, calls)
    });
    expect(exitCode).toBe(EXIT.ok);
    expect(stdoutLines.join("\n")).toBe("null");
  });

  it("--jsonl --key actions prints one compact line per action", async () => {
    const { stdout } = await runState(["state", "--jsonl", "--key", "actions"]);
    const lines = stdout.split("\n").filter((line) => line.length > 0);
    expect(lines).toHaveLength(4);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });

  it("calls only GET /api/state, never a POST", async () => {
    const { calls } = await runState(["state"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "GET", path: "/api/state" });
  });
});
