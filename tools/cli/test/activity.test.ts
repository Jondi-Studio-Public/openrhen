import { activityCommandSchema } from "@openrhen/contracts";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { EXIT } from "../src/errors.js";
import { fakeFetch, type RecordedCall } from "./fake-fetch.js";
import { fixtureActiveSession, fixtureNow, fixtureRawState } from "./fixture-state.js";

interface Run {
  exitCode: number;
  stdout: string;
  stderr: string;
  calls: RecordedCall[];
}

async function run(
  argv: string[],
  routes: Parameters<typeof fakeFetch>[0] = {},
  rawState: Record<string, unknown> = fixtureRawState()
): Promise<Run> {
  const calls: RecordedCall[] = [];
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const fetchImpl = fakeFetch({ "/api/state": { body: { state: rawState } }, ...routes }, calls);
  const exitCode = await runCli(["activity", ...argv], {
    stdout: (text) => stdoutLines.push(text),
    stderr: (text) => stderrLines.push(text),
    env: {},
    readConfigFile: () => null,
    now: () => fixtureNow,
    fetchImpl
  });
  return { exitCode, stdout: stdoutLines.join("\n"), stderr: stderrLines.join("\n"), calls };
}

// A distinct uuid so assertions cannot conflate the fixture session with this one.
const RUNNING_SESSION_ID = "33333333-3333-4333-a333-333333333333";
function withRunningSession(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base = fixtureActiveSession().activeSession as Record<string, unknown>;
  return { activeSession: { ...base, id: RUNNING_SESSION_ID, ...overrides } };
}

describe("activity start", () => {
  it("posts targetId for a fixed_commitment resolved by title, with the phase", async () => {
    const raw = fixtureRawState();
    let posted: Record<string, unknown> | undefined;
    const { exitCode } = await run(
      ["start", "--type", "fixed_commitment", "--target", "Gym session", "--minutes", "60", "--phase", "setup"],
      {
        "/api/commands/activity": (call) => {
          posted = call.body as Record<string, unknown>;
          expect(activityCommandSchema.safeParse(call.body).success).toBe(true);
          return { body: { state: raw } };
        }
      },
      raw
    );
    expect(exitCode).toBe(EXIT.ok);
    expect(posted?.type).toBe("start_activity");
    expect(posted?.targetType).toBe("fixed_commitment");
    expect(posted?.targetId).toBe("commitment-gym");
    expect(posted?.plannedMinutes).toBe(60);
    expect(posted?.phase).toBe("setup");
  });

  it("posts targetId for a deliverable resolved by id, with the step", async () => {
    const raw = fixtureRawState();
    let posted: Record<string, unknown> | undefined;
    const { exitCode } = await run(
      ["start", "--type", "deliverable", "--target", "deliverable-chapter", "--step", "step-write", "--minutes", "45"],
      {
        "/api/commands/activity": (call) => {
          posted = call.body as Record<string, unknown>;
          return { body: { state: raw } };
        }
      },
      raw
    );
    expect(exitCode).toBe(EXIT.ok);
    expect(posted?.targetType).toBe("deliverable");
    expect(posted?.targetId).toBe("deliverable-chapter");
    expect(posted?.stepId).toBe("step-write");
  });

  it("resolves a routine step by id and sends its version", async () => {
    const raw = fixtureRawState();
    raw.routineSteps = (raw.routineSteps as Record<string, unknown>[]).map((step) =>
      step.id === "step-pack" ? { ...step, version: 2 } : step
    );
    let posted: Record<string, unknown> | undefined;
    await run(
      ["start", "--type", "routine_step", "--target", "step-pack", "--minutes", "10"],
      {
        "/api/commands/activity": (call) => ((posted = call.body as Record<string, unknown>), { body: { state: raw } })
      },
      raw
    );
    expect(posted?.targetType).toBe("routine_step");
    expect(posted?.targetId).toBe("step-pack");
    expect(posted?.expectedVersion).toBe(2);
  });

  it("an unknown target id exits notFound", async () => {
    const { exitCode, calls } = await run([
      "start",
      "--type",
      "routine_step",
      "--target",
      "no-such-step",
      "--minutes",
      "10"
    ]);
    expect(exitCode).toBe(EXIT.notFound);
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("a bad --phase fails local schema validation, no POST", async () => {
    const { exitCode, calls } = await run([
      "start",
      "--type",
      "fixed_commitment",
      "--target",
      "commitment-gym",
      "--minutes",
      "10",
      "--phase",
      "not-a-real-phase"
    ]);
    expect(exitCode).toBe(EXIT.validation);
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("requires --type, --target and --minutes", async () => {
    expect((await run(["start"])).exitCode).toBe(EXIT.usage);
    expect((await run(["start", "--type", "sleep"])).exitCode).toBe(EXIT.usage);
    expect((await run(["start", "--type", "sleep", "--target", "sleep-tonight"])).exitCode).toBe(EXIT.usage);
  });

  it("--dry-run prints the payload and never sends the POST", async () => {
    const { exitCode, stdout, calls } = await run([
      "start",
      "--type",
      "sleep",
      "--target",
      "sleep-tonight",
      "--minutes",
      "480",
      "--dry-run"
    ]);
    expect(exitCode).toBe(EXIT.ok);
    expect(stdout).toContain('"dryRun": true');
    expect(stdout).toContain("/api/commands/activity");
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });
});

describe("activity switch-step", () => {
  it("requires --step", async () => {
    const raw = { ...fixtureRawState(), ...withRunningSession() };
    const { exitCode, calls } = await run(["switch-step"], {}, raw);
    expect(exitCode).toBe(EXIT.usage);
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("posts switch_deliverable_step with the running session's id", async () => {
    const raw = { ...fixtureRawState(), ...withRunningSession({ version: 2 }) };
    let posted: Record<string, unknown> | undefined;
    await run(
      ["switch-step", "--step", "step-write"],
      {
        "/api/commands/activity": (call) => ((posted = call.body as Record<string, unknown>), { body: { state: raw } })
      },
      raw
    );
    expect(posted?.type).toBe("switch_deliverable_step");
    expect(posted?.sessionId).toBe(RUNNING_SESSION_ID);
    expect(posted?.expectedVersion).toBe(2);
    expect(posted?.stepId).toBe("step-write");
  });
});

describe("activity pause/resume", () => {
  it("pause with no session running exits notFound", async () => {
    const { exitCode, calls } = await run(["pause"]);
    expect(exitCode).toBe(EXIT.notFound);
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("pause and resume address the running session", async () => {
    const raw = { ...fixtureRawState(), ...withRunningSession() };
    let pausePosted: Record<string, unknown> | undefined;
    await run(
      ["pause"],
      {
        "/api/commands/activity": (call) => (
          (pausePosted = call.body as Record<string, unknown>),
          { body: { state: raw } }
        )
      },
      raw
    );
    expect(pausePosted?.type).toBe("pause_activity");
    expect(pausePosted?.sessionId).toBe(RUNNING_SESSION_ID);

    let resumePosted: Record<string, unknown> | undefined;
    await run(
      ["resume"],
      {
        "/api/commands/activity": (call) => (
          (resumePosted = call.body as Record<string, unknown>),
          { body: { state: raw } }
        )
      },
      raw
    );
    expect(resumePosted?.type).toBe("resume_activity");
  });

  it("--note on pause is carried in the posted payload", async () => {
    const raw = { ...fixtureRawState(), ...withRunningSession() };
    let posted: Record<string, unknown> | undefined;
    await run(
      ["pause", "--note", "Kid needs help with homework"],
      {
        "/api/commands/activity": (call) => ((posted = call.body as Record<string, unknown>), { body: { state: raw } })
      },
      raw
    );
    expect(posted?.type).toBe("pause_activity");
    expect(posted?.note).toBe("Kid needs help with homework");
    expect(activityCommandSchema.safeParse(posted).success).toBe(true);
  });

  it("resume never sends a note, even if one is passed", async () => {
    const raw = { ...fixtureRawState(), ...withRunningSession() };
    let posted: Record<string, unknown> | undefined;
    await run(
      ["resume", "--note", "Should be ignored"],
      {
        "/api/commands/activity": (call) => ((posted = call.body as Record<string, unknown>), { body: { state: raw } })
      },
      raw
    );
    expect(posted?.type).toBe("resume_activity");
    expect(posted).not.toHaveProperty("note");
  });
});

describe("activity finish", () => {
  it("posts outcome and note", async () => {
    const raw = { ...fixtureRawState(), ...withRunningSession() };
    let posted: Record<string, unknown> | undefined;
    const { exitCode, stdout } = await run(
      ["finish", "--outcome", "stopped", "--note", "Ran out of time", "--json"],
      {
        "/api/commands/activity": (call) => ((posted = call.body as Record<string, unknown>), { body: { state: raw } })
      },
      raw
    );
    expect(exitCode).toBe(EXIT.ok);
    expect(posted?.type).toBe("finish_activity");
    expect(posted?.sessionId).toBe(RUNNING_SESSION_ID);
    expect(posted?.outcome).toBe("stopped");
    expect(posted?.note).toBe("Ran out of time");
    const doc = JSON.parse(stdout) as { ok: boolean };
    expect(doc.ok).toBe(true);
  });

  // a routine step's own linked occurrence now completes automatically
  // (`completeStepActionOccurrence`) when the step itself completes, so `finish_activity` no longer
  // takes a list of occurrences to check off by hand — there is no `--occurrences` option any more.
  it("has no --occurrences option", async () => {
    const raw = { ...fixtureRawState(), ...withRunningSession() };
    const { exitCode } = await run(["finish", "--occurrences", "occurrence-weed"], {}, raw);
    expect(exitCode).toBe(EXIT.usage);
  });

  it("--ended-at round-trips into the payload as endedAt", async () => {
    const raw = { ...fixtureRawState(), ...withRunningSession() };
    let posted: Record<string, unknown> | undefined;
    const { exitCode } = await run(
      ["finish", "--outcome", "stopped", "--ended-at", "2026-09-03T10:00:00+10:00"],
      {
        "/api/commands/activity": (call) => ((posted = call.body as Record<string, unknown>), { body: { state: raw } })
      },
      raw
    );
    expect(exitCode).toBe(EXIT.ok);
    expect(posted?.type).toBe("finish_activity");
    expect(posted?.endedAt).toBe("2026-09-03T10:00:00+10:00");
    expect(activityCommandSchema.safeParse(posted).success).toBe(true);
  });

  it("omitting --ended-at behaves exactly as before", async () => {
    const raw = { ...fixtureRawState(), ...withRunningSession() };
    let posted: Record<string, unknown> | undefined;
    const { exitCode } = await run(
      ["finish", "--outcome", "completed"],
      {
        "/api/commands/activity": (call) => ((posted = call.body as Record<string, unknown>), { body: { state: raw } })
      },
      raw
    );
    expect(exitCode).toBe(EXIT.ok);
    expect(posted?.type).toBe("finish_activity");
    expect(posted).not.toHaveProperty("endedAt");
    expect(activityCommandSchema.safeParse(posted).success).toBe(true);
  });

  it("--dry-run with --ended-at reports the floor", async () => {
    const raw = { ...fixtureRawState(), ...withRunningSession() };
    const { exitCode, stdout, stderr } = await run(
      ["finish", "--outcome", "stopped", "--ended-at", "2026-09-03T10:00:00+10:00", "--dry-run"],
      {},
      raw
    );
    expect(exitCode).toBe(EXIT.ok);
    expect(stdout).toContain('"dryRun": true');
    expect(stdout).toContain("endedAt");
    expect(stderr).toContain("floor");
    expect(stderr).toContain("2026-09-03T09:05:00+10:00"); // segmentStartedAt from fixture
  });

  it("rejects invalid ISO datetime on --ended-at", async () => {
    const raw = { ...fixtureRawState(), ...withRunningSession() };
    const { exitCode, calls } = await run(["finish", "--outcome", "stopped", "--ended-at", "not-a-date"], {}, raw);
    expect(exitCode).toBe(EXIT.usage);
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });
});

describe("activity start --started-at", () => {
  const startArgs = ["start", "--type", "deliverable", "--target", "deliverable-chapter", "--minutes", "45"];

  it("round-trips into the payload as startedAt", async () => {
    const raw = fixtureRawState();
    let posted: Record<string, unknown> | undefined;
    const { exitCode } = await run(
      [...startArgs, "--started-at", "2026-09-03T09:00:00+10:00"],
      {
        "/api/commands/activity": (call) => ((posted = call.body as Record<string, unknown>), { body: { state: raw } })
      },
      raw
    );
    expect(exitCode).toBe(EXIT.ok);
    expect(posted?.startedAt).toBe("2026-09-03T09:00:00+10:00");
    expect(activityCommandSchema.safeParse(posted).success).toBe(true);
  });

  it("omitting --started-at leaves the key out", async () => {
    const raw = fixtureRawState();
    let posted: Record<string, unknown> | undefined;
    await run(
      startArgs,
      {
        "/api/commands/activity": (call) => ((posted = call.body as Record<string, unknown>), { body: { state: raw } })
      },
      raw
    );
    expect(posted?.type).toBe("start_activity");
    expect(posted).not.toHaveProperty("startedAt");
  });

  it("--dry-run reports the start time", async () => {
    const { exitCode, stdout, stderr, calls } = await run([
      ...startArgs,
      "--started-at",
      "2026-09-03T09:00:00+10:00",
      "--dry-run"
    ]);
    expect(exitCode).toBe(EXIT.ok);
    expect(stdout).toContain("startedAt");
    expect(stderr).toContain("started at 2026-09-03T09:00:00+10:00");
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("rejects an invalid ISO datetime", async () => {
    const { exitCode, calls } = await run([...startArgs, "--started-at", "not-a-date"]);
    expect(exitCode).toBe(EXIT.usage);
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });
});

describe("activity skip-step", () => {
  it("requires --step", async () => {
    expect((await run(["skip-step"])).exitCode).toBe(EXIT.usage);
  });

  it("refuses an unknown step id", async () => {
    const { exitCode } = await run(["skip-step", "--step", "no-such-step"]);
    expect(exitCode).toBe(EXIT.notFound);
  });

  // names the `routine_steps` row directly, for either anchor — no instance id, since a
  // sleep-anchored step is a row like a commitment's own now.
  it("posts skip_routine_step", async () => {
    const raw = fixtureRawState();
    let posted: Record<string, unknown> | undefined;
    const { exitCode } = await run(
      ["skip-step", "--step", "step-pack"],
      {
        "/api/commands/activity": (call) => {
          posted = call.body as Record<string, unknown>;
          expect(activityCommandSchema.safeParse(call.body).success).toBe(true);
          return { body: { state: raw } };
        }
      },
      raw
    );
    expect(exitCode).toBe(EXIT.ok);
    expect(posted?.type).toBe("skip_routine_step");
    expect(posted?.stepId).toBe("step-pack");
    expect(posted).not.toHaveProperty("routineInstanceId");
  });
});

describe("activity unskip-step", () => {
  const skippedState = (): Record<string, unknown> => {
    const raw = fixtureRawState();
    const steps = raw.routineSteps as Record<string, unknown>[];
    return {
      ...raw,
      routineSteps: steps.map((step) => (step.id === "step-pack" ? { ...step, status: "skipped" } : step))
    };
  };

  it("requires --step", async () => {
    expect((await run(["unskip-step"])).exitCode).toBe(EXIT.usage);
  });

  it("refuses a step that is not skipped", async () => {
    const { exitCode, calls } = await run(["unskip-step", "--step", "step-pack"]);
    expect(exitCode).toBe(EXIT.usage);
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("posts reopen_routine_step for a skipped step", async () => {
    const raw = skippedState();
    let posted: Record<string, unknown> | undefined;
    const { exitCode } = await run(
      ["unskip-step", "--step", "step-pack"],
      {
        "/api/commands/activity": (call) => {
          posted = call.body as Record<string, unknown>;
          expect(activityCommandSchema.safeParse(call.body).success).toBe(true);
          return { body: { state: raw } };
        }
      },
      raw
    );
    expect(exitCode).toBe(EXIT.ok);
    expect(posted?.type).toBe("reopen_routine_step");
    expect(posted?.stepId).toBe("step-pack");
  });
});

describe("activity usage", () => {
  it("refuses an unknown subcommand", async () => {
    const { exitCode, stderr } = await run(["bogus"]);
    expect(exitCode).toBe(EXIT.usage);
    expect(stderr).toContain("bogus");
  });

  it("reports a portal conflict as exit 3", async () => {
    const raw = { ...fixtureRawState(), ...withRunningSession() };
    const { exitCode } = await run(
      ["pause"],
      { "/api/commands/activity": { status: 409, body: { error: "stale, re-read and retry" } } },
      raw
    );
    expect(exitCode).toBe(EXIT.conflict);
  });
});

describe("activity finish retried under the same --command-id", () => {
  const COMMAND_ID = "7a1f0c52-3d4e-4b6a-9c8d-0e1f2a3b4c5d";
  // The first try landed: the session closed and sits in today's history, and nothing is running.
  function afterFinish(): Record<string, unknown> {
    const raw = fixtureRawState();
    return {
      ...raw,
      activeSession: null,
      completedToday: [
        ...(raw.completedToday as Record<string, unknown>[]),
        {
          id: RUNNING_SESSION_ID,
          actionId: "action-draft",
          actionTitle: "Draft chapter 3",
          result: "completed",
          startedAt: "2026-09-03T09:00:00+10:00",
          endedAt: "2026-09-03T09:20:00+10:00",
          plannedMinutes: 45,
          activeMinutes: 20,
          remainingBeforeMinutes: 90,
          remainingAfterMinutes: 70
        }
      ]
    };
  }

  it("asks the portal, which holds the receipt, and reports replayed: true, applied: false", async () => {
    const raw = afterFinish();
    let posted: Record<string, unknown> | undefined;
    const { exitCode, stdout } = await run(
      ["finish", "--command-id", COMMAND_ID, "--json"],
      {
        "/api/commands/activity": (call) => ((posted = call.body as Record<string, unknown>), { body: { state: raw } })
      },
      raw
    );
    expect(exitCode).toBe(EXIT.ok);
    expect(posted?.type).toBe("finish_activity");
    expect(posted?.sessionId).toBe(RUNNING_SESSION_ID);
    expect(posted?.commandId).toBe(COMMAND_ID);
    const doc = JSON.parse(stdout) as Record<string, unknown>;
    expect(doc.replayed).toBe(true);
    expect(doc.applied).toBe(false);
    expect(doc.commandId).toBe(COMMAND_ID);
    expect(doc.id).toBe(RUNNING_SESSION_ID);
  });

  it("says a retried finish has probably landed when the portal holds no receipt for the id", async () => {
    const raw = afterFinish();
    const { exitCode, stderr } = await run(
      ["finish", "--command-id", COMMAND_ID],
      { "/api/commands/activity": { status: 404, body: { error: "The open activity session was not found." } } },
      raw
    );
    expect(exitCode).toBe(EXIT.notFound);
    expect(stderr).toContain("No session is running.");
    expect(stderr).toContain("probably already landed");
  });

  it("without --command-id a finish with nothing running is still refused locally, with no POST", async () => {
    const { exitCode, calls } = await run(["finish"], {}, afterFinish());
    expect(exitCode).toBe(EXIT.notFound);
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });
});
