import { mcpManifestTool, sessionCommandSchema, validateToolArguments } from "@openrhen/contracts";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { EXIT } from "../src/errors.js";
import { fakeFetch, type RecordedCall } from "./fake-fetch.js";
import { fixtureActiveSession, fixtureNow, fixtureRawState, fixtureActiveSessionId } from "./fixture-state.js";

interface Run {
  exitCode: number;
  stdout: string;
  stderr: string;
  calls: RecordedCall[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function run(
  argv: string[],
  routes: Parameters<typeof fakeFetch>[0] = {},
  rawState: Record<string, unknown> = fixtureRawState()
): Promise<Run> {
  const calls: RecordedCall[] = [];
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const fetchImpl = fakeFetch({ "/api/state": { body: { state: rawState } }, ...routes }, calls);
  const exitCode = await runCli(["session", ...argv], {
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
const RUNNING_SESSION_ID = "22222222-2222-4222-a222-222222222222";
function withRunningSession(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base = fixtureActiveSession().activeSession as Record<string, unknown>;
  return { activeSession: { ...base, id: RUNNING_SESSION_ID, ...overrides } };
}

describe("session start", () => {
  it("with no flags, starts the recommended action with its recommended minutes", async () => {
    const raw = fixtureRawState();
    let posted: Record<string, unknown> | undefined;
    const { exitCode, stdout } = await run(
      ["start", "--json"],
      {
        "/api/commands/session": (call) => {
          posted = call.body as Record<string, unknown>;
          expect(sessionCommandSchema.safeParse(call.body).success).toBe(true);
          return {
            body: {
              state: {
                ...raw,
                activeSession: {
                  id: RUNNING_SESSION_ID,
                  actionId: "action-draft",
                  status: "running",
                  targetType: "action",
                  targetId: "action-draft",
                  targetTitle: "Draft chapter 3",
                  startedAt: "2026-09-03T09:30:00+10:00",
                  plannedEndAt: "2026-09-03T10:15:00+10:00",
                  plannedMinutes: 45,
                  remainingBeforeMinutes: 90,
                  activeElapsedSeconds: 0
                }
              }
            }
          };
        }
      },
      raw
    );
    expect(exitCode).toBe(EXIT.ok);
    expect(posted?.type).toBe("start");
    expect(posted?.actionId).toBe("action-draft");
    expect(posted?.plannedMinutes).toBe(45);
    expect(posted?.expectedVersion).toBeNull();
    expect(posted?.recommendationId).toBe("6b1f5d0e-2a3b-4c5d-8e9f-0a1b2c3d4e5f");
    expect(UUID_RE.test(posted?.commandId as string)).toBe(true);
    const doc = JSON.parse(stdout) as { id: string; actionId: string };
    expect(doc.id).toBe(RUNNING_SESSION_ID);
    expect(doc.actionId).toBe("action-draft");
  });

  it("sends the action's stored version as expectedVersion when the fixture carries one", async () => {
    const raw = fixtureRawState();
    raw.actions = (raw.actions as Record<string, unknown>[]).map((action) =>
      action.id === "action-draft" ? { ...action, version: 7 } : action
    );
    let posted: Record<string, unknown> | undefined;
    await run(
      ["start"],
      {
        "/api/commands/session": (call) => {
          posted = call.body as Record<string, unknown>;
          return { body: { state: raw } };
        }
      },
      raw
    );
    expect(posted?.expectedVersion).toBe(7);
  });

  it("resolves --action by title", async () => {
    const raw = fixtureRawState();
    let posted: Record<string, unknown> | undefined;
    const { exitCode } = await run(
      ["start", "--action", "Fix citations", "--minutes", "30"],
      {
        "/api/commands/session": (call) => {
          posted = call.body as Record<string, unknown>;
          return { body: { state: raw } };
        }
      },
      raw
    );
    expect(exitCode).toBe(EXIT.ok);
    expect(posted?.actionId).toBe("action-cite");
    expect(posted?.plannedMinutes).toBe(30);
    // recommendationId is only sent when starting the recommended (directive) action.
    expect(posted?.recommendationId).toBeUndefined();
  });

  describe("on a recurring series (audit L3)", () => {
    /** `action-weed` as a recurring template (version 5) with a pending occurrence whose window is open at fixtureNow. */
    function recurringState(extraOccurrences: Record<string, unknown>[] = []): Record<string, unknown> {
      const raw = fixtureRawState();
      raw.actions = (raw.actions as Record<string, unknown>[]).map((action) =>
        action.id === "action-weed" ? { ...action, status: "active", schedulingMode: "recurring", version: 5 } : action
      );
      raw.occurrences = [
        {
          id: "occurrence-open",
          actionId: "action-weed",
          recurrenceRuleId: "rule-weed",
          windowId: "window-morning",
          windowName: "Morning",
          localDate: "2026-09-03",
          windowStartsAt: "2026-09-03T07:00:00+10:00",
          windowEndsAt: "2026-09-03T12:00:00+10:00",
          anchorSource: "preferred_wake",
          status: "pending"
        },
        ...extraOccurrences
      ];
      return raw;
    }
    const post = (raw: Record<string, unknown>, onPost: (body: Record<string, unknown>) => void) => ({
      "/api/commands/session": (call: { body: unknown }) => {
        onPost(call.body as Record<string, unknown>);
        return { body: { state: raw } };
      }
    });

    it("starts the directive's occurrence with the template's version", async () => {
      const raw = recurringState();
      const planning = raw.planning as { result: { currentDirective: Record<string, unknown> } };
      planning.result.currentDirective = {
        kind: "action",
        targetId: "occurrence-open",
        title: "Weed the beds",
        recommendedMinutes: 20
      };
      let posted: Record<string, unknown> | undefined;
      const { exitCode } = await run(
        ["start"],
        post(raw, (body) => (posted = body)),
        raw
      );
      expect(exitCode).toBe(EXIT.ok);
      expect(posted?.actionId).toBe("occurrence-open");
      expect(posted?.expectedVersion).toBe(5);
    });

    it("maps an explicit occurrence id to its template", async () => {
      const raw = recurringState();
      let posted: Record<string, unknown> | undefined;
      const { exitCode } = await run(
        ["start", "--action", "occurrence-open", "--minutes", "15"],
        post(raw, (body) => (posted = body)),
        raw
      );
      expect(exitCode).toBe(EXIT.ok);
      expect(posted?.actionId).toBe("occurrence-open");
      expect(posted?.expectedVersion).toBe(5);
      expect(posted?.plannedMinutes).toBe(15);
    });

    it("turns the series' title into the one occurrence open now instead of filing time on the template", async () => {
      const raw = recurringState([
        {
          id: "occurrence-tomorrow",
          actionId: "action-weed",
          recurrenceRuleId: "rule-weed",
          windowId: "window-morning",
          windowName: "Morning",
          localDate: "2026-09-04",
          windowStartsAt: "2026-09-04T07:00:00+10:00",
          windowEndsAt: "2026-09-04T12:00:00+10:00",
          anchorSource: "preferred_wake",
          status: "pending"
        }
      ]);
      let posted: Record<string, unknown> | undefined;
      const { exitCode } = await run(
        ["start", "--action", "Weed the beds", "--minutes", "15"],
        post(raw, (body) => (posted = body)),
        raw
      );
      expect(exitCode).toBe(EXIT.ok);
      expect(posted?.actionId).toBe("occurrence-open");
      expect(posted?.expectedVersion).toBe(5);
    });

    it("asks for an occurrence id when the series could mean several, and sends nothing", async () => {
      const raw = recurringState([
        {
          id: "occurrence-second",
          actionId: "action-weed",
          recurrenceRuleId: "rule-weed",
          windowId: "window-evening",
          windowName: "Evening",
          localDate: "2026-09-03",
          windowStartsAt: "2026-09-03T08:00:00+10:00",
          windowEndsAt: "2026-09-03T20:00:00+10:00",
          anchorSource: "preferred_wake",
          status: "pending"
        }
      ]);
      const result = await run(["start", "--action", "Weed the beds", "--minutes", "15"], {}, raw);
      expect(result.exitCode).toBe(EXIT.usage);
      expect(result.stderr).toContain("pass --action <occurrence id>");
      expect(result.stderr).toContain("occurrence-open");
      expect(result.calls.filter((call) => call.method === "POST")).toHaveLength(0);
    });

    it("says so when the series has nothing pending, and sends nothing", async () => {
      const raw = recurringState();
      raw.occurrences = [];
      const result = await run(["start", "--action", "Weed the beds", "--minutes", "15"], {}, raw);
      expect(result.exitCode).toBe(EXIT.notFound);
      expect(result.stderr).toContain("no pending occurrence");
    });

    // Yesterday's morning occurrence is still pending next to today's open one.
    const withYesterday = () =>
      recurringState([
        {
          id: "occurrence-yesterday",
          actionId: "action-weed",
          recurrenceRuleId: "rule-weed",
          windowId: "window-morning",
          windowName: "Morning",
          localDate: "2026-09-02",
          windowStartsAt: "2026-09-02T07:00:00+10:00",
          windowEndsAt: "2026-09-02T12:00:00+10:00",
          anchorSource: "preferred_wake",
          status: "pending"
        }
      ]);

    it("picks the occurrence open at --started-at, not the one open now (start)", async () => {
      const raw = withYesterday();
      let posted: Record<string, unknown> | undefined;
      const { exitCode } = await run(
        ["start", "--action", "Weed the beds", "--minutes", "15", "--started-at", "2026-09-02T09:00:00+10:00"],
        post(raw, (body) => (posted = body)),
        raw
      );
      expect(exitCode).toBe(EXIT.ok);
      expect(posted?.actionId).toBe("occurrence-yesterday");
      expect(posted?.startedAt).toBeDefined();
      expect(posted?.expectedVersion).toBe(5);
    });

    it("re-resolves the directive's occurrence at --started-at when no --action is given (start)", async () => {
      const raw = withYesterday();
      const planning = raw.planning as { result: { currentDirective: Record<string, unknown> } };
      planning.result.currentDirective = {
        kind: "action",
        targetId: "occurrence-open",
        title: "Weed the beds",
        recommendedMinutes: 20
      };
      let posted: Record<string, unknown> | undefined;
      const { exitCode } = await run(
        ["start", "--started-at", "2026-09-02T09:00:00+10:00"],
        post(raw, (body) => (posted = body)),
        raw
      );
      expect(exitCode).toBe(EXIT.ok);
      expect(posted?.actionId).toBe("occurrence-yesterday");
      expect(posted?.expectedVersion).toBe(5);
      expect(posted?.plannedMinutes).toBe(20);
      // The recommendation names today's occurrence, so a start on yesterday's must not claim it.
      expect(posted?.recommendationId).toBeUndefined();
    });

    it("keeps the directive's occurrence and recommendation when --started-at falls inside its window", async () => {
      const raw = withYesterday();
      const planning = raw.planning as { result: { currentDirective: Record<string, unknown> } };
      planning.result.currentDirective = {
        kind: "action",
        targetId: "occurrence-open",
        title: "Weed the beds",
        recommendedMinutes: 20
      };
      let posted: Record<string, unknown> | undefined;
      const { exitCode } = await run(
        ["start", "--started-at", "2026-09-03T09:00:00+10:00"],
        post(raw, (body) => (posted = body)),
        raw
      );
      expect(exitCode).toBe(EXIT.ok);
      expect(posted?.actionId).toBe("occurrence-open");
      expect(posted?.recommendationId).toBe("6b1f5d0e-2a3b-4c5d-8e9f-0a1b2c3d4e5f");
    });

    it("refuses `alternative` for a past occurrence, pointing to `start --started-at`", async () => {
      const raw = withYesterday();
      let posted: Record<string, unknown> | undefined;
      const { exitCode, stderr } = await run(
        [
          "alternative",
          "--action",
          "Weed the beds",
          "--minutes",
          "15",
          "--reason",
          "lower_energy",
          "--started-at",
          "2026-09-02T09:00:00+10:00"
        ],
        post(raw, (body) => (posted = body)),
        raw
      );
      expect(exitCode).toBe(EXIT.usage);
      expect(stderr).toContain("not a current alternative");
      expect(stderr).toContain("session start --action <occurrence id> --started-at");
      expect(posted).toBeUndefined();
    });

    it("still sends `alternative --started-at` for an occurrence open now", async () => {
      const raw = withYesterday();
      let posted: Record<string, unknown> | undefined;
      const { exitCode } = await run(
        [
          "alternative",
          "--action",
          "occurrence-open",
          "--minutes",
          "15",
          "--reason",
          "lower_energy",
          "--started-at",
          "2026-09-03T08:30:00+10:00"
        ],
        post(raw, (body) => (posted = body)),
        raw
      );
      expect(exitCode).toBe(EXIT.ok);
      expect(posted?.actionId).toBe("occurrence-open");
      expect(posted?.startedAt).toBeDefined();
    });

    it("still picks today's occurrence without --started-at when yesterday's is also pending", async () => {
      const raw = withYesterday();
      let posted: Record<string, unknown> | undefined;
      await run(
        ["start", "--action", "Weed the beds", "--minutes", "15"],
        post(raw, (body) => (posted = body)),
        raw
      );
      expect(posted?.actionId).toBe("occurrence-open");
    });

    it("maps an occurrence id for `alternative` too", async () => {
      const raw = recurringState();
      let posted: Record<string, unknown> | undefined;
      const { exitCode } = await run(
        ["alternative", "--action", "occurrence-open", "--minutes", "15", "--reason", "lower_energy"],
        post(raw, (body) => (posted = body)),
        raw
      );
      expect(exitCode).toBe(EXIT.ok);
      expect(posted?.type).toBe("select_alternative");
      expect(posted?.actionId).toBe("occurrence-open");
      expect(posted?.expectedVersion).toBe(5);
    });

    it("leaves a one-off action's start unchanged", async () => {
      const raw = recurringState();
      let posted: Record<string, unknown> | undefined;
      await run(
        ["start", "--action", "Fix citations", "--minutes", "30"],
        post(raw, (body) => (posted = body)),
        raw
      );
      expect(posted?.actionId).toBe("action-cite");
    });
  });

  it("errors clearly when the current directive is not an action and no --action was given", async () => {
    const raw = fixtureRawState();
    const planning = raw.planning as Record<string, unknown>;
    const result = planning.result as Record<string, unknown>;
    result.currentDirective = {
      kind: "boundary",
      title: "Nothing fits before bedtime",
      recommendedMinutes: 0,
      boundaryAt: "2026-09-03T22:00:00+10:00",
      boundaryKind: "daily_horizon",
      nextFit: null
    };
    const { exitCode, stderr, calls } = await run(["start"], {}, raw);
    expect(exitCode).toBe(EXIT.usage);
    expect(stderr).toContain("boundary");
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("--dry-run prints the payload and never sends the POST", async () => {
    const { exitCode, stdout, calls } = await run(["start", "--dry-run"]);
    expect(exitCode).toBe(EXIT.ok);
    expect(stdout).toContain('"dryRun": true');
    expect(stdout).toContain("/api/commands/session");
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("reports a portal conflict as exit 3", async () => {
    const { exitCode } = await run(["start"], {
      "/api/commands/session": { status: 409, body: { error: "stale, re-read and retry" } }
    });
    expect(exitCode).toBe(EXIT.conflict);
  });
});

describe("session start --started-at", () => {
  it("round-trips into the payload as startedAt", async () => {
    const raw = fixtureRawState();
    let posted: Record<string, unknown> | undefined;
    const { exitCode } = await run(
      ["start", "--minutes", "30", "--started-at", "2026-09-03T09:00:00+10:00"],
      {
        "/api/commands/session": (call) => ((posted = call.body as Record<string, unknown>), { body: { state: raw } })
      },
      raw
    );
    expect(exitCode).toBe(EXIT.ok);
    expect(posted?.startedAt).toBe("2026-09-03T09:00:00+10:00");
    expect(sessionCommandSchema.safeParse(posted).success).toBe(true);
  });

  it("omitting --started-at leaves the key out", async () => {
    const raw = fixtureRawState();
    let posted: Record<string, unknown> | undefined;
    await run(
      ["start", "--minutes", "30"],
      {
        "/api/commands/session": (call) => ((posted = call.body as Record<string, unknown>), { body: { state: raw } })
      },
      raw
    );
    expect(posted).not.toHaveProperty("startedAt");
  });

  it("--dry-run reports the start time and sends nothing", async () => {
    const { exitCode, stdout, stderr, calls } = await run([
      "start",
      "--minutes",
      "30",
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
    const { exitCode, calls } = await run(["start", "--minutes", "30", "--started-at", "not-a-date"]);
    expect(exitCode).toBe(EXIT.usage);
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });
});

describe("session alternative", () => {
  it("requires --action, --minutes and --reason", async () => {
    expect((await run(["alternative"])).exitCode).toBe(EXIT.usage);
    expect((await run(["alternative", "--action", "Weed the beds"])).exitCode).toBe(EXIT.usage);
    expect((await run(["alternative", "--action", "Weed the beds", "--minutes", "20"])).exitCode).toBe(EXIT.usage);
  });

  it("posts select_alternative with the current recommendationId", async () => {
    const raw = fixtureRawState();
    let posted: Record<string, unknown> | undefined;
    const { exitCode } = await run(
      ["alternative", "--action", "Weed the beds", "--minutes", "20", "--reason", "lower_energy"],
      {
        "/api/commands/session": (call) => {
          posted = call.body as Record<string, unknown>;
          expect(sessionCommandSchema.safeParse(call.body).success).toBe(true);
          return { body: { state: raw } };
        }
      },
      raw
    );
    expect(exitCode).toBe(EXIT.ok);
    expect(posted?.type).toBe("select_alternative");
    expect(posted?.actionId).toBe("action-weed");
    expect(posted?.reason).toBe("lower_energy");
    expect(posted?.recommendationId).toBe("6b1f5d0e-2a3b-4c5d-8e9f-0a1b2c3d4e5f");
  });
});

describe("session pause/resume/feedback", () => {
  it("pause with no session running exits notFound", async () => {
    const { exitCode, calls } = await run(["pause"]);
    expect(exitCode).toBe(EXIT.notFound);
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("pause posts the running session's id and version", async () => {
    const raw = { ...fixtureRawState(), ...withRunningSession({ version: 4 }) };
    let posted: Record<string, unknown> | undefined;
    const { exitCode } = await run(
      ["pause"],
      {
        "/api/commands/session": (call) => {
          posted = call.body as Record<string, unknown>;
          return { body: { state: raw } };
        }
      },
      raw
    );
    expect(exitCode).toBe(EXIT.ok);
    expect(posted?.type).toBe("pause");
    expect(posted?.sessionId).toBe(RUNNING_SESSION_ID);
    expect(posted?.expectedVersion).toBe(4);
  });

  it("resume and feedback address the running session too", async () => {
    const raw = { ...fixtureRawState(), ...withRunningSession() };
    let resumePosted: Record<string, unknown> | undefined;
    await run(
      ["resume"],
      {
        "/api/commands/session": (call) => (
          (resumePosted = call.body as Record<string, unknown>),
          { body: { state: raw } }
        )
      },
      raw
    );
    expect(resumePosted?.type).toBe("resume");

    let feedbackPosted: Record<string, unknown> | undefined;
    await run(
      ["feedback"],
      {
        "/api/commands/session": (call) => (
          (feedbackPosted = call.body as Record<string, unknown>),
          { body: { state: raw } }
        )
      },
      raw
    );
    expect(feedbackPosted?.type).toBe("request_feedback");
  });

  it("addresses the plain fixture session directly", async () => {
    const raw = { ...fixtureRawState(), ...fixtureActiveSession() };
    let posted: Record<string, unknown> | undefined;
    const { exitCode } = await run(
      ["pause"],
      {
        "/api/commands/session": (call) => ((posted = call.body as Record<string, unknown>), { body: { state: raw } })
      },
      raw
    );
    expect(exitCode).toBe(EXIT.ok);
    expect(posted?.type).toBe("pause");
    expect(posted?.sessionId).toBe(fixtureActiveSessionId);
  });
});

describe("session continue", () => {
  it("requires --minutes", async () => {
    const raw = { ...fixtureRawState(), ...withRunningSession() };
    const { exitCode, calls } = await run(["continue"], {}, raw);
    expect(exitCode).toBe(EXIT.usage);
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("posts requestedMinutes", async () => {
    const raw = { ...fixtureRawState(), ...withRunningSession() };
    let posted: Record<string, unknown> | undefined;
    await run(
      ["continue", "--minutes", "15"],
      {
        "/api/commands/session": (call) => ((posted = call.body as Record<string, unknown>), { body: { state: raw } })
      },
      raw
    );
    expect(posted?.type).toBe("continue");
    expect(posted?.requestedMinutes).toBe(15);
  });
});

describe("session finish", () => {
  it("--outcome progress without --remaining fails local validation, no POST", async () => {
    const raw = { ...fixtureRawState(), ...withRunningSession() };
    const { exitCode, calls } = await run(["finish", "--outcome", "progress"], {}, raw);
    expect(exitCode).toBe(EXIT.validation);
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("--remaining with any outcome but progress is a usage error, no POST", async () => {
    const raw = { ...fixtureRawState(), ...withRunningSession() };
    for (const argv of [
      ["finish", "--outcome", "completed", "--remaining", "5"],
      ["finish", "--remaining", "5"],
      ["finish", "--outcome", "unsure", "--remaining", "5"]
    ]) {
      const { exitCode, stderr, calls } = await run(argv, {}, raw);
      expect(exitCode).toBe(EXIT.usage);
      expect(stderr).toContain("--remaining only applies with --outcome progress");
      expect(calls.some((call) => call.method === "POST")).toBe(false);
    }
  });

  it("posts the running session's id, defaulting outcome to completed", async () => {
    const raw = { ...fixtureRawState(), ...withRunningSession() };
    let posted: Record<string, unknown> | undefined;
    const { exitCode, stdout } = await run(
      ["finish", "--json"],
      {
        "/api/commands/session": (call) => ((posted = call.body as Record<string, unknown>), { body: { state: raw } })
      },
      raw
    );
    expect(exitCode).toBe(EXIT.ok);
    expect(posted?.type).toBe("finish");
    expect(posted?.sessionId).toBe(RUNNING_SESSION_ID);
    expect(posted?.outcome).toBe("completed");
    const doc = JSON.parse(stdout) as { ok: boolean };
    expect(doc.ok).toBe(true);
  });

  it("posts progress with remainingMinutes and a note", async () => {
    const raw = { ...fixtureRawState(), ...withRunningSession() };
    let posted: Record<string, unknown> | undefined;
    await run(
      ["finish", "--outcome", "progress", "--remaining", "30", "--note", "Made a start"],
      {
        "/api/commands/session": (call) => ((posted = call.body as Record<string, unknown>), { body: { state: raw } })
      },
      raw
    );
    expect(posted?.outcome).toBe("progress");
    expect(posted?.remainingMinutes).toBe(30);
    expect(posted?.note).toBe("Made a start");
  });
});

describe("session block", () => {
  it("requires --reason, without calling the portal", async () => {
    const raw = { ...fixtureRawState(), ...withRunningSession() };
    const { exitCode, calls } = await run(["block"], {}, raw);
    expect(exitCode).toBe(EXIT.usage);
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("posts reason and actionStatus, defaulting status to blocked", async () => {
    const raw = { ...fixtureRawState(), ...withRunningSession() };
    let posted: Record<string, unknown> | undefined;
    await run(
      ["block", "--reason", "waiting_on_someone", "--status", "waiting", "--note", "Ask supervisor"],
      {
        "/api/commands/session": (call) => ((posted = call.body as Record<string, unknown>), { body: { state: raw } })
      },
      raw
    );
    expect(posted?.reason).toBe("waiting_on_someone");
    expect(posted?.actionStatus).toBe("waiting");
    expect(posted?.note).toBe("Ask supervisor");
  });
});

describe("session did-not-start", () => {
  it("posts did_not_start for the running session", async () => {
    const raw = { ...fixtureRawState(), ...withRunningSession() };
    let posted: Record<string, unknown> | undefined;
    const { exitCode } = await run(
      ["did-not-start"],
      {
        "/api/commands/session": (call) => ((posted = call.body as Record<string, unknown>), { body: { state: raw } })
      },
      raw
    );
    expect(exitCode).toBe(EXIT.ok);
    expect(posted?.type).toBe("did_not_start");
    expect(posted?.sessionId).toBe(RUNNING_SESSION_ID);
  });
});

describe("session usage", () => {
  it("refuses an unknown subcommand", async () => {
    const { exitCode, stderr } = await run(["bogus"]);
    expect(exitCode).toBe(EXIT.usage);
    expect(stderr).toContain("bogus");
  });
});

describe("session set-start", () => {
  it("posts correct_start for the running session", async () => {
    const raw = { ...fixtureRawState(), ...withRunningSession() };
    let posted: Record<string, unknown> | undefined;
    const { exitCode } = await run(
      ["set-start", "--started-at", "2026-09-03T09:00:00+10:00"],
      {
        "/api/commands/session": (call) => ((posted = call.body as Record<string, unknown>), { body: { state: raw } })
      },
      raw
    );
    expect(exitCode).toBe(EXIT.ok);
    expect(posted).toMatchObject({
      type: "correct_start",
      sessionId: RUNNING_SESSION_ID,
      startedAt: "2026-09-03T09:00:00+10:00"
    });
    expect(sessionCommandSchema.safeParse(posted).success).toBe(true);
  });

  it("needs --started-at and a running session", async () => {
    const raw = { ...fixtureRawState(), ...withRunningSession() };
    expect((await run(["set-start"], {}, raw)).exitCode).toBe(EXIT.usage);
    expect((await run(["set-start", "--started-at", "2026-09-03T09:00:00+10:00"])).exitCode).toBe(EXIT.notFound);
  });
});

describe("session commands on the wrong kind of session (F3-02)", () => {
  const stateOf = (targetType: string) => ({ ...fixtureRawState(), ...withRunningSession({ targetType }) });
  const failure = (stdout: string) => JSON.parse(stdout) as Record<string, any>;

  it.each([
    ["finish", ["finish"], { subcommand: "finish", outcome: "completed" }],
    ["finish --outcome unsure", ["finish", "--outcome", "unsure"], { subcommand: "finish", outcome: "stopped" }],
    ["block", ["block", "--reason", "stuck"], { subcommand: "finish", outcome: "blocked" }],
    ["did-not-start", ["did-not-start"], { subcommand: "finish", outcome: "did_not_start" }]
  ])("%s on a routine step names the rhen_activity call that does it", async (_label, argv, call) => {
    const { exitCode, stdout: stderr, calls } = await run([...argv, "--json"], {}, stateOf("routine_step"));
    expect(exitCode).not.toBe(EXIT.ok);
    expect(calls.some((entry) => entry.url.includes("/api/commands/"))).toBe(false);
    const error = failure(stderr);
    expect(error.error).toContain("routine step");
    expect(error.error).toContain("rhen_activity");
    expect(error.nextCall).toMatchObject({ tool: "rhen_activity", arguments: call });
    const tool = mcpManifestTool(error.nextCall.tool)!;
    expect(validateToolArguments(tool.inputSchema, error.nextCall.arguments, tool.name).ok).toBe(true);
  });

  it("an action session is untouched", async () => {
    const { stdout: stderr } = await run(["finish", "--json"], {}, stateOf("action"));
    expect(stderr).not.toContain("rhen_activity");
  });

  it("with nothing running, says how to look and how to start", async () => {
    const { exitCode, stdout: stderr } = await run(["finish", "--json"]);
    expect(exitCode).toBe(EXIT.notFound);
    const error = failure(stderr);
    expect(error.error).toContain("rhen_status");
    expect(error.error).toContain("rhen_session");
    expect(error.error).toContain("rhen_activity");
    expect(error.nextCall).toMatchObject({ tool: "rhen_status", arguments: {} });
  });
});

describe("session refusals review follow-ups (F3-02)", () => {
  const stateOf = (targetType: string) => ({ ...fixtureRawState(), ...withRunningSession({ targetType }) });
  const failure = (stdout: string) => JSON.parse(stdout) as Record<string, any>;

  function withDirective(directive: Record<string, unknown>): Record<string, unknown> {
    const raw = structuredClone(fixtureRawState()) as any;
    raw.planning.result.currentDirective = directive;
    return raw;
  }

  /** Runs the printed `rhen_activity` call through the real `activity` command against the same state. */
  async function runPrinted(text: string, raw: Record<string, unknown>) {
    const match = /rhen_activity (\{"subcommand":"start"[^}]*\})/.exec(text);
    expect(match, text).not.toBeNull();
    const call = JSON.parse(match![1]!) as Record<string, unknown>;
    expect(call.minutes, "minutes is a number, not a placeholder").toEqual(expect.any(Number));
    const calls: RecordedCall[] = [];
    const out: string[] = [];
    const fetchImpl = fakeFetch(
      { "/api/state": { body: { state: raw } }, "/api/commands/activity": () => ({ body: { state: raw } }) },
      calls
    );
    const exitCode = await runCli(
      [
        "activity",
        "start",
        "--type",
        String(call.type),
        "--target",
        String(call.target),
        "--minutes",
        String(call.minutes),
        "--json"
      ],
      {
        stdout: (t) => out.push(t),
        stderr: (t) => out.push(t),
        env: {},
        readConfigFile: () => null,
        now: () => fixtureNow,
        fetchImpl
      }
    );
    return { exitCode, out: out.join("\n"), posted: calls.some((c) => c.url.includes("/api/commands/activity")) };
  }

  it.each([
    ["routine_step", "step-pack", "Pack the bag"],
    ["sleep", "sleep-tonight", "Sleep tonight"]
  ])("the start refusal for a %s directive prints a call the activity resolver accepts", async (kind, id, title) => {
    const raw = withDirective({ kind, targetId: id, title, recommendedMinutes: 10 });
    const { stdout } = await run(["start", "--json"], {}, raw);
    const error = failure(stdout);
    expect(error.error).toContain(`"target":"${id}"`);
    expect(error.error).not.toContain(`"target":"${title}"`);
    const result = await runPrinted(error.error, raw);
    expect(result.out).not.toContain("No routine step");
    expect(result.out).not.toContain("No sleep plan");
    expect(result.posted).toBe(true);
  });

  it("finish --outcome skipped on a routine step maps to the skipped outcome", async () => {
    const { stdout } = await run(["finish", "--outcome", "skipped", "--json"], {}, stateOf("routine_step"));
    expect(failure(stdout).nextCall.arguments).toEqual({ subcommand: "finish", outcome: "skipped" });
  });

  it("feedback on a routine step says there is no feedback step and offers finish or pause", async () => {
    const { stdout } = await run(["feedback", "--json"], {}, stateOf("routine_step"));
    const error = failure(stdout);
    expect(error.error).toContain("no feedback step");
    expect(error.error).toContain('rhen_activity {"subcommand":"pause"}');
    expect(error.error).toContain('rhen_activity {"subcommand":"finish","outcome":"completed"}');
    expect(error.nextCall.arguments).toEqual({ subcommand: "finish", outcome: "completed" });
  });
});
