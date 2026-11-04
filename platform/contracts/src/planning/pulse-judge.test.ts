import { describe, expect, it } from "vitest";
import { judgePulse, type JudgePulseInput, type PulseTarget } from "./pulse-judge.js";

const NOW = new Date("2026-09-26T14:00:00.000Z");

const action: PulseTarget = { kind: "action", id: "action-1", title: "Sort the bedroom floor" };
const commitment: PulseTarget = { kind: "commitment", id: "commitment-1", title: "Dinner" };
const step: PulseTarget = { kind: "step", id: "step-1", title: "Pack bag" };
const sleep: PulseTarget = { kind: "sleep", id: "sleep-1", title: "Tonight" };
const journey: PulseTarget = { kind: "journey", id: "journey-1", title: "Drive to the office" };

function baseInput(overrides: Partial<JudgePulseInput> = {}): JudgePulseInput {
  return {
    now: NOW,
    directive: null,
    dayPlanBlocks: [],
    protectedInForce: [],
    session: null,
    checkIns: [],
    arrival: null,
    underway: null,
    sleep: { state: "awake" },
    privateTargets: new Set(),
    ...overrides
  };
}

describe("judgePulse: free time (Q1)", () => {
  it.each(["none", "boundary", "answer", "recovery"])(
    "is free when the directive is %s and nothing else is sanctioned",
    (kind) => {
      const judgement = judgePulse(baseInput({ directive: { kind } }));
      expect(judgement.state).toBe("free");
      expect(judgement.reason).toBe("free");
    }
  );

  it("is not free when a protected block is in force even with a free directive", () => {
    const judgement = judgePulse(baseInput({ directive: { kind: "none" }, protectedInForce: [commitment] }));
    expect(judgement.state).toBe("off");
    expect(judgement.expected).toEqual(commitment);
  });

  it("a session started in free time stays free, not off plan", () => {
    const judgement = judgePulse(
      baseInput({
        directive: { kind: "none" },
        session: { target: action, sanction: "free", sanctionedUntil: null, startedAt: NOW }
      })
    );
    expect(judgement.state).toBe("free");
    expect(judgement.doing).toEqual(action);
  });
});

describe("judgePulse: on plan via a directive or protected block (P1)", () => {
  it("on plan when a check-in confirms the directive's action target", () => {
    const judgement = judgePulse(
      baseInput({
        directive: { kind: "action", targetId: action.id, title: action.title },
        checkIns: [{ target: action, slotAt: NOW, status: "on_track", answeredAt: NOW }]
      })
    );
    expect(judgement.state).toBe("on");
    expect(judgement.reason).toBe("confirmed");
    expect(judgement.doing).toEqual(action);
  });

  it("a protected commitment in force is expected, off/unconfirmed with nothing confirming it", () => {
    const judgement = judgePulse(baseInput({ protectedInForce: [commitment] }));
    expect(judgement.state).toBe("off");
    expect(judgement.reason).toBe("unconfirmed");
    expect(judgement.expected).toEqual(commitment);
  });

  it("an arrival confirms a located commitment", () => {
    const judgement = judgePulse(
      baseInput({ protectedInForce: [commitment], arrival: { target: commitment, at: NOW } })
    );
    expect(judgement.state).toBe("on");
    expect(judgement.confirmedAt).toEqual(NOW);
  });

  it("underway confirms a journey", () => {
    const judgement = judgePulse(
      baseInput({
        directive: { kind: "travel", targetId: journey.id, title: journey.title },
        underway: { target: journey, at: NOW }
      })
    );
    expect(judgement.state).toBe("on");
    expect(judgement.doing).toEqual(journey);
  });

  it("a sleeping night is asleep", () => {
    const judgement = judgePulse(baseInput({ protectedInForce: [sleep], sleep: { state: "sleeping" } }));
    expect(judgement.state).toBe("asleep");
  });
});

describe('judgePulse: sleep precedence (Decision "Sleep")', () => {
  it("a sleeping night whose own sleep session is running is asleep, not on plan", () => {
    // Starting sleep sets the plan to `sleeping` AND opens a `sleep`-target session sanctioned as a
    // day_plan_block until the planned wake — this is the tracked-night bug: without the fix this
    // read "on/confirmed: sleep" all night instead of "asleep".
    const judgement = judgePulse(
      baseInput({
        protectedInForce: [sleep],
        sleep: { state: "sleeping" },
        session: {
          target: sleep,
          sanction: "day_plan_block",
          sanctionedUntil: new Date(NOW.getTime() + 8 * 60 * 60_000),
          startedAt: NOW
        }
      })
    );
    expect(judgement.state).toBe("asleep");
    expect(judgement.reason).toBe("asleep");
  });

  it("a planned night with a non-sleep session running is judged by that session", () => {
    const judgement = judgePulse(
      baseInput({
        protectedInForce: [sleep],
        sleep: { state: "planned" },
        session: { target: action, sanction: "directive", sanctionedUntil: null, startedAt: NOW }
      })
    );
    expect(judgement.state).toBe("on");
    expect(judgement.reason).toBe("confirmed");
    expect(judgement.doing).toEqual(action);
  });

  it("a planned night with no session is not asleep: bedtime passing is not going to bed", () => {
    const judgement = judgePulse(baseInput({ protectedInForce: [sleep], sleep: { state: "planned" } }));
    expect(judgement.state).not.toBe("asleep");
    expect(judgement.reason).not.toBe("asleep");
    expect(judgement.state).toBe("off");
    expect(judgement.reason).toBe("unconfirmed");
    expect(judgement.expected).toEqual(sleep);
  });

  it("a planned night whose own sleep session is running is asleep", () => {
    const judgement = judgePulse(
      baseInput({
        protectedInForce: [sleep],
        sleep: { state: "planned" },
        session: { target: sleep, sanction: "day_plan_block", sanctionedUntil: null, startedAt: NOW }
      })
    );
    expect(judgement.state).toBe("asleep");
  });
});

describe("judgePulse: lapses", () => {
  it("deviated check-in on the expected target is off/deviated", () => {
    const judgement = judgePulse(
      baseInput({
        directive: { kind: "action", targetId: action.id },
        checkIns: [{ target: action, slotAt: NOW, status: "deviated", answeredAt: NOW }]
      })
    );
    expect(judgement.state).toBe("off");
    expect(judgement.reason).toBe("deviated");
  });

  it("unknown (unanswered past timeout) is off whenever something is expected", () => {
    const judgement = judgePulse(
      baseInput({
        directive: { kind: "action", targetId: action.id },
        checkIns: [{ target: action, slotAt: NOW, status: "unknown", answeredAt: null }]
      })
    );
    expect(judgement.state).toBe("off");
    expect(judgement.reason).toBe("unconfirmed");
  });
});

describe("judgePulse: self-started sessions (Q2)", () => {
  it("a session started as the directive holds on plan until sanctionedUntil", () => {
    const until = new Date(NOW.getTime() + 30 * 60_000);
    const judgement = judgePulse(
      baseInput({
        session: { target: action, sanction: "directive", sanctionedUntil: until, startedAt: NOW }
      })
    );
    expect(judgement.state).toBe("on");
    expect(judgement.reason).toBe("confirmed");
  });

  it("a session started as an alternative is on plan with no covering block", () => {
    const until = new Date(NOW.getTime() + 15 * 60_000);
    const judgement = judgePulse(
      baseInput({
        session: { target: action, sanction: "alternative", sanctionedUntil: until, startedAt: NOW }
      })
    );
    expect(judgement.state).toBe("on");
  });

  it("overran once past sanctionedUntil", () => {
    const past = new Date(NOW.getTime() - 5 * 60_000);
    const judgement = judgePulse(
      baseInput({
        session: { target: action, sanction: "directive", sanctionedUntil: past, startedAt: NOW }
      })
    );
    expect(judgement.state).toBe("off");
    expect(judgement.reason).toBe("overran");
  });

  it("a continuation extends the sanctioned window", () => {
    const extended = new Date(NOW.getTime() + 45 * 60_000);
    const judgement = judgePulse(
      baseInput({
        session: { target: action, sanction: "continuation", sanctionedUntil: extended, startedAt: NOW }
      })
    );
    expect(judgement.state).toBe("on");
  });

  it("a NULL (legacy) sanction is judged live against what the plan currently sanctions", () => {
    const onPlan = judgePulse(
      baseInput({
        directive: { kind: "action", targetId: action.id },
        session: { target: action, sanction: null, sanctionedUntil: null, startedAt: NOW }
      })
    );
    expect(onPlan.state).toBe("on");

    const offPlan = judgePulse(
      baseInput({
        directive: { kind: "action", targetId: "some-other-action" },
        session: { target: action, sanction: null, sanctionedUntil: null, startedAt: NOW }
      })
    );
    expect(offPlan.state).toBe("off");
    expect(offPlan.reason).toBe("unsanctioned");
  });

  it("a day_plan_block sanction goes off plan once no longer covered", () => {
    const judgement = judgePulse(
      baseInput({
        session: {
          target: step,
          sanction: "day_plan_block",
          sanctionedUntil: new Date(NOW.getTime() - 1000),
          startedAt: NOW
        }
      })
    );
    expect(judgement.state).toBe("off");
    expect(judgement.reason).toBe("overran");
  });
});

describe("judgePulse: privacy", () => {
  it("marks doing private when the target is in privateTargets, and still counts on plan", () => {
    const judgement = judgePulse(
      baseInput({
        session: { target: action, sanction: "directive", sanctionedUntil: null, startedAt: NOW },
        privateTargets: new Set(["action:action-1"])
      })
    );
    expect(judgement.state).toBe("on");
    expect(judgement.private).toBe(true);
  });

  it("private false when the target is not in privateTargets", () => {
    const judgement = judgePulse(
      baseInput({ session: { target: action, sanction: "directive", sanctionedUntil: null, startedAt: NOW } })
    );
    expect(judgement.private).toBe(false);
  });
});

describe("judgePulse: day-plan block vs. a stale stored directive", () => {
  it("resolves a covering block's own target when it differs from the stored directive's", () => {
    // The stored directive is `blocks[0]`'s by construction and can go stale once `now` has moved
    // into a later block without a fresh plan calculation landing (a protected commitment's own
    // directive kind is `none`, carrying no target at all, is the other way this diverges). Without
    // resolving the block's own target, `sanctionedTarget` would fall back to the stale directive and
    // this would read off/unconfirmed with no `expected` at all.
    const judgement = judgePulse(
      baseInput({
        directive: { kind: "action", targetId: "some-other-action", title: "Stale directive" },
        dayPlanBlocks: [
          {
            kind: "deliverable",
            targetId: "deliverable-9",
            title: "Ship the release notes",
            startsAt: new Date(NOW.getTime() - 60_000).toISOString(),
            endsAt: new Date(NOW.getTime() + 60_000).toISOString()
          }
        ]
      })
    );
    expect(judgement.state).toBe("off");
    expect(judgement.reason).toBe("unconfirmed");
    expect(judgement.expected).toEqual({ kind: "deliverable", id: "deliverable-9", title: "Ship the release notes" });
  });
});

describe("judgePulse: nothing sanctioned and nothing confirmed", () => {
  it("off/unconfirmed with no directive, no protected block, and a non-free directive kind missing", () => {
    const judgement = judgePulse(baseInput({ directive: { kind: "action", targetId: action.id } }));
    expect(judgement.state).toBe("off");
    expect(judgement.reason).toBe("unconfirmed");
    expect(judgement.expected).toEqual({ kind: "action", id: action.id, title: "" });
  });
});
