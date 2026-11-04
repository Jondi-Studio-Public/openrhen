import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { EXIT } from "../src/errors.js";
import { fakeFetch, type RecordedCall } from "./fake-fetch.js";
import { fixtureNow, fixtureRawState } from "./fixture-state.js";

// fixtureNow is 2026-09-03 in the seed zone, so the session window starts 2026-08-04.
const nightPlan = (id: string, actualStartAt: string, actualWakeAt: string, extra: Record<string, unknown> = {}) => ({
  id,
  plannedStartAt: actualStartAt,
  plannedWakeAt: actualWakeAt,
  desiredMinutes: 480,
  allowedMinutes: 480,
  sleepDeficitMinutes: 0,
  anchorDeviationMinutes: 0,
  hardErrors: [],
  explanation: "",
  status: "completed",
  actualStartAt,
  actualWakeAt,
  ...extra
});

const raw = (): Record<string, unknown> => {
  const base = fixtureRawState();
  return {
    ...base,
    sleepPlans: [
      ...(base.sleepPlans as unknown[]),
      // Logged by hand, no session: listed.
      nightPlan("plan-manual", "2026-09-01T22:00:00+10:00", "2026-09-02T05:42:00+10:00", { manual: true }),
      // Recorded by "session-sleep" below (its actionId is this id): not listed twice.
      nightPlan("plan-tracked", "2026-09-02T22:30:00+10:00", "2026-09-03T06:30:00+10:00"),
      // Not completed, or older than the 30-day window: not listed.
      nightPlan("plan-open", "2026-09-02T22:00:00+10:00", "2026-09-03T06:00:00+10:00", { status: "planned" }),
      nightPlan("plan-old", "2026-07-09T22:00:00+10:00", "2026-07-10T06:00:00+10:00", { manual: true })
    ],
    spans: [
      { id: "old", version: 1, title: "Old trip", startDate: "2026-07-01", endDate: "2026-07-03" },
      { id: "trip", version: 1, title: "Trip 1", startDate: "2026-08-27", endDate: "2026-08-29" }
    ],
    completedToday: [
      ...(base.completedToday as unknown[]),
      {
        id: "session-sleep",
        actionId: "plan-tracked",
        actionTitle: "Sleep",
        result: "completed",
        targetType: "sleep",
        startedAt: "2026-09-02T22:30:00+10:00",
        endedAt: "2026-09-03T06:30:00+10:00",
        plannedMinutes: 480,
        activeMinutes: 480,
        remainingBeforeMinutes: 0,
        remainingAfterMinutes: 0
      }
    ],
    occurrences: [
      ...(base.occurrences as unknown[]),
      {
        id: "occ-done",
        actionId: "action-weed",
        recurrenceRuleId: "rule-weed",
        windowId: "window-morning",
        windowName: "Morning",
        localDate: "2026-09-02",
        windowStartsAt: "2026-09-02T07:00:00+10:00",
        windowEndsAt: "2026-09-02T08:00:00+10:00",
        anchorSource: "preferred_wake",
        status: "completed"
      }
    ]
  };
};

async function run(argv: string[]) {
  const calls: RecordedCall[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const fetchImpl = fakeFetch({ "/api/state": { body: { state: raw() } } }, calls);
  const exitCode = await runCli(argv, {
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    env: {},
    readConfigFile: () => null,
    now: () => fixtureNow,
    fetchImpl
  });
  return { exitCode, stdout: out.join("\n"), stderr: err.join("\n"), calls };
}

describe("history", () => {
  it("returns sessions, sleep, closed occurrences and spans for the range", async () => {
    const { exitCode, stdout, stderr, calls } = await run([
      "history",
      "--from",
      "2026-08-25",
      "--to",
      "2026-09-03",
      "--json"
    ]);
    expect(exitCode).toBe(EXIT.ok);
    const history = JSON.parse(stdout) as Record<string, { id: string }[] | string>;
    expect((history.sessions as { id: string }[]).map((item) => item.id)).toEqual(["session-email"]);
    expect((history.sleep as { id: string }[]).map((item) => item.id)).toEqual(["plan-manual", "session-sleep"]);
    expect((history.occurrences as { id: string }[]).map((item) => item.id)).toEqual(["occ-done"]);
    expect((history.spans as { id: string }[]).map((item) => item.id)).toEqual(["trip"]);
    expect(history.sessionsFrom).toBe("2026-08-04");
    expect(stderr).toBe("");
    expect(calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("lists a night logged by hand with its times, minutes and source, and not a night a session covers", async () => {
    const { stdout } = await run(["history", "--from", "2026-08-25", "--to", "2026-09-03", "--json"]);
    const { sleep } = JSON.parse(stdout) as { sleep: Record<string, unknown>[] };
    expect(sleep[0]).toMatchObject({
      id: "plan-manual",
      source: "sleep_plan",
      date: "2026-09-02",
      result: "logged",
      actualStartAt: "2026-09-01T22:00:00+10:00",
      actualWakeAt: "2026-09-02T05:42:00+10:00",
      minutes: 462,
      manual: true
    });
    expect(sleep[1]).toMatchObject({ id: "session-sleep", source: "session", result: "completed", minutes: 480 });
    expect(sleep.map((item) => item.id)).not.toContain("plan-tracked");
  });

  it("excludes a plan-derived night outside the range or the 30-day window", async () => {
    const day = async (from: string, to: string) =>
      (
        JSON.parse((await run(["history", "--from", from, "--to", to, "--json"])).stdout) as { sleep: { id: string }[] }
      ).sleep.map((item) => item.id);
    expect(await day("2026-09-03", "2026-09-03")).toEqual(["session-sleep"]);
    expect(await day("2026-06-25", "2026-09-03")).toEqual(["plan-manual", "session-sleep"]);
  });

  it("clamps sessions to the 30-day window but returns spans for the whole range, and says so", async () => {
    const { stdout, stderr } = await run(["history", "--from", "2026-06-25", "--to", "2026-09-03", "--json"]);
    const history = JSON.parse(stdout) as { sessionsFrom: string; spans: { id: string }[]; from: string };
    expect(history.from).toBe("2026-06-25");
    expect(history.sessionsFrom).toBe("2026-08-04");
    expect(history.spans.map((span) => span.id)).toEqual(["old", "trip"]);
    expect(stderr.split("\n")).toHaveLength(1);
    expect(stderr).toContain("sessionsFrom");
  });

  it("excludes days outside the range and prints a readable table", async () => {
    const { stdout } = await run(["history", "--from", "2026-09-03", "--to", "2026-09-03"]);
    expect(stdout).toContain("Sessions (1)");
    expect(stdout).toContain("Sleep (1)");
    expect(stdout).toContain("Occurrences: none");
    expect(stdout).toContain("Spans: none");
  });

  it("shows a hand-logged night as a Sleep table row", async () => {
    const { stdout } = await run(["history", "--from", "2026-09-02", "--to", "2026-09-02"]);
    expect(stdout).toContain("Sleep (1)");
    expect(stdout).toMatch(/2026-09-02\s+logged\s+462\s+sleep_plan/);
  });

  it("refuses bad dates and a reversed range", async () => {
    expect((await run(["history", "--from", "2026-13-01"])).exitCode).toBe(EXIT.usage);
    expect((await run(["history", "--from", "2026-09-03", "--to", "2026-09-01"])).exitCode).toBe(EXIT.usage);
  });

  it("is a read command, so it runs under --read-only", async () => {
    expect((await run(["history", "--read-only", "--json"])).exitCode).toBe(EXIT.ok);
  });
});
