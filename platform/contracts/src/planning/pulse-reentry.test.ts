import { describe, expect, it } from "vitest";
import {
  agentBulkResetProblems,
  agentFactsProblems,
  reentryAnswerGuide,
  REENTRY_REQUIRED_INSTRUCTION,
  reentryExampleCall,
  reentryLeavesOnLedger,
  groupReentryEntries,
  incompleteReentryMessage,
  missingReentryFacts,
  planReentrySettlement,
  reenterCommandSchema,
  reentryMissingLines,
  reentryRequiredBody,
  reentryRequirementLines,
  type PulseReentryView,
  type ReentryEntry
} from "./pulse-reentry.js";
import { reentryTier } from "./pulse-state.js";

const TZ = "Australia/Brisbane";
const commandId = "9f1c6f0e-2a37-4a8e-8d52-0e1f4a0c7b11";

const occurrence = (id: string, day: string, projectId = "p1"): ReentryEntry => ({
  id: `occurrence:${id}`,
  kind: "occurrence",
  title: `Stretch ${id}`,
  plannedAt: `${day}T08:00:00+10:00`,
  localDate: day,
  projectId,
  projectTitle: projectId === "p1" ? "Health" : "Maths",
  version: null
});
const selfDate = (projectId: string, day: string): ReentryEntry => ({
  id: `deadline:${projectId}`,
  kind: "self_set_deadline",
  title: projectId === "p1" ? "Health" : "Maths",
  plannedAt: `${day}T17:00:00+10:00`,
  localDate: null,
  projectId,
  projectTitle: projectId === "p1" ? "Health" : "Maths",
  version: 3
});
const externalDate = (projectId: string, day: string): ReentryEntry => ({
  ...selfDate(projectId, day),
  id: `deadline:${projectId}`,
  kind: "external_deadline"
});

describe("reentryTier", () => {
  it("picks the review from the gap, at each boundary", () => {
    expect(reentryTier(119)).toBe("none");
    expect(reentryTier(120)).toBe("today");
    expect(reentryTier(36 * 60 - 1)).toBe("today");
    expect(reentryTier(36 * 60)).toBe("days");
    expect(reentryTier(7 * 24 * 60 - 1)).toBe("days");
    expect(reentryTier(7 * 24 * 60)).toBe("projects");
  });
});

describe("reenterCommandSchema", () => {
  it("accepts an empty answer, so the server can name what is missing", () => {
    const parsed = reenterCommandSchema.parse({ commandId });
    expect(parsed).toMatchObject({ basis: "inferred", settlement: {} });
    expect(missingReentryFacts(parsed)).toEqual(["location", "energy", "contexts"]);
  });

  it("treats an empty context list as an answer ('none') but not an absent one", () => {
    expect(missingReentryFacts({ locationId: "home", energy: "low", contexts: [] })).toEqual([]);
    expect(missingReentryFacts({ locationId: "home", energy: "low" })).toEqual(["contexts"]);
  });

  it("needs the person's words for a stated re-entry and refuses an unknown energy or day form", () => {
    expect(reenterCommandSchema.safeParse({ commandId, basis: "stated" }).success).toBe(false);
    expect(reenterCommandSchema.safeParse({ commandId, energy: "tired" }).success).toBe(false);
    expect(
      reenterCommandSchema.safeParse({
        commandId,
        settlement: { days: [{ day: "monday", answer: "nothing_recorded" }] }
      }).success
    ).toBe(false);
  });
});

describe("groupReentryEntries", () => {
  const entries = [
    occurrence("a", "2026-10-12"),
    selfDate("p1", "2026-10-13"),
    occurrence("b", "2026-10-13", "p2"),
    selfDate("p2", "2026-10-12")
  ];

  it("reviews nothing under two hours", () => {
    expect(groupReentryEntries(entries, "none", TZ)).toEqual({ items: [], days: [], projects: [] });
  });

  it("lists the reviewable things item by item at today, never the recurring occurrences", () => {
    const groups = groupReentryEntries(entries, "today", TZ);
    expect(groups.items.map((entry) => entry.id)).toEqual(["deadline:p1", "deadline:p2"]);
    expect(groups.days).toEqual([]);
  });

  it("groups by local day, newest first, from 36 hours", () => {
    const groups = groupReentryEntries(entries, "days", TZ);
    expect(groups.days.map((day) => [day.day, day.entries.map((entry) => entry.id)])).toEqual([
      ["2026-10-13", ["deadline:p1"]],
      ["2026-10-12", ["deadline:p2"]]
    ]);
    expect(groups.items).toEqual([]);
  });

  it("puts a deadline planned late in the evening on its local day, not the UTC one", () => {
    const late: ReentryEntry = { ...selfDate("p1", "2026-10-13"), plannedAt: "2026-10-13T23:30:00+10:00" };
    expect(groupReentryEntries([late], "days", TZ).days[0]?.day).toBe("2026-10-13");
  });

  it("groups by project from seven days, the busiest first, with the project's name", () => {
    const groups = groupReentryEntries([...entries, selfDate("p2", "2026-10-14")].slice(1), "projects", TZ);
    expect(groups.projects[0]).toMatchObject({ projectId: "p2", title: "Maths" });
    expect(groups.projects.map((project) => project.projectId)).toEqual(["p2", "p1"]);
  });
});

describe("planReentrySettlement", () => {
  it("lapses recurring occurrences as missed without asking, and names none of them as unreviewed", () => {
    const plan = planReentrySettlement([occurrence("a", "2026-10-12"), occurrence("b", "2026-10-12")], "today", {}, TZ);
    expect(plan.unreviewed).toEqual([]);
    expect(plan.lapsing).toBe(2);
    expect(plan.verdicts).toEqual([
      { verdict: { entryId: "occurrence:a", verdict: "skipped" }, unrecorded: true },
      { verdict: { entryId: "occurrence:b", verdict: "skipped" }, unrecorded: true }
    ]);
  });

  it("under two hours reviews nothing: the gap is the still-doing-X line", () => {
    const plan = planReentrySettlement([selfDate("p1", "2026-10-13")], "none", {}, TZ);
    expect(plan.unreviewed).toEqual([]);
    expect(plan.verdicts).toEqual([]);
  });

  it("at today names each item nobody answered, and applies the answer given", () => {
    const entries = [selfDate("p1", "2026-10-13"), externalDate("p2", "2026-10-13")];
    expect(planReentrySettlement(entries, "today", {}, TZ).unreviewed.map((entry) => entry.id)).toEqual([
      "deadline:p1",
      "deadline:p2"
    ]);
    const plan = planReentrySettlement(entries, "today", { items: [{ entryId: "deadline:p1", verdict: "done" }] }, TZ);
    expect(plan.unreviewed.map((entry) => entry.id)).toEqual(["deadline:p2"]);
    expect(plan.verdicts).toEqual([{ verdict: { entryId: "deadline:p1", verdict: "done" }, unrecorded: false }]);
  });

  it("refuses a day or project answer at the item-by-item tier, and says what to answer instead", () => {
    const plan = planReentrySettlement(
      [selfDate("p1", "2026-10-13")],
      "today",
      { days: [{ day: "2026-10-13", answer: "nothing_recorded" }], startFresh: true },
      TZ
    );
    expect(plan.problems.join(" ")).toMatch(/days answers are not accepted/);
    expect(plan.problems.join(" ")).toMatch(/startFresh is not accepted/);
    expect(plan.unreviewed).toHaveLength(1);
  });

  it("covers a day with one tap, which carries a lapsed own date as it is and never writes done", () => {
    const plan = planReentrySettlement(
      [occurrence("a", "2026-10-12"), selfDate("p1", "2026-10-12")],
      "days",
      { days: [{ day: "2026-10-12", answer: "nothing_recorded" }] },
      TZ
    );
    expect(plan.unreviewed).toEqual([]);
    expect(plan.verdicts.map((entry) => [entry.verdict.verdict, entry.unrecorded])).toEqual([
      ["skipped", true],
      ["pending", true]
    ]);
    expect(plan.verdicts.every((entry) => entry.verdict.verdict !== "done")).toBe(true);
  });

  it("lets an item answer be the exception inside a day that was tapped", () => {
    const plan = planReentrySettlement(
      [selfDate("p1", "2026-10-12"), selfDate("p2", "2026-10-12")],
      "days",
      {
        days: [{ day: "2026-10-12", answer: "nothing_recorded" }],
        items: [{ entryId: "deadline:p2", verdict: "done", at: "2026-10-12T10:00:00+10:00" }]
      },
      TZ
    );
    expect(plan.verdicts.find((entry) => entry.verdict.entryId === "deadline:p2")).toEqual({
      verdict: { entryId: "deadline:p2", verdict: "done", at: "2026-10-12T10:00:00+10:00" },
      unrecorded: false
    });
    expect(plan.verdicts.find((entry) => entry.verdict.entryId === "deadline:p1")?.unrecorded).toBe(true);
  });

  it("never covers an external date in bulk, at any tier", () => {
    const entries = [externalDate("p1", "2026-10-12")];
    for (const settlement of [
      { days: [{ day: "2026-10-12", answer: "nothing_recorded" as const }] },
      { projects: [{ projectId: "p1", answer: "keep_open" as const }] },
      { startFresh: true }
    ])
      expect(planReentrySettlement(entries, "projects", settlement, TZ).unreviewed).toHaveLength(1);
  });

  it("at projects: keep_open lapses the project's occurrences and leaves its dates; drop_all cancels and clears", () => {
    const entries = [occurrence("a", "2026-09-01"), selfDate("p1", "2026-09-02"), occurrence("b", "2026-09-01", "p2")];
    const keep = planReentrySettlement(
      entries,
      "projects",
      {
        projects: [
          { projectId: "p1", answer: "keep_open" },
          { projectId: "p2", answer: "drop_all" }
        ]
      },
      TZ
    );
    expect(keep.unreviewed).toEqual([]);
    expect(keep.verdicts.map((entry) => [entry.verdict.entryId, entry.verdict.verdict])).toEqual([
      ["occurrence:a", "skipped"],
      ["deadline:p1", "pending"],
      ["occurrence:b", "dropped"]
    ]);
    const drop = planReentrySettlement(
      entries,
      "projects",
      { projects: [{ projectId: "p1", answer: "drop_all" }] },
      TZ
    );
    expect(drop.verdicts.find((entry) => entry.verdict.entryId === "deadline:p1")?.verdict.verdict).toBe("skipped");
  });

  it("start fresh covers every project with the soft reset, and keep_open still wins for a named project", () => {
    const entries = [selfDate("p1", "2026-09-02"), selfDate("p2", "2026-09-02")];
    const plan = planReentrySettlement(
      entries,
      "projects",
      { startFresh: true, projects: [{ projectId: "p2", answer: "keep_open" }] },
      TZ
    );
    expect(plan.unreviewed).toEqual([]);
    expect(plan.verdicts.map((entry) => [entry.verdict.entryId, entry.verdict.verdict])).toEqual([
      ["deadline:p1", "skipped"],
      ["deadline:p2", "pending"]
    ]);
  });

  it("rejects an answer for an entry outside the window and one answered twice", () => {
    const plan = planReentrySettlement(
      [selfDate("p1", "2026-10-13")],
      "today",
      {
        items: [
          { entryId: "deadline:zzz", verdict: "skipped" },
          { entryId: "deadline:p1", verdict: "pending" },
          { entryId: "deadline:p1", verdict: "done" }
        ]
      },
      TZ
    );
    expect(plan.problems).toEqual(["deadline:zzz is not an entry in this window.", "deadline:p1 is answered twice."]);
  });
});

describe("the incomplete answer and the gate refusal", () => {
  it("names each missing fact and unreviewed item in the rejection", () => {
    const lines = reentryMissingLines(["location", "energy"], [selfDate("p1", "2026-10-13")]);
    expect(lines).toEqual(["location", "energy", 'review deadline:p1 "Health" (planned 2026-10-13)']);
    const message = incompleteReentryMessage(lines, [], "today");
    expect(message).toContain("nothing was written");
    expect(message).toContain("location; energy; review deadline:p1");
    expect(message).toContain("Ask the owner");
  });

  it("states the three facts and the number of items a status line asks for", () => {
    expect(reentryRequirementLines("none", 4)).toEqual(["location", "energy", "contexts"]);
    expect(reentryRequirementLines("days", 2)).toEqual([
      "location",
      "energy",
      "contexts",
      "review 2 items (gap of 36 hours to 7 days)"
    ]);
  });

  it("carries the instruction, the pulse fields and missing, and nothing else", () => {
    const view: PulseReentryView = {
      state: "off",
      reason: "lapsed",
      since: "2026-10-28T01:00:00.000Z",
      lastConfirmedAt: "2026-10-27T01:00:00.000Z",
      silenceUntil: null,
      reentry: { due: true, tier: "today", gapMinutes: 1440, missing: ["location", "energy", "contexts"] }
    };
    const body = reentryRequiredBody(view);
    expect(Object.keys(body).sort()).toEqual(["code", "error", "missing", "pulse"]);
    expect(body.code).toBe("reentryRequired");
    expect(body.error).toBe(REENTRY_REQUIRED_INSTRUCTION);
    expect(body.error).toMatch(
      /^You must call rhen_reenter and complete it before anything else; ask the owner for what you do not know\./
    );
    expect(body.error).toContain("with no arguments");
    expect(body.error).toContain("never guess or infer");
    expect(body.error).toContain("Never send startFresh or drop_all");
    expect(body.error).toContain("repeat the call that was refused");
    expect(body.pulse).toEqual(view);
  });
});

describe("agentBulkResetProblems", () => {
  it("refuses startFresh and drop_all from an inferred agent", () => {
    expect(agentBulkResetProblems({ startFresh: true }, "inferred")).toHaveLength(1);
    const [problem] = agentBulkResetProblems({ startFresh: true }, "inferred");
    expect(problem).toContain("ask the owner");
    expect(problem).toContain("basis stated");
    expect(problem).toContain("NEW command-id");
    expect(problem).not.toMatch(/\b(he|his|him)\b/);
    expect(agentBulkResetProblems({ projects: [{ projectId: "p", answer: "drop_all" }] }, "inferred")).toHaveLength(1);
    expect(
      agentBulkResetProblems({ startFresh: true, projects: [{ projectId: "p", answer: "drop_all" }] }, "inferred")
    ).toHaveLength(2);
  });
  it("allows them when the owner stated it, and allows keep_open and days always", () => {
    expect(agentBulkResetProblems({ startFresh: true }, "stated")).toEqual([]);
    expect(agentBulkResetProblems({ projects: [{ projectId: "p", answer: "keep_open" }] }, "inferred")).toEqual([]);
    expect(agentBulkResetProblems({ days: [{ day: "2026-10-30", answer: "nothing_recorded" }] }, "inferred")).toEqual(
      []
    );
  });
});

describe("entries re-entry leaves on the catch-up ledger", () => {
  const base = { plannedAt: "2026-10-30T00:00:00Z", localDate: null, projectId: null, version: 1 } as const;
  const entries = [
    { ...base, id: "occurrence:o1", kind: "occurrence", title: "Stretch" },
    { ...base, id: "wake", kind: "stale_wake", title: "Wake" },
    { ...base, id: "check-in:c1", kind: "check_in", title: "Check-in" },
    { ...base, id: "session:s1", kind: "open_session", title: "Session" }
  ] as unknown as ReentryEntry[];

  it("lapses only the occurrence and never produces a verdict for a wake, check-in or session", () => {
    const plan = planReentrySettlement(entries, "days", {}, "Australia/Sydney");
    expect(plan.verdicts.map((v) => v.verdict.entryId)).toEqual(["occurrence:o1"]);
    expect(plan.lapsing).toBe(1);
    expect(plan.unreviewed).toEqual([]);
    expect(entries.filter(reentryLeavesOnLedger).map((e) => e.id)).toEqual(["wake", "check-in:c1", "session:s1"]);
  });

  it("refuses an explicit answer for them and points at catch-up-settle", () => {
    const plan = planReentrySettlement(
      entries,
      "days",
      { items: [{ entryId: "wake", verdict: "done" }] },
      "Australia/Sydney"
    );
    expect(plan.problems.join(" ")).toContain("catch-up-settle");
    expect(plan.verdicts.map((v) => v.verdict.entryId)).toEqual(["occurrence:o1"]);
  });
});

describe("the example call", () => {
  it("fills the first saved ids and says to replace them", () => {
    const call = reentryExampleCall({
      places: [{ id: "p1" }],
      contexts: [{ id: "desktop" }, { id: "online" }, { id: "x" }]
    });
    expect(call).toContain("location=p1");
    expect(call).toContain("contexts=desktop,online");
    expect(call).toContain("replace every value");
    expect(call).toContain("basis=stated");
  });
});

describe("an agent's facts must be the owner's words (F21, F28)", () => {
  const facts = { locationId: "home", energy: "medium" as const, contexts: ["laptop"] };
  it("refuses location, energy or contexts sent inferred or with no basis, and says to ask and resend stated", () => {
    const [problem] = agentFactsProblems({ ...facts, basis: "inferred" });
    expect(problem).toContain("location, energy, contexts");
    expect(problem).toContain("ask the owner");
    expect(problem).toContain("basis stated");
    expect(problem).toContain("evidence set to the owner's own words");
    expect(problem).toContain("NEW command-id");
    expect(problem).toContain("cannot be reached, stop");
    expect(problem).toContain("do not guess");
    expect(agentFactsProblems({ locationId: "home", basis: "inferred" })[0]).toContain("You sent location without");
  });
  it("lets a stated basis through and has nothing to say when no fact was sent", () => {
    expect(agentFactsProblems({ ...facts, basis: "stated" })).toEqual([]);
    expect(agentFactsProblems({ basis: "inferred" })).toEqual([]);
  });
});

describe("the refusal reads as a sentence even when no fact is missing", () => {
  it("does not print an empty 'Still needed:' when only a problem remains", () => {
    const message = incompleteReentryMessage([], ["startFresh is not accepted for a gap."], "days", 0);
    expect(message).not.toContain("Still needed: .");
    expect(message).toContain("The three facts are complete");
    expect(message).toContain("startFresh is not accepted");
  });

  it("says startFresh 'is' not accepted, not 'are'", () => {
    const plan = planReentrySettlement([], "days", { startFresh: true } as never, TZ);
    expect(plan.problems[0]).toMatch(/^startFresh is not accepted/);
  });
});

describe("the settlement is asked for only when the gap has something to review (F20)", () => {
  it("leaves the settlement out of the refusal when nothing is reviewable", () => {
    const none = incompleteReentryMessage(["location"], [], "days", 0);
    expect(none).toContain("settlement-json may be left out");
    expect(none).not.toContain("settlement.days");
    expect(incompleteReentryMessage(["location"], [], "none")).toContain("may be left out");
  });
  it("names the days to answer when there are reviewable entries", () => {
    expect(incompleteReentryMessage(["location"], [], "days", 2)).toContain("settlement.days");
    expect(incompleteReentryMessage(["location"], [], "days")).toContain("settlement.days");
  });
});

describe("reentryAnswerGuide (F23)", () => {
  const places = [{ id: "home" }];
  const contexts = [{ id: "laptop" }];
  it("lists the energies with the owner's meanings, falling back to defaults", () => {
    const guide = reentryAnswerGuide({
      tier: "days",
      entries: [],
      days: [],
      energyMeanings: { high: "Flow state" },
      places,
      contexts
    });
    expect(guide.energies).toEqual([
      { value: "high", meaning: "Flow state" },
      { value: "medium", meaning: "Steady concentration" },
      { value: "low", meaning: "Light work only" },
      { value: "recovery", meaning: "Rest and recovery" }
    ]);
  });
  it("says explicitly that settlement may be omitted when there is nothing to review", () => {
    const guide = reentryAnswerGuide({ tier: "days", entries: [], days: [], places, contexts });
    expect(guide.nothingToReview).toBe(true);
    expect(guide.settlementExample).toBeNull();
    expect(guide.toAnswer).toContain("may be left out");
    expect(guide.call).toContain('basis "stated"');
  });
  it("builds an exact settlement-json for tier days from the real days, external dates as items", () => {
    const own = selfDate("p1", "2026-10-13");
    const external = externalDate("p2", "2026-10-14");
    const guide = reentryAnswerGuide({
      tier: "days",
      entries: [own, external],
      days: [
        { day: "2026-10-14", entryIds: [external.id] },
        { day: "2026-10-13", entryIds: [own.id] }
      ],
      places,
      contexts
    });
    expect(guide.nothingToReview).toBe(false);
    expect(JSON.parse(guide.settlementExample!)).toEqual({
      days: [{ day: "2026-10-13", answer: "nothing_recorded" }],
      items: [{ entryId: "deadline:p2", verdict: "pending" }]
    });
    expect(guide.toAnswer).toContain("2026-10-14, 2026-10-13");
    // The example it prints is accepted by the planner: nothing is left unreviewed.
    const settlement = JSON.parse(guide.settlementExample!);
    expect(planReentrySettlement([own, external], "days", settlement, TZ).unreviewed).toEqual([]);
  });
  it("uses items for tier today", () => {
    const own = selfDate("p1", "2026-10-13");
    const guide = reentryAnswerGuide({ tier: "today", entries: [own], days: [], places, contexts });
    expect(JSON.parse(guide.settlementExample!)).toEqual({ items: [{ entryId: "deadline:p1", verdict: "pending" }] });
  });
});
