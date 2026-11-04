import { describe, expect, it } from "vitest";
import type { Need } from "@openrhen/contracts";
import { runCli } from "../src/cli.js";
import { fakeFetch, type RecordedCall } from "./fake-fetch.js";
import { fixtureActiveSession, fixtureNow, fixtureRawState, fixtureActiveSessionId } from "./fixture-state.js";

interface Run {
  exitCode: number;
  stdout: string;
  stderr: string;
  calls: RecordedCall[];
}

async function runStatus(
  argv: readonly string[],
  routes: Parameters<typeof fakeFetch>[0],
  overrides: (raw: Record<string, unknown>) => Record<string, unknown> = (raw) => raw
): Promise<Run> {
  const calls: RecordedCall[] = [];
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const state = overrides(fixtureRawState());
  const fetchImpl = fakeFetch(
    {
      "/api/state": { body: { state } },
      "/api/check-ins/current": { body: { checkIn: null } },
      ...routes
    },
    calls
  );
  const exitCode = await runCli(argv, {
    stdout: (text) => stdoutLines.push(text),
    stderr: (text) => stderrLines.push(text),
    env: {},
    readConfigFile: () => null,
    now: () => fixtureNow,
    fetchImpl
  });
  return { exitCode, stdout: stdoutLines.join("\n"), stderr: stderrLines.join("\n"), calls };
}

describe("status add-ons", () => {
  const switches = [
    { addon: "backfill", mode: "on" },
    { addon: "drafts", mode: "shadow" },
    { addon: "executor", mode: "off" }
  ];

  it("shows each non-off add-on mode in the table and every mode in JSON", async () => {
    const table = await runStatus(["status"], { "/api/plan-map": { body: { switches } } });
    expect(table.stdout).toContain("backfill on, drafts shadow (all others off)");
    const json = await runStatus(["status", "--json"], { "/api/plan-map": { body: { switches } } });
    expect(JSON.parse(json.stdout).addOns).toEqual({ backfill: "on", drafts: "shadow", executor: "off" });
  });

  it("says who turns an all-off set on, and still works when the read fails", async () => {
    const off = await runStatus(["status"], {
      "/api/plan-map": { body: { switches: [{ addon: "backfill", mode: "off" }] } }
    });
    expect(off.stdout).toContain("only the owner switches them on");
    const failed = await runStatus(["status"], { "/api/plan-map": { status: 500, body: { error: "boom" } } });
    expect(failed.exitCode).toBe(0);
    expect(failed.stdout).not.toContain("Add-ons");
  });
});

describe("status", () => {
  it("renders a table with the plan, directive, session, commitments, and today", async () => {
    const { exitCode, stdout } = await runStatus(["status"], {});
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Plan");
    expect(stdout).toContain("current");
    expect(stdout).toContain("Now");
    expect(stdout).toContain("Draft chapter 3");
    expect(stdout).toContain("action-draft");
    expect(stdout).toContain("Why");
    expect(stdout).toContain("Due in 7 days and the only chapter still unwritten.");
    expect(stdout).toContain("Up next");
    expect(stdout).toContain("Fix citations");
    expect(stdout).toContain("Commitment");
    expect(stdout).toContain("Gym session");
    expect(stdout).toContain("17:00");
    expect(stdout).toContain("18:00");
    // Both step-pack and step-shower belong to commitment-gym and are pending.
    expect(stdout).toContain("2 prep steps pending");
    expect(stdout).toContain("commitment-gym");
    expect(stdout).toContain("Today");
    expect(stdout).toContain("[x] Email supervisor");
    expect(stdout).toContain("[ ] Draft chapter 3");
    expect(stdout).toContain("Done today");
    expect(stdout).toContain("Situation");
    expect(stdout).toContain("at Home");
  });

  it("never truncates the directive's reason even when it is long", async () => {
    const longReason =
      "This reason is deliberately much longer than the forty-eight character cell width that table " +
      "rendering normally truncates to, so the test can prove status never cuts it.";
    const { stdout } = await runStatus(["status"], {}, (raw) => {
      const planning = raw.planning as { result: { dayPlan: { blocks: Record<string, unknown>[] } } };
      const block = planning.result.dayPlan.blocks[0];
      if (block) block.reason = longReason;
      return raw;
    });
    expect(stdout).toContain(longReason);
  });

  it("prints JSON with the directive, commitments, today, and situation resolved", async () => {
    const { exitCode, stdout } = await runStatus(["status", "--json"], {});
    expect(exitCode).toBe(0);
    const summary = JSON.parse(stdout);
    expect(summary.directive.targetId).toBe("action-draft");
    expect(summary.directive.reason).toBe("Due in 7 days and the only chapter still unwritten.");
    expect(summary.directive.projectTitle).toBe("Thesis");
    expect(summary.nextCommitment.id).toBe("commitment-gym");
    expect(summary.currentCommitment).toBeNull();
    expect(summary.today.items).toEqual([
      { actionId: "action-draft", title: "Draft chapter 3", status: "planned", done: false },
      { actionId: "action-cite", title: "Fix citations", status: "active", done: false },
      { actionId: "action-done", title: "Email supervisor", status: "done", done: true }
    ]);
    expect(summary.situation.locationName).toBe("Home");
    expect(summary.plan.validUntil).toBe("2026-09-03T10:12:00+10:00");
    // `now` is built from `context.now().toISOString()` (always UTC 'Z'), but must reach JSON in the
    // planning timezone's own offset, matching `summary.timezone`, not the raw UTC form.
    expect(summary.now).toMatch(/^2026-09-03T\d{2}:\d{2}:\d{2}\+10:00$/);
    expect(summary.now).not.toMatch(/Z$/);
  });

  it("reports the running session's elapsed and remaining minutes", async () => {
    const { stdout } = await runStatus(["status", "--json"], {}, (raw) => ({ ...raw, ...fixtureActiveSession() }));
    const summary = JSON.parse(stdout);
    expect(summary.session).not.toBeNull();
    expect(summary.session.id).toBe(fixtureActiveSessionId);
    expect(summary.session.elapsedMinutes).toBe(25);
    expect(summary.session.minutesLeft).toBe(20);
  });

  it("treats a missing planning document as unavailable, with no directive", async () => {
    const { exitCode, stdout } = await runStatus(["status", "--json"], {}, (raw) => {
      const { planning: _planning, ...rest } = raw;
      return rest;
    });
    expect(exitCode).toBe(0);
    const summary = JSON.parse(stdout);
    expect(summary.plan.status).toBe("unavailable");
    expect(summary.directive).toBeNull();
  });

  it("finds a commitment that is currently underway", async () => {
    const { stdout } = await runStatus(["status", "--json"], {}, (raw) => {
      const commitments = raw.commitments as Record<string, unknown>[];
      return {
        ...raw,
        commitments: commitments.map((commitment) =>
          commitment.id === "commitment-gym"
            ? { ...commitment, startsAt: "2026-09-03T09:00:00+10:00", endsAt: "2026-09-03T10:00:00+10:00" }
            : commitment
        )
      };
    });
    const summary = JSON.parse(stdout);
    expect(summary.currentCommitment).not.toBeNull();
    expect(summary.currentCommitment.id).toBe("commitment-gym");
    expect(summary.nextCommitment).toBeNull();
  });

  it("reports the engine's planned journey, and whether an anchor's hour is open or engaged", async () => {
    const underway = (raw: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
      ...raw,
      ...extra,
      commitments: (raw.commitments as Record<string, unknown>[]).map((commitment) =>
        commitment.id === "commitment-gym"
          ? {
              ...commitment,
              startsAt: "2026-09-03T09:00:00+10:00",
              endsAt: "2026-09-03T10:00:00+10:00",
              presence: "anchor"
            }
          : commitment
      )
    });
    const timeline = {
      id: "commitment-gym",
      setupStartsAt: "2026-09-03T08:30:00+10:00",
      leaveBy: "2026-09-03T08:40:00+10:00",
      arriveBy: "2026-09-03T08:55:00+10:00",
      startsAt: "2026-09-03T09:00:00+10:00",
      endsAt: "2026-09-03T10:00:00+10:00",
      effectiveEndsAt: "2026-09-03T10:00:00+10:00",
      freeAt: "2026-09-03T10:10:00+10:00",
      protectedUntil: "2026-09-03T10:10:00+10:00",
      overtime: false,
      latenessMatters: true,
      journeyBefore: {
        fromLocationId: "ctx-home",
        toLocationId: "ctx-gym",
        minutes: 15,
        typicalMinutes: 12,
        source: "typical",
        sampleCount: 4
      }
    };
    const open = await runStatus(["status", "--json"], {}, (raw) => {
      const base = underway(raw);
      const planning = raw.planning as { result: Record<string, unknown> };
      return {
        ...base,
        currentSituation: { locationId: "ctx-gym" },
        planning: {
          ...planning,
          result: {
            ...planning.result,
            derivedState: { ...(planning.result.derivedState as object), commitmentTimelines: [timeline] }
          }
        }
      };
    });
    const openSummary = JSON.parse(open.stdout).currentCommitment;
    expect(openSummary.anchorState).toBe("open");
    expect(openSummary.journey.leaveBy).toBe("2026-09-03T08:40:00+10:00");
    expect(openSummary.journey.before).toMatchObject({ minutes: 15, source: "typical" });
    const engaged = await runStatus(["status", "--json"], {}, (raw) => {
      const base = underway(raw, { currentSituation: { locationId: "ctx-gym" } });
      return {
        ...base,
        activeSession: {
          ...(fixtureActiveSession().activeSession as object),
          targetType: "fixed_commitment",
          targetId: "commitment-gym"
        }
      };
    });
    expect(JSON.parse(engaged.stdout).currentCommitment.anchorState).toBe("engaged");
    const placeless = await runStatus(["status", "--json"], {}, (raw) => {
      const base = underway(raw, { currentSituation: { locationId: "ctx-gym" } });
      return {
        ...base,
        commitments: (base.commitments as Record<string, unknown>[]).map((commitment) =>
          commitment.id === "commitment-gym"
            ? { ...commitment, location: undefined, locationId: undefined }
            : commitment
        ),
        routineSteps: [
          {
            id: "step-prep",
            commitmentId: "commitment-gym",
            anchorType: "commitment",
            phase: "before",
            status: "pending",
            title: "Pack bag",
            durationMinutes: 5,
            sequence: 0,
            timingRule: "flexible",
            energy: "low",
            contexts: []
          }
        ]
      };
    });
    expect(JSON.parse(placeless.stdout).currentCommitment.anchorState).toBeUndefined();
    const away = await runStatus(["status", "--json"], {}, (raw) => underway(raw));
    expect(JSON.parse(away.stdout).currentCommitment.anchorState).toBeUndefined();
  });

  it("survives a check-in route failure without failing the command", async () => {
    const { exitCode, stdout } = await runStatus(["status", "--json"], {
      "/api/check-ins/current": { status: 500, body: { error: "boom" } }
    });
    expect(exitCode).toBe(0);
    const summary = JSON.parse(stdout);
    expect(summary.checkIn).toBeNull();
    expect(typeof summary.checkInError).toBe("string");
    expect(summary.checkInError.length).toBeGreaterThan(0);
  });

  it("renders a pending check-in in the table", async () => {
    const { stdout } = await runStatus(["status"], {
      "/api/check-ins/current": {
        body: {
          checkIn: {
            id: "checkin-1",
            status: "pending",
            directiveKind: "action",
            directiveTargetId: "action-draft",
            directiveTitle: "Draft chapter 3",
            slotAt: "2026-09-03T09:30:00+10:00",
            promptedAt: "2026-09-03T09:30:00+10:00",
            answeredAt: null
          }
        }
      }
    });
    expect(stdout).toContain("Check-in");
    expect(stdout).toContain("Draft chapter 3");
    expect(stdout).toContain("checkin-1");
  });

  it("shows a Prep row and includes prepPace in JSON when the engine reports one behind", async () => {
    const withPrepPace = (raw: Record<string, unknown>) => {
      const planning = raw.planning as { result: Record<string, unknown> };
      planning.result.prepPace = {
        commitmentId: "commitment-gym",
        commitmentTitle: "Gym session",
        commitmentStartsAt: "2026-09-03T17:00:00+10:00",
        requiredMinutes: 25,
        availableMinutes: 18,
        minutesBehind: 7,
        status: "behind"
      };
      return raw;
    };
    const { stdout: table } = await runStatus(["status"], {}, withPrepPace);
    expect(table).toContain("Prep");
    expect(table).toContain("behind by 7 min for Gym session at");

    const { stdout: json } = await runStatus(["status", "--json"], {}, withPrepPace);
    const summary = JSON.parse(json);
    expect(summary.prepPace).toEqual({
      commitmentId: "commitment-gym",
      commitmentTitle: "Gym session",
      commitmentStartsAt: "2026-09-03T17:00:00+10:00",
      requiredMinutes: 25,
      availableMinutes: 18,
      minutesBehind: 7,
      status: "behind"
    });
  });

  it("shows the quieter tight wording, and omits the Prep row entirely when absent", async () => {
    const { stdout: absent } = await runStatus(["status"], {});
    expect(absent).not.toContain("Prep ");

    const { stdout: absentJson } = await runStatus(["status", "--json"], {});
    expect(JSON.parse(absentJson).prepPace).toBeNull();

    const { stdout: tightTable } = await runStatus(["status"], {}, (raw) => {
      const planning = raw.planning as { result: Record<string, unknown> };
      planning.result.prepPace = {
        commitmentId: "commitment-gym",
        commitmentTitle: "Gym session",
        commitmentStartsAt: "2026-09-03T17:00:00+10:00",
        requiredMinutes: 20,
        availableMinutes: 23,
        minutesBehind: 0,
        status: "tight"
      };
      return raw;
    });
    expect(tightTable).toContain("tight, 3 min spare for Gym session at");
  });

  it('lists every running anchor, so two overlapping classes both read as "I\'m free" (10-07)', async () => {
    const { stdout } = await runStatus(["status", "--json"], {}, (raw) => {
      const gym = (raw.commitments as Record<string, unknown>[]).find((item) => item.id === "commitment-gym")!;
      const anchor = { ...gym, startsAt: "2026-09-03T09:00:00+10:00", presence: "anchor" };
      return {
        ...raw,
        currentSituation: { locationId: "ctx-gym" },
        commitments: [
          { ...anchor, endsAt: "2026-09-03T10:00:00+10:00" },
          { ...anchor, id: "commitment-gym-copy", endsAt: "2026-09-03T10:30:00+10:00", origin: "disruption" }
        ]
      };
    });
    expect(JSON.parse(stdout).anchors).toEqual({ open: ["commitment-gym", "commitment-gym-copy"], engaged: [] });
  });

  it("states the wake time and reason behind a sleep directive, so an agent never re-derives it from an alarm", async () => {
    const withSleep = (raw: Record<string, unknown>) => {
      const planning = raw.planning as { result: { currentDirective: unknown } };
      planning.result.currentDirective = {
        kind: "sleep",
        targetId: "sleep-tonight",
        title: "Time to sleep",
        recommendedMinutes: 540
      };
      const plan = (raw.sleepPlans as Record<string, unknown>[])[0]!;
      plan.plannedStartAt = "2026-09-03T01:20:00+10:00";
      plan.plannedWakeAt = "2026-09-03T10:19:00+10:00";
      plan.allowedMinutes = 540;
      (raw.routineSteps as Record<string, unknown>[]).push({
        id: "step-teeth",
        anchorType: "sleep_plan",
        anchorId: "sleep-tonight",
        purpose: "bedtime",
        title: "Brush and floss teeth",
        durationMinutes: 8,
        sequence: 0,
        timingRule: "contiguous",
        energy: "low",
        contexts: [],
        status: "pending"
      });
      plan.replannedFromMissedStart = true;
      plan.explanation = "The planned start was missed, so the wake time moved later to protect 540 minutes of sleep.";
      return raw;
    };
    const { stdout } = await runStatus(["status"], {}, withSleep);
    expect(stdout).toContain("540 min · until");
    expect(stdout).toContain("first: Brush and floss teeth (8 min)");
    expect(stdout).toContain("10:19");
    expect(stdout).toContain("Preferred wake 06:30");
    expect(stdout).toContain("No confirmed commitment caps this wake");
    const { stdout: json } = await runStatus(["status", "--json"], {}, withSleep);
    const sleep = JSON.parse(json).directive.sleep;
    expect(sleep).toMatchObject({ wakesAt: "2026-09-03T10:19:00+10:00", replannedFromMissedStart: true });
    expect(sleep.wakeConstraint).toBeUndefined();
    expect(sleep.currentStep).toMatchObject({ id: "step-teeth", title: "Brush and floss teeth" });
  });

  it("says protection ends, not that the commitment starts, when a boundary is an end edge", async () => {
    const withBoundary = (edge?: string) => (raw: Record<string, unknown>) => {
      const planning = raw.planning as { result: { currentDirective: unknown } };
      planning.result.currentDirective = {
        kind: "boundary",
        title: "Nothing fits",
        recommendedMinutes: 0,
        boundaryAt: "2026-09-03T17:13:00+10:00",
        boundaryKind: "commitment",
        boundaryTitle: "College Class",
        ...(edge ? { boundaryEdge: edge } : {}),
        nextFit: null
      };
      return raw;
    };
    const end = await runStatus(["status"], {}, withBoundary("end"));
    expect(end.stdout).toContain("Nothing fits until College Class's protection ends at");
    const start = await runStatus(["status"], {}, withBoundary());
    expect(start.stdout).toContain("Nothing fits before College Class at");
    const json = await runStatus(["status", "--json"], {}, withBoundary("end"));
    expect(JSON.parse(json.stdout).directive.boundaryEdge).toBe("end");
  });

  it("never sends a POST, and reads exactly the five GET routes", async () => {
    const { calls } = await runStatus(["status"], {});
    expect(calls.some((call) => call.method === "POST")).toBe(false);
    const paths = calls.map((call) => call.path).sort();
    expect(paths).toEqual([
      "/api/catch-up",
      "/api/check-ins/current",
      "/api/plan-map",
      "/api/pulse/reentry",
      "/api/state"
    ]);
  });
});

describe("status catch-up line", () => {
  const ledger = (due: boolean) => ({
    now: "2026-09-04T00:00:00.000Z",
    since: "2026-09-01T00:00:00.000Z",
    due,
    unsettled: 14,
    staleDates: 3,
    entries: [],
    remaining: 0,
    nextOffset: null
  });

  it("reports due when the window is due", async () => {
    const due = await runStatus(["status", "--json"], { "/api/catch-up": { body: ledger(true) } });
    expect(JSON.parse(due.stdout).catchUp).toMatchObject({ state: "due", unsettled: 14, staleDates: 3 });
    const table = await runStatus(["status"], { "/api/catch-up": { body: ledger(true) } });
    expect(table.stdout).toContain("Catch-up");
    expect(table.stdout).toContain("14 to settle, 3 stale dates");
  });

  it("reports none when not due, and says nothing extra in the table", async () => {
    for (const body of [ledger(false)]) {
      const json = await runStatus(["status", "--json"], { "/api/catch-up": { body } });
      expect(JSON.parse(json.stdout).catchUp.state).toBe("none");
      const table = await runStatus(["status"], { "/api/catch-up": { body } });
      expect(table.stdout).not.toContain("Catch-up");
    }
  });

  it("is in the brief digest, and a failed read leaves it out without failing status", async () => {
    const brief = await runStatus(["status", "--brief", "--json"], { "/api/catch-up": { body: ledger(true) } });
    expect(JSON.parse(brief.stdout).catchUp.state).toBe("due");
    const failed = await runStatus(["status", "--json"], { "/api/catch-up": { status: 500, body: { error: "x" } } });
    expect(failed.exitCode).toBe(0);
    expect(JSON.parse(failed.stdout).catchUp).toBeUndefined();
  });
});

describe("status session and today lines", () => {
  const withSession = (patch: Record<string, unknown>) => (raw: Record<string, unknown>) => {
    const { activeSession } = fixtureActiveSession() as { activeSession: Record<string, unknown> };
    return { ...raw, activeSession: { ...activeSession, ...patch } };
  };

  it("names an action session by its action when the portal sends no targetTitle", async () => {
    const run = await runStatus(["status", "--json"], {}, withSession({ targetTitle: undefined }));
    expect(JSON.parse(run.stdout).session.title).toBe("Draft chapter 3");
    const table = await runStatus(["status"], {}, withSession({ targetTitle: undefined }));
    expect(table.stdout).toContain("running · Draft chapter 3 ·");
  });

  it("keeps a session's own title, and falls back to the id for an action the state no longer holds", async () => {
    const own = await runStatus(["status", "--json"], {}, withSession({ targetTitle: "Chapter 3, renamed" }));
    expect(JSON.parse(own.stdout).session.title).toBe("Chapter 3, renamed");
    const gone = await runStatus(
      ["status", "--json"],
      {},
      withSession({ targetTitle: undefined, actionId: "action-missing", targetId: "action-missing" })
    );
    expect(JSON.parse(gone.stdout).session.title).toBe("action-missing");
  });

  it("counts a paused session's minutes left from the frozen remainder and prints no end time", async () => {
    // fixtureNow is 09:30; the planned end of 09:50 would give 20 minutes, but the pause froze 33.
    const paused = withSession({ status: "paused", pausedRemainingSeconds: 1980, segmentStartedAt: undefined });
    const json = await runStatus(["status", "--json"], {}, paused);
    expect(JSON.parse(json.stdout).session).toMatchObject({ status: "paused", minutesLeft: 33 });
    const table = await runStatus(["status"], {}, paused);
    expect(table.stdout).toContain("paused · Draft chapter 3");
    expect(table.stdout).toContain("33 min left when resumed");
    expect(table.stdout).not.toContain("ends 09:50");
    const brief = await runStatus(["status", "--brief", "--json"], {}, paused);
    expect(JSON.parse(brief.stdout).session.minutesLeft).toBe(33);
  });

  it("still shows the end time of a running session", async () => {
    const run = await runStatus(["status"], {}, withSession({}));
    expect(run.stdout).toContain("ends 09:50");
    expect(JSON.parse((await runStatus(["status", "--json"], {}, withSession({}))).stdout).session.minutesLeft).toBe(
      20
    );
  });

  it("shows the daily plan under Today only when it is for today in the portal's timezone", async () => {
    const tomorrow = (raw: Record<string, unknown>) => ({
      ...raw,
      dailyPlan: { ...(raw.dailyPlan as Record<string, unknown>), localDate: "2026-09-04" }
    });
    const other = await runStatus(["status", "--json"], {}, tomorrow);
    expect(JSON.parse(other.stdout).today).toBeNull();
    expect((await runStatus(["status"], {}, tomorrow)).stdout).not.toMatch(/^Today /m);
    // fixtureNow is still 2026-09-02 in UTC, so a UTC reading of "today" would have been wrong too.
    const today = await runStatus(["status", "--json"], {});
    expect(JSON.parse(today.stdout).today.localDate).toBe("2026-09-03");
  });
});

describe("status needs", () => {
  const HOUR = 3_600_000;
  const ago = (ms: number) => new Date(fixtureNow.getTime() - ms).toISOString();
  /** Energy said an hour ago, so the one need the fixture otherwise raises (an undated energy) is gone. */
  const energyFresh = (raw: Record<string, unknown>) => ({
    ...raw,
    currentSituation: { ...(raw.currentSituation as object), energySetAt: ago(HOUR) }
  });
  /** A 45-minute session whose planned end was 18 hours ago. */
  const forgottenSession = (raw: Record<string, unknown>) => ({
    ...energyFresh(raw),
    activeSession: {
      ...(fixtureActiveSession().activeSession as object),
      startedAt: ago(19 * HOUR),
      plannedEndAt: ago(18 * HOUR),
      segmentStartedAt: ago(19 * HOUR)
    }
  });
  const oldWake = (raw: Record<string, unknown>) => ({
    ...forgottenSession(raw),
    settings: { ...(raw.settings as object), lastWokeAt: ago(40 * HOUR) }
  });
  const rowsOf = (stdout: string) => stdout.split("\n");

  it("prints Needs before Now: the blocking one first and marked, each with the command that settles it", async () => {
    const { exitCode, stdout } = await runStatus(["status"], {}, oldWake);
    expect(exitCode).toBe(0);
    const lines = rowsOf(stdout);
    const needs = lines.findIndex((line) => line.startsWith("Needs"));
    const now = lines.findIndex((line) => line.startsWith("Now"));
    expect(needs).toBeGreaterThan(0);
    expect(needs).toBeLessThan(now);
    expect(lines[needs]).toContain(
      "blocking · Draft chapter 3 · Running 19 h, planned 45 min. When did it stop? (settle: rhen session finish --ended-at <time>)"
    );
    // The next need continues the block, under an empty label, and is not marked.
    expect(lines[needs + 1]).toMatch(
      /^\s+Last woke 40 h ago\. When did you wake up\? \(settle: rhen wake --at <time>\)$/
    );
    expect(lines[needs + 1]).not.toContain("blocking");
    // Plan, then the block, then Now: nothing else sits between the block and Now.
    expect(lines[needs + 2]).toMatch(/^Now\s/);
  });

  it("asks a stale paused session to be finished, with no end time to give", async () => {
    const { stdout } = await runStatus(["status"], {}, (raw) => ({
      ...energyFresh(raw),
      activeSession: {
        ...(fixtureActiveSession().activeSession as object),
        status: "paused",
        startedAt: ago(7 * HOUR),
        plannedEndAt: ago(6 * HOUR),
        pausedAt: ago(5 * HOUR),
        pausedRemainingSeconds: 1200
      }
    }));
    expect(stdout).toContain("blocking · Draft chapter 3 · Paused 5 h ago. Finish it? (settle: rhen session finish)");
  });

  it("names the energy command for an energy that was never dated", async () => {
    const { stdout } = await runStatus(["status"], {});
    expect(stdout).toContain("How is your energy now? (settle: rhen save current_availability --set currentEnergy=");
  });

  it("prints no Needs row while every fact is current", async () => {
    const { stdout } = await runStatus(["status"], {}, energyFresh);
    expect(rowsOf(stdout).some((line) => line.startsWith("Needs"))).toBe(false);
  });

  it("carries the needs in JSON as the list the contracts build, blocking first", async () => {
    const { stdout } = await runStatus(["status", "--json"], {}, oldWake);
    const summary = JSON.parse(stdout) as { needs: Need[]; directive: unknown };
    expect(summary.needs.map((need) => need.fact)).toEqual(["session_end", "wake"]);
    expect(summary.needs[0]).toMatchObject({
      fact: "session_end",
      subjectId: fixtureActiveSessionId,
      title: "Draft chapter 3",
      question: "Running 19 h, planned 45 min. When did it stop?",
      blocksDirective: true,
      answer: {
        tool: "rhen_session",
        action: "finish",
        fields: ["endedAt"],
        cli: "rhen session finish --ended-at <time>"
      }
    });
    // Dates are written in the planning zone like every other instant in the result.
    expect(new Date(summary.needs[0]!.asOf!).getTime()).toBe(fixtureNow.getTime() - 18 * HOUR);
    expect(summary.needs[1]).toMatchObject({ fact: "wake", blocksDirective: false });
  });

  it("carries an empty list when nothing is stale", async () => {
    const { stdout } = await runStatus(["status", "--json"], {}, energyFresh);
    expect(JSON.parse(stdout).needs).toEqual([]);
  });

  it("puts the needs in the brief digest too, in JSON and in the table", async () => {
    const json = await runStatus(["status", "--brief", "--json"], {}, oldWake);
    expect(JSON.parse(json.stdout).needs.map((need: Need) => need.fact)).toEqual(["session_end", "wake"]);
    const table = await runStatus(["status", "--brief"], {}, oldWake);
    const lines = rowsOf(table.stdout);
    expect(lines.findIndex((line) => line.startsWith("Needs"))).toBe(1);
    expect(table.stdout).toContain("(settle: rhen session finish --ended-at <time>)");
  });
});

describe("status pulse: the disruption in force", () => {
  const withPulse = (raw: Record<string, unknown>) => ({
    ...raw,
    pulse: {
      state: "on",
      since: "2026-09-02T23:00:00.000Z",
      reason: "disrupted",
      private: false,
      disruption: {
        doing: "Hospital visit",
        until: "2026-09-03T05:00:00.000Z",
        locationId: "ctx-home",
        contexts: ["ctx-laptop"],
        exclusive: true,
        recordedBy: "agent"
      },
      shares: {
        today: { onPercent: 50, countedMinutes: 60 },
        days7: { onPercent: null, countedMinutes: 0 },
        days30: { onPercent: null, countedMinutes: 0 }
      }
    }
  });

  it("shows what he is doing instead, until when, and whether it takes all of him", async () => {
    const table = await runStatus(["status"], {}, withPulse);
    expect(table.stdout).toContain("disrupted: Hospital visit until");
    expect(table.stdout).toContain("takes all of you");
    const json = await runStatus(["status", "--json"], {}, withPulse);
    expect(JSON.parse(json.stdout).pulseRecord.disruption).toMatchObject({ doing: "Hospital visit", exclusive: true });
  });
});
