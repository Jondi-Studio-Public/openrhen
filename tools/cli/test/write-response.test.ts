import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { EXIT } from "../src/errors.js";
import { fakeFetch, type RecordedCall } from "./fake-fetch.js";
import { fixtureActiveSession, fixtureNow, fixtureRawState } from "./fixture-state.js";

const COMMAND_ID = "7a1f0c52-3d4e-4b6a-9c8d-0e1f2a3b4c5d";
const SESSION_ID = "33333333-3333-4333-a333-333333333333";

async function run(
  argv: string[],
  routes: Parameters<typeof fakeFetch>[0] = {},
  rawState: Record<string, unknown> = fixtureRawState()
) {
  const calls: RecordedCall[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const exitCode = await runCli(argv, {
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    env: {},
    readConfigFile: () => null,
    now: () => fixtureNow,
    fetchImpl: fakeFetch({ "/api/state": { body: { state: rawState } }, ...routes }, calls)
  });
  return { exitCode, stdout: out.join("\n"), stderr: err.join("\n"), calls };
}

const running = (): Record<string, unknown> => ({
  ...fixtureRawState(),
  activeSession: { ...(fixtureActiveSession().activeSession as object), id: SESSION_ID }
});

describe("every write answers with an explicit applied flag", () => {
  it("a dry run says applied: false and names the command id it would send", async () => {
    const { exitCode, stdout } = await run([
      "activity",
      "start",
      "--type",
      "sleep",
      "--target",
      "sleep-tonight",
      "--minutes",
      "480",
      "--command-id",
      COMMAND_ID,
      "--dry-run"
    ]);
    expect(exitCode).toBe(EXIT.ok);
    const doc = JSON.parse(stdout) as Record<string, unknown>;
    expect(doc.dryRun).toBe(true);
    expect(doc.applied).toBe(false);
    expect(doc.commandId).toBe(COMMAND_ID);
  });

  it("activity start returns applied: true, the command id and the session record", async () => {
    const { exitCode, stdout } = await run(
      [
        "activity",
        "start",
        "--type",
        "fixed_commitment",
        "--target",
        "Gym session",
        "--minutes",
        "60",
        "--command-id",
        COMMAND_ID,
        "--json"
      ],
      { "/api/commands/activity": { body: { state: running() } } }
    );
    expect(exitCode).toBe(EXIT.ok);
    const doc = JSON.parse(stdout) as Record<string, unknown>;
    expect(doc.applied).toBe(true);
    expect(doc.commandId).toBe(COMMAND_ID);
    expect(doc.id).toBe(SESSION_ID);
  });

  it("activity pause (no record to show) carries applied: true and the command id", async () => {
    const raw = running();
    const { stdout } = await run(
      ["activity", "pause", "--command-id", COMMAND_ID, "--json"],
      { "/api/commands/activity": { body: { state: raw } } },
      raw
    );
    const doc = JSON.parse(stdout) as Record<string, unknown>;
    expect(doc.applied).toBe(true);
    expect(doc.commandId).toBe(COMMAND_ID);
  });

  it("recalculate says applied: true and the command id", async () => {
    const { stdout } = await run(["recalculate", "--command-id", COMMAND_ID, "--json"], {
      "/api/commands/recalculate": { body: { state: fixtureRawState() } }
    });
    const doc = JSON.parse(stdout) as Record<string, unknown>;
    expect(doc.applied).toBe(true);
    expect(doc.commandId).toBe(COMMAND_ID);
  });

  it("a plain save echoes the command id", async () => {
    const raw = fixtureRawState();
    const { stdout } = await run(
      ["save", "capture", "--set", "text=Book the dentist", "--command-id", COMMAND_ID, "--json"],
      {
        "/api/commands/entity": (call) => {
          const entity = (call.body as { entity: Record<string, unknown> }).entity;
          const captures = raw.captures as Record<string, unknown>[];
          return { body: { state: { ...raw, captures: [...captures, { status: "pending", ...entity }] } } };
        }
      }
    );
    const doc = JSON.parse(stdout) as Record<string, unknown>;
    expect(doc.applied).toBe(true);
    expect(doc.commandId).toBe(COMMAND_ID);
  });
});

describe("other write commands state applied explicitly too", () => {
  it("session start returns applied: true, the command id and the session record", async () => {
    const { exitCode, stdout } = await run(
      ["session", "start", "--action", "action-draft", "--minutes", "30", "--command-id", COMMAND_ID, "--json"],
      { "/api/commands/session": { body: { state: running() } } }
    );
    expect(exitCode).toBe(EXIT.ok);
    const doc = JSON.parse(stdout) as Record<string, unknown>;
    expect(doc.applied).toBe(true);
    expect(doc.commandId).toBe(COMMAND_ID);
    expect(doc.id).toBe(SESSION_ID);
  });

  it("check-in answers applied: true with the command id", async () => {
    const { exitCode, stdout } = await run(["check-in", "on-track", "--command-id", COMMAND_ID, "--json"], {
      "/api/check-ins/current": {
        body: { checkIn: { id: "e9f6ac30-f59f-4852-a65b-d3074da3b090", version: 3, status: "pending" } }
      },
      "/api/commands/check-in": { body: { state: fixtureRawState() } }
    });
    expect(exitCode).toBe(EXIT.ok);
    const doc = JSON.parse(stdout) as Record<string, unknown>;
    expect(doc.applied).toBe(true);
    expect(doc.commandId).toBe(COMMAND_ID);
  });

  it("a stretch dry run says applied: false", async () => {
    const stretch = await run([
      "stretch",
      "--choice",
      "accept",
      "--action",
      "action-draft",
      "--basis",
      "stated",
      "--evidence",
      "Yes, give me the 45 minutes",
      "--command-id",
      COMMAND_ID,
      "--dry-run"
    ]);
    expect(JSON.parse(stretch.stdout)).toMatchObject({ dryRun: true, applied: false, commandId: COMMAND_ID });
  });
});
