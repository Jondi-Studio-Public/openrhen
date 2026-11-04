import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { EXIT } from "../src/errors.js";
import { commands } from "../src/registry.js";
import { fakeFetch, type RecordedCall } from "./fake-fetch.js";
import { fixtureNow, fixtureRawState } from "./fixture-state.js";

async function run(argv: string[], routes: Parameters<typeof fakeFetch>[0] = {}) {
  const calls: RecordedCall[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runCli(argv, {
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
    env: {},
    readConfigFile: () => null,
    now: () => fixtureNow,
    fetchImpl: fakeFetch({ "/api/state": { body: { state: fixtureRawState() } }, ...routes }, calls)
  });
  return { exitCode, stdout: stdout.join("\n"), stderr: stderr.join("\n"), calls };
}

const done = {
  result: { recorded: true, doing: "Hospital", until: "x", revertible: "c1" },
  state: {},
  revertible: "c1"
};

describe("disrupt", () => {
  it("is a write command", () => {
    expect(commands.find((command) => command.name === "disrupt")?.mutates).toBe(true);
  });

  it("with no options only reads, and lists the places and contexts that can be named", async () => {
    const { exitCode, stdout, calls } = await run(["disrupt"]);
    expect(exitCode).toBe(EXIT.ok);
    expect(calls.every((call) => call.method === "GET")).toBe(true);
    expect(stdout).toContain("No disruption is in force");
    expect(stdout).toContain("ctx-home (Home)");
    expect(stdout).toContain("ctx-laptop (Laptop)");
  });

  it("resolves names to ids and posts one command with a time from the clock", async () => {
    const { exitCode, calls } = await run(
      [
        "disrupt",
        "--doing",
        "Hospital",
        "--until",
        "+3h",
        "--location",
        "home",
        "--contexts",
        "Laptop",
        "--exclusive",
        "false",
        "--json"
      ],
      { "/api/commands/pulse-disruption": { body: done } }
    );
    expect(exitCode).toBe(EXIT.ok);
    const post = calls.find((call) => call.method === "POST")!;
    expect(post.path).toBe("/api/commands/pulse-disruption");
    expect(post.body).toMatchObject({
      doing: "Hospital",
      until: new Date(fixtureNow.getTime() + 3 * 3_600_000).toISOString(),
      locationId: "ctx-home",
      contexts: ["ctx-laptop"],
      exclusive: false
    });
  });

  it("takes a plan item as the target", async () => {
    const { calls } = await run(["disrupt", "--target", "action:a1", "--doing", "Laundry"], {
      "/api/commands/pulse-disruption": { body: done }
    });
    expect(calls.find((call) => call.method === "POST")!.body).toMatchObject({
      doing: { kind: "action", id: "a1", title: "Laundry" }
    });
  });

  it("sends an incomplete answer on and shows the server's missing fields", async () => {
    const { exitCode, stderr } = await run(["disrupt", "--doing", "Hospital"], {
      "/api/commands/pulse-disruption": {
        status: 422,
        body: {
          code: "disruptionIncomplete",
          error:
            "A deviation stays on plan only when it is recorded with everything the plan needs; missing: until; exclusive. Nothing was recorded.",
          missing: ["until", "exclusive"]
        }
      }
    });
    expect(exitCode).toBe(EXIT.validation);
    expect(stderr).toContain("until");
    expect(stderr).toContain("exclusive");
  });

  it("ends a disruption with --end, ignoring the other options", async () => {
    const { calls } = await run(["disrupt", "--end", "--doing", "ignored"], {
      "/api/commands/pulse-disruption": { body: { ...done, result: { ended: true, revertible: "c1" } } }
    });
    const body = calls.find((call) => call.method === "POST")!.body as Record<string, unknown>;
    expect(body.end).toBe(true);
    expect(body.doing).toBeUndefined();
  });

  it("names an unknown place without posting, and rejects a bad --exclusive and --target", async () => {
    const place = await run(["disrupt", "--location", "Moon", "--doing", "x"]);
    expect(place.exitCode).toBe(EXIT.notFound);
    expect(place.stderr).toContain("ctx-home");
    expect(place.calls.some((call) => call.method === "POST")).toBe(false);
    expect((await run(["disrupt", "--exclusive", "maybe"])).exitCode).toBe(EXIT.usage);
    expect((await run(["disrupt", "--target", "banana"])).exitCode).toBe(EXIT.usage);
  });

  it("does not run in the dry-run", async () => {
    const { exitCode, calls, stdout } = await run(["disrupt", "--end", "--dry-run"]);
    expect(exitCode).toBe(EXIT.ok);
    expect(calls.some((call) => call.method === "POST")).toBe(false);
    expect(stdout).toContain("/api/commands/pulse-disruption");
  });
});
