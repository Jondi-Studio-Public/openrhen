import { describe, expect, it } from "vitest";
import {
  THRESHOLDS,
  checkInAllowanceLabel,
  parseThreshold,
  pulseChip,
  pulseIsUnknown,
  pulseNeedsReentry,
  pulseSentence,
  stillDoingQuestion,
  type PulseReading
} from "./pulse-view";

const base: PulseReading = {
  state: "on",
  since: "2026-10-28T00:00:00.000Z",
  reason: "confirmed",
  private: false,
  shares: {
    today: { onPercent: null, countedMinutes: 0 },
    days7: { onPercent: null, countedMinutes: 0 },
    days30: { onPercent: null, countedMinutes: 0 }
  }
};
const unknown: PulseReading = {
  ...base,
  state: "unknown",
  reason: "unconfirmed",
  doing: { kind: "action", id: "a", title: "Write report" }
};
const lapsed: PulseReading = { ...base, state: "off", reason: "lapsed", offReason: "lapsed" };

describe("pulse state reads", () => {
  it("needs re-entry only for off/lapsed", () => {
    expect(pulseNeedsReentry(lapsed)).toBe(true);
    expect(pulseNeedsReentry({ ...base, state: "off", reason: "deviated" })).toBe(false);
    expect(pulseNeedsReentry(unknown)).toBe(false);
    expect(pulseNeedsReentry(undefined)).toBe(false);
  });
  it("recognises unknown", () => {
    expect(pulseIsUnknown(unknown)).toBe(true);
    expect(pulseIsUnknown(base)).toBe(false);
  });
  it("words the chip for each state, saying in words what the tone says", () => {
    expect(pulseChip(undefined)).toBeNull();
    expect(pulseChip(base)).toEqual({ tone: "accent", label: "On plan" });
    expect(pulseChip(unknown)).toEqual({ tone: "warn", label: "Not sure what you're doing" });
    expect(pulseChip(lapsed)).toEqual({ tone: "danger", label: "Lost track · catch up" });
    expect(pulseChip({ ...base, state: "off", reason: "deviated" })?.label).toBe("Off plan");
    expect(pulseChip({ ...base, state: "asleep", reason: "asleep" })?.label).toBe("Asleep");
    expect(pulseChip({ ...base, state: "free", reason: "free" })?.label).toBe("Free");
  });
  it("words the You row", () => {
    expect(pulseSentence(lapsed)).toMatch(/Contact was lost/);
    expect(pulseSentence(unknown)).toBe("Still doing Write report? Say so on Now.");
    expect(pulseSentence({ ...base, doing: { kind: "action", id: "a", title: "Write report" } })).toBe(
      "On plan · Write report"
    );
  });
  it("asks the unknown question with what the pulse says, else the check-in's title", () => {
    expect(stillDoingQuestion(unknown, "Other")).toBe("Still doing Write report?");
    expect(stillDoingQuestion({ ...unknown, doing: undefined }, "Other")).toBe("Still doing Other?");
    expect(stillDoingQuestion(undefined, "")).toBe("Still on plan?");
  });
});

describe("thresholds", () => {
  const [first, prompts, cap] = THRESHOLDS;
  it("shows the contract defaults", () => {
    expect([first!.fallback, prompts!.fallback, cap!.fallback]).toEqual([30, 1, 60]);
  });
  it("reads blank as the default, a number as itself, and bad entries as a message", () => {
    expect(parseThreshold(first!, "  ")).toBeNull();
    expect(parseThreshold(first!, "45")).toBe(45);
    expect(parseThreshold(prompts!, "0")).toBe(0);
    expect(parseThreshold(first!, "4")).toBe("Between 5 and 480.");
    expect(parseThreshold(prompts!, "11")).toBe("Between 0 and 10.");
    expect(parseThreshold(cap!, "1.5")).toMatch(/whole number/);
  });
  it("labels the allowance", () => {
    expect(checkInAllowanceLabel(null)).toBe("Default (+15 min)");
    expect(checkInAllowanceLabel(0)).toBe("+0 min");
  });
});
