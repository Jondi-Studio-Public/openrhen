import { stretchCommandSchema } from "@openrhen/contracts";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { EXIT } from "../src/errors.js";
import { fakeFetch, type RecordedCall } from "./fake-fetch.js";
import { fixtureNow, fixtureRawState } from "./fixture-state.js";

const STRETCH = "/api/commands/stretch";
const ID = "6f1c7a3e-3c1b-4d56-8d7e-0a1b2c3d4e5f";
const STATED = ["--basis", "stated", "--evidence", "Yes, give me the 45 minutes"];

const result = {
  choice: "accept",
  outcome: "accepted",
  actionId: "action-draft",
  title: "Draft chapter 3",
  minutes: 45,
  until: "2026-09-02T23:45:00.000Z",
  by: "agent",
  next: "Stretch started: Draft chapter 3 until 09:45. Start it with rhen_session start. rhen_undo reverses it.",
  revertible: ID
};

async function run(argv: string[], routes: Parameters<typeof fakeFetch>[0] = {}) {
  const calls: RecordedCall[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runCli(["stretch", "--command-id", ID, ...argv], {
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
    env: {},
    readConfigFile: () => null,
    now: () => fixtureNow,
    fetchImpl: fakeFetch({ "/api/state": { body: { state: fixtureRawState() } }, ...routes }, calls)
  });
  return { exitCode, stdout: stdout.join("\n"), stderr: stderr.join("\n"), calls };
}

describe("stretch", () => {
  it("is a write tool with choice, action and dry-run", async () => {
    const { commands } = await import("../src/registry.js");
    const spec = commands.find((command) => command.name === "stretch");
    expect(spec?.mutates).toBe(true);
    expect(Object.keys(spec!.options)).toEqual(expect.arrayContaining(["choice", "action", "dry-run"]));
  });

  it("dry-run prints the payload the portal would get, and sends nothing", async () => {
    const { exitCode, stdout, calls } = await run([
      "--choice",
      "accept",
      "--action",
      "action-draft",
      ...STATED,
      "--dry-run",
      "--json"
    ]);
    expect(exitCode).toBe(EXIT.ok);
    const printed = JSON.parse(stdout);
    expect(printed).toMatchObject({ dryRun: true, path: STRETCH });
    expect(printed.payload).toEqual({
      commandId: ID,
      choice: "accept",
      actionId: "action-draft",
      basis: "stated",
      evidence: "Yes, give me the 45 minutes"
    });
    expect(stretchCommandSchema.safeParse(printed.payload).success).toBe(true);
    expect(calls.filter((call) => call.method === "POST")).toEqual([]);
  });

  it("accept without an action is refused before anything is sent", async () => {
    const { exitCode, stderr, calls } = await run(["--choice", "accept", ...STATED]);
    expect(exitCode).not.toBe(EXIT.ok);
    expect(stderr).toContain("Say which action the stretch is for (action: the offer's actionId)");
    expect(calls.filter((call) => call.method === "POST")).toEqual([]);
  });

  it("a stated answer without the person's words is refused before anything is sent", async () => {
    const { exitCode, stderr } = await run(["--choice", "decline", "--action", "action-draft", "--basis", "stated"]);
    expect(exitCode).not.toBe(EXIT.ok);
    expect(stderr).toContain("A stated answer needs the person's words as evidence.");
  });

  it("a missing or unknown choice names the three values", async () => {
    for (const argv of [[], ["--choice", "yes"]]) {
      const { exitCode, stderr } = await run(argv);
      expect(exitCode).toBe(EXIT.usage);
      expect(stderr).toContain("accept, decline, decline_all");
    }
  });

  it("decline_all needs no action, basis or evidence", async () => {
    let body: Record<string, unknown> | undefined;
    const { exitCode } = await run(["--choice", "decline_all"], {
      [STRETCH]: (call) => {
        body = call.body as Record<string, unknown>;
        return { body: { result: { ...result, choice: "decline_all", outcome: "declined_all" }, revertible: ID } };
      }
    });
    expect(exitCode).toBe(EXIT.ok);
    expect(body).toEqual({ commandId: ID, choice: "decline_all" });
  });

  it("prints the answer's next step in table mode and the whole result as JSON", async () => {
    const routes = { [STRETCH]: { body: { result, revertible: ID } } };
    const table = await run(["--choice", "accept", "--action", "action-draft", ...STATED], routes);
    expect(table.exitCode).toBe(EXIT.ok);
    expect(table.stdout).toBe(result.next);
    const json = await run(["--choice", "accept", "--action", "action-draft", ...STATED, "--json"], routes);
    expect(JSON.parse(json.stdout)).toMatchObject({ outcome: "accepted", until: result.until, revertible: ID });
  });

  it("shows the portal's refusal, which ends with the exact next call", async () => {
    const refusal =
      "There is no stretch offer now. Nothing was changed. Next: call rhen_status; tell the person about a stretch only if its answer shows stretchOffer.";
    const { exitCode, stderr } = await run(["--choice", "accept", "--action", "action-draft", ...STATED], {
      [STRETCH]: { status: 409, body: { error: refusal } }
    });
    expect(exitCode).toBe(EXIT.conflict);
    expect(stderr).toContain("Next: call rhen_status");
  });
});
