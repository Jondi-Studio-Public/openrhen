import { describe, expect, it } from "vitest";
import type { PlanForecastResponse } from "@openrhen/contracts";
import {
  buildChangeLogRow,
  changedFieldsBefore,
  currentEngineResultIncludesActivity,
  deriveSessionSanction,
  explainActivityRefusal,
  explainCommitmentActivityRefusal,
  explainContinuationRefusal,
  planForecastStanding
} from "./planning-evidence";

const iso = (minutes: number) => new Date(Date.UTC(2026, 7, 18, 10, 0, 0) + minutes * 60_000).toISOString();

const baseResult = (protectedCommitment: Record<string, unknown> | null): PlanForecastResponse => ({
  contractVersion: "1",
  requestId: "11111111-1111-1111-1111-111111111111",
  inputVersion: "v1",
  engineVersion: "test",
  calculatedAt: iso(0),
  validUntil: iso(120),
  derivedState: {
    sleepPlans: [],
    occurrences: [],
    routineSteps: [],
    commitmentRepeats: [],
    stepPlacements: []
  },
  schedule: [],
  recommendation: (protectedCommitment ? { protectedCommitment } : {}) as PlanForecastResponse["recommendation"],
  currentDirective: { kind: "none", title: "Nothing", recommendedMinutes: 0 },
  upcomingDirectives: [],
  continuation: null,
  softPlacements: []
});

const resultWithOpenAnchor = (openAnchor: Record<string, unknown> | null): PlanForecastResponse => ({
  ...baseResult(null),
  recommendation: (openAnchor ? { openAnchor } : {}) as PlanForecastResponse["recommendation"]
});

describe("buildChangeLogRow", () => {
  const jobEvidence = { recommendationId: "rec-1", inputVersion: "v2" };

  it("merges the caller's evidence with the job's recommendationId and inputVersion", () => {
    const row = buildChangeLogRow(
      {
        entityType: "current_situation",
        entityId: "place-1",
        operation: "observe",
        evidence: { source: "phone", previousLocationId: "place-0" },
        commandId: "cmd-1",
        at: new Date("2026-09-26T00:00:00Z")
      },
      jobEvidence,
      null
    );
    expect(row.evidence).toEqual({
      source: "phone",
      previousLocationId: "place-0",
      recommendationId: "rec-1",
      inputVersion: "v2"
    });
    expect(row.entityType).toBe("current_situation");
    expect(row.entityId).toBe("place-1");
    expect(row.operation).toBe("observe");
  });

  it("stores the job's evidence alone when the caller passes none", () => {
    const row = buildChangeLogRow(
      { entityType: "planning", operation: "recalculate", commandId: "cmd-2", at: new Date() },
      jobEvidence,
      null
    );
    expect(row.evidence).toEqual(jobEvidence);
  });

  it("normalises a missing commandId to null", () => {
    const row = buildChangeLogRow({ entityType: "state", operation: "replace", at: new Date() }, jobEvidence, null);
    expect(row.commandId).toBeNull();
  });

  it("passes an explicit commandId through unchanged", () => {
    const row = buildChangeLogRow(
      { entityType: "planning", operation: "recalculate", commandId: "cmd-3", at: new Date() },
      jobEvidence,
      null
    );
    expect(row.commandId).toBe("cmd-3");
  });

  it("normalises a missing entityId to null", () => {
    const row = buildChangeLogRow(
      { entityType: "planning", operation: "recalculate", at: new Date() },
      jobEvidence,
      null
    );
    expect(row.entityId).toBeNull();
  });

  it("stores no before-image for a person's or the system's write", () => {
    const change = { entityType: "project", operation: "save", at: new Date(), before: { title: "Old" } };
    expect(buildChangeLogRow(change, jobEvidence, null).evidence).toEqual(jobEvidence);
    expect(buildChangeLogRow(change, jobEvidence, "system").evidence).toEqual(jobEvidence);
    expect(buildChangeLogRow(change, jobEvidence, null).actor).toBeNull();
    expect(buildChangeLogRow(change, jobEvidence, "system").actor).toBe("system");
  });

  describe("an agent's claimed basis and evidence", () => {
    const change = { entityType: "commitment", operation: "save", at: new Date(), before: { title: "Old" } };
    const claim = { basis: "stated" as const, evidence: "can we do Friday instead" };

    it("adds both to an agent's write that supplied them", () => {
      const row = buildChangeLogRow(change, jobEvidence, "scribe", claim);
      expect(row.evidence).toMatchObject({ basis: "stated", statedEvidence: "can we do Friday instead" });
    });
    it("adds only what was supplied", () => {
      expect(buildChangeLogRow(change, jobEvidence, "scribe", { basis: "inferred" }).evidence).not.toHaveProperty(
        "statedEvidence"
      );
      expect(buildChangeLogRow(change, jobEvidence, "scribe", {}).evidence).not.toHaveProperty("basis");
      expect(buildChangeLogRow(change, jobEvidence, "scribe").evidence).not.toHaveProperty("basis");
    });
    it("adds nothing for a person or the system", () => {
      for (const actor of [null, "system"])
        expect(buildChangeLogRow(change, jobEvidence, actor, claim).evidence).toEqual(jobEvidence);
    });
    it("keeps the basis but not the quote for an email-derived entity", () => {
      const row = buildChangeLogRow({ ...change, noBefore: true }, jobEvidence, "scribe", {
        basis: "observed",
        evidence: "quoted from the email"
      });
      expect(row.evidence).toMatchObject({ basis: "observed", beforeMissing: true });
      expect(row.evidence).not.toHaveProperty("statedEvidence");
    });
  });

  it("keeps the before-image an agent's writer supplied", () => {
    const row = buildChangeLogRow(
      { entityType: "project", operation: "save", at: new Date(), before: { title: "Old" } },
      jobEvidence,
      "mark"
    );
    expect(row.actor).toBe("mark");
    expect(row.evidence).toEqual({ before: { title: "Old" }, ...jobEvidence });
  });

  it("marks an agent's write beforeMissing when its writer supplied no row", () => {
    const row = buildChangeLogRow({ entityType: "session", operation: "start", at: new Date() }, jobEvidence, "mark");
    expect(row.evidence).toEqual({ before: null, beforeMissing: true, ...jobEvidence });
  });

  it("never stores a before-image for an email-derived entity, whatever the writer supplied", () => {
    const row = buildChangeLogRow(
      { entityType: "capture_review", operation: "save", at: new Date(), before: { text: "mail" }, noBefore: true },
      jobEvidence,
      "mark"
    );
    expect(row.evidence).toEqual({ before: null, beforeMissing: true, ...jobEvidence });
  });
});

describe("currentEngineResultIncludesActivity — fixed_commitment", () => {
  it("refuses a commitment the engine's current plan does not protect at all", () => {
    const result = baseResult(null);
    expect(currentEngineResultIncludesActivity(result, "fixed_commitment", "dinner", 20, "setup")).toBe(false);
  });

  it("refuses a phase that does not match the engine's current phase", () => {
    // The engine says the commitment is in setup; a client claiming to track "travel" — or a stale
    // client sending no phase at all — must be refused rather than silently accepted by id alone.
    const result = baseResult({
      id: "dinner",
      phase: "setup",
      phaseStartsAt: iso(0),
      phaseEndsAt: iso(15)
    });
    expect(currentEngineResultIncludesActivity(result, "fixed_commitment", "dinner", 10, "travel")).toBe(false);
    expect(currentEngineResultIncludesActivity(result, "fixed_commitment", "dinner", 10, undefined)).toBe(false);
  });

  it("accepts a matching phase whose requested minutes fit inside the phase window", () => {
    const result = baseResult({
      id: "dinner",
      phase: "setup",
      phaseStartsAt: iso(0),
      phaseEndsAt: iso(15)
    });
    expect(currentEngineResultIncludesActivity(result, "fixed_commitment", "dinner", 15, "setup")).toBe(true);
  });

  it("refuses minutes that overshoot the phase window — the bug that let setup claim the whole block", () => {
    const result = baseResult({
      id: "dinner",
      phase: "setup",
      phaseStartsAt: iso(0),
      phaseEndsAt: iso(15)
    });
    // 80 minutes was the old bug: the whole protected block requested while only 15 minutes of setup
    // remained.
    expect(currentEngineResultIncludesActivity(result, "fixed_commitment", "dinner", 80, "setup")).toBe(false);
  });

  it("falls back to the id-and-phase check for a run persisted before phase edges were published", () => {
    const result = baseResult({ id: "dinner", phase: "active" });
    expect(currentEngineResultIncludesActivity(result, "fixed_commitment", "dinner", 999, "active")).toBe(true);
  });

  it("accepts the active phase's trailing transition buffer, which its own Start button legitimately requests", () => {
    // protected-commitment-panel.tsx and device-now.ts's commitmentPhaseRawMinutes both compute the
    // active phase's plannedMinutes against `protectedEndAt`, not `phaseEndsAt` — deliberately, so
    // tracking covers the transition buffer after the commitment too. The bound here has to widen the
    // same way for the active phase, or every tap in that buffer's opening minutes was refused as "not
    // present in the current Plan and Forecast Engine result" even though the commitment was right
    // there (an active-phase commitment with a 20-minute transitionAfterMinutes
    // rejected Start for the first 20 minutes of every session).
    const result = baseResult({
      id: "dinner",
      phase: "active",
      phaseStartsAt: iso(0),
      phaseEndsAt: iso(90),
      protectedStartAt: iso(-10),
      protectedEndAt: iso(110)
    });
    expect(currentEngineResultIncludesActivity(result, "fixed_commitment", "dinner", 110, "active")).toBe(true);
    // Still refuses a duration that overshoots even the protected window.
    expect(currentEngineResultIncludesActivity(result, "fixed_commitment", "dinner", 111, "active")).toBe(false);
  });

  it("bounds a non-active phase to phaseEndsAt even when protectedEndAt is published", () => {
    // Only the active phase gets the trailing-buffer allowance; setup/travel/arrival/transition/return
    // still track only their own window.
    const result = baseResult({
      id: "dinner",
      phase: "setup",
      phaseStartsAt: iso(0),
      phaseEndsAt: iso(15),
      protectedStartAt: iso(0),
      protectedEndAt: iso(110)
    });
    expect(currentEngineResultIncludesActivity(result, "fixed_commitment", "dinner", 80, "setup")).toBe(false);
  });
});

describe("currentEngineResultIncludesActivity — open anchor", () => {
  // The engagement strip's "I'm engaged" button starts a `fixed_commitment` session for the anchor
  // you're standing at while it's free — but the engine reports that under `recommendation.openAnchor`,
  // never `protectedCommitment` (the two are mutually exclusive: one means the clock is held, the other
  // that it isn't). Checking only `protectedCommitment` rejected every open-anchor session on id alone.
  it("refuses an open anchor when only protectedCommitment is checked (the bug)", () => {
    const result = resultWithOpenAnchor({
      id: "carnival",
      phase: "active",
      phaseStartsAt: iso(0),
      phaseEndsAt: iso(90)
    });
    expect(currentEngineResultIncludesActivity(result, "fixed_commitment", "carnival", 90, "active")).toBe(true);
  });

  it("refuses an open anchor the engine's current plan does not report at all", () => {
    const result = resultWithOpenAnchor(null);
    expect(currentEngineResultIncludesActivity(result, "fixed_commitment", "carnival", 90, "active")).toBe(false);
  });

  it("refuses an open anchor id mismatch", () => {
    const result = resultWithOpenAnchor({
      id: "carnival",
      phase: "active",
      phaseStartsAt: iso(0),
      phaseEndsAt: iso(90)
    });
    expect(currentEngineResultIncludesActivity(result, "fixed_commitment", "different-event", 90, "active")).toBe(
      false
    );
  });

  it("refuses minutes that overshoot the open anchor's phase window", () => {
    const result = resultWithOpenAnchor({
      id: "carnival",
      phase: "active",
      phaseStartsAt: iso(0),
      phaseEndsAt: iso(90)
    });
    expect(currentEngineResultIncludesActivity(result, "fixed_commitment", "carnival", 200, "active")).toBe(false);
  });

  it("falls back to the id-and-phase check for an open anchor persisted before phase edges were published", () => {
    const result = resultWithOpenAnchor({ id: "carnival", phase: "active" });
    expect(currentEngineResultIncludesActivity(result, "fixed_commitment", "carnival", 999, "active")).toBe(true);
  });
});

/**
 * `deriveSessionSanction` (the pulse criteria and publish design note, Decision Q2): what sanctions a
 * session's target at the moment it starts.
 */
describe("deriveSessionSanction", () => {
  const at = new Date(iso(0));

  it("names 'directive' when the target is the current directive", () => {
    const result: PlanForecastResponse = {
      ...baseResult(null),
      currentDirective: { kind: "action", targetId: "action-1", title: "Do it", recommendedMinutes: 30 }
    };
    expect(deriveSessionSanction(result, "action", "action-1", at)).toBe("directive");
  });

  it("names 'day_plan_block' for a protected commitment the directive does not name", () => {
    const result = baseResult({ id: "carnival", phase: "active", phaseStartsAt: iso(0), phaseEndsAt: iso(90) });
    expect(deriveSessionSanction(result, "fixed_commitment", "carnival", at, "active")).toBe("day_plan_block");
  });

  it("names 'day_plan_block' for a sleep plan or routine step in the engine's own collections", () => {
    const sleepResult: PlanForecastResponse = {
      ...baseResult(null),
      derivedState: { ...baseResult(null).derivedState, sleepPlans: [{ id: "sleep-1", allowedMinutes: 480 }] }
    };
    expect(deriveSessionSanction(sleepResult, "sleep", "sleep-1", at)).toBe("day_plan_block");
    const stepResult: PlanForecastResponse = {
      ...baseResult(null),
      derivedState: { ...baseResult(null).derivedState, routineSteps: [{ id: "step-1", durationMinutes: 10 }] }
    };
    expect(deriveSessionSanction(stepResult, "routine_step", "step-1", at)).toBe("day_plan_block");
  });

  it("names 'day_plan_block' for a target a day-plan block covers now", () => {
    const result: PlanForecastResponse = {
      ...baseResult(null),
      dayPlan: {
        through: iso(600),
        mode: "policy_replay" as const,
        truncated: false,
        displaced: [],
        locations: [],
        blocks: [
          {
            startsAt: iso(-10),
            endsAt: iso(30),
            kind: "action",
            targetId: "action-2",
            title: "Later work",
            focusedMinutes: 30,
            wallClockMinutes: 30,
            reason: "test",
            confidence: "projected"
          }
        ]
      }
    };
    expect(deriveSessionSanction(result, "action", "action-2", at)).toBe("day_plan_block");
  });

  it("names 'free' when the directive is free and no protected block is in force", () => {
    const result: PlanForecastResponse = {
      ...baseResult(null),
      currentDirective: { kind: "none", title: "Nothing", recommendedMinutes: 0 }
    };
    expect(deriveSessionSanction(result, "action", "action-3", at)).toBe("free");
  });

  it("names null (unsanctioned) when the directive is not free and nothing sanctions the target", () => {
    const result: PlanForecastResponse = {
      ...baseResult(null),
      currentDirective: { kind: "action", targetId: "other-action", title: "Other", recommendedMinutes: 20 }
    };
    expect(deriveSessionSanction(result, "action", "action-4", at)).toBeNull();
  });

  it("is not free when a protected block (commitment/sleep/routine_step) is in force even with a free directive", () => {
    const result: PlanForecastResponse = {
      ...baseResult(null),
      currentDirective: { kind: "none", title: "Nothing", recommendedMinutes: 0 },
      dayPlan: {
        through: iso(600),
        mode: "policy_replay" as const,
        truncated: false,
        displaced: [],
        locations: [],
        blocks: [
          {
            startsAt: iso(-10),
            endsAt: iso(30),
            kind: "commitment",
            targetId: "commitment-1",
            title: "Meeting",
            focusedMinutes: 0,
            wallClockMinutes: 40,
            reason: "test",
            confidence: "firm"
          }
        ]
      }
    };
    expect(deriveSessionSanction(result, "action", "unrelated-action", at)).toBeNull();
  });
});

describe("planForecastStanding", () => {
  const validUntil = new Date("2026-08-13T03:00:00.000Z");
  const minutesAfter = (minutes: number) => new Date(validUntil.getTime() + minutes * 60_000);

  it("is current up to and including the validity boundary", () => {
    expect(planForecastStanding(validUntil, minutesAfter(-30))).toBe("current");
    expect(planForecastStanding(validUntil, validUntil)).toBe("current");
  });

  it("is grace from the boundary through exactly two hours past it", () => {
    expect(planForecastStanding(validUntil, minutesAfter(1))).toBe("grace");
    expect(planForecastStanding(validUntil, minutesAfter(120))).toBe("grace");
  });

  it("is expired beyond two hours, and accepts the ISO string a stored result carries", () => {
    expect(planForecastStanding(validUntil, minutesAfter(121))).toBe("expired");
    expect(planForecastStanding(validUntil.toISOString(), minutesAfter(121))).toBe("expired");
  });
});

describe("changedFieldsBefore", () => {
  it("keeps only the changed columns at their earlier value, ignoring bookkeeping", () => {
    const before = { id: "p", title: "Old", status: "active", version: 1, updated_at: "a" };
    const after = { id: "p", title: "New", status: "active", version: 2, updated_at: "b" };
    expect(changedFieldsBefore(before, after)).toEqual({ id: "p", version: 1, title: "Old" });
  });
  it("is null for a create and empty when nothing changed", () => {
    expect(changedFieldsBefore(undefined, { id: "p" })).toBeNull();
    expect(changedFieldsBefore({ id: "p", version: 1 }, { id: "p", version: 2 })).toEqual({ id: "p", version: 1 });
  });
});

describe("explainCommitmentActivityRefusal", () => {
  const setup = { id: "dinner", phase: "setup", phaseStartsAt: iso(0), phaseEndsAt: iso(15) };

  it("names a commitment the plan is not tracking, and mentions arrival", () => {
    const message = explainCommitmentActivityRefusal(baseResult(null), "dinner", 10, "setup");
    expect(message).toMatch(/not the one running now/);
    expect(message).toMatch(/arrival/);
    expect(explainCommitmentActivityRefusal(baseResult({ ...setup, id: "other" }), "dinner", 10, "setup")).toMatch(
      /not the one running now/
    );
  });

  it("asks for the phase when none was given", () => {
    const message = explainCommitmentActivityRefusal(baseResult(setup), "dinner", 10, undefined);
    expect(message).toBe("No phase was given, but this commitment is in its setup phase now; pass phase setup.");
  });

  it("names both phases when they differ", () => {
    const message = explainCommitmentActivityRefusal(baseResult(setup), "dinner", 10, "travel");
    expect(message).toBe("This commitment is in its setup phase now, not travel; pass phase setup.");
  });

  it("names the minutes the phase has when the request overshoots", () => {
    const message = explainCommitmentActivityRefusal(baseResult(setup), "dinner", 80, "setup");
    expect(message).toBe("80 minutes is longer than the 15 that the setup phase has; ask for 15 or fewer.");
  });

  it("measures the active phase through the protected end, as the check does", () => {
    const active = { ...setup, phase: "active", phaseEndsAt: iso(90), protectedEndAt: iso(110) };
    expect(explainCommitmentActivityRefusal(baseResult(active), "dinner", 111, "active")).toMatch(/than the 110 that/);
  });

  it("reads an open anchor the same way", () => {
    expect(explainCommitmentActivityRefusal(resultWithOpenAnchor(setup), "dinner", 10, "active")).toMatch(
      /in its setup phase now, not active/
    );
  });
});

describe("explainActivityRefusal (routine step, sleep, deliverable)", () => {
  const withStep = (durationMinutes: number): PlanForecastResponse => ({
    ...baseResult(null),
    derivedState: { ...baseResult(null).derivedState, routineSteps: [{ id: "step-1", durationMinutes }] }
  });

  it("a routine step due now for other minutes names the minutes the plan gives it and the corrected call", () => {
    const refusal = explainActivityRefusal(withStep(15), "routine_step", "step-1", 30);
    expect(refusal.message).toContain("15 minutes");
    expect(refusal.message).toContain("not 30");
    expect(refusal.message).toContain("minutes 15");
    expect(refusal.validValues).toEqual({ minutes: ["15"] });
  });

  it("a sleep plan is read through allowedMinutes", () => {
    const result: PlanForecastResponse = {
      ...baseResult(null),
      derivedState: { ...baseResult(null).derivedState, sleepPlans: [{ id: "sleep-1", allowedMinutes: 450 }] }
    };
    expect(explainActivityRefusal(result, "sleep", "sleep-1", 400).validValues).toEqual({ minutes: ["450"] });
  });

  it("a deliverable the plan directs now is read through the directive's recommended minutes", () => {
    const result: PlanForecastResponse = {
      ...baseResult(null),
      currentDirective: { kind: "deliverable", targetId: "d-1", title: "Write", recommendedMinutes: 45 }
    };
    expect(explainActivityRefusal(result, "deliverable", "d-1", 30).validValues).toEqual({ minutes: ["45"] });
  });

  it("a target the plan is not tracking says so and names rhen_status as the next call", () => {
    const refusal = explainActivityRefusal(baseResult(null), "routine_step", "step-9", 15);
    expect(refusal.message).toContain("not present in the current Plan");
    expect(refusal.nextCall?.tool).toBe("rhen_status");
  });

  it("a target blocked by a protected commitment names the commitment and its end instead of a bare 'not present'", () => {
    const holder = { id: "craig", title: "Craig Cooking", phase: "active", protectedEndAt: "2026-11-06T04:00:00.000Z" };
    const refusal = explainActivityRefusal(baseResult(holder), "deliverable", "d-1", 30);
    expect(refusal.message).toContain('"Craig Cooking" (id craig) holds this time until 2026-11-06T04:00:00.000Z');
    expect(refusal.message).toContain("Do not retry");
    expect(refusal.message).toContain("rhen_cancel");
    expect(refusal.message).not.toContain("from Now");
    expect(refusal.message).not.toContain("not present in the current Plan");
    expect(refusal.nextCall?.tool).toBe("rhen_status");
  });

  it("a mismatch also carries rhen_status as the next call, to see the plan's minutes", () => {
    expect(explainActivityRefusal(withStep(15), "routine_step", "step-1", 30).nextCall?.tool).toBe("rhen_status");
  });
});

describe("explainContinuationRefusal", () => {
  it("a safe continuation for other minutes names the figure and the exact call to repeat", () => {
    const refusal = explainContinuationRefusal({ safe: true, recommendedMinutes: 30, reason: "30 minutes fit." }, 45);
    expect(refusal.message).toContain("exactly 30 minutes, not 45");
    expect(refusal.message).toContain("Why: 30 minutes fit.");
    expect(refusal.message).toContain("minutes 30");
    expect(refusal.nextCall).toEqual({
      tool: "rhen_session",
      arguments: { subcommand: "continue", minutes: 30 },
      note: "the only figure the plan allows"
    });
    expect(refusal.validValues).toEqual({ minutes: ["30"] });
  });

  it("an unsafe continuation gives the engine's reason and sends the caller to finish the session", () => {
    const refusal = explainContinuationRefusal(
      { safe: false, recommendedMinutes: 0, reason: "Only 5 minutes are free." },
      30
    );
    expect(refusal.message).toContain("Only 5 minutes are free.");
    expect(refusal.message).toContain("rhen_session finish");
    expect(refusal.nextCall?.tool).toBe("rhen_session");
    expect(refusal.nextCall?.arguments).toEqual({ subcommand: "finish" });
  });

  it("no continuation at all is treated as not permitted", () => {
    expect(explainContinuationRefusal(null, 30).message).toContain("does not permit");
  });
});
