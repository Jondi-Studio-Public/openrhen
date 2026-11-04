import { describe, expect, it } from "vitest";
import {
  DIGEST_BODY_MAX,
  REVIEWER_MIN_INTERVAL_DAYS,
  composeDigest,
  reviewerDedupeKey,
  reviewerDue,
  type ReviewerInput
} from "./plan-reviewer.js";

const empty: ReviewerInput = {
  findings: { openByCheck: [], topOpen: [], acceptedThisWeek: 0, dismissedThisWeek: 0 },
  links: { waiting: 0, confirmedThisWeek: 0, rejectedThisWeek: 0 },
  nudge: [0.5, 1, 2].map((capDays) => ({
    capDays: capDays as 0.5 | 1 | 2,
    runs: 0,
    actionsMoved: 0,
    placesGained: 0,
    movedThenDone: 0,
    displaced: 0,
    slippedDue: 0
  })),
  explorer: []
};

describe("composeDigest", () => {
  it("is quiet when nothing happened", () => {
    const digest = composeDigest(empty);
    expect(digest.quiet).toBe(true);
    expect(digest.lines).toEqual([]);
    expect(digest.body).toBe("");
  });

  it("summarises findings, links, nudge and explorer in a few lines", () => {
    const digest = composeDigest({
      findings: {
        openByCheck: [
          { check: "unit-code", count: 2 },
          { check: "duplicate", count: 1 }
        ],
        topOpen: ["QRSTUV272 has no project", "Two captures look the same"],
        acceptedThisWeek: 1,
        dismissedThisWeek: 0
      },
      links: { waiting: 5, confirmedThisWeek: 2, rejectedThisWeek: 1 },
      nudge: empty.nudge.map((cap, index) => ({
        ...cap,
        runs: 7,
        actionsMoved: [2, 4, 6][index]!,
        movedThenDone: [1, 3, 4][index]!,
        slippedDue: index === 2 ? 1 : 0
      })),
      explorer: [
        {
          backend: "haiku",
          runs: 12,
          scored: 8,
          meanF1: 0.82,
          meanTokens: 4100,
          meanCalls: 5,
          meanMs: 900,
          incomplete: 0,
          failed: 0
        },
        {
          backend: "local",
          runs: 12,
          scored: 8,
          meanF1: null,
          meanTokens: 800,
          meanCalls: 6,
          meanMs: 4000,
          incomplete: 1,
          failed: 0
        }
      ]
    });
    expect(digest.quiet).toBe(false);
    expect(digest.lines).toEqual([
      "3 open findings (2 unit-code, 1 duplicate); 1 accepted, 0 dismissed this week.",
      "• QRSTUV272 has no project",
      "• Two captures look the same",
      "5 suggested links waiting; 2 confirmed, 1 rejected this week.",
      "Nudge (0.5/1/2 day caps, shadow): 2/4/6 actions moved, 1/3/4 later done; 1 due item displaced.",
      "Explorer: haiku F1 0.82, 4.1k tokens, 12 runs; local no score, 800 tokens, 12 runs."
    ]);
    expect(digest.body).toBe(digest.lines.join("\n"));
  });

  it("says no due item was displaced, and uses the singular", () => {
    const digest = composeDigest({
      ...empty,
      findings: { ...empty.findings, openByCheck: [{ check: "duplicate", count: 1 }] },
      nudge: empty.nudge.map((cap) => ({ ...cap, runs: 1, actionsMoved: 1 }))
    });
    expect(digest.lines[0]).toBe("1 open finding (1 duplicate); 0 accepted, 0 dismissed this week.");
    expect(digest.lines[1]).toContain("no due item displaced");
  });

  it("shortens a long finding and caps the body", () => {
    const long = "x".repeat(300);
    const digest = composeDigest({
      ...empty,
      findings: { ...empty.findings, openByCheck: [{ check: "a", count: 1 }], topOpen: [long, long] }
    });
    expect(digest.lines[1]!.length).toBeLessThanOrEqual(72);
    expect(digest.lines[1]!.endsWith("…")).toBe(true);
    const crowded = composeDigest({
      ...empty,
      findings: {
        ...empty.findings,
        openByCheck: [{ check: "a", count: 1 }],
        topOpen: ["y".repeat(70), "y".repeat(70)]
      },
      links: { waiting: 1, confirmedThisWeek: 1, rejectedThisWeek: 1 },
      nudge: empty.nudge.map((cap) => ({ ...cap, runs: 1 })),
      explorer: Array.from({ length: 2 }, (_, i) => ({
        backend: i === 0 ? ("haiku" as const) : ("local" as const),
        runs: 1,
        scored: 1,
        meanF1: 1,
        meanTokens: 1,
        meanCalls: 1,
        meanMs: 1,
        incomplete: 0,
        failed: 0
      }))
    });
    expect(crowded.body.length).toBeLessThanOrEqual(DIGEST_BODY_MAX);
  });
});

describe("reviewerDue", () => {
  const now = new Date("2026-10-08T01:00:00.000Z");
  it("is due with no digest yet", () => expect(reviewerDue(null, now)).toBe(true));
  it("waits until the interval has passed", () => {
    const day = 86_400_000;
    expect(reviewerDue(new Date(now.getTime() - (REVIEWER_MIN_INTERVAL_DAYS - 1) * day), now)).toBe(false);
    expect(reviewerDue(new Date(now.getTime() - REVIEWER_MIN_INTERVAL_DAYS * day), now)).toBe(true);
  });
  it("keys the push by UTC date", () => expect(reviewerDedupeKey(now)).toBe("plan_digest:2026-10-08"));
});
