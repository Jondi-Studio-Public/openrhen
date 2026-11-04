import { describe, expect, it } from "vitest";
import {
  agentStretchProblems,
  buildStretchAnswer,
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

describe("buildStretchAnswer", () => {
  const locale = "en-AU";
  const recommendation = { stretchOffer: oneStep };
  const base = { recommendation, stretch: undefined, now: NOW, timeZone: TZ, locale } as const;
  const record = (acceptedAt: string, minutes = 40, actionId = "act-1") => ({
    actionId,
    title: "Unit 3 reading",
    acceptedAt,
    until: new Date(new Date(acceptedAt).getTime() + minutes * 60_000).toISOString(),
    minutes,
    by: "person" as const
  });

  it("carries the offer, its sentence and the agent instruction", () => {
    const { stretchOffer, stretch } = buildStretchAnswer(base);
    expect(stretchOffer).toMatchObject({ actionId: "act-1", minutes: 40, endsAt: "2026-11-04T12:40:00.000Z" });
    expect(stretchOffer?.text).toBe(stretchOfferText(oneStep, { timeZone: TZ, locale, now: NOW }));
    expect(stretchOffer?.next).toContain("Only the person answers");
    expect(stretchOffer?.next).toContain("never raise declared energy");
    expect(stretchOffer?.next).not.toMatch(/anyway/i);
    expect(stretch).toBeNull();
  });

  it("has no offer for a missing or malformed one, or while the plan is not current", () => {
    expect(buildStretchAnswer({ ...base, recommendation: {} }).stretchOffer).toBeNull();
    expect(buildStretchAnswer({ ...base, recommendation: { stretchOffer: { actionId: 1 } } }).stretchOffer).toBeNull();
    expect(buildStretchAnswer({ ...base, recommendation: null }).stretchOffer).toBeNull();
    expect(buildStretchAnswer({ ...base, planCurrent: false }).stretchOffer).toBeNull();
  });

  it("hides the offer an answer already ruled out, before the plan recalculates", () => {
    const at = "2026-11-04T11:00:00.000Z";
    const declined = { accepted: [], declined: [{ actionId: "act-1", at }] };
    expect(buildStretchAnswer({ ...base, stretch: declined }).stretchOffer).toBeNull();
    const other = { accepted: [], declined: [{ actionId: "act-2", at }] };
    expect(buildStretchAnswer({ ...base, stretch: other }).stretchOffer).not.toBeNull();
    const all = { accepted: [], declined: [], declinedAllAt: at };
    expect(buildStretchAnswer({ ...base, stretch: all }).stretchOffer).toBeNull();
    // A no from yesterday does not count.
    const old = { accepted: [], declined: [], declinedAllAt: "2026-11-02T11:00:00.000Z" };
    expect(buildStretchAnswer({ ...base, stretch: old }).stretchOffer).not.toBeNull();
    // A decline from before the energy was said again does not count either.
    expect(
      buildStretchAnswer({ ...base, stretch: declined, energySetAt: "2026-11-04T11:30:00.000Z" }).stretchOffer
    ).not.toBeNull();
    const running = { accepted: [record("2026-11-04T11:50:00.000Z")], declined: [] };
    expect(
      buildStretchAnswer({ ...base, stretch: running, energySetAt: "2026-11-04T10:00:00.000Z" }).stretchOffer
    ).toBeNull();
  });

  it("drops an offer from a plan older than the energy it was made for", () => {
    const energySetAt = "2026-11-04T11:00:00.000Z";
    expect(
      buildStretchAnswer({ ...base, energySetAt, planCalculatedAt: "2026-11-04T10:00:00.000Z" }).stretchOffer
    ).toBeNull();
    expect(
      buildStretchAnswer({ ...base, energySetAt, planCalculatedAt: "2026-11-04T11:30:00.000Z" }).stretchOffer
    ).not.toBeNull();
  });

  it("reports the active stretch", () => {
    const stretch = { accepted: [record("2026-11-04T11:50:00.000Z")], declined: [] };
    const answer = buildStretchAnswer({
      ...base,
      recommendation: {},
      stretch,
      energySetAt: "2026-11-04T10:00:00.000Z"
    });
    expect(answer.stretchOffer).toBeNull();
    expect(answer.stretch?.active).toMatchObject({ title: "Unit 3 reading", until: "2026-11-04T12:30:00.000Z" });
    expect(answer.stretch?.loan).toBeUndefined();
  });

  it("names the count and clock times from the second stretch of the day, neutrally", () => {
    // 20:30 Brisbane, already ended; now 22:00.
    const first = { accepted: [record("2026-11-04T10:30:00.000Z")], declined: [] };
    const offered = buildStretchAnswer({ ...base, stretch: first });
    expect(offered.stretch?.today?.note).toBe(
      "This would be your second stretch today; the earlier one began at 20:30."
    );
    expect(offered.stretch?.today?.count).toBe(1);
    const second = { accepted: [...first.accepted, record("2026-11-04T11:00:00.000Z")], declined: [] };
    const again = buildStretchAnswer({ ...base, recommendation: {}, stretch: second });
    expect(again.stretch?.today?.note).toBe("2 stretches today, begun at 20:30 and 21:00.");
    // One stretch with no offer says nothing about a count.
    expect(buildStretchAnswer({ ...base, recommendation: {}, stretch: first }).stretch?.today).toBeUndefined();
  });

  it("gives the morning-after loan line only for a stretch that ended before today", () => {
    const morning = new Date("2026-11-04T22:30:00Z"); // 08:30 on 5 Nov in Brisbane
    const stretch = { accepted: [record("2026-11-04T12:30:00.000Z")], declined: [] }; // 22:30 to 23:10 on the 4th
    const answer = buildStretchAnswer({ ...base, recommendation: {}, stretch, now: morning });
    expect(answer.stretch?.loan?.line).toBe("Last night: 40 minutes of Unit 3 reading, ended 23:10");
    // Same evening: not a loan yet.
    expect(
      buildStretchAnswer({ ...base, recommendation: {}, stretch, now: new Date("2026-11-04T13:30:00Z") }).stretch
    ).toBeNull();
    // Three days on it is named by weekday, not "last night".
    const later = buildStretchAnswer({ ...base, recommendation: {}, stretch, now: new Date("2026-11-07T22:30:00Z") });
    expect(later.stretch?.loan?.line).toMatch(/^Wednesday: 40 minutes of Unit 3 reading, ended 23:10$/);
    // A stretch taken again today replaces the old line.
    const again = {
      accepted: [...stretch.accepted, record("2026-11-04T23:00:00.000Z")],
      declined: []
    };
    expect(
      buildStretchAnswer({ ...base, recommendation: {}, stretch: again, now: morning }).stretch?.loan
    ).toBeUndefined();
  });

  it("does not call a stretch active once energy was declared again, or when energy was never stamped", () => {
    const stretch = { accepted: [record("2026-11-04T02:45:00.000Z")], declined: [] }; // 12:45 Brisbane
    const at = new Date("2026-11-04T02:50:00.000Z");
    const args = { ...base, recommendation: {}, stretch, now: at };
    expect(buildStretchAnswer({ ...args, energySetAt: "2026-11-04T02:48:00.000Z" }).stretch?.active).toBeUndefined();
    expect(buildStretchAnswer({ ...args, energySetAt: "2026-11-04T02:30:00.000Z" }).stretch?.active).toBeDefined();
    expect(buildStretchAnswer(args).stretch?.active).toBeUndefined();
  });

  it("gives the loan line for a stretch that crossed midnight", () => {
    const zone = "Australia/Sydney";
    // Accepted 23:45 on 4 Nov local (12:45Z), until 00:30 on the 5th; now 08:00 on the 5th.
    const stretch = {
      accepted: [record("2026-11-04T12:45:00.000Z", 45)],
      declined: []
    };
    const answer = buildStretchAnswer({
      ...base,
      recommendation: {},
      stretch,
      timeZone: zone,
      now: new Date("2026-11-04T21:00:00.000Z")
    });
    expect(answer.stretch?.loan?.line).toBe("Last night: 45 minutes of Unit 3 reading, ended 00:30");
  });

  it("treats a malformed stretch as absent instead of throwing", () => {
    const bad = { accepted: "nope", declined: [{ actionId: "act-1", at: "not a date" }] } as never;
    expect(() => buildStretchAnswer({ ...base, stretch: bad })).not.toThrow();
    expect(buildStretchAnswer({ ...base, stretch: bad }).stretchOffer).not.toBeNull();
    const mixed = {
      accepted: [{ ...record("2026-11-04T11:50:00.000Z"), until: "garbage" }, record("2026-11-04T11:55:00.000Z")],
      declined: []
    };
    const answer = buildStretchAnswer({
      ...base,
      recommendation: {},
      stretch: mixed,
      energySetAt: "2026-11-04T10:00:00.000Z"
    });
    expect(answer.stretch?.active?.until).toBe("2026-11-04T12:35:00.000Z");
  });
});
