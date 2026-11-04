import { describe, expect, it } from "vitest";
import { ENERGY_COST_NEXT, buildEnergyCostAnswer, energyCostText, parseEnergyCost } from "./energy-cost.js";

const TZ = "Australia/Brisbane";
const NOW = new Date("2026-11-04T12:00:00Z"); // Wed 22:00 in Brisbane
const options = { timeZone: TZ, locale: "en-AU", now: NOW };

const cost = {
  declaredEnergy: "low",
  blockedCount: 3,
  dueSoon: [{ actionId: "a1", title: "Unit 3", deadlineAt: "2026-11-05T23:00:00.000Z" }] // Fri 09:00 Brisbane
};
const base = { recommendation: { energyCost: cost }, now: NOW, timeZone: TZ, locale: "en-AU" } as const;

describe("parseEnergyCost", () => {
  it("parses the wire form and treats absent or malformed as null", () => {
    expect(parseEnergyCost(cost)).toEqual(cost);
    expect(parseEnergyCost({ declaredEnergy: "low", blockedCount: 2 })).toEqual({
      declaredEnergy: "low",
      blockedCount: 2,
      dueSoon: []
    });
    expect(parseEnergyCost(undefined)).toBeNull();
    expect(parseEnergyCost({ ...cost, blockedCount: 0 })).toBeNull();
    expect(parseEnergyCost({ ...cost, declaredEnergy: "recovery" })).toBeNull();
    expect(parseEnergyCost({ ...cost, dueSoon: [{ actionId: "a" }] })).toBeNull();
  });
});

describe("energyCostText", () => {
  it("counts with the local weekday of the date", () => {
    expect(energyCostText(parseEnergyCost(cost)!, options)).toBe("Low energy is holding back 3 actions, 1 due Friday.");
  });

  it("uses the singular and omits the due clause when nothing is due soon", () => {
    expect(energyCostText({ declaredEnergy: "medium", blockedCount: 1, dueSoon: [] }, options)).toBe(
      "Medium energy is holding back 1 action."
    );
  });

  it("uses the local weekday, not UTC's, and says today for the same local day", () => {
    const late = { ...cost, dueSoon: [{ actionId: "a", title: "A", deadlineAt: "2026-11-05T15:00:00Z" }] }; // Fri 01:00 Brisbane, Thu UTC
    expect(energyCostText(parseEnergyCost(late)!, options)).toContain("1 due Friday");
    const today = { ...cost, dueSoon: [{ actionId: "a", title: "A", deadlineAt: "2026-11-04T13:00:00Z" }] };
    expect(energyCostText(parseEnergyCost(today)!, options)).toContain("1 due today");
  });

  it("groups several: one day, several days, and passed dates", () => {
    const entry = (id: string, deadlineAt: string) => ({ actionId: id, title: id, deadlineAt });
    const sameDay = parseEnergyCost({
      ...cost,
      dueSoon: [entry("a", "2026-11-05T01:00:00Z"), entry("b", "2026-11-05T05:00:00Z")]
    })!;
    expect(energyCostText(sameDay, options)).toBe("Low energy is holding back 3 actions, 2 due Thursday.");
    const days = parseEnergyCost({
      ...cost,
      dueSoon: [entry("a", "2026-11-05T01:00:00Z"), entry("b", "2026-11-06T05:00:00Z")]
    })!;
    expect(energyCostText(days, options)).toContain("2 due soon, the first Thursday");
    const passed = parseEnergyCost({ ...cost, dueSoon: [entry("a", "2026-11-03T01:00:00Z")] })!;
    expect(energyCostText(passed, options)).toBe("Low energy is holding back 3 actions, 1 past its date.");
  });

  it("does not name the action the stretch offer already covers, but keeps the count", () => {
    expect(energyCostText(parseEnergyCost(cost)!, { ...options, omitActionId: "a1" })).toBe(
      "Low energy is holding back 3 actions."
    );
  });

  it("copes with an unknown time zone and never prescribes", () => {
    const text = energyCostText(parseEnergyCost(cost)!, { ...options, timeZone: "Not/AZone" });
    expect(text).toMatch(/^Low energy is holding back 3 actions, 1 due \w+day\.$/);
    expect(text).not.toMatch(/worth more|should|anyway|pattern/i);
  });
});

describe("buildEnergyCostAnswer", () => {
  it("carries the counts, the sentence and what an agent does with it", () => {
    const answer = buildEnergyCostAnswer(base);
    expect(answer).toMatchObject({
      declaredEnergy: "low",
      blockedCount: 3,
      text: "Low energy is holding back 3 actions, 1 due Friday.",
      next: ENERGY_COST_NEXT
    });
    expect(answer?.next).toContain("rhen_session with subcommand start");
    expect(answer?.next).toContain("minutes (a whole number, 1 to 1440; ask the person how long");
    expect(answer?.next).toContain("tracking now");
    expect(answer?.next).toContain("using their own quoted words as evidence");
    expect(answer?.next).toContain("rhen_activity with subcommand start, type sleep");
    expect(answer?.next).toContain("rhen_save with entityType current_availability");
    expect(answer?.next).toContain("never set or raise it yourself");
    expect(answer?.next).toContain("do not nag");
    expect(answer?.next).toContain("do not guess why");
  });

  it("is null when absent, malformed, or the plan is not current", () => {
    expect(buildEnergyCostAnswer({ ...base, recommendation: {} })).toBeNull();
    expect(buildEnergyCostAnswer({ ...base, recommendation: null })).toBeNull();
    expect(buildEnergyCostAnswer({ ...base, recommendation: { energyCost: { blockedCount: "x" } } })).toBeNull();
    expect(buildEnergyCostAnswer({ ...base, planCurrent: false })).toBeNull();
  });

  it("is hidden when the plan is older than the last energy statement", () => {
    const outdated = { ...base, energySetAt: "2026-11-04T11:30:00Z", planCalculatedAt: "2026-11-04T11:00:00Z" };
    expect(buildEnergyCostAnswer(outdated)).toBeNull();
    expect(buildEnergyCostAnswer({ ...outdated, planCalculatedAt: "2026-11-04T11:45:00Z" })).not.toBeNull();
  });

  it("still shows the count when a stretch offer is on show, without naming its action", () => {
    const answer = buildEnergyCostAnswer({ ...base, stretchOfferActionId: "a1" });
    expect(answer?.blockedCount).toBe(3);
    expect(answer?.text).toBe("Low energy is holding back 3 actions.");
  });
});
