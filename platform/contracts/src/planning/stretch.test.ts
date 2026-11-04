import { describe, expect, it } from "vitest";
import {
  agentStretchProblems,
  parseStretchOffer,
  stretchCommandSchema,
  stretchNextStep,
  stretchOfferText,
  type StretchOfferView
} from "./stretch.js";

const commandId = "9f1c6f0e-2a37-4a8e-8d52-0e1f4a0c7b11";
const TZ = "Australia/Brisbane";
const NOW = new Date("2026-11-04T12:00:00Z"); // 22:00 in Brisbane

const oneStep: StretchOfferView = {
  actionId: "act-1",
  title: "Unit 3 reading",
  declaredEnergy: "medium",
  requiredEnergy: "high",
  energyGap: 1,
  minutes: 40,
  cappedAtMinutes: null,
  reason: "external_within_48h",
  externalDeadlineAt: "2026-11-05T23:00:00Z",
  latestSafeStartAt: null
};
const twoStep: StretchOfferView = {
  ...oneStep,
  declaredEnergy: "low",
  minutes: 45,
  cappedAtMinutes: 45,
  reason: "at_risk_external"
};
const overdue: StretchOfferView = {
  ...oneStep,
  reason: "overdue_external",
  externalDeadlineAt: "2026-11-03T23:00:00Z"
};

describe("stretchCommandSchema", () => {
  it("takes accept and decline with an action, and decline_all with none", () => {
    expect(stretchCommandSchema.parse({ commandId, choice: "accept", actionId: " act-1 " })).toMatchObject({
      actionId: "act-1",
      basis: "inferred"
    });
    expect(stretchCommandSchema.safeParse({ commandId, choice: "decline", actionId: "act-1" }).success).toBe(true);
    expect(stretchCommandSchema.safeParse({ commandId, choice: "decline_all" }).success).toBe(true);
  });

  it("needs an action for accept and decline", () => {
    for (const choice of ["accept", "decline"]) {
      const parsed = stretchCommandSchema.safeParse({ commandId, choice });
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues[0]?.path).toEqual(["actionId"]);
    }
  });

  it("needs the person's words when the basis is stated, like re-entry", () => {
    const missing = stretchCommandSchema.safeParse({ commandId, choice: "accept", actionId: "a", basis: "stated" });
    expect(missing.success).toBe(false);
    expect(missing.error?.issues[0]?.path).toEqual(["evidence"]);
    expect(
      stretchCommandSchema.safeParse({
        commandId,
        choice: "accept",
        actionId: "a",
        basis: "stated",
        evidence: "Yes, do the reading."
      }).success
    ).toBe(true);
  });

  it("refuses evidence over 300 characters, an unknown choice and a client-supplied end", () => {
    expect(
      stretchCommandSchema.safeParse({ commandId, choice: "accept", actionId: "a", evidence: "x".repeat(301) }).success
    ).toBe(false);
    expect(stretchCommandSchema.safeParse({ commandId, choice: "later", actionId: "a" }).success).toBe(false);
    // `until` and `minutes` are not part of the command: they are stripped, never read.
    expect(
      stretchCommandSchema.parse({
        commandId,
        choice: "accept",
        actionId: "a",
        until: "2099-01-01T00:00:00Z",
        minutes: 999
      })
    ).not.toHaveProperty("until");
  });
});

describe("agentStretchProblems", () => {
  const refusal =
    "Only the person can say yes or no to a stretch. Next: ask the person; if they answered, call openrhen_stretch again with basis stated, evidence set to their own words (up to 300 characters), and a NEW command-id. If they cannot be reached, do nothing; do not raise declared energy instead.";

  it("refuses an unstated accept or decline with the exact text", () => {
    expect(agentStretchProblems({ choice: "accept", basis: "inferred" })).toEqual([refusal]);
    expect(agentStretchProblems({ choice: "decline", basis: "inferred" })).toEqual([refusal]);
  });

  it("lets a stated answer through and lets decline_all be inferred, since it only restricts", () => {
    expect(agentStretchProblems({ choice: "accept", basis: "stated" })).toEqual([]);
    expect(agentStretchProblems({ choice: "decline", basis: "stated" })).toEqual([]);
    expect(agentStretchProblems({ choice: "decline_all", basis: "inferred" })).toEqual([]);
  });
});

describe("stretchOfferText", () => {
  const options = { timeZone: TZ, locale: "en-AU", now: NOW };

  it("describes a one-step gap neutrally: the date, the energy, the length, the end, both choices", () => {
    const text = stretchOfferText(oneStep, options);
    expect(text).toContain("Unit 3 reading has an outside deadline on");
    expect(text).toContain("needs high energy; you said medium");
    expect(text).toContain("for 40 minutes now, ending at 22:40");
    expect(text).toContain("or rest and come back to it fresh. Both are reasonable.");
    expect(text).not.toMatch(/anyway/i);
    expect(text).not.toMatch(/set by you|you set|you put/i);
    expect(text).not.toContain("45");
  });

  it("names the 45 minute cap for a two-step gap", () => {
    const text = stretchOfferText(twoStep, options);
    expect(text).toContain("needs high energy; you said low");
    expect(text).toContain("up to 45 minutes (the most for a two-step energy gap is 45)");
    expect(text).toContain("ending at 22:45");
  });

  it("says an overdue date has passed", () => {
    const text = stretchOfferText(overdue, options);
    expect(text).toContain("had an outside deadline that passed on");
    expect(text).not.toContain("has an outside deadline on");
  });

  it("copes with no date and an unknown time zone", () => {
    expect(stretchOfferText({ ...oneStep, externalDeadlineAt: null }, options)).toContain(
      "Unit 3 reading has an outside deadline and needs"
    );
    expect(stretchOfferText(oneStep, { ...options, timeZone: "Not/AZone" })).toContain("ending at 12:40");
  });

  it("prints the end in the person's own zone", () => {
    expect(stretchOfferText(oneStep, { ...options, timeZone: "UTC" })).toContain("ending at 12:40");
  });
});

describe("parseStretchOffer", () => {
  it("round-trips the engine's JSON form, ISO strings and nulls included", () => {
    const wire = JSON.parse(JSON.stringify({ ...twoStep, latestSafeStartAt: "2026-11-05T09:00:00Z" }));
    expect(parseStretchOffer(wire)).toEqual({ ...twoStep, latestSafeStartAt: "2026-11-05T09:00:00Z" });
    expect(parseStretchOffer(JSON.parse(JSON.stringify(oneStep)))).toEqual(oneStep);
  });

  it("reads an absent date as null and returns null for no offer or a malformed one", () => {
    const { externalDeadlineAt: _a, latestSafeStartAt: _b, cappedAtMinutes: _c, ...rest } = oneStep;
    expect(parseStretchOffer(rest)).toMatchObject({
      externalDeadlineAt: null,
      latestSafeStartAt: null,
      cappedAtMinutes: null
    });
    expect(parseStretchOffer(undefined)).toBeNull();
    expect(parseStretchOffer(null)).toBeNull();
    expect(parseStretchOffer({ ...oneStep, energyGap: 3 })).toBeNull();
    expect(parseStretchOffer({ ...oneStep, externalDeadlineAt: "tomorrow" })).toBeNull();
  });
});

describe("stretchNextStep", () => {
  it("tells what comes next after each answer", () => {
    const base = { timeZone: TZ, locale: "en-AU" };
    expect(stretchNextStep("declined_all", base)).toBe("No stretches until tomorrow; do not raise it again.");
    expect(stretchNextStep("declined", { ...base, title: "Unit 3" })).toContain("do not offer it again until tomorrow");
    const accepted = stretchNextStep("accepted", { ...base, title: "Unit 3", until: "2026-11-04T13:10:00Z" });
    expect(accepted).toContain("Stretch started: Unit 3 until 23:10.");
    expect(accepted).toContain("rhen_undo reverses it");
  });
});
