import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { renderRecord, renderTable } from "../src/output.js";
import { formatClock, sameLocalDay } from "../src/when.js";
import { fakeFetch } from "./fake-fetch.js";
import { fixtureNow, fixtureRawState, fixtureTimeZone } from "./fixture-state.js";

const UTC_BREAKFAST = "2026-09-03T05:17:00.000Z";

function run(argv: string[], state: Record<string, unknown> = fixtureRawState()) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const fetchImpl = fakeFetch({
    "/api/state": { body: { state } },
    "/api/check-ins/current": { body: { checkIn: null } }
  });
  return runCli(argv, {
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
    env: {},
    readConfigFile: () => null,
    fetchImpl,
    now: () => fixtureNow
  }).then((code) => ({ code, stdout: stdout.join("\n"), stderr: stderr.join("\n") }));
}

describe("local time in human output", () => {
  it("formats an instant as a full local wall-clock time", () => {
    expect(formatClock(UTC_BREAKFAST, fixtureTimeZone)).toBe("2026-09-03 15:17");
    expect(formatClock("garbage", fixtureTimeZone)).toBe("garbage");
  });

  it("decides same-day in the planning timezone, not UTC", () => {
    // 23:30 local on the 2nd is 13:30 UTC on the 2nd; 00:30 local on the 3rd is 14:30 UTC on the 2nd.
    expect(sameLocalDay(new Date("2026-09-02T13:30:00Z"), fixtureNow, fixtureTimeZone)).toBe(false);
    expect(sameLocalDay(new Date("2026-09-02T14:30:00Z"), fixtureNow, fixtureTimeZone)).toBe(true);
  });

  it("localises table cells and record values only when a timezone is given", () => {
    const rows = [{ id: "row-1", startsAt: UTC_BREAKFAST }];
    expect(renderTable(rows, ["id", "startsAt"], { timeZone: fixtureTimeZone })).toContain("2026-09-03 15:17");
    expect(renderTable(rows, ["id", "startsAt"])).toContain(UTC_BREAKFAST);
    expect(renderRecord({ endsAt: UTC_BREAKFAST }, { timeZone: fixtureTimeZone })).toContain("2026-09-03 15:17");
    expect(renderRecord({ endsAt: UTC_BREAKFAST })).toContain(UTC_BREAKFAST);
  });

  it("shows local times in tables, and rewrites JSON instants to the same zone's own offset", async () => {
    const table = await run(["list", "commitments", "--search", "gym"]);
    expect(table.stdout).toContain("2026-09-03 17:00");
    const json = await run(["list", "commitments", "--search", "gym", "--json"]);
    // The fixture already stores this instant in +10:00, so this alone would pass even if JSON were
    // left untouched (localising an already-local offset is a no-op) — the next test proves the rewrite.
    expect(JSON.parse(json.stdout)[0].startsAt).toBe("2026-09-03T17:00:00+10:00");
  });

  it("rewrites a UTC 'Z' instant to the local offset in list/show/status JSON, but leaves `state`'s raw dump alone", async () => {
    const state = fixtureRawState();
    const commitments = state.commitments as Record<string, unknown>[];
    const gym = commitments.find((commitment) => commitment.id === "commitment-gym") as Record<string, unknown>;
    gym.startsAt = "2026-09-03T07:00:00Z"; // 17:00 in Australia/Sydney

    const list = await run(["list", "commitments", "--search", "gym", "--json"], state);
    expect(JSON.parse(list.stdout)[0].startsAt).toBe("2026-09-03T17:00:00+10:00");

    const show = await run(["show", "commitment", "commitment-gym", "--json"], state);
    const doc = JSON.parse(show.stdout) as { item: { startsAt: string } };
    expect(doc.item.startsAt).toBe("2026-09-03T17:00:00+10:00");

    const raw = await run(["state", "--key", "commitments"], state);
    const rawCommitments = JSON.parse(raw.stdout) as { id: string; startsAt: string }[];
    expect(rawCommitments.find((commitment) => commitment.id === "commitment-gym")?.startsAt).toBe(
      "2026-09-03T07:00:00Z"
    );
  });

  it("status --json carries the timezone and a local-offset `now`", async () => {
    const result = await run(["status", "--json"]);
    const summary = JSON.parse(result.stdout) as { now: string; timezone: string };
    expect(summary.timezone).toBe(fixtureTimeZone);
    expect(summary.now).toMatch(/[+-]\d{2}:\d{2}$/);
    expect(summary.now).not.toMatch(/Z$/);
  });
});

describe("status counts only sessions that ended today", () => {
  it("drops history from earlier days and keeps today's", async () => {
    const state = fixtureRawState();
    const sessions = state.completedToday as Record<string, unknown>[];
    sessions.push({
      ...sessions[0],
      id: "session-yesterday",
      actionId: "action-draft",
      actionTitle: "Draft chapter 3",
      startedAt: "2026-09-02T08:00:00+10:00",
      endedAt: "2026-09-02T08:30:00+10:00"
    });
    const result = await run(["status", "--json"], state);
    expect(result.code).toBe(0);
    const summary = JSON.parse(result.stdout);
    expect(summary.doneToday.map((item: { id: string }) => item.id)).toEqual(["session-email"]);
    // Yesterday's completed session on the draft must not mark today's plan item done.
    const draft = summary.today.items.find((item: { actionId: string }) => item.actionId === "action-draft");
    expect(draft.done).toBe(false);
  });
});
