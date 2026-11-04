import { describe, expect, it } from "vitest";
import { z } from "zod";
import { runCli } from "../src/cli.js";
import { EXIT } from "../src/errors.js";
import { describeIssues } from "../src/issues.js";
import { fakeFetch } from "./fake-fetch.js";
import { fixtureNow, fixtureRawState } from "./fixture-state.js";

const schema = z.object({
  outcome: z.enum(["completed", "progress", "stopped"]),
  startedAt: z.iso.datetime({ offset: true }),
  nested: z.object({ count: z.number() })
});

function issuesOf(input: unknown) {
  const parsed = schema.safeParse(input);
  if (parsed.success) throw new Error("expected a failure");
  return JSON.parse(JSON.stringify(parsed.error.issues)) as unknown[];
}

describe("describeIssues", () => {
  const issues = issuesOf({ outcome: "bogus", startedAt: "2026-10-27T14:54:00", nested: { count: "x" } });

  it("names the allowed options of an enum", () => {
    expect(describeIssues(issues, ["outcome"])?.[0]).toBe("--outcome must be one of: completed, progress, stopped");
  });

  it("says to include an offset instead of printing the datetime regex", () => {
    const line = describeIssues(issues, ["started-at"])?.[1] ?? "";
    expect(line).toContain("--started-at must be an ISO date and time that includes an offset like +11:00 or Z");
    expect(line).not.toContain("^(?:");
  });

  it("falls back to the dotted path for a field that is not a flag, and trims zod's prefix", () => {
    expect(describeIssues(issues, ["outcome"])?.[2]).toBe("nested.count: expected number, received string");
  });

  it("names the bound of a number and the flag that sets it", () => {
    const parsed = z
      .object({ plannedMinutes: z.number().int().positive().max(1440) })
      .safeParse({ plannedMinutes: 99999 });
    const tooBig = JSON.parse(JSON.stringify(parsed.error?.issues));
    expect(describeIssues(tooBig, ["minutes", "action"])).toEqual(["--minutes must be at most 1440"]);
    const zero = z.object({ plannedMinutes: z.number().positive() }).safeParse({ plannedMinutes: 0 });
    expect(describeIssues(JSON.parse(JSON.stringify(zero.error?.issues)), ["minutes"])).toEqual([
      "--minutes must be greater than 0"
    ]);
  });

  it("returns null for details that are not an issue list", () => {
    expect(describeIssues({ reason: "x" })).toBeNull();
    expect(describeIssues([])).toBeNull();
    expect(describeIssues(undefined)).toBeNull();
  });

  it("accepts the dotted-string paths one portal route sends", () => {
    expect(describeIssues([{ path: "sessions.0.endedAt", message: "endedAt is in the future." }])).toEqual([
      "sessions.0.endedAt: endedAt is in the future."
    ]);
  });

  it("caps a long list", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ path: ["f", i], message: "bad" }));
    const lines = describeIssues(many) ?? [];
    expect(lines).toHaveLength(9);
    expect(lines.at(-1)).toBe("...and 4 more.");
  });
});

async function run(argv: string[], routes: Parameters<typeof fakeFetch>[0]) {
  let stdout = "";
  let stderr = "";
  const exitCode = await runCli(argv, {
    stdout: (text) => (stdout += `${text}\n`),
    stderr: (text) => (stderr += `${text}\n`),
    env: {},
    readConfigFile: () => null,
    now: () => fixtureNow,
    fetchImpl: fakeFetch({ "/api/state": { body: { state: fixtureRawState() } }, ...routes })
  });
  return { exitCode, stdout, stderr };
}

describe("validation errors reach the person as short lines", () => {
  const zodIssues = (() => {
    const parsed = z.object({ outcome: z.enum(["completed", "progress", "stopped"]) }).safeParse({ outcome: "bogus" });
    return JSON.parse(JSON.stringify(parsed.error?.issues ?? []));
  })();

  it("prints one readable line for a portal 400 and keeps the array under --json", async () => {
    const routes = {
      "/api/commands/entity": { status: 400, body: { error: "Command validation failed.", issues: zodIssues } }
    };
    const entity = await run(["capture", "x"], routes);
    expect(entity.exitCode).toBe(EXIT.validation);
    expect(entity.stderr).toContain("rhen: Command validation failed.");
    expect(entity.stderr).toContain("  outcome must be one of: completed, progress, stopped");
    expect(entity.stderr).not.toContain('"code"');
    const json = await run(["capture", "x", "--json"], routes);
    expect(JSON.parse(json.stdout).details).toEqual(zodIssues);
  });

  it("explains a check-in category the CLI rejects before it reaches the contract", async () => {
    const result = await run(["check-in", "deviated", "--category", "bogus"], {
      "/api/check-ins/current": {
        body: { checkIn: { id: "e9f6ac30-f59f-4852-a65b-d3074da3b090", version: 3, status: "pending" } }
      }
    });
    expect(result.exitCode).toBe(EXIT.usage);
    expect(result.stderr).toContain('Unknown --category "bogus". Use one of: work, family, life_admin, other.');
    expect(result.stderr).not.toContain('"code"');
  });

  it("names the flag for a check-in category the portal rejects", async () => {
    const categoryIssues = JSON.parse(
      JSON.stringify(
        z.object({ deviationCategory: z.enum(["work", "family"]) }).safeParse({ deviationCategory: "bogus" }).error
          ?.issues ?? []
      )
    );
    const result = await run(["check-in", "deviated", "--category", "work"], {
      "/api/check-ins/current": {
        body: { checkIn: { id: "e9f6ac30-f59f-4852-a65b-d3074da3b090", version: 3, status: "pending" } }
      },
      "/api/commands/check-in": { status: 400, body: { error: "Command validation failed.", issues: categoryIssues } }
    });
    expect(result.exitCode).toBe(EXIT.validation);
    expect(result.stderr).toMatch(/--category must be one of: /);
    expect(result.stderr).not.toContain('"code"');
  });
});
