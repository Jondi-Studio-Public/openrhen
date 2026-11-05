import { describe, expect, it } from "vitest";
import { REENTRY_REQUIRED_INSTRUCTION } from "@openrhen/contracts";
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

const view = {
  state: "off",
  reason: "lapsed",
  since: "2026-09-02T01:00:00.000Z",
  lastConfirmedAt: "2026-09-01T01:00:00.000Z",
  silenceUntil: null,
  reentry: { due: true, tier: "today", gapMinutes: 1440, missing: ["location", "energy", "contexts", "review 1 item"] }
};
const lapsed = {
  pulse: view,
  lapsed: true,
  review: {
    tier: "today",
    reviewable: 1,
    lapsing: 0,
    days: [],
    projects: [],
    entries: [
      {
        id: "deadline:p1",
        kind: "self_set_deadline",
        title: "Thesis draft",
        plannedAt: "2026-09-01T09:00:00.000Z",
        version: 4
      }
    ]
  },
  choices: {
    places: [
      { id: "ctx-home", name: "Home" },
      { id: "ctx-campus", name: "Campus" }
    ],
    contexts: [{ id: "laptop", name: "Laptop" }]
  }
};
const on = {
  pulse: {
    ...view,
    state: "on",
    reason: "confirmed",
    reentry: { due: false, tier: "none", gapMinutes: 5, missing: [] }
  },
  lapsed: false
};

describe("registry", () => {
  it("lists reenter as a write command", () => {
    expect(commands.find((command) => command.name === "reenter")?.mutates).toBe(true);
  });
});

describe("reenter", () => {
  it("with no answers only reads, and prints what is needed and the choices", async () => {
    const { exitCode, stdout, calls } = await run(["reenter"], { "/api/commands/reenter": { body: lapsed } });
    expect(exitCode).toBe(EXIT.ok);
    expect(calls.every((call) => call.method === "GET")).toBe(true);
    expect(stdout).toContain("Still needed: location; energy; contexts; review 1 item");
    expect(stdout).toContain("ctx-home (Home)");
    expect(stdout).toContain('deadline:p1 self_set_deadline "Thesis draft"');
  });

  it("says there is nothing to re-enter when the pulse is on", async () => {
    const { exitCode, stdout } = await run(["reenter"], { "/api/commands/reenter": { body: on } });
    expect(exitCode).toBe(EXIT.ok);
    expect(stdout).toContain("nothing to re-enter");
  });

  it("refuses answers when the pulse is on, without posting", async () => {
    const { exitCode, calls } = await run(["reenter", "--location", "Home", "--energy", "low", "--contexts", "none"], {
      "/api/commands/reenter": { body: on }
    });
    expect(exitCode).toBe(EXIT.conflict);
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("resolves place and context names to ids and posts one command", async () => {
    const { exitCode, calls, stdout } = await run(
      [
        "reenter",
        "--location",
        "home",
        "--energy",
        "medium",
        "--contexts",
        "Laptop",
        "--settlement-json",
        '{"items":[{"entryId":"deadline:p1","verdict":"pending"}]}',
        "--json"
      ],
      {
        "/api/commands/reenter": (call) => ({
          body:
            call.method === "GET"
              ? lapsed
              : { result: { reentered: true, lapsed: 0, unrecorded: 0, revertible: "c1" }, state: {}, revertible: "c1" }
        })
      }
    );
    expect(exitCode).toBe(EXIT.ok);
    const post = calls.find((call) => call.method === "POST")!;
    expect(post.path).toBe("/api/commands/reenter");
    expect(post.body).toMatchObject({
      locationId: "ctx-home",
      energy: "medium",
      contexts: ["laptop"],
      settlement: { items: [{ entryId: "deadline:p1", verdict: "pending" }] }
    });
    expect(JSON.parse(stdout)).toMatchObject({ reentered: true, revertible: "c1" });
  });

  it("sends 'none' as an empty context list, which is an answer", async () => {
    const { calls } = await run(["reenter", "--location", "ctx-home", "--energy", "low", "--contexts", "none"], {
      "/api/commands/reenter": (call) => ({
        body: call.method === "GET" ? lapsed : { result: { reentered: true }, state: {} }
      })
    });
    expect(calls.find((call) => call.method === "POST")!.body).toMatchObject({ contexts: [] });
  });

  it("names an unknown place and lists the known ones", async () => {
    const { exitCode, stderr, calls } = await run(
      ["reenter", "--location", "Mars", "--energy", "low", "--contexts", "none"],
      {
        "/api/commands/reenter": { body: lapsed }
      }
    );
    expect(exitCode).toBe(EXIT.notFound);
    expect(stderr).toContain("ctx-home (Home)");
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("prints a dry run without posting", async () => {
    const { exitCode, stdout, calls } = await run(
      ["reenter", "--location", "ctx-home", "--energy", "low", "--contexts", "none", "--dry-run"],
      { "/api/commands/reenter": { body: lapsed } }
    );
    expect(exitCode).toBe(EXIT.ok);
    expect(calls.some((call) => call.method === "POST")).toBe(false);
    expect(stdout).toContain('"dryRun": true');
    expect(JSON.parse(stdout)).toMatchObject({ applied: false });
  });

  it("surfaces the portal's 422 as a validation error whose details name each gap", async () => {
    const body = {
      code: "reentryIncomplete",
      error: "Re-entry is incomplete (gap of 2 to 36 hours); nothing was written. Still needed: energy.",
      tier: "today",
      missing: ["energy"]
    };
    const { exitCode, stdout } = await run(["reenter", "--location", "ctx-home", "--contexts", "none", "--json"], {
      "/api/commands/reenter": (call) => (call.method === "GET" ? { body: lapsed } : { status: 422, body })
    });
    expect(exitCode).toBe(EXIT.validation);
    expect(JSON.parse(stdout)).toMatchObject({ error: body.error, details: { missing: ["energy"] } });
  });
});

describe("status", () => {
  it("carries the pulse fields and what re-entry needs", async () => {
    const { exitCode, stdout } = await run(["status", "--json"], { "/api/pulse/reentry": { body: on } });
    expect(exitCode).toBe(EXIT.ok);
    expect(JSON.parse(stdout).pulse).toMatchObject({
      state: "on",
      // Instants are shown in the person's time zone, like every other status field.
      since: "2026-09-02T11:00:00+10:00",
      lastConfirmedAt: "2026-09-01T11:00:00+10:00",
      silenceUntil: null,
      reentry: { due: false, tier: "none", gapMinutes: 5, missing: [] }
    });
  });

  it("still answers when the pulse cannot be read, and the brief digest carries it too", async () => {
    const plain = await run(["status", "--json"]);
    expect(plain.exitCode).toBe(EXIT.ok);
    expect(JSON.parse(plain.stdout).pulse).not.toHaveProperty("reentry");
    const brief = await run(["status", "--brief", "--json"], { "/api/pulse/reentry": { body: on } });
    expect(JSON.parse(brief.stdout).pulse).toMatchObject({ state: "on", reentry: { due: false } });
  });
});

describe("the agent gate as the CLI sees it", () => {
  const refusal = {
    code: "reentryRequired",
    error: REENTRY_REQUIRED_INSTRUCTION,
    pulse: view,
    missing: view.reentry.missing
  };

  it("exits with the reentry code and keeps the pulse fields and missing in the details", async () => {
    const { exitCode, stdout } = await run(["status", "--json"], { "/api/state": { status: 428, body: refusal } });
    expect(exitCode).toBe(EXIT.reentry);
    expect(JSON.parse(stdout)).toMatchObject({
      error: refusal.error,
      exitCode: EXIT.reentry,
      details: { code: "reentryRequired", missing: refusal.missing, pulse: { state: "off", reason: "lapsed" } }
    });
  });

  it("puts the notice on stderr for guide, help and version when the pulse has lapsed", async () => {
    for (const argv of [["guide"], ["help"], ["version"]]) {
      const { exitCode, stdout, stderr } = await run(
        argv,
        { "/api/pulse/reentry": { body: lapsed } },
        { OPENRHEN_TOKEN: "t" }
      );
      expect(exitCode).toBe(EXIT.ok);
      expect(stdout).not.toContain("You must call rhen_reenter");
      expect(stderr).toContain("You must call rhen_reenter and complete it before anything else");
    }
  });

  it("says nothing extra when the pulse is on or the portal cannot be asked", async () => {
    const quiet = await run(["guide"], { "/api/pulse/reentry": { body: on } }, { OPENRHEN_TOKEN: "t" });
    expect(quiet.stderr).not.toContain("rhen_reenter");
    const down = await run(["guide"], {}, { OPENRHEN_TOKEN: "t" });
    expect(down.exitCode).toBe(EXIT.ok);
    expect(down.stderr).not.toContain("rhen_reenter");
  });

  it("does not ask at all without a token or agent name, so a person's offline help stays offline", async () => {
    const { calls } = await run(["help"], { "/api/pulse/reentry": { body: lapsed } });
    expect(calls).toEqual([]);
  });
});
