import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { EXIT } from "../src/errors.js";
import { fakeFetch, type RecordedCall } from "./fake-fetch.js";
import { fixtureNow, fixtureRawState } from "./fixture-state.js";

async function run(argv: string[]) {
  const calls: RecordedCall[] = [];
  const lines: string[] = [];
  const exitCode = await runCli(["routine", ...argv], {
    stdout: (text) => lines.push(text),
    stderr: () => {},
    env: {},
    readConfigFile: () => null,
    now: () => fixtureNow,
    fetchImpl: fakeFetch({ "/api/state": { body: { state: fixtureRawState() } } }, calls)
  });
  return { exitCode, text: lines.join("\n"), calls };
}

describe("routine run", () => {
  it("saves a one-off commitment pinned to the preset, starting after its before-steps", async () => {
    const { exitCode, text } = await run(["run", "Gym prep", "--dry-run"]);
    expect(exitCode).toBe(0);
    const payload = JSON.parse(text.slice(text.indexOf("{")));
    const entity = payload.body?.entity ?? payload.entity ?? payload.payload?.entity;
    expect(entity).toMatchObject({
      title: "Gym prep",
      routineSource: "preset",
      routinePresetId: "preset-gym",
      status: "confirmed"
    });
    // One 10-minute before-step: the commitment starts 10 minutes after the fixture's now.
    expect(new Date(entity.startsAt).getTime() - fixtureNow.getTime()).toBe(10 * 60_000);
  });

  it("refuses an unknown preset and an unknown subcommand", async () => {
    expect((await run(["run", "nope", "--dry-run"])).exitCode).not.toBe(0);
    expect((await run(["stop", "Gym prep"])).exitCode).toBe(EXIT.usage);
  });
});
