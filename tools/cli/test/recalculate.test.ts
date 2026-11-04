import { recalculateCommandSchema } from "@openrhen/contracts";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { EXIT } from "../src/errors.js";
import { localiseInstant } from "../src/when.js";
import { fakeFetch, type RecordedCall } from "./fake-fetch.js";
import { fixtureNow, fixtureRawState, fixtureTimeZone } from "./fixture-state.js";

interface RunResult {
  exitCode: number;
  lines: string[];
  text: string;
  stderr: string;
  calls: RecordedCall[];
}

async function run(argv: string[], routes: Parameters<typeof fakeFetch>[0] = {}): Promise<RunResult> {
  const calls: RecordedCall[] = [];
  const lines: string[] = [];
  let stderr = "";
  const exitCode = await runCli(["recalculate", ...argv], {
    stdout: (text) => lines.push(text),
    stderr: (text) => {
      stderr += (stderr ? "\n" : "") + text;
    },
    env: {},
    readConfigFile: () => null,
    now: () => fixtureNow,
    fetchImpl: fakeFetch({ "/api/state": { body: { state: fixtureRawState() } }, ...routes }, calls)
  });
  return { exitCode, lines, text: lines.join("\n"), stderr, calls };
}

describe("recalculate", () => {
  it("posts the current time and the requested conditions", async () => {
    const result = await run(["--conditions", "home,laptop"], {
      "/api/commands/recalculate": (call) => {
        const parsed = recalculateCommandSchema.safeParse(call.body);
        expect(parsed.success).toBe(true);
        const body = call.body as Record<string, unknown>;
        expect(body.now).toBe(fixtureNow.toISOString());
        expect(body.assertedConditions).toEqual(["home", "laptop"]);
        return { body: { state: fixtureRawState() } };
      }
    });
    expect(result.exitCode).toBe(EXIT.ok);
  });

  it("omits assertedConditions entirely when --conditions is not given", async () => {
    const result = await run([], {
      "/api/commands/recalculate": (call) => {
        const body = call.body as Record<string, unknown>;
        expect(body.now).toBe(fixtureNow.toISOString());
        expect("assertedConditions" in body).toBe(false);
        return { body: { state: fixtureRawState() } };
      }
    });
    expect(result.exitCode).toBe(EXIT.ok);
  });

  it("prints the plan status and lastSuccessfulAt from the returned state in JSON mode", async () => {
    const result = await run(["--json"], {
      "/api/commands/recalculate": { body: { state: fixtureRawState() } }
    });
    expect(result.exitCode).toBe(EXIT.ok);
    const printed = JSON.parse(result.text) as { status: string; lastSuccessfulAt: string };
    expect(printed.status).toBe("current");
    expect(printed.lastSuccessfulAt).toBe("2026-09-03T09:12:00+10:00");
  });

  it("prints a fallback line when the returned state carries no planning document", async () => {
    const result = await run([], {
      "/api/commands/recalculate": {
        body: {
          state: (() => {
            const { planning: _planning, ...rest } = fixtureRawState();
            return rest;
          })()
        }
      }
    });
    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.text).toContain("Recalculation queued.");
  });

  it("prints the plan line in table mode", async () => {
    const result = await run([], { "/api/commands/recalculate": { body: { state: fixtureRawState() } } });
    expect(result.text).toContain("current");
  });

  it("localises lastSuccessfulAt to the portal's timezone in JSON mode, even when the portal returns a bare UTC instant", async () => {
    const rawState = fixtureRawState();
    (rawState.planning as Record<string, unknown>).lastSuccessfulAt = "2026-09-03T23:12:00Z";
    const result = await run(["--json"], { "/api/commands/recalculate": { body: { state: rawState } } });
    expect(result.exitCode).toBe(EXIT.ok);
    const printed = JSON.parse(result.text) as { lastSuccessfulAt: string };
    expect(printed.lastSuccessfulAt).toBe(localiseInstant("2026-09-03T23:12:00Z", fixtureTimeZone));
    expect(printed.lastSuccessfulAt).not.toContain("Z");
  });

  it("prints a localised wall-clock time in table mode rather than the raw ISO instant", async () => {
    const rawState = fixtureRawState();
    (rawState.planning as Record<string, unknown>).lastSuccessfulAt = "2026-09-03T23:12:00Z";
    const result = await run([], { "/api/commands/recalculate": { body: { state: rawState } } });
    expect(result.text).not.toContain("2026-09-03T23:12:00Z");
    expect(result.text).toContain("09:12");
  });

  it("prints the payload and sends nothing on --dry-run", async () => {
    const result = await run(["--conditions", "home", "--dry-run"]);
    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.calls.some((call) => call.method === "POST")).toBe(false);
    const printed = JSON.parse(result.text) as { dryRun: boolean; payload: { assertedConditions: string[] } };
    expect(printed.dryRun).toBe(true);
    expect(printed.payload.assertedConditions).toEqual(["home"]);
  });
});
