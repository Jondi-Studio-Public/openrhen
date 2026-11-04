import { describe, expect, it } from "vitest";
import {
  agentTimeLine,
  formatMinutes,
  ingestAgentSessionsSchema,
  sessionsFromTheFuture,
  summariseAgentTime,
  unionMs
} from "./agent-sessions.js";

const at = (hhmm: string) => new Date(`2026-10-26T${hhmm}:00.000Z`);
const session = (agent: string, from: string, to: string, topics: string[] = []) => ({
  agent,
  startedAt: at(from),
  endedAt: at(to),
  topics
});
const minuteMs = 60_000;

describe("unionMs", () => {
  it("counts overlapping and touching intervals once and ignores empty ones", () => {
    expect(
      unionMs([
        [0, 10 * minuteMs],
        [5 * minuteMs, 20 * minuteMs],
        [20 * minuteMs, 30 * minuteMs],
        [50 * minuteMs, 50 * minuteMs]
      ])
    ).toBe(30 * minuteMs);
    expect(unionMs([])).toBe(0);
  });
});

describe("summariseAgentTime", () => {
  const windowStart = at("00:00");
  const windowEnd = at("23:59");

  it("counts a reported conversation and the calls inside it once", () => {
    const summary = summariseAgentTime(
      [session("openclaw", "09:00", "10:00", ["OpenRhen build"]), session("openclaw", "09:10", "09:40")],
      windowStart,
      windowEnd
    );
    expect(summary.totalMinutes).toBe(60);
    expect(summary.agents).toEqual([{ agent: "openclaw", minutes: 60, sessions: 2 }]);
  });

  it("totals the union across agents while each agent keeps its own figure", () => {
    const summary = summariseAgentTime(
      [session("openclaw", "09:00", "10:00"), session("claude-code", "09:30", "10:30")],
      windowStart,
      windowEnd
    );
    expect(summary.totalMinutes).toBe(90);
    expect(summary.agents.map((agent) => [agent.agent, agent.minutes])).toEqual([
      ["claude-code", 60],
      ["openclaw", 60]
    ]);
  });

  it("clips to the window and drops sessions outside it", () => {
    const summary = summariseAgentTime(
      [session("a", "08:00", "10:00"), session("b", "20:00", "21:00")],
      at("09:00"),
      at("12:00")
    );
    expect(summary.totalMinutes).toBe(60);
    expect(summary.agents.map((agent) => agent.agent)).toEqual(["a"]);
  });

  it("merges topics that differ only in case and ranks them by minutes", () => {
    const summary = summariseAgentTime(
      [session("a", "09:00", "10:00", ["Lockdown"]), session("a", "11:00", "11:20", ["lockdown", "Email"])],
      windowStart,
      windowEnd
    );
    expect(summary.topics).toEqual([
      { topic: "Lockdown", minutes: 80 },
      { topic: "Email", minutes: 20 }
    ]);
  });
});

describe("the Review line", () => {
  const empty = summariseAgentTime([], at("00:00"), at("23:00"));
  it("formats minutes", () => {
    expect([0, 35, 120, 250].map(formatMinutes)).toEqual(["0m", "35m", "2h", "4h 10m"]);
  });
  it("says nothing was recorded rather than going quiet", () => {
    expect(agentTimeLine(empty)).toBe("Agent time, last 7 days: none recorded.");
  });
  it("names the one agent, or the busiest of several, and the top topic", () => {
    const one = summariseAgentTime([session("openclaw", "09:00", "10:00")], at("00:00"), at("23:00"));
    expect(agentTimeLine(one)).toBe("Agent time, last 7 days: 1h with openclaw.");
    const many = summariseAgentTime(
      [session("openclaw", "09:00", "10:00", ["build"]), session("claude-code", "11:00", "11:30")],
      at("00:00"),
      at("23:00")
    );
    expect(agentTimeLine(many)).toBe("Agent time, last 7 days: 1h 30m, mostly openclaw (1h); top topic: build.");
  });
});

describe("the ingest schema", () => {
  const valid = { id: "oc-1", startedAt: "2026-10-26T09:00:00Z", endedAt: "2026-10-26T20:00:00+10:00" };

  it("defaults kind and topics and ignores properties it does not know", () => {
    const parsed = ingestAgentSessionsSchema.parse({ schemaVersion: 1, sessions: [{ ...valid, extra: true }] });
    expect(parsed.sessions[0]).toEqual({ ...valid, kind: "conversation", topics: [] });
  });

  it("refuses another schema version, an empty or oversized batch and bad ids", () => {
    const bad = [
      { schemaVersion: 2, sessions: [valid] },
      { schemaVersion: 1, sessions: [] },
      { schemaVersion: 1, sessions: Array.from({ length: 101 }, (_, i) => ({ ...valid, id: `s${i}` })) },
      { schemaVersion: 1, sessions: [{ ...valid, id: "has space" }] },
      { schemaVersion: 1, sessions: [{ ...valid, id: "x".repeat(129) }] }
    ];
    for (const body of bad)
      expect(ingestAgentSessionsSchema.safeParse(body).success, JSON.stringify(body).slice(0, 60)).toBe(false);
  });

  it("refuses an end before the start and a span over 24 hours", () => {
    const run = (startedAt: string, endedAt: string) =>
      ingestAgentSessionsSchema.safeParse({ schemaVersion: 1, sessions: [{ ...valid, startedAt, endedAt }] }).success;
    expect(run("2026-10-26T10:00:00Z", "2026-10-26T09:00:00Z")).toBe(false);
    expect(run("2026-10-25T09:00:00Z", "2026-10-26T09:00:01Z")).toBe(false);
    expect(run("2026-10-25T09:00:00Z", "2026-10-26T09:00:00Z")).toBe(true);
  });

  it("limits titles, summaries and topics", () => {
    const run = (extra: Record<string, unknown>) =>
      ingestAgentSessionsSchema.safeParse({ schemaVersion: 1, sessions: [{ ...valid, ...extra }] }).success;
    expect(run({ title: "x".repeat(121) })).toBe(false);
    expect(run({ summary: "x".repeat(501) })).toBe(false);
    expect(run({ topics: Array.from({ length: 9 }, (_, i) => `t${i}`) })).toBe(false);
    expect(run({ turns: -1 })).toBe(false);
    expect(run({ title: "ok", summary: "ok", topics: ["a"], turns: 3, kind: "work" })).toBe(true);
  });

  it("finds sessions that end more than five minutes after now", () => {
    const sessions = ingestAgentSessionsSchema.parse({
      schemaVersion: 1,
      sessions: [valid, { ...valid, id: "late", endedAt: "2026-10-26T10:07:00Z" }]
    }).sessions;
    expect(sessionsFromTheFuture(sessions, new Date("2026-10-26T10:00:00Z"))).toEqual([1]);
  });
});
