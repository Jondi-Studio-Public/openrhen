import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { EXIT } from "../src/errors.js";
import { fakeFetch } from "./fake-fetch.js";
import { fixtureNow, fixtureRawState } from "./fixture-state.js";

// fixtureNow is 2026-09-03 09:30 in the seed zone, so the portal's session window starts 2026-08-04.
const session = (
  id: string,
  actionId: string,
  actionTitle: string,
  startedAt: string,
  endedAt: string,
  extra: Record<string, unknown> = {}
) => ({
  id,
  actionId,
  actionTitle,
  result: "completed",
  startedAt,
  endedAt,
  plannedMinutes: 30,
  activeMinutes: 30,
  remainingBeforeMinutes: 30,
  remainingAfterMinutes: 0,
  ...extra
});

const night = (
  id: string,
  plannedStartAt: string,
  plannedWakeAt: string,
  actualStartAt: string,
  actualWakeAt: string
) => ({
  id,
  plannedStartAt,
  plannedWakeAt,
  desiredMinutes: 480,
  allowedMinutes: 480,
  sleepDeficitMinutes: 0,
  anchorDeviationMinutes: 0,
  hardErrors: [],
  explanation: "",
  status: "completed",
  actualStartAt,
  actualWakeAt
});

function raw(): Record<string, unknown> {
  const base = fixtureRawState();
  return {
    ...base,
    completedToday: [
      // 09-03: the fixture's email session (15 min, finishes its action), and a draft session that does not finish.
      ...(base.completedToday as unknown[]),
      session("s-draft", "action-draft", "Draft chapter 3", "2026-09-03T07:00:00+10:00", "2026-09-03T07:45:00+10:00", {
        activeMinutes: 45,
        remainingAfterMinutes: 45
      }),
      // 14:30Z is 00:30 on 09-03 in the seed zone, not 09-02.
      session("s-late", "action-weed", "Weed the beds", "2026-09-02T14:00:00Z", "2026-09-02T14:30:00Z", {
        result: "stopped",
        activeMinutes: 20,
        remainingAfterMinutes: 10
      }),
      // 09-02
      session("s-cite", "action-cite", "Fix citations", "2026-09-02T10:00:00+10:00", "2026-09-02T10:30:00+10:00"),
      session("s-skip", "action-draft", "Draft chapter 3", "2026-09-02T11:00:00+10:00", "2026-09-02T11:00:00+10:00", {
        result: "skipped",
        activeMinutes: 0
      }),
      session("s-sleep", "plan-tracked", "Sleep", "2026-09-01T22:30:00+10:00", "2026-09-02T06:30:00+10:00", {
        targetType: "sleep",
        activeMinutes: 480
      })
    ],
    sleepPlans: [
      ...(base.sleepPlans as unknown[]),
      night(
        "plan-tracked",
        "2026-09-01T22:00:00+10:00",
        "2026-09-02T06:00:00+10:00",
        "2026-09-01T22:30:00+10:00",
        "2026-09-02T06:30:00+10:00"
      ),
      night(
        "plan-manual",
        "2026-09-02T22:30:00+10:00",
        "2026-09-03T06:30:00+10:00",
        "2026-09-02T23:00:00+10:00",
        "2026-09-03T05:42:00+10:00"
      )
    ]
  };
}

async function run(argv: string[], state: Record<string, unknown> = raw()) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runCli(argv, {
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
    env: {},
    readConfigFile: () => null,
    now: () => fixtureNow,
    fetchImpl: fakeFetch({ "/api/state": { body: { state } } })
  });
  return { exitCode, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}

describe("summary", () => {
  it("rolls up two local days: focus by project, sessions by result, actions finished, sleep", async () => {
    const { exitCode, stdout } = await run(["summary", "--from", "2026-09-02", "--to", "2026-09-03", "--json"]);
    expect(exitCode).toBe(0);
    const json = JSON.parse(stdout);
    const [first, second] = json.days;
    expect(first).toMatchObject({
      date: "2026-09-02",
      focusedMinutes: 30,
      projects: [{ title: "Thesis", minutes: 30 }],
      sessions: { completed: 1, skipped: 1 },
      actionsFinished: ["Fix citations"]
    });
    // The 00:30 stop and the draft land on 09-03 with the email, whatever offset they arrived in.
    expect(second).toMatchObject({
      date: "2026-09-03",
      focusedMinutes: 15 + 45 + 20,
      sessions: { completed: 2, stopped: 1 },
      actionsFinished: ["Email supervisor"]
    });
    expect(second.projects).toEqual([
      { title: "Thesis", minutes: 60 },
      { title: "Garden", minutes: 20 }
    ]);
    // The tracked night is dated by its wake day and carries its plan; the hand-logged one is 09-03.
    expect(first.sleep).toEqual([
      {
        plannedStart: "2026-09-01T22:00:00+10:00",
        plannedWake: "2026-09-02T06:00:00+10:00",
        actualStart: "2026-09-01T22:30:00+10:00",
        actualWake: "2026-09-02T06:30:00+10:00",
        minutes: 480
      }
    ]);
    expect(second.sleep).toHaveLength(1);
    expect(second.sleep[0]).toMatchObject({ actualWake: "2026-09-03T05:42:00+10:00", minutes: 402 });
    expect(json.totals).toMatchObject({
      focusedMinutes: 110,
      sessions: { completed: 3, skipped: 1, stopped: 1 },
      actionsFinished: 2,
      sleepNights: 2
    });
    expect(json.sessionsFrom).toBe("2026-08-04");
  });

  it("defaults to today", async () => {
    const json = JSON.parse((await run(["summary", "--json"])).stdout);
    expect(json.from).toBe("2026-09-03");
    expect(json.to).toBe("2026-09-03");
    expect(json.days).toHaveLength(1);
  });

  it("reads an offset the way changes does, as the local day it falls on", async () => {
    const json = JSON.parse((await run(["summary", "--from", "-1d", "--json"])).stdout);
    expect([json.from, json.to]).toEqual(["2026-09-02", "2026-09-03"]);
    const named = JSON.parse((await run(["summary", "--from", "yesterday", "--to", "yesterday", "--json"])).stdout);
    expect([named.from, named.to]).toEqual(["2026-09-02", "2026-09-02"]);
  });

  it("refuses a window over 31 days, a backwards one and an unreadable day", async () => {
    const wide = await run(["summary", "--from", "2026-08-01", "--to", "2026-09-03"]);
    expect(wide.exitCode).toBe(EXIT.usage);
    expect(wide.stderr).toContain("at most 31 days");
    expect((await run(["summary", "--from", "2026-08-04", "--to", "2026-09-03", "--json"])).exitCode).toBe(0);
    expect((await run(["summary", "--from", "2026-09-03", "--to", "2026-09-02"])).exitCode).toBe(EXIT.usage);
    const bad = await run(["summary", "--from", "last week"]);
    expect(bad.exitCode).toBe(EXIT.usage);
    expect(bad.stderr).toContain('from "last week" is not a day I can read');
  });

  it("notes when the window starts before the portal keeps sessions", async () => {
    const { stderr } = await run(["summary", "--from", "2026-08-01", "--to", "2026-08-10", "--json"]);
    expect(stderr).toContain("only kept from 2026-08-04");
  });

  it("prints a table with a line per day", async () => {
    const { stdout } = await run(["summary", "--from", "2026-09-02", "--to", "2026-09-03"]);
    expect(stdout).toContain("2026-09-02");
    expect(stdout).toContain("1 completed, 1 skipped");
    expect(stdout).toContain("22:30-06:30 480m");
    expect(stdout).toContain("Thesis");
  });

  it("keeps seven busy days under 8 KB of JSON", async () => {
    const base = fixtureRawState();
    const sessions = Array.from({ length: 7 * 6 }, (_, index) => {
      const day = 27 + Math.floor(index / 6);
      const date = day > 31 ? `2026-09-0${day - 31}` : `2026-08-${day}`;
      const hour = 8 + (index % 6) * 2;
      return session(
        `s-${index}`,
        index % 2 ? "action-draft" : "action-weed",
        index % 2 ? "Draft chapter 3" : "Weed the beds",
        `${date}T${String(hour).padStart(2, "0")}:00:00+10:00`,
        `${date}T${String(hour).padStart(2, "0")}:30:00+10:00`
      );
    });
    const { stdout } = await run(["summary", "--from", "2026-08-28", "--to", "2026-09-03", "--json"], {
      ...base,
      completedToday: sessions
    });
    const json = JSON.parse(stdout);
    expect(json.days).toHaveLength(7);
    expect(json.totals.focusedMinutes).toBeGreaterThan(0);
    expect(Buffer.byteLength(stdout)).toBeLessThan(8 * 1024);
  });

  it("counts two finished actions that share a title as two", async () => {
    const state = raw();
    state.completedToday = [
      session("s-a", "action-x", "Tidy", "2026-09-02T10:00:00+10:00", "2026-09-02T10:30:00+10:00"),
      session("s-b", "action-y", "Tidy", "2026-09-02T11:00:00+10:00", "2026-09-02T11:30:00+10:00")
    ];
    const json = JSON.parse(
      (await run(["summary", "--from", "2026-09-02", "--to", "2026-09-02", "--json"], state)).stdout
    );
    expect(json.days[0].actionsFinished).toEqual(["Tidy", "Tidy"]);
  });
});
