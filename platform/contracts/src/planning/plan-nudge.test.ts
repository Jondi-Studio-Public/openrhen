import { describe, expect, it } from "vitest";
import type { PlanLink } from "./plan-map.js";
import {
  NUDGE_CAPS_DAYS,
  NUDGE_POINTS_PER_DAY,
  computeNudge,
  type NudgeCandidate,
  type NudgeInput,
  type NudgeTrigger
} from "./plan-nudge.js";

const NOW = new Date("2026-10-01T00:00:00.000Z");
const inDays = (days: number) => new Date(NOW.getTime() + days * 86_400_000).toISOString();

const link = (
  kind: "about" | "prepares",
  from: [PlanLink["fromType"], string],
  to: [PlanLink["toType"], string],
  status: PlanLink["status"] = "confirmed"
): PlanLink => ({
  id: crypto.randomUUID(),
  fromType: from[0],
  fromId: from[1],
  toType: to[0],
  toId: to[1],
  kind,
  weight: null,
  status,
  proposer: "owner",
  evidence: [],
  createdAt: NOW.toISOString(),
  decidedAt: null,
  lastConfirmedAt: null
});

const candidate = (
  id: string,
  rank: number,
  totalScore: number,
  extra: Partial<NudgeCandidate> = {}
): NudgeCandidate => ({
  targetType: "action",
  targetId: id,
  title: id,
  rank,
  totalScore,
  eligible: true,
  criticalRank: 1,
  recurring: false,
  dueAt: null,
  ...extra
});

const exam: NudgeTrigger = { type: "commitment", id: "exam", title: "Maths exam", dueAt: inDays(3), kind: "exam" };

function input(overrides: Partial<NudgeInput> = {}): NudgeInput {
  return {
    now: NOW,
    ordinaryRank: 1,
    candidates: [candidate("a", 1, 60), candidate("b", 2, 58), candidate("practice", 3, 55), candidate("c", 4, 40)],
    triggers: [exam],
    links: [
      link("about", ["commitment", "exam"], ["subject", "maths"]),
      link("prepares", ["action", "practice"], ["commitment", "exam"])
    ],
    ...overrides
  };
}

const at = (results: ReturnType<typeof computeNudge>, capDays: number) => results.find((r) => r.capDays === capDays)!;

describe("computeNudge", () => {
  it("boosts what prepares an exam this week, by at most the cap, at each of the three caps", () => {
    const results = computeNudge(input());
    expect(results.map((r) => r.capDays)).toEqual([...NUDGE_CAPS_DAYS]);
    for (const result of results) {
      expect(result.capPoints).toBe(result.capDays * NUDGE_POINTS_PER_DAY);
      expect(result.boosted).toHaveLength(1);
      expect(result.boosted[0]!.boost).toBe(result.capPoints);
    }
    // 55 + 1.5 does not pass 58; 55 + 3 passes neither 60 nor 58 (58 > 58? equal is not lower); 55 + 6 passes both.
    expect(at(results, 0.5).moves).toEqual([]);
    expect(at(results, 1).moves).toEqual([]);
    const two = at(results, 2);
    expect(two.moves).toHaveLength(1);
    expect(two.moves[0]).toMatchObject({ targetId: "practice", rankBefore: 3, rankAfter: 1 });
    expect(two.moves[0]!.reason).toContain("Maths exam");
  });

  it("lifts past a lower score at one day, and names who fell", () => {
    const results = computeNudge(
      input({ candidates: [candidate("a", 1, 60), candidate("b", 2, 57), candidate("practice", 3, 55)] })
    );
    const one = at(results, 1);
    expect(one.moves[0]).toMatchObject({ targetId: "practice", rankBefore: 3, rankAfter: 2 });
    expect(one.displaced).toEqual([
      expect.objectContaining({ targetId: "b", rankBefore: 2, rankAfter: 3, dueWithinHorizon: false })
    ]);
  });

  it("flags a displaced candidate whose own project is due inside the horizon", () => {
    const results = computeNudge(
      input({
        candidates: [candidate("a", 1, 60), candidate("b", 2, 50, { dueAt: inDays(2) }), candidate("practice", 3, 49)]
      })
    );
    expect(at(results, 2).displaced).toEqual([expect.objectContaining({ targetId: "b", dueWithinHorizon: true })]);
  });

  it("never moves a deadline tier or an ineligible candidate", () => {
    const results = computeNudge(
      input({
        candidates: [
          candidate("tiered", 1, 10, { criticalRank: 0 }),
          candidate("a", 2, 60),
          candidate("practice", 3, 30, { criticalRank: 0 }),
          candidate("blocked", 4, 55, { eligible: false })
        ],
        links: [
          link("about", ["commitment", "exam"], ["subject", "maths"]),
          link("prepares", ["action", "practice"], ["commitment", "exam"]),
          link("prepares", ["action", "blocked"], ["commitment", "exam"])
        ]
      })
    );
    for (const result of results) {
      expect(result.boosted).toEqual([]);
      expect(result.moves).toEqual([]);
    }
  });

  it("ignores links that are not confirmed", () => {
    const results = computeNudge(
      input({
        links: [
          link("about", ["commitment", "exam"], ["subject", "maths"]),
          link("prepares", ["action", "practice"], ["commitment", "exam"], "suggested")
        ]
      })
    );
    expect(at(results, 2).boosted).toEqual([]);
  });

  it("falls back to recurring work about the same subject when nothing prepares the trigger", () => {
    const results = computeNudge(
      input({
        candidates: [
          candidate("a", 1, 60),
          candidate("study", 2, 40, { recurring: true }),
          candidate("other", 3, 41, { recurring: true })
        ],
        links: [
          link("about", ["commitment", "exam"], ["subject", "maths"]),
          link("about", ["action", "study"], ["subject", "maths"]),
          link("about", ["action", "other"], ["subject", "meals"])
        ]
      })
    );
    expect(at(results, 2).boosted.map((b) => b.targetId)).toEqual(["study"]);
  });

  it("does nothing for a trigger outside the horizon, without a subject, or already past", () => {
    for (const triggers of [
      [{ ...exam, dueAt: inDays(9) }],
      [{ ...exam, dueAt: inDays(-1) }],
      [{ ...exam, id: "other-exam" }]
    ]) {
      for (const result of computeNudge(input({ triggers }))) expect(result.boosted).toEqual([]);
    }
  });

  it("is deterministic and leaves its input untouched", () => {
    const frozen = input();
    const deepFreeze = (value: unknown): void => {
      if (value && typeof value === "object" && !Object.isFrozen(value)) {
        Object.freeze(value);
        Object.values(value).forEach(deepFreeze);
      }
    };
    deepFreeze(frozen);
    const first = computeNudge(frozen);
    expect(computeNudge(frozen)).toEqual(first);
    // The live ranking the caller holds is exactly what it was.
    expect(frozen.candidates.map((c) => [c.targetId, c.rank, c.totalScore])).toEqual([
      ["a", 1, 60],
      ["b", 2, 58],
      ["practice", 3, 55],
      ["c", 4, 40]
    ]);
  });
});
