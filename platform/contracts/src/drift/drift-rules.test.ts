import { describe, expect, it } from "vitest";
import {
  DIVERSION_CATEGORIES,
  DRIFT_RULE_IDS,
  DRIFT_RULE_THRESHOLDS,
  evaluateRules,
  flagBucket,
  flagEventKey,
  holdoutAssigned,
  isFlagEligible,
  labelSignals,
  normaliseCategory,
  ruleSignals,
  scorableTypes,
  workItemDiversionApplies,
  type DriftMoment
} from "./drift-rules.js";

const at = (minutes: number): Date => new Date(Date.UTC(2026, 0, 5, 9, 0, 0) + minutes * 60_000);
const moment = (overrides: Partial<DriftMoment> = {}): DriftMoment => ({
  id: "m1",
  at: at(10),
  pulse: "on",
  captureLive: true,
  lastSwitchAt: null,
  foreground: null,
  item: "item-a",
  lastFlagAt: {},
  ...overrides
});

describe("rule B, after a shift", () => {
  const context = { shiftEnds: [at(0)] };
  it("flags the first 30 minutes after a measured shift end only", () => {
    expect(evaluateRules(moment({ at: at(0) }), context).map((f) => f.rule)).toEqual(["after_shift"]);
    expect(evaluateRules(moment({ at: at(29) }), context)).toHaveLength(1);
    expect(evaluateRules(moment({ at: at(30) }), context)).toEqual([]);
    expect(evaluateRules(moment({ at: at(-1) }), context)).toEqual([]);
    expect(DRIFT_RULE_THRESHOLDS.afterShiftMinutes).toBe(30);
  });
  it("is cleared by the cooldown", () => {
    const recent = moment({ at: at(10), lastFlagAt: { after_shift: at(2) } });
    expect(evaluateRules(recent, context)).toEqual([]);
    expect(evaluateRules(moment({ at: at(20), lastFlagAt: { after_shift: at(2) } }), context)).toHaveLength(1);
  });
});

describe("rule A, behind an injected predicate", () => {
  const isWork = (item: unknown): boolean => item === "work-item";
  it("fires on a game or media foreground or a hidden denylist interval during a work item", () => {
    for (const category of ["games", "Game", "media"]) {
      expect(workItemDiversionApplies(moment({ item: "work-item", foreground: { category } }), isWork)).toBe(true);
    }
    expect(
      workItemDiversionApplies(moment({ item: "work-item", foreground: { suppressedDenylist: true } }), isWork)
    ).toBe(true);
  });
  it("does not fire outside a work item, on an unmapped category, or without a foreground", () => {
    expect(workItemDiversionApplies(moment({ foreground: { category: "game" } }), isWork)).toBe(false);
    expect(workItemDiversionApplies(moment({ item: "work-item", foreground: { category: "editor" } }), isWork)).toBe(
      false
    );
    expect(workItemDiversionApplies(moment({ item: "work-item" }), isWork)).toBe(false);
  });
  it("never fires until a predicate is wired", () => {
    const m = moment({ item: "work-item", foreground: { category: "game" } });
    expect(evaluateRules(m, { shiftEnds: [] })).toEqual([]);
    expect(evaluateRules(m, { shiftEnds: [], isWorkItem: isWork }).map((f) => f.rule)).toEqual(["work_item_diversion"]);
  });
  it("normalises categories", () => {
    expect(normaliseCategory(" Games ")).toBe("game");
    expect(normaliseCategory("class")).toBe("class");
    expect(normaliseCategory(undefined)).toBe("");
    expect(DIVERSION_CATEGORIES).toEqual(["game", "media"]);
  });
});

describe("eligibility", () => {
  it("needs pulse on, live capture, and distance from a switch", () => {
    expect(isFlagEligible(moment())).toBe(true);
    expect(isFlagEligible(moment({ pulse: "asleep" }))).toBe(false);
    expect(isFlagEligible(moment({ pulse: "free" }))).toBe(false);
    expect(isFlagEligible(moment({ captureLive: false }))).toBe(false);
    expect(isFlagEligible(moment({ lastSwitchAt: at(7) }))).toBe(false);
    expect(isFlagEligible(moment({ lastSwitchAt: at(5) }))).toBe(true);
  });
});

describe("flags", () => {
  it("are shadow, with a deterministic holdout and an idempotent key", () => {
    const [flag] = evaluateRules(moment(), { shiftEnds: [at(0)] });
    expect(flag?.arm).toBe("shadow");
    expect(holdoutAssigned("m1")).toBe(holdoutAssigned("m1"));
    const share = Array.from({ length: 2000 }, (_, i) => holdoutAssigned(`moment-${i}`)).filter(Boolean).length / 2000;
    expect(share).toBeGreaterThan(0.16);
    expect(share).toBeLessThan(0.24);
    expect(flagBucket(at(10))).toBe(flagBucket(at(11)));
    expect(flagEventKey("u", "after_shift", flagBucket(at(10)))).toBe(`u|after_shift|${flagBucket(at(10))}`);
  });
});

describe("label and rule signals", () => {
  it("rule A is scored on the check-in and session types, never on activity mismatch", () => {
    expect(scorableTypes("work_item_diversion").sort()).toEqual(["deviated_checkin", "unsanctioned_session"]);
    expect(scorableTypes("after_shift")).toContain("activity_mismatch");
  });
  it("a scorable type shares no signal with the rule", () => {
    for (const rule of DRIFT_RULE_IDS) {
      for (const type of scorableTypes(rule)) {
        expect(labelSignals[type].filter((s) => ruleSignals[rule].includes(s))).toEqual([]);
      }
    }
  });
});
