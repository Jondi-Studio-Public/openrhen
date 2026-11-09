import { describe, expect, it } from "vitest";
import {
  DRIFT_COLLAPSE_WINDOW_MINUTES,
  DRIFT_SIGNALS,
  DRIFT_TYPES,
  countDriftEpisodes,
  detectDriftEpisodes,
  type DriftCheckInRow,
  type DriftSessionRow
} from "./drift-episodes.js";

const at = (minutes: number): Date => new Date(Date.UTC(2026, 0, 5, 9, 0, 0) + minutes * 60_000);

const session = (overrides: Partial<DriftSessionRow> = {}): DriftSessionRow => ({
  id: "s1",
  status: "completed",
  startedAt: at(0),
  startedRecordedAt: null,
  endedAt: at(30),
  endedRecordedAt: null,
  planSanction: null,
  createdAt: at(0),
  ...overrides
});

const checkIn = (overrides: Partial<DriftCheckInRow> = {}): DriftCheckInRow => ({
  id: "c1",
  status: "deviated",
  answeredAt: at(120),
  answerSource: "in_app_banner",
  answeredBy: null,
  ...overrides
});

describe("detectDriftEpisodes: unsanctioned sessions", () => {
  it("makes one pinned episode of a session with no sanction, with its end as extra evidence", () => {
    const episodes = detectDriftEpisodes({ checkIns: [], sessions: [session()] });
    expect(episodes).toHaveLength(1);
    expect(episodes[0]).toMatchObject({ id: "unsanctioned_session:s1", type: "unsanctioned_session", pinned: true });
    expect(episodes[0]?.occurredAt).toEqual(at(0));
    expect(episodes[0]?.evidence.map((item) => item.signal)).toEqual(["session_started", "session_ended"]);
  });

  it("skips sanctioned sessions and sessions that never started", () => {
    const rows = [
      session({ id: "a", planSanction: "directive" }),
      session({ id: "b", planSanction: "free" }),
      session({ id: "c", status: "planned", startedAt: null, endedAt: null })
    ];
    expect(detectDriftEpisodes({ checkIns: [], sessions: rows })).toEqual([]);
  });

  it("skips rows created before the legacy cut, where a null sanction only means the column did not exist", () => {
    const old = session({ id: "old", createdAt: at(-60 * 24) });
    expect(detectDriftEpisodes({ checkIns: [], sessions: [old], legacyBefore: at(-60) })).toEqual([]);
    expect(detectDriftEpisodes({ checkIns: [], sessions: [old] })).toHaveLength(1);
  });

  it("does not pin a backdated session and reports when the system knew", () => {
    const backdated = session({ startedAt: at(0), startedRecordedAt: at(20), endedAt: null });
    const [episode] = detectDriftEpisodes({ checkIns: [], sessions: [backdated] });
    expect(episode?.pinned).toBe(false);
    expect(episode?.occurredAt).toEqual(at(0));
    expect(episode?.knownAt).toEqual(at(20));
  });

  it("takes a later recorded end as when the drift was known", () => {
    const [episode] = detectDriftEpisodes({ checkIns: [], sessions: [session({ endedRecordedAt: at(90) })] });
    expect(episode?.knownAt).toEqual(at(90));
    expect(episode?.pinned).toBe(false);
  });

  it("counts a session still running", () => {
    const running = session({ status: "running", endedAt: null });
    expect(detectDriftEpisodes({ checkIns: [], sessions: [running] })).toHaveLength(1);
  });
});

describe("detectDriftEpisodes: deviated check-ins", () => {
  it("makes an unpinned episode of a deviated answer given outside a session", () => {
    const [episode] = detectDriftEpisodes({ checkIns: [checkIn()], sessions: [] });
    expect(episode).toMatchObject({ id: "deviated_checkin:c1", type: "deviated_checkin", pinned: false });
    expect(episode?.occurredAt).toEqual(at(120));
  });

  it("handles each answer source", () => {
    const answered = (answerSource: string | null, answeredBy: string | null = null) =>
      detectDriftEpisodes({ checkIns: [checkIn({ answerSource, answeredBy })], sessions: [] }).length;
    expect(answered("in_app_banner")).toBe(1);
    expect(answered("sheet")).toBe(1);
    expect(answered("push_action")).toBe(1);
    expect(answered(null)).toBe(1);
    expect(answered("session_reconciliation")).toBe(0);
    expect(answered("sheet", "agent-a")).toBe(0);
  });

  it("ignores every status but deviated, and an unanswered row", () => {
    for (const status of ["pending", "on_track", "unknown", "superseded"])
      expect(detectDriftEpisodes({ checkIns: [checkIn({ status })], sessions: [] })).toEqual([]);
    expect(detectDriftEpisodes({ checkIns: [checkIn({ answeredAt: null })], sessions: [] })).toEqual([]);
  });

  it("counts nothing for a deviated answer given inside a running session", () => {
    const covering = session({ id: "s2", planSanction: "directive", startedAt: at(100), endedAt: at(150) });
    expect(detectDriftEpisodes({ checkIns: [checkIn()], sessions: [covering] })).toEqual([]);
    const open = session({ id: "s3", planSanction: "directive", status: "running", startedAt: at(100), endedAt: null });
    expect(detectDriftEpisodes({ checkIns: [checkIn()], sessions: [open] })).toEqual([]);
  });
});

describe("detectDriftEpisodes: collapse", () => {
  it("folds a deviated answer just after an unsanctioned session into that session's episode", () => {
    const rows = detectDriftEpisodes({
      checkIns: [checkIn({ answeredAt: at(30 + DRIFT_COLLAPSE_WINDOW_MINUTES - 1) })],
      sessions: [session()]
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe("unsanctioned_session");
    expect(rows[0]?.evidence.map((item) => item.signal)).toEqual([
      "session_started",
      "session_ended",
      "checkin_deviated"
    ]);
  });

  it("folds a deviated answer just before the session starts", () => {
    const rows = detectDriftEpisodes({ checkIns: [checkIn({ answeredAt: at(-3) })], sessions: [session()] });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.pinned).toBe(true);
  });

  it("keeps a distant check-in as its own episode, in time order", () => {
    const rows = detectDriftEpisodes({
      checkIns: [checkIn({ answeredAt: at(30 + DRIFT_COLLAPSE_WINDOW_MINUTES + 1) })],
      sessions: [session()]
    });
    expect(rows.map((row) => row.type)).toEqual(["unsanctioned_session", "deviated_checkin"]);
  });

  it("is deterministic and does not change its input", () => {
    const input = { checkIns: [checkIn()], sessions: [session()] };
    const before = JSON.stringify(input);
    expect(detectDriftEpisodes(input)).toEqual(detectDriftEpisodes(input));
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe("detectDriftEpisodes: window", () => {
  it("keeps episodes that occurred inside [from, to) but still collapses with rows outside it", () => {
    const input = { checkIns: [checkIn({ answeredAt: at(-3) })], sessions: [session()] };
    expect(detectDriftEpisodes({ ...input, window: { from: at(-10), to: at(10) } })).toHaveLength(1);
    expect(detectDriftEpisodes({ ...input, window: { from: at(1), to: at(10) } })).toEqual([]);
    expect(detectDriftEpisodes({ ...input, window: { from: at(-10), to: at(0) } })).toEqual([]);
  });
});

describe("countDriftEpisodes", () => {
  it("counts episodes per primary type and pinned, with per-signal counts beside them", () => {
    const episodes = detectDriftEpisodes({
      checkIns: [checkIn({ answeredAt: at(35) }), checkIn({ id: "c2", answeredAt: at(150) })],
      sessions: [session(), session({ id: "s9", startedAt: at(200), startedRecordedAt: at(230), endedAt: null })]
    });
    const counts = countDriftEpisodes(episodes);
    expect(counts.episodes).toBe(3);
    expect(counts.pinned).toBe(1);
    expect(counts.byType.unsanctioned_session).toEqual({ episodes: 2, pinned: 1 });
    expect(counts.byType.deviated_checkin).toEqual({ episodes: 1, pinned: 0 });
    expect(counts.bySignal).toEqual({ checkin_deviated: 2, session_started: 2, session_ended: 1 });
  });

  it("lists every type and signal even when empty", () => {
    const counts = countDriftEpisodes([]);
    expect(Object.keys(counts.byType)).toEqual([...DRIFT_TYPES]);
    expect(Object.keys(counts.bySignal)).toEqual([...DRIFT_SIGNALS]);
    expect(counts.episodes).toBe(0);
  });
});
