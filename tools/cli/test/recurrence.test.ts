import { endRecurrenceGoalCommandSchema, saveCommitmentRecurrenceRuleCommandSchema } from "@openrhen/contracts";
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function run(
  argv: string[],
  routes: Parameters<typeof fakeFetch>[0] = {},
  overrides: (raw: Record<string, unknown>) => Record<string, unknown> = (raw) => raw
): Promise<RunResult> {
  const calls: RecordedCall[] = [];
  const lines: string[] = [];
  let stderr = "";
  const state = overrides(withGymRepeat(fixtureRawState()));
  const exitCode = await runCli(["recurrence", ...argv], {
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

/**
 * `rule-gym` in the shared fixture (`tools/cli/test/fixture-state.ts:177-191`) still carries the
 * earlier flat `intervalDays: 7` rather than the `repeat` the wire schema
 * (`commitmentRecurrenceRuleSchema`) now requires — that fixture file is outside this task's allowed
 * files, so every test here patches the raw state itself instead of relying on the fixture. Without
 * it, `pickRuleFields` finds no `repeat` on the merged existing rule and every rule-gym command fails
 * schema validation before it even reaches `--yes`/`postCommand`.
 */
function withGymRepeat(raw: Record<string, unknown>): Record<string, unknown> {
  const rules = raw.commitmentRecurrenceRules as Record<string, unknown>[];
  return {
    ...raw,
    commitmentRecurrenceRules: rules.map((rule) =>
      rule.id === "rule-gym" ? { ...rule, repeat: { unit: "days", intervalDays: 7 } } : rule
    )
  };
}

/** Adds a `version` to `rule-gym`, which the fixture otherwise leaves out. */
function withGymVersion(version: number) {
  return (raw: Record<string, unknown>): Record<string, unknown> => {
    const rules = raw.commitmentRecurrenceRules as Record<string, unknown>[];
    return {
      ...raw,
      commitmentRecurrenceRules: rules.map((rule) => (rule.id === "rule-gym" ? { ...rule, version } : rule))
    };
  };
}

describe("recurrence set", () => {
  it("refuses to change a rule without --yes, and never calls the portal", async () => {
    const result = await run(["set", "--id", "rule-gym", "--set", "title=Gym v2"]);
    expect(result.exitCode).toBe(EXIT.usage);
    expect(result.stderr).toContain("--yes");
    expect(result.calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("updates a rule with --yes, merging the change and keeping the rest, sending the rule's version", async () => {
    const result = await run(
      ["set", "--id", "rule-gym", "--set", "title=Gym v2", "--yes"],
      {
        "/api/commands/commitment-recurrence": (call) => {
          const parsed = saveCommitmentRecurrenceRuleCommandSchema.safeParse(call.body);
          expect(parsed.success).toBe(true);
          const body = call.body as Record<string, unknown>;
          expect(body.expectedVersion).toBe(4);
          const rule = body.rule as Record<string, unknown>;
          expect(rule.id).toBe("rule-gym");
          expect(rule.title).toBe("Gym v2");
          expect(rule.timezone).toBe("Australia/Sydney");
          expect(rule.startDate).toBe("2026-08-05");
          expect("version" in rule).toBe(false);
          return { body: { state: fixtureRawState() } };
        }
      },
      withGymVersion(4)
    );
    expect(result.exitCode).toBe(EXIT.ok);
  });

  it("switches an existing rule from days to months, though the merge leaves a stale intervalDays on the wire", async () => {
    // mergeAssignments deep-merges objects rather than replacing them, so `repeat.unit=months` merged
    // over the fixture's `repeat: { unit: "days", intervalDays: 7 }` keeps the old `intervalDays`
    // alongside the new months fields. `saveCommitmentRecurrenceRuleCommandSchema`'s zod object strips
    // it on `.safeParse`, but `postCommand` sends the raw (unparsed) payload, so the extra key is what
    // actually reaches the wire — harmless only if the server's own parse strips it the same way.
    const result = await run(
      [
        "set",
        "--id",
        "rule-gym",
        "--set",
        "repeat.unit=months",
        "--set",
        "repeat.intervalMonths=1",
        "--set",
        "repeat.anchor=day_of_month",
        "--yes"
      ],
      {
        "/api/commands/commitment-recurrence": (call) => {
          const parsed = saveCommitmentRecurrenceRuleCommandSchema.safeParse(call.body);
          expect(parsed.success).toBe(true);
          const body = call.body as Record<string, unknown>;
          const rule = body.rule as Record<string, unknown>;
          const repeat = rule.repeat as Record<string, unknown>;
          expect(repeat.unit).toBe("months");
          expect(repeat.intervalMonths).toBe(1);
          expect(repeat.anchor).toBe("day_of_month");
          // Documents the leak named above rather than asserting it away.
          expect(repeat.intervalDays).toBe(7);
          return { body: { state: fixtureRawState() } };
        }
      },
      withGymVersion(4)
    );
    expect(result.exitCode).toBe(EXIT.ok);
  });

  it("sends latenessMatters and transportMode on the rule", async () => {
    const result = await run(
      ["set", "--id", "rule-gym", "--set", "latenessMatters=false", "--set", "transportMode=bike", "--yes"],
      {
        "/api/commands/commitment-recurrence": (call) => {
          expect(saveCommitmentRecurrenceRuleCommandSchema.safeParse(call.body).success).toBe(true);
          const rule = (call.body as Record<string, unknown>).rule as Record<string, unknown>;
          expect(rule.latenessMatters).toBe(false);
          expect(rule.transportMode).toBe("bike");
          return { body: { state: fixtureRawState() } };
        }
      }
    );
    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.calls.some((call) => call.method === "POST")).toBe(true);
  });

  it("sends shareToCalendar and private on the rule", async () => {
    const result = await run(
      ["set", "--id", "rule-gym", "--set", "shareToCalendar=true", "--set", "private=true", "--yes"],
      {
        "/api/commands/commitment-recurrence": (call) => {
          expect(saveCommitmentRecurrenceRuleCommandSchema.safeParse(call.body).success).toBe(true);
          const rule = (call.body as Record<string, unknown>).rule as Record<string, unknown>;
          expect(rule.shareToCalendar).toBe(true);
          expect(rule.private).toBe(true);
          return { body: { state: fixtureRawState() } };
        }
      }
    );
    expect(result.exitCode).toBe(EXIT.ok);
  });

  it("clears transportMode with transportMode=null", async () => {
    const result = await run(["set", "--id", "rule-gym", "--set", "transportMode=null", "--yes"], {
      "/api/commands/commitment-recurrence": (call) => {
        const rule = (call.body as Record<string, unknown>).rule as Record<string, unknown>;
        expect(rule.transportMode).toBeNull();
        return { body: { state: fixtureRawState() } };
      }
    });
    expect(result.exitCode).toBe(EXIT.ok);
  });

  it("rejects an unknown transport mode locally, without calling the portal", async () => {
    const result = await run(["set", "--id", "rule-gym", "--set", "transportMode=rocket", "--yes"]);
    expect(result.exitCode).toBe(EXIT.validation);
    expect(result.calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("rejects a non-boolean latenessMatters locally", async () => {
    const result = await run(["set", "--id", "rule-gym", "--set", "latenessMatters=maybe", "--yes"]);
    expect(result.exitCode).toBe(EXIT.validation);
    expect(result.calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("rejects a local end time before the start time locally, without calling the portal", async () => {
    const result = await run([
      "set",
      "--id",
      "rule-gym",
      "--set",
      "localStartTime=20:00",
      "--set",
      "localEndTime=19:00",
      "--yes"
    ]);
    expect(result.exitCode).toBe(EXIT.validation);
    expect(result.calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("creates a new rule when --set supplies every required field", async () => {
    const result = await run(
      [
        "set",
        "--set",
        "id=rule-yoga",
        "--set",
        "title=Yoga",
        "--set",
        "timezone=Australia/Sydney",
        "--set",
        "startDate=2026-09-10",
        "--set",
        "repeat.unit=days",
        "--set",
        "repeat.intervalDays=7",
        "--set",
        "localStartTime=07:00",
        "--set",
        "localEndTime=08:00",
        "--set",
        "setupBeforeMinutes=5",
        "--set",
        "transitionAfterMinutes=5",
        "--set",
        "contactId=sam",
        "--yes"
      ],
      {
        "/api/commands/commitment-recurrence": (call) => {
          const parsed = saveCommitmentRecurrenceRuleCommandSchema.safeParse(call.body);
          expect(parsed.success).toBe(true);
          const body = call.body as Record<string, unknown>;
          expect(body.expectedVersion).toBeNull();
          const rule = body.rule as Record<string, unknown>;
          expect(rule.id).toBe("rule-yoga");
          expect(rule.title).toBe("Yoga");
          expect(rule.repeat).toEqual({ unit: "days", intervalDays: 7 });
          expect(rule.contactId).toBe("sam");
          return { body: { state: fixtureRawState() } };
        }
      }
    );
    expect(result.exitCode).toBe(EXIT.ok);
  });

  it("creates a new rule with a monthly repeat through dotted --set assignments", async () => {
    const result = await run(
      [
        "set",
        "--set",
        "id=rule-checkup",
        "--set",
        "title=Checkup",
        "--set",
        "timezone=Australia/Sydney",
        "--set",
        "startDate=2026-09-30",
        "--set",
        "repeat.unit=months",
        "--set",
        "repeat.intervalMonths=1",
        "--set",
        "repeat.anchor=last_day",
        "--set",
        "localStartTime=09:00",
        "--set",
        "localEndTime=10:00",
        "--set",
        "setupBeforeMinutes=5",
        "--set",
        "transitionAfterMinutes=5",
        "--yes"
      ],
      {
        "/api/commands/commitment-recurrence": (call) => {
          const parsed = saveCommitmentRecurrenceRuleCommandSchema.safeParse(call.body);
          expect(parsed.success).toBe(true);
          const body = call.body as Record<string, unknown>;
          expect(body.expectedVersion).toBeNull();
          const rule = body.rule as Record<string, unknown>;
          expect(rule.id).toBe("rule-checkup");
          expect(rule.repeat).toEqual({ unit: "months", intervalMonths: 1, anchor: "last_day" });
          return { body: { state: fixtureRawState() } };
        }
      }
    );
    expect(result.exitCode).toBe(EXIT.ok);
  });

  it("creates a rule on several weekdays through a JSON array assignment", async () => {
    const result = await run(
      [
        "set",
        "--set",
        "id=rule-class",
        "--set",
        "title=Class",
        "--set",
        "timezone=Australia/Sydney",
        "--set",
        "startDate=2026-10-06",
        "--set",
        "repeat.unit=weeks",
        "--set",
        "repeat.intervalWeeks=1",
        "--set",
        "repeat.weekdays=[2,4]",
        "--set",
        "localStartTime=09:00",
        "--set",
        "localEndTime=10:00",
        "--set",
        "setupBeforeMinutes=5",
        "--set",
        "transitionAfterMinutes=5",
        "--yes"
      ],
      {
        "/api/commands/commitment-recurrence": (call) => {
          expect(saveCommitmentRecurrenceRuleCommandSchema.safeParse(call.body).success).toBe(true);
          const rule = (call.body as Record<string, unknown>).rule as Record<string, unknown>;
          expect(rule.repeat).toEqual({ unit: "weeks", intervalWeeks: 1, weekdays: [2, 4] });
          return { body: { state: fixtureRawState() } };
        }
      }
    );
    expect(result.exitCode).toBe(EXIT.ok);
  });

  it("prints the payload and sends nothing on --dry-run", async () => {
    const result = await run(["set", "--id", "rule-gym", "--set", "title=Gym v3", "--yes", "--dry-run"]);
    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.calls.some((call) => call.method === "POST")).toBe(false);
    const printed = JSON.parse(result.text) as { dryRun: boolean; payload: { rule: { title: string } } };
    expect(printed.dryRun).toBe(true);
    expect(printed.payload.rule.title).toBe("Gym v3");
  });

  const newRuleArgs = [
    "set",
    "--set",
    "title=Pilates",
    "--set",
    "timezone=Australia/Sydney",
    "--set",
    "startDate=2026-09-10",
    "--set",
    "repeat.unit=days",
    "--set",
    "repeat.intervalDays=7",
    "--set",
    "localStartTime=07:00",
    "--set",
    "localEndTime=08:00",
    "--set",
    "setupBeforeMinutes=5",
    "--set",
    "transitionAfterMinutes=5",
    "--yes"
  ];

  it("generates a UUID-shaped id and creates a new rule when --id and --set id are both omitted", async () => {
    const result = await run(newRuleArgs, {
      "/api/commands/commitment-recurrence": (call) => {
        const parsed = saveCommitmentRecurrenceRuleCommandSchema.safeParse(call.body);
        expect(parsed.success).toBe(true);
        const body = call.body as Record<string, unknown>;
        expect(body.expectedVersion).toBeNull();
        const rule = body.rule as Record<string, unknown>;
        expect(typeof rule.id).toBe("string");
        expect(rule.id as string).toMatch(UUID_RE);
        return { body: { state: fixtureRawState() } };
      }
    });
    expect(result.exitCode).toBe(EXIT.ok);
  });

  it("prints the generated id on --dry-run without sending anything", async () => {
    const result = await run([...newRuleArgs, "--dry-run"]);
    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.calls.some((call) => call.method === "POST")).toBe(false);
    const printed = JSON.parse(result.text) as { dryRun: boolean; payload: { rule: { id: string } } };
    expect(printed.dryRun).toBe(true);
    expect(printed.payload.rule.id).toMatch(UUID_RE);
  });
});

describe("recurrence end", () => {
  it("ends the recurrence goal on an action found by title", async () => {
    const result = await run(["end", "Weed the beds"], {
      "/api/commands/recurrence-goal": (call) => {
        const parsed = endRecurrenceGoalCommandSchema.safeParse(call.body);
        expect(parsed.success).toBe(true);
        const body = call.body as Record<string, unknown>;
        expect(body.actionId).toBe("action-weed");
        expect(body.type).toBe("end_recurrence_goal");
        return { body: { state: fixtureRawState() } };
      }
    });
    expect(result.exitCode).toBe(EXIT.ok);
  });

  it("requires no --yes, since it touches only one action", async () => {
    const result = await run(["end", "action-weed"], {
      "/api/commands/recurrence-goal": { body: { state: fixtureRawState() } }
    });
    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.calls.some((call) => call.method === "POST")).toBe(true);
  });
});
