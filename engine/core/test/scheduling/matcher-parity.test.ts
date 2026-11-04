import { describe, expect, it } from "vitest";
import { evaluateConditions, resolveSituation } from "@openrhen/contracts";
import { normalizePlanningSlots, slotFitsAction } from "../../src/index.js";
import type { Action, CapacityWindow } from "../../src/index.js";
import { holding } from "../model/situation.js";

/**
 * The scheduling path and the ranking path used to answer "can this be done here" with two separate
 * implementations, and they disagreed: the slot filter demanded every tag be present in the window,
 * while the score filter compared against a flat list of what was currently held. Both now go through
 * the shared evaluator, and this is the test that keeps them from drifting apart again.
 */
const now = new Date("2026-08-11T00:00:00.000Z");
const until = new Date("2026-08-11T06:00:00.000Z");

const action = (id: string, contexts: string[]): Action => ({
  id,
  projectId: "project",
  title: id,
  status: "active",
  optimisticMinutes: 20,
  expectedMinutes: 30,
  remainingMinutes: 30,
  pessimisticMinutes: 40,
  energy: "medium",
  minimumSessionMinutes: 15,
  maximumSessionMinutes: 60,
  importance: 3,
  consequence: 3,
  contexts,
  dependenciesComplete: true
});

const window = (contexts: string[]): CapacityWindow => ({
  id: "window",
  startsAt: now,
  endsAt: until,
  energy: "medium",
  contexts,
  usableFraction: 1
});

/** What the ranking path concludes, given the same contexts stated as what is currently held. */
function scoreVerdict(subject: Action, held: string[]): boolean {
  const { conditionDefinitions, currentSituation } = holding(...held);
  const resolved = resolveSituation({ situation: currentSituation, definitions: conditionDefinitions, now });
  const pathways = subject.contexts.length ? [{ id: `${subject.id}:legacy`, contextIds: subject.contexts }] : [];
  return evaluateConditions({ pathways, resolved }).status !== "no";
}

/** What the scheduling path concludes, given the same contexts stated as what the window offers. */
function slotVerdict(subject: Action, offered: string[]): boolean {
  const slots = normalizePlanningSlots({ from: now, until, capacityWindows: [window(offered)], commitments: [] });
  return slots.some((slot) => slotFitsAction(slot, subject));
}

describe("matcher parity between scheduling and ranking", () => {
  const cases: Array<{ requires: string[]; available: string[] }> = [
    { requires: [], available: [] },
    { requires: [], available: ["home"] },
    { requires: ["home"], available: ["home"] },
    { requires: ["home"], available: ["campus"] },
    { requires: ["home", "desktop"], available: ["home", "desktop"] },
    { requires: ["home", "desktop"], available: ["home"] },
    { requires: ["desktop"], available: ["home", "desktop", "online"] }
  ];

  for (const { requires, available } of cases) {
    it(`agrees for ${requires.length ? requires.join("+") : "no requirement"} against ${available.length ? available.join("+") : "nothing offered"}`, () => {
      const subject = action("subject", requires);
      expect(slotVerdict(subject, available)).toBe(scoreVerdict(subject, available));
    });
  }

  it("keeps unknown permissive on the scheduling path, where a silent window must not empty the forecast", () => {
    // A window declaring nothing is a statement about capacity, not about context, so work that
    // states a requirement still schedules into it. The ranking path is stricter by design: it is
    // answering about right now, where an unheld context is genuinely absent.
    const subject = action("needs-home", ["home"]);
    expect(slotVerdict(subject, [])).toBe(true);
    expect(scoreVerdict(subject, [])).toBe(false);
  });
});
