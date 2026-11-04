import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { EXIT } from "../src/errors.js";
import { commands } from "../src/registry.js";
import { fakeFetch, type RecordedCall } from "./fake-fetch.js";
import { fixtureNow, fixtureRawState } from "./fixture-state.js";

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
    fetchImpl: fakeFetch({ "/api/state": { body: { state: fixtureRawState() } }, ...routes }, calls)
  });
  return { exitCode, stdout: stdout.join("\n"), stderr: stderr.join("\n"), calls };
}

const PAYLOAD = '{"command":"save_project","body":{"expectedVersion":1,"project":{"id":"p1"}}}';
const stored = {
  id: "11111111-1111-4111-8111-111111111111",
  agent: "scribe",
  kind: "entity_command",
  summary: "Move the dentist",
  basis: "stated",
  status: "rejected",
  createdAt: "2026-09-04T07:00:00.000Z",
  resolvedAt: "2026-09-04T09:00:00.000Z",
  resolutionNote: "Not this week"
};

describe("registry", () => {
  it("lists proposals as a read command and propose as a write", () => {
    expect(commands.find((command) => command.name === "proposals")?.mutates).toBe(false);
    expect(commands.find((command) => command.name === "propose")?.mutates).toBe(true);
  });
});

describe("proposals", () => {
  it("lists the caller's proposals with status and resolution note", async () => {
    const { exitCode, stdout, calls } = await run(
      ["proposals", "--status", "rejected", "--limit", "5", "--agent", "scribe"],
      {
        "/api/agent-proposals": { body: { proposals: [stored] } }
      }
    );
    expect(exitCode).toBe(EXIT.ok);
    const url = new URL(calls.find((call) => call.path === "/api/agent-proposals")!.url);
    expect(url.searchParams.get("status")).toBe("rejected");
    expect(url.searchParams.get("limit")).toBe("5");
    expect(stdout).toContain("rejected");
    expect(stdout).toContain("Not this week");
    expect(calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("defaults to 20 rows and prints JSON rows", async () => {
    const { stdout, calls } = await run(["proposals", "--json"], {
      "/api/agent-proposals": { body: { proposals: [stored] } }
    });
    expect(new URL(calls.find((call) => call.path === "/api/agent-proposals")!.url).searchParams.get("limit")).toBe(
      "20"
    );
    expect(JSON.parse(stdout)[0].resolutionNote).toBe("Not this week");
  });

  it("refuses a bad status, a big limit and --state-file", async () => {
    expect((await run(["proposals", "--status", "maybe"])).exitCode).toBe(EXIT.usage);
    expect((await run(["proposals", "--limit", "201"])).exitCode).toBe(EXIT.usage);
    expect((await run(["proposals", "--state-file", "snapshot.json"])).exitCode).toBe(EXIT.usage);
  });
});

describe("propose", () => {
  const answer = { body: { proposal: { ...stored, status: "pending" }, outcome: "created" } };

  it("posts the proposal with a command id, basis, evidence and coalesce key", async () => {
    const { exitCode, stdout, calls } = await run(
      [
        "propose",
        "entity_command",
        "--summary",
        "Move the dentist",
        "--payload-json",
        PAYLOAD,
        "--basis",
        "stated",
        "--evidence",
        "Friday instead",
        "--coalesce-key",
        "dentist",
        "--agent",
        "scribe"
      ],
      { "/api/agent-proposals": answer }
    );
    expect(exitCode).toBe(EXIT.ok);
    const post = calls.find((call) => call.method === "POST")!;
    expect(post.path).toBe("/api/agent-proposals");
    expect(post.headers["x-openrhen-agent"]).toBe("scribe");
    expect(post.body).toMatchObject({
      kind: "entity_command",
      summary: "Move the dentist",
      basis: "stated",
      evidence: "Friday instead",
      coalesceKey: "dentist",
      payload: JSON.parse(PAYLOAD)
    });
    expect((post.body as { commandId: string }).commandId).toMatch(/^[0-9a-f-]{36}$/);
    expect(stdout).toContain("waiting for the person to confirm");
  });

  it("keeps a retry idempotent with --command-id", async () => {
    const { calls } = await run(
      [
        "propose",
        "entity_command",
        "--summary",
        "x",
        "--payload-json",
        PAYLOAD,
        "--command-id",
        "22222222-2222-4222-8222-222222222222"
      ],
      { "/api/agent-proposals": answer }
    );
    expect((calls.find((call) => call.method === "POST")!.body as { commandId: string }).commandId).toBe(
      "22222222-2222-4222-8222-222222222222"
    );
  });

  it("previews with --dry-run and sends nothing", async () => {
    const { exitCode, stdout, calls } = await run(
      ["propose", "entity_command", "--summary", "x", "--payload-json", PAYLOAD, "--dry-run"],
      { "/api/agent-proposals": answer }
    );
    expect(exitCode).toBe(EXIT.ok);
    expect(calls.some((call) => call.method === "POST")).toBe(false);
    expect(JSON.parse(stdout).dryRun).toBe(true);
  });

  it("needs no summary: the portal writes the line the person reads", async () => {
    const { exitCode, stdout } = await run(["propose", "entity_command", "--payload-json", PAYLOAD, "--dry-run"]);
    expect(exitCode).toBe(EXIT.ok);
    expect(JSON.parse(stdout).payload).not.toHaveProperty("summary");
  });

  it("refuses a missing or bad payload, an unknown basis and a long summary", async () => {
    expect((await run(["propose", "entity_command", "--summary", "x"])).exitCode).toBe(EXIT.usage);
    expect((await run(["propose", "entity_command", "--summary", "x", "--payload-json", "[1]"])).exitCode).toBe(
      EXIT.usage
    );
    expect((await run(["propose", "entity_command", "--summary", "x", "--payload-json", "{oops"])).exitCode).toBe(
      EXIT.usage
    );
    expect(
      (await run(["propose", "entity_command", "--summary", "x", "--payload-json", PAYLOAD, "--basis", "guess"]))
        .exitCode
    ).toBe(EXIT.usage);
    expect(
      (await run(["propose", "entity_command", "--summary", "x".repeat(301), "--payload-json", PAYLOAD])).exitCode
    ).toBe(EXIT.usage);
  });

  it("a 5xx on the write names the command id it carried, so a repeat with it is a no-op if it landed", async () => {
    const id = "2d8f4a52-1c1e-4c53-9d34-3a2f8f0c9a33";
    const broken = { "/api/agent-proposals": { status: 503, body: { error: "The portal is restarting." } } };
    const argv = [
      "propose",
      "entity_command",
      "--summary",
      "x",
      "--payload-json",
      PAYLOAD,
      "--agent",
      "scribe",
      "--json"
    ];
    const given = await run([...argv, "--command-id", id], broken);
    expect(given.exitCode).toBe(EXIT.unavailable);
    expect(JSON.parse(given.stdout)).toMatchObject({ exitCode: EXIT.unavailable, commandId: id });
    const minted = JSON.parse((await run(argv, broken)).stdout) as { commandId: string };
    expect(minted.commandId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("a failure before any write names no command id", async () => {
    const { stdout } = await run(["capture", "hi", "--json"], {
      "/api/state": { status: 503, body: { error: "down" } }
    });
    expect(JSON.parse(stdout)).not.toHaveProperty("commandId");
  });

  it("is a write command: --read-only refuses it", async () => {
    const { exitCode, calls } = await run([
      "propose",
      "entity_command",
      "--summary",
      "x",
      "--payload-json",
      PAYLOAD,
      "--read-only"
    ]);
    expect(exitCode).not.toBe(EXIT.ok);
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });
});
