import { recordCadenceCompletionCommandSchema } from "@openrhen/contracts";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { EXIT } from "../src/errors.js";
import { fakeFetch, type RecordedCall } from "./fake-fetch.js";
import { fixtureNow, fixtureRawState } from "./fixture-state.js";

interface RunResult {
  exitCode: number;
  lines: string[];
  text: string;
  stderr: string;
  calls: RecordedCall[];
}

async function run(
  argv: string[],
  routes: Parameters<typeof fakeFetch>[0] = {},
  overrides: (raw: Record<string, unknown>) => Record<string, unknown> = (raw) => raw
): Promise<RunResult> {
  const calls: RecordedCall[] = [];
  const lines: string[] = [];
  let stderr = "";
  const state = overrides(fixtureRawState());
  const exitCode = await runCli(["cadence", ...argv], {
    stdout: (text) => lines.push(text),
    stderr: (text) => {
      stderr += (stderr ? "\n" : "") + text;
    },
    env: {},
    readConfigFile: () => null,
    now: () => fixtureNow,
    fetchImpl: fakeFetch({ "/api/state": { body: { state } }, ...routes }, calls)
  });
  return { exitCode, lines, text: lines.join("\n"), stderr, calls };
}

/** Adds a `version` to `action-weed`, which the fixture otherwise leaves out. */
function withWeedVersion(version: number) {
  return (raw: Record<string, unknown>): Record<string, unknown> => {
    const actions = raw.actions as Record<string, unknown>[];
    return {
      ...raw,
      actions: actions.map((action) => (action.id === "action-weed" ? { ...action, version } : action))
    };
  };
}

describe("cadence", () => {
  it("resolves the action by exact title", async () => {
    const result = await run(["complete", "Weed the beds"], {
      "/api/commands/cadence-completion": (call) => {
        const parsed = recordCadenceCompletionCommandSchema.safeParse(call.body);
        expect(parsed.success).toBe(true);
        const body = call.body as Record<string, unknown>;
        expect(body.actionId).toBe("action-weed");
        expect(body.type).toBe("record_cadence_completion");
        return { body: { state: fixtureRawState() } };
      }
    });
    expect(result.exitCode).toBe(EXIT.ok);
  });

  it("resolves --date today to the local date in the portal's timezone (Australia/Sydney)", async () => {
    const result = await run(["complete", "action-weed", "--date", "today"], {
      "/api/commands/cadence-completion": (call) => {
        const body = call.body as Record<string, unknown>;
        expect(body.localDate).toBe("2026-09-03");
        return { body: { state: fixtureRawState() } };
      }
    });
    expect(result.exitCode).toBe(EXIT.ok);
  });

  it("passes an explicit --date and --minutes through", async () => {
    const result = await run(["complete", "action-weed", "--date", "2026-09-01", "--minutes", "20"], {
      "/api/commands/cadence-completion": (call) => {
        const body = call.body as Record<string, unknown>;
        expect(body.localDate).toBe("2026-09-01");
        expect(body.minutes).toBe(20);
        return { body: { state: fixtureRawState() } };
      }
    });
    expect(result.exitCode).toBe(EXIT.ok);
  });

  it("refuses a non-integer --minutes as a usage error, without posting", async () => {
    const result = await run(["complete", "action-weed", "--minutes", "abc"]);
    expect(result.exitCode).toBe(EXIT.usage);
    expect(result.calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("refuses a negative --minutes", async () => {
    const result = await run(["complete", "action-weed", "--minutes", "-5"]);
    expect(result.exitCode).toBe(EXIT.usage);
  });

  it("refuses an unknown cadence subcommand", async () => {
    const result = await run(["skip", "action-weed"]);
    expect(result.exitCode).toBe(EXIT.usage);
  });

  it("sends the action's own version as expectedVersion", async () => {
    const result = await run(
      ["complete", "action-weed"],
      {
        "/api/commands/cadence-completion": (call) => {
          const body = call.body as Record<string, unknown>;
          expect(body.expectedVersion).toBe(7);
          return { body: { state: fixtureRawState() } };
        }
      },
      withWeedVersion(7)
    );
    expect(result.exitCode).toBe(EXIT.ok);
  });

  it("prints the payload and sends nothing on --dry-run", async () => {
    const result = await run(["complete", "action-weed", "--minutes", "15", "--dry-run"]);
    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.calls.some((call) => call.method === "POST")).toBe(false);
    const printed = JSON.parse(result.text) as { dryRun: boolean; payload: { actionId: string; minutes: number } };
    expect(printed.dryRun).toBe(true);
    expect(printed.payload.actionId).toBe("action-weed");
    expect(printed.payload.minutes).toBe(15);
  });
});
