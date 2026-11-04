import { wakeCommandSchema } from "@openrhen/contracts";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { EXIT } from "../src/errors.js";
import { memoryJournal, type Journal } from "../src/undo-journal.js";
import { fakeFetch, type RecordedCall } from "./fake-fetch.js";
import { fixtureNow, fixtureRawState } from "./fixture-state.js";

interface Run {
  exitCode: number;
  stdout: string;
  stderr: string;
  calls: RecordedCall[];
}

const WAKE = "/api/commands/wake";
// fixtureNow is 09:30 on Wednesday 2026-09-03 in the seed zone (+10:00).
const WOKE = "2026-09-03T07:00:00+10:00";
const SLEPT = "2026-09-02T23:15:00+10:00";
const SLEEP_PLAN_ID = "33333333-3333-4333-a333-333333333333";

/** What the portal answers: the state, and which of the three things it did. */
function answer(wake: Record<string, unknown> | undefined, lastWokeAt = "2026-09-02T21:00:00.000Z") {
  const state = fixtureRawState();
  state.settings = { ...(state.settings as Record<string, unknown>), lastWokeAt };
  return { body: { state, ...(wake ? { wake } : {}) } };
}

async function run(argv: string[], routes: Parameters<typeof fakeFetch>[0] = {}): Promise<Run> {
  const calls: RecordedCall[] = [];
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const exitCode = await runCli(["wake", ...argv], {
    stdout: (text) => stdoutLines.push(text),
    stderr: (text) => stderrLines.push(text),
    env: {},
    readConfigFile: () => null,
    now: () => fixtureNow,
    fetchImpl: fakeFetch({ "/api/state": { body: { state: fixtureRawState() } }, ...routes }, calls)
  });
  return { exitCode, stdout: stdoutLines.join("\n"), stderr: stderrLines.join("\n"), calls };
}

const posts = (calls: RecordedCall[]) => calls.filter((call) => call.method === "POST");

describe("wake", () => {
  it("is a write tool with the two time flags", async () => {
    const { commands } = await import("../src/registry.js");
    const spec = commands.find((command) => command.name === "wake");
    expect(spec?.mutates).toBe(true);
    expect(Object.keys(spec!.options)).toEqual(expect.arrayContaining(["at", "slept-at", "dry-run"]));
  });

  it("carries the pulse and what re-entry needs in its answer", async () => {
    const pulse = {
      state: "on",
      reason: "confirmed",
      since: "2026-10-28T00:00:00Z",
      lastConfirmedAt: "2026-10-28T00:00:00Z",
      silenceUntil: null,
      reentry: { due: false, tier: "none", gapMinutes: 5, missing: [] }
    };
    const { exitCode, stdout } = await run(["--json"], {
      [WAKE]: () => answer(undefined),
      "/api/pulse/reentry": { body: { pulse, lapsed: false } }
    });
    expect(exitCode).toBe(EXIT.ok);
    expect(JSON.parse(stdout).pulse).toMatchObject({ state: "on", reentry: { due: false, tier: "none" } });
  });

  it("sends only the command when no time is given, so the portal's clock decides now", async () => {
    let body: Record<string, unknown> | undefined;
    const { exitCode, calls } = await run([], {
      [WAKE]: (call) => {
        body = call.body as Record<string, unknown>;
        return answer(undefined);
      }
    });
    expect(exitCode).toBe(EXIT.ok);
    expect(wakeCommandSchema.safeParse(body).success).toBe(true);
    expect(body).toEqual({ commandId: expect.any(String), type: "wake" });
    // It reads nothing first: the portal settles the night in one transaction. Only the pulse is read afterwards.
    expect(calls.filter((call) => call.method === "GET" && !call.url.includes("/api/pulse/reentry"))).toHaveLength(0);
    expect(posts(calls)).toHaveLength(1);
  });

  it("sends --at and --slept-at as given", async () => {
    let body: Record<string, unknown> | undefined;
    const { exitCode } = await run(["--at", WOKE, "--slept-at", SLEPT], {
      [WAKE]: (call) => {
        body = call.body as Record<string, unknown>;
        return answer(undefined);
      }
    });
    expect(exitCode).toBe(EXIT.ok);
    expect(wakeCommandSchema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({ type: "wake", at: WOKE, sleptAt: SLEPT });
  });

  it("uses --command-id as the command id, so a retry applies at most once", async () => {
    const id = "6f1c7a3e-3c1b-4d56-8d7e-0a1b2c3d4e5f";
    let body: Record<string, unknown> | undefined;
    await run(["--command-id", id], {
      [WAKE]: (call) => {
        body = call.body as Record<string, unknown>;
        return answer(undefined);
      }
    });
    expect(body?.commandId).toBe(id);
  });

  it("says which night it settled, in the planning timezone", async () => {
    const finished = await run(["--at", WOKE], {
      [WAKE]: answer({
        outcome: "finished_session",
        sleepPlanId: SLEEP_PLAN_ID,
        sleptAt: "2026-09-02T13:20:00.000Z",
        wokeAt: "2026-09-02T21:00:00.000Z",
        startAssumed: false
      })
    });
    expect(finished.stdout).toContain("Finished the running sleep: slept Wed 23:20, woke 07:00 (7 h 40 min).");
    const logged = await run(["--at", WOKE, "--slept-at", SLEPT], {
      [WAKE]: answer({
        outcome: "logged_night",
        sleepPlanId: SLEEP_PLAN_ID,
        sleptAt: "2026-09-02T13:15:00.000Z",
        wokeAt: "2026-09-02T21:00:00.000Z",
        startAssumed: false
      })
    });
    expect(logged.stdout).toContain("Logged last night: slept Wed 23:15, woke 07:00 (7 h 45 min).");
  });

  it("says when only the wake was recorded and no night was logged", async () => {
    const { stdout } = await run(["--at", WOKE], {
      [WAKE]: answer({ outcome: "recorded_wake", wokeAt: "2026-09-02T21:00:00.000Z" })
    });
    expect(stdout).toContain("Recorded the wake at 07:00. No night was logged: give --slept-at to log one.");
  });

  it("marks an assumed start and says how to correct it", async () => {
    const { stdout } = await run(["--at", WOKE], {
      [WAKE]: answer({
        outcome: "completed_plan",
        sleepPlanId: SLEEP_PLAN_ID,
        sleptAt: "2026-09-02T12:30:00.000Z",
        wokeAt: "2026-09-02T21:00:00.000Z",
        startAssumed: true
      })
    });
    expect(stdout).toContain(
      "Completed last night's planned sleep: slept Wed 22:30 (assumed), woke 07:00 (8 h 30 min)."
    );
    expect(stdout).toContain(`save sleep-log-entry --id ${SLEEP_PLAN_ID} --set sleepAt=<time> --set wakeAt=<time>`);
  });

  it("prints the settled night and the derived lastWokeAt as JSON, localised", async () => {
    const { exitCode, stdout } = await run(["--json", "--at", WOKE], {
      [WAKE]: answer(
        {
          outcome: "completed_plan",
          sleepPlanId: SLEEP_PLAN_ID,
          sleptAt: "2026-09-02T12:30:00.000Z",
          wokeAt: "2026-09-02T21:00:00.000Z",
          startAssumed: true
        },
        "2026-09-02T21:00:00.000Z"
      )
    });
    expect(exitCode).toBe(EXIT.ok);
    expect(JSON.parse(stdout)).toEqual({
      ok: true,
      outcome: "completed_plan",
      sleepPlanId: SLEEP_PLAN_ID,
      sleptAt: "2026-09-02T22:30:00+10:00",
      wokeAt: "2026-09-03T07:00:00+10:00",
      startAssumed: true,
      lastWokeAt: "2026-09-03T07:00:00+10:00"
    });
  });

  it("says so when the portal had already applied this command", async () => {
    const { exitCode, stdout } = await run([], { [WAKE]: answer(undefined) });
    expect(exitCode).toBe(EXIT.ok);
    expect(stdout).toContain("already applied");
  });

  it("prints the payload and sends nothing on --dry-run", async () => {
    const { exitCode, stdout, calls } = await run(["--at", WOKE, "--slept-at", SLEPT, "--dry-run"]);
    expect(exitCode).toBe(EXIT.ok);
    expect(posts(calls)).toHaveLength(0);
    const printed = JSON.parse(stdout) as { dryRun: boolean; path: string; payload: Record<string, unknown> };
    expect(printed.dryRun).toBe(true);
    expect(printed.path).toBe(WAKE);
    expect(wakeCommandSchema.safeParse(printed.payload).success).toBe(true);
    expect(printed.payload).toMatchObject({ at: WOKE, sleptAt: SLEPT });
  });

  describe("refuses, before anything is sent", () => {
    it.each([
      ["a wake in the future", ["--at", "2026-09-03T12:00:00+10:00"], "--at must be in the past"],
      ["a wake more than 24 hours back", ["--at", "2026-09-02T08:00:00+10:00"], "within the last 24 hours"],
      ["a sleep more than 24 hours back", ["--slept-at", "2026-09-02T08:00:00+10:00"], "--slept-at must be within"],
      ["a time that is not a date", ["--at", "seven"], "--at must be a valid ISO 8601"],
      ["a time with no offset", ["--at", "2026-09-03T07:00:00"], "--at needs an offset"],
      ["a date with no time", ["--slept-at", "2026-09-02"], "--slept-at needs an offset"],
      ["a sleep at or after the wake", ["--at", WOKE, "--slept-at", WOKE], "--slept-at must be before the wake"],
      [
        "a sleep after now when no wake is given",
        ["--slept-at", "2026-09-03T09:30:00+10:00"],
        "must be before the wake"
      ]
    ])("%s", async (_name, argv, message) => {
      const { exitCode, stderr, calls } = await run(argv);
      expect(exitCode).toBe(EXIT.usage);
      expect(stderr).toContain(message);
      expect(posts(calls)).toHaveLength(0);
    });

    it("takes a wake a few minutes ahead of the clock, as the portal does", async () => {
      const { exitCode, calls } = await run(["--at", "2026-09-03T09:33:00+10:00"], { [WAKE]: answer(undefined) });
      expect(exitCode).toBe(EXIT.ok);
      expect(posts(calls)).toHaveLength(1);
    });
  });

  it("passes the portal's refusal on, with its reason", async () => {
    const { exitCode, stderr } = await run(["--at", WOKE, "--slept-at", SLEPT], {
      [WAKE]: { status: 400, body: { error: "This night overlaps one already logged, from 11:00 pm to 7:00 am." } }
    });
    expect(exitCode).not.toBe(EXIT.ok);
    expect(stderr).toContain("overlaps one already logged");
  });

  it("is refused under --read-only", async () => {
    const { exitCode, calls } = await run(["--read-only"]);
    expect(exitCode).not.toBe(EXIT.ok);
    expect(posts(calls)).toHaveLength(0);
  });
});

describe("undoing a wake", () => {
  const NIGHT = {
    outcome: "completed_plan",
    sleepPlanId: SLEEP_PLAN_ID,
    sleptAt: "2026-09-02T12:30:00.000Z",
    wokeAt: "2026-09-02T21:00:00.000Z",
    startAssumed: true
  };

  async function runWithJournal(argv: string[], journal: Journal, revertible: boolean) {
    const calls: RecordedCall[] = [];
    const stderrLines: string[] = [];
    const exitCode = await runCli(argv, {
      stdout: () => undefined,
      stderr: (text) => stderrLines.push(text),
      env: {},
      readConfigFile: () => null,
      now: () => fixtureNow,
      journal,
      fetchImpl: fakeFetch(
        {
          "/api/state": { body: { state: fixtureRawState() } },
          [WAKE]: (call) => ({
            body: {
              ...answer(NIGHT).body,
              ...(revertible ? { revertible: (call.body as { commandId: string }).commandId } : {})
            }
          }),
          "/api/commands/revert": { body: { state: fixtureRawState() } }
        },
        calls
      )
    });
    return { exitCode, stderr: stderrLines.join("\n"), calls };
  }

  it("journals the wake as one entry the portal reverts whole, so a single undo reverses it", async () => {
    const journal = memoryJournal();
    const woke = await runWithJournal(["wake", "--at", WOKE, "--agent", "alice"], journal, true);
    expect(woke.exitCode).toBe(EXIT.ok);
    expect(woke.stderr).toContain("undo with `rhen undo`");
    const sent = posts(woke.calls)[0]!.body as { commandId: string };
    expect(journal.read()).toHaveLength(1);
    expect(journal.read()[0]).toMatchObject({
      status: "applied",
      serverChecked: true,
      undo: { path: "/api/commands/revert", payload: { target: sent.commandId, direction: "undo" } },
      redo: { path: "/api/commands/revert", payload: { target: sent.commandId, direction: "redo" } }
    });

    const undone = await runWithJournal(["undo", "--agent", "alice"], journal, true);
    expect(undone.exitCode).toBe(EXIT.ok);
    expect(posts(undone.calls)).toHaveLength(1);
    expect(posts(undone.calls)[0]).toMatchObject({
      path: "/api/commands/revert",
      body: { target: sent.commandId, direction: "undo" }
    });
    expect(journal.read()[0]?.status).toBe("undone");
  });

  it("records nothing when the portal did not keep the rows (the person's own wake)", async () => {
    const journal = memoryJournal();
    const woke = await runWithJournal(["wake", "--at", WOKE], journal, false);
    expect(woke.exitCode).toBe(EXIT.ok);
    expect(journal.read()).toEqual([]);
    expect(woke.stderr).not.toContain("rhen undo");
  });
});
