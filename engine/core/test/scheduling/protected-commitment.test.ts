import { describe, expect, it } from "vitest";
import { planSchedule, recommend, resolveProtectedCommitment } from "../../src/index.js";
import type { Action, CapacityWindow, FixedCommitment, Project } from "../../src/index.js";
import { conditionDefinitionSchema, currentSituationSchema } from "@openrhen/contracts";
import { holding } from "../model/situation.js";

const base = new Date("2026-08-11T05:00:00.000Z");
const at = (minutes: number) => new Date(base.getTime() + minutes * 60_000);
const commitment = (overrides: Partial<FixedCommitment> = {}): FixedCommitment => ({
  id: "ortho",
  title: "Dentist",
  startsAt: at(30),
  endsAt: at(60),
  setupBeforeMinutes: 15,
  transitionAfterMinutes: 10,
  ...overrides
});
const project: Project = {
  id: "study",
  status: "active",
  uncertainty: "known",
  value: 3,
  consequence: 3,
  outcomeActive: true
};
const action: Action = {
  id: "draft",
  projectId: project.id,
  title: "Draft assignment",
  status: "active",
  expectedMinutes: 30,
  remainingMinutes: 30,
  pessimisticMinutes: 30,
  energy: "high",
  minimumSessionMinutes: 15,
  maximumSessionMinutes: 30,
  importance: 3,
  consequence: 3,
  contexts: ["desktop", "online"],
  dependenciesComplete: true
};
const capacity: CapacityWindow = {
  id: "available",
  startsAt: base,
  endsAt: at(120),
  energy: "high",
  usableFraction: 1
};

describe("protected commitment phases", () => {
  it.each([
    [15, "setup"],
    [29, "setup"],
    [30, "active"],
    [59, "active"],
    [60, "transition"],
    [69, "transition"]
  ] as const)("resolves minute %s as %s", (minute, phase) => {
    expect(resolveProtectedCommitment(at(minute), [commitment()], 2)?.phase).toBe(phase);
  });

  it("ends protection exactly at the transition boundary", () => {
    expect(resolveProtectedCommitment(at(14), [commitment()], 2)).toBeNull();
    expect(resolveProtectedCommitment(at(70), [commitment()], 2)).toBeNull();
  });

  it("prefers an active event, then the nearest setup, then the latest transition", () => {
    const active = commitment({ id: "active" });
    const setup = commitment({ id: "setup", startsAt: at(45), endsAt: at(75), setupBeforeMinutes: 30 });
    const transition = commitment({ id: "transition", startsAt: at(-30), endsAt: at(10), transitionAfterMinutes: 30 });
    expect(resolveProtectedCommitment(at(35), [setup, active, transition], 2)?.id).toBe("active");
    expect(resolveProtectedCommitment(at(20), [setup, transition], 2)?.id).toBe("setup");
    const laterTransition = commitment({
      id: "later-transition",
      startsAt: at(-20),
      endsAt: at(15),
      transitionAfterMinutes: 30
    });
    expect(resolveProtectedCommitment(at(20), [transition, laterTransition], 2)?.id).toBe("later-transition");
  });

  it("widens the travel and arrival phases to a supplied margin instead of the default", () => {
    // setup 15, travel 20, margin 10 (not the default 2): lead = 20 + 10 = 30, so protection starts
    // 45 minutes before startsAt(30) — at(-15) — and the arrival phase itself is the 10 minutes
    // immediately before startsAt, not the usual 2.
    const withTravel = commitment({ travelBeforeMinutes: 20 });
    const phaseAt = (minute: number) => resolveProtectedCommitment(at(minute), [withTravel], 10)?.phase;
    expect(resolveProtectedCommitment(at(-16), [withTravel], 10)).toBeNull();
    expect(phaseAt(-15)).toBe("setup"); // protectedStartAt = startsAt - (setup 15 + lead 30)
    expect(phaseAt(-1)).toBe("setup");
    expect(phaseAt(0)).toBe("travel"); // travelStartsAt = startsAt - lead(30)
    expect(phaseAt(19)).toBe("travel");
    expect(phaseAt(20)).toBe("arrival"); // arrivalStartsAt = startsAt - margin(10)
    expect(phaseAt(29)).toBe("arrival");
    expect(phaseAt(30)).toBe("active");
    expect(phaseAt(59)).toBe("active");
    expect(phaseAt(60)).toBe("transition");
    expect(resolveProtectedCommitment(at(70), [withTravel], 10)).toBeNull();

    // The same instant, resolved against the default 2-minute margin instead of the 10-minute one
    // above, reads differently: arrival only opens at startsAt−2 (minute 28) rather than startsAt−10
    // (minute 20), so minute 25 — "arrival" a moment ago — is still "travel" here.
    const defaultPhaseAt = (minute: number) => resolveProtectedCommitment(at(minute), [withTravel], 2)?.phase;
    expect(defaultPhaseAt(25)).toBe("travel");
    expect(defaultPhaseAt(28)).toBe("arrival");
    expect(defaultPhaseAt(29)).toBe("arrival");
  });

  it("reports setup/late in the pre-start travel phase when a before-phase step is still pending", () => {
    // Same shape as "widens the travel and arrival phases..." above: setup 15, travel 20, margin 10,
    // so at(10) falls inside the travel phase (travelStartsAt = at(0), arrivalStartsAt = at(20)).
    const withTravel = commitment({ travelBeforeMinutes: 20, locationId: "work" });
    const pendingStep = { commitmentId: "ortho", phase: "before" as const, status: "pending" };
    const resolved = resolveProtectedCommitment(at(10), [withTravel], 10, [pendingStep], null);
    expect(resolved).toMatchObject({ id: "ortho", phase: "setup", late: true, phaseEndsAt: at(60) });
  });

  it("leaves the travel phase unchanged once the before-phase steps are done", () => {
    const withTravel = commitment({ travelBeforeMinutes: 20, locationId: "work" });
    const doneStep = { commitmentId: "ortho", phase: "before" as const, status: "completed" };
    const resolved = resolveProtectedCommitment(at(10), [withTravel], 10, [doneStep], null);
    expect(resolved).toMatchObject({ id: "ortho", phase: "travel" });
    expect(resolved?.late).toBeUndefined();
  });

  it("does not report late pre-start once arrival is asserted, even with a step still pending", () => {
    const withTravel = commitment({ travelBeforeMinutes: 20, locationId: "work" });
    const pendingStep = { commitmentId: "ortho", phase: "before" as const, status: "pending" };
    const resolved = resolveProtectedCommitment(at(10), [withTravel], 10, [pendingStep], "work");
    expect(resolved).toMatchObject({ id: "ortho", phase: "travel" });
    expect(resolved?.late).toBeUndefined();
  });

  it("publishes the current phase's own window, not the whole protected block", () => {
    // The Now page's Start button used to send `protectedEndAt` regardless of
    // phase because the phase's own edges were computed here but never published on the result.
    const withTravel = commitment({ travelBeforeMinutes: 20 });
    const phaseWindow = (minute: number) => {
      const resolved = resolveProtectedCommitment(at(minute), [withTravel], 10);
      return resolved && { phaseStartsAt: resolved.phaseStartsAt, phaseEndsAt: resolved.phaseEndsAt };
    };
    expect(phaseWindow(-15)).toEqual({ phaseStartsAt: at(-15), phaseEndsAt: at(0) }); // setup
    expect(phaseWindow(0)).toEqual({ phaseStartsAt: at(0), phaseEndsAt: at(20) }); // travel
    expect(phaseWindow(20)).toEqual({ phaseStartsAt: at(20), phaseEndsAt: at(30) }); // arrival
    expect(phaseWindow(30)).toEqual({ phaseStartsAt: at(30), phaseEndsAt: at(60) }); // active
    expect(phaseWindow(60)).toEqual({ phaseStartsAt: at(60), phaseEndsAt: at(70) }); // transition
  });

  it("takes precedence over context exclusions and recovery capacity", () => {
    const result = recommend({
      now: at(20),
      horizonEnd: at(120),
      projects: [project],
      actions: [action],
      capacityWindows: [{ ...capacity, energy: "recovery" }],
      commitments: [commitment()],
      ...holding("home"),
      currentEnergy: "high",
      timezone: "Australia/Sydney",
      locale: "en-AU"
    });
    expect(result).toMatchObject({
      headline: "Preparing for Dentist",
      primary: null,
      protectedCommitment: { id: "ortho", phase: "setup" }
    });
    expect(result.explanation).toContain("starts at 3:30 pm");
  });
});

describe("context-only recommendation explanation", () => {
  it("names the closest candidate and each missing context", () => {
    const result = recommend({
      now: base,
      horizonEnd: at(120),
      projects: [project],
      actions: [action],
      capacityWindows: [capacity],
      commitments: [],
      ...holding("home"),
      currentEnergy: "high"
    });
    expect(result.headline).toContain("desktop and online");
    expect(result.explanation).toContain("Draft assignment is the closest suitable action");
    expect(result.explanation).toContain("it needs desktop and online");
  });

  it("leads with the action and says where, not with the raw context name as the subject", () => {
    const errand = { ...action, id: "errand", title: "Buy the remaining supplies", contexts: ["shops"] };
    const result = recommend({
      now: base,
      horizonEnd: at(120),
      projects: [project],
      actions: [errand],
      capacityWindows: [capacity],
      commitments: [],
      conditionDefinitions: [
        conditionDefinitionSchema.parse({ id: "shops", name: "shops", kind: "location", portability: "fixed" })
      ],
      currentSituation: currentSituationSchema.parse({ locationId: "home" }),
      currentEnergy: "high"
    });
    expect(result.headline).toBe("Buy the remaining supplies needs you at shops");
    expect(result.explanation).toBe(
      "Buy the remaining supplies is the closest suitable action, but it needs you at shops, so it is not suggested from here. Get to shops, or say you are there, and it can be recommended."
    );
  });

  it("keeps the action-led wording when a commitment boundary also leaves no room", () => {
    const errand = {
      ...action,
      id: "errand",
      title: "Buy the remaining supplies",
      contexts: ["shops"],
      minimumSessionMinutes: 30
    };
    const plain = { ...action, id: "plain", title: "Plain work", contexts: [], minimumSessionMinutes: 30 };
    const meeting = commitment({
      title: "Craig Cooking",
      startsAt: at(20),
      endsAt: at(60),
      setupBeforeMinutes: 0,
      transitionAfterMinutes: 0
    });
    const planning = planSchedule({
      now: base,
      horizonEnd: at(120),
      projects: [project],
      actions: [errand, plain],
      capacityWindows: [capacity],
      commitments: [meeting]
    });
    const result = recommend({
      now: base,
      horizonEnd: at(120),
      projects: [project],
      actions: [errand, plain],
      planning,
      forecasts: planning.forecasts,
      capacityWindows: [capacity],
      commitments: [meeting],
      conditionDefinitions: [
        conditionDefinitionSchema.parse({ id: "shops", name: "shops", kind: "location", portability: "fixed" })
      ],
      currentSituation: currentSituationSchema.parse({ locationId: "home" }),
      currentEnergy: "high",
      timezone: "Australia/Sydney",
      locale: "en-AU"
    });
    expect(result.headline).toMatch(/^Nothing to start until .*, after Craig Cooking$/);
    expect(result.noFit?.kind).toBe("boundary");
    expect(result.explanation).toBe(
      "Buy the remaining supplies is the closest suitable action, but it needs you at shops, so it is not suggested from here. Get to shops, or say you are there, and it can be recommended."
    );
    expect(result.explanation).not.toContain("is needed for");
  });

  it("keeps places and other needs apart when both block", () => {
    const errand = { ...action, id: "errand", title: "Buy supplies", contexts: ["shops", "wallet"] };
    const result = recommend({
      now: base,
      horizonEnd: at(120),
      projects: [project],
      actions: [errand],
      capacityWindows: [capacity],
      commitments: [],
      conditionDefinitions: [
        conditionDefinitionSchema.parse({ id: "shops", name: "shops", kind: "location", portability: "fixed" }),
        conditionDefinitionSchema.parse({ id: "wallet", name: "wallet", kind: "capability", portability: "portable" })
      ],
      currentSituation: currentSituationSchema.parse({ locationId: "home", overrides: { wallet: "unavailable" } }),
      currentEnergy: "high"
    });
    expect(result.headline).toBe("Buy supplies needs you at shops, plus wallet");
  });

  it("asks rather than refuses when the blocking context is merely unanswered", () => {
    const carried = { ...action, contexts: ["laptop"] };
    const result = recommend({
      now: base,
      horizonEnd: at(120),
      projects: [project],
      actions: [carried],
      capacityWindows: [capacity],
      commitments: [],
      conditionDefinitions: [
        conditionDefinitionSchema.parse({ id: "laptop", name: "laptop", kind: "capability", portability: "portable" })
      ],
      currentSituation: currentSituationSchema.parse({}),
      currentEnergy: "high"
    });
    expect(result.headline).toBe("Draft assignment needs an answer: Do you have laptop?");
    expect(result.needsAnswer.map((candidate) => candidate.action.id)).toEqual(["draft"]);
    expect(result.reachable).toEqual([]);
  });

  it("retains the generic fallback when context is not the only blocker", () => {
    const blocked = { ...action, dependenciesComplete: false };
    const result = recommend({
      now: base,
      horizonEnd: at(120),
      projects: [project],
      actions: [blocked],
      capacityWindows: [capacity],
      commitments: [],
      ...holding("home"),
      currentEnergy: "high"
    });
    expect(result.headline).toBe("No suitable action fits right now");
    expect(result.evidence).toContain("A dependency is incomplete.");
  });
});
