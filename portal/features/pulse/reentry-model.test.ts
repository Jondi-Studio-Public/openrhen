import { describe, expect, it } from "vitest";
import type { CatchUpEntry } from "@openrhen/contracts";
import {
  EMPTY_REENTRY_DRAFT,
  buildReenterBody,
  buildSettlement,
  gapPhrase,
  missingFacts,
  progressLine,
  refusalFrom,
  reentryProgress,
  setItem,
  setProject,
  toggleContext,
  toggleDay,
  unreviewedEntries,
  type ReentryDraft,
  type ReentryReview
} from "./reentry-model";

const TZ = "Australia/Sydney";
const entry = (id: string, over: Partial<CatchUpEntry> = {}): CatchUpEntry => ({
  id,
  kind: "self_set_deadline",
  title: id,
  question: null,
  verdicts: ["done", "skipped", "dropped", "pending"],
  atRequired: [],
  plannedAt: "2026-10-27T01:00:00.000Z",
  localDate: null,
  projectId: "p1",
  projectTitle: "Thesis",
  version: 2,
  ...over
});
const review = (
  tier: ReentryReview["tier"],
  entries: CatchUpEntry[],
  over: Partial<ReentryReview> = {}
): ReentryReview => ({
  tier,
  lastConfirmedAt: "2026-10-27T00:00:00.000Z",
  gapMinutes: 600,
  reviewable: entries.length,
  lapsing: 0,
  days: [],
  projects: [],
  entries,
  ...over
});
const facts: Partial<ReentryDraft> = { locationId: "home", energy: "medium", contexts: [] };
const draft = (over: Partial<ReentryDraft> = {}): ReentryDraft => ({ ...EMPTY_REENTRY_DRAFT, ...facts, ...over });

describe("facts", () => {
  it("names each missing fact, and treats an empty context list as an answer", () => {
    expect(missingFacts(EMPTY_REENTRY_DRAFT)).toEqual(["location", "energy", "contexts"]);
    expect(missingFacts(draft())).toEqual([]);
    expect(missingFacts(toggleContext(toggleContext(EMPTY_REENTRY_DRAFT, "a"), "a"))).toContain("energy");
    expect(toggleContext(EMPTY_REENTRY_DRAFT, "a").contexts).toEqual(["a"]);
  });
});

describe("tier none", () => {
  it("is complete with only the three facts", () => {
    expect(reentryProgress(review("none", []), draft(), TZ).complete).toBe(true);
    expect(reentryProgress(review("none", []), EMPTY_REENTRY_DRAFT, TZ).complete).toBe(false);
  });
});

describe("tier today", () => {
  const items = [entry("deadline:a"), entry("deadline:b")];
  it("needs every item answered, each defaulting to unreviewed", () => {
    const r = review("today", items);
    expect(unreviewedEntries(r, draft(), TZ).map((e) => e.id)).toEqual(["deadline:a", "deadline:b"]);
    const one = setItem(draft(), "deadline:a", "done");
    expect(unreviewedEntries(r, one, TZ).map((e) => e.id)).toEqual(["deadline:b"]);
    const all = setItem(one, "deadline:b", "pending");
    expect(reentryProgress(r, all, TZ).complete).toBe(true);
  });
  it("sends item verdicts with versions, and a dropped deadline pauses its project", () => {
    const r = review("today", items);
    const d = setItem(setItem(draft(), "deadline:a", "dropped"), "deadline:b", "done");
    expect(buildSettlement(r, d).items).toEqual([
      { entryId: "deadline:a", verdict: "dropped", version: 2, becomes: "paused" },
      { entryId: "deadline:b", verdict: "done", version: 2 }
    ]);
  });
  it("ignores a day tap, which this tier does not accept", () => {
    const r = review("today", items);
    expect(buildSettlement(r, toggleDay(draft(), "2026-10-27")).days).toBeUndefined();
  });
  it("clears an answer when tapped again", () => {
    expect(setItem(setItem(draft(), "x", "done"), "x", null).items).toEqual({});
  });
});

describe("tier days", () => {
  const a = entry("deadline:a", { localDate: "2026-10-26" });
  const ext = entry("deadline:e", { kind: "external_deadline", localDate: "2026-10-26" });
  const b = entry("deadline:b", { localDate: "2026-10-25" });
  const r = review("days", [a, ext, b], {
    days: [
      { day: "2026-10-26", entryIds: [a.id, ext.id] },
      { day: "2026-10-25", entryIds: [b.id] }
    ]
  });
  it("one tap covers a day's own items, but an external date still needs its own answer", () => {
    const tapped = toggleDay(toggleDay(draft(), "2026-10-26"), "2026-10-25");
    expect(unreviewedEntries(r, tapped, TZ).map((e) => e.id)).toEqual(["deadline:e"]);
    expect(reentryProgress(r, setItem(tapped, "deadline:e", "dropped"), TZ).complete).toBe(true);
  });
  it("sends the days tapped as nothing recorded, and toggling again removes it", () => {
    const tapped = toggleDay(draft(), "2026-10-26");
    expect(buildSettlement(r, tapped).days).toEqual([{ day: "2026-10-26", answer: "nothing_recorded" }]);
    expect(Object.keys(toggleDay(tapped, "2026-10-26").days)).toEqual([]);
  });
  it("lets an exception stand beside a tapped day", () => {
    const d = setItem(toggleDay(draft(), "2026-10-26"), "deadline:a", "done");
    const settlement = buildSettlement(r, d);
    expect(settlement.items).toHaveLength(1);
    expect(settlement.days).toHaveLength(1);
  });
});

describe("tier projects", () => {
  const a = entry("deadline:a", { projectId: "p1" });
  const b = entry("deadline:b", { projectId: "p2", projectTitle: "Garden" });
  const r = review("projects", [a, b], {
    projects: [
      { projectId: "p1", title: "Thesis", entryIds: [a.id] },
      { projectId: "p2", title: "Garden", entryIds: [b.id] }
    ]
  });
  it("is covered by an answer per project", () => {
    const d = setProject(setProject(draft(), "p1", "keep_open"), "p2", "drop_all");
    expect(reentryProgress(r, d, TZ).complete).toBe(true);
    expect(buildSettlement(r, d).projects).toEqual([
      { projectId: "p1", answer: "keep_open" },
      { projectId: "p2", answer: "drop_all" }
    ]);
  });
  it("is covered by start fresh, and leaves one project still asked", () => {
    expect(reentryProgress(r, draft({ startFresh: true }), TZ).complete).toBe(true);
    expect(unreviewedEntries(r, setProject(draft(), "p1", "keep_open"), TZ).map((e) => e.id)).toEqual(["deadline:b"]);
  });
  it("sends start fresh only at this tier", () => {
    expect(buildSettlement(review("days", []), draft({ startFresh: true })).startFresh).toBeUndefined();
  });
});

describe("the command and words", () => {
  it("builds the body with the facts, the settlement and a stated basis", () => {
    const r = review("today", [entry("deadline:a")]);
    const body = buildReenterBody(r, setItem(draft({ note: "  was ill " }), "deadline:a", "done"), "cmd-1");
    expect(body).toMatchObject({
      commandId: "cmd-1",
      locationId: "home",
      energy: "medium",
      contexts: [],
      basis: "stated",
      note: "was ill"
    });
  });
  it("words the gap and the progress", () => {
    expect(gapPhrase(null)).toBe("a while");
    expect(gapPhrase(45)).toBe("45 minutes");
    expect(gapPhrase(300)).toBe("about 5 hours");
    expect(gapPhrase(60 * 24 * 4)).toBe("4 days");
    const r = review("today", [entry("deadline:a")]);
    expect(progressLine(reentryProgress(r, EMPTY_REENTRY_DRAFT, TZ))).toBe(
      "Still needed: where you are, your energy, what's available and 1 item to review."
    );
    expect(progressLine(reentryProgress(review("none", []), draft(), TZ))).toBe("Ready.");
  });
  it("reads the server's refusal and nothing else", () => {
    expect(refusalFrom({ code: "reentryIncomplete", error: "No.", missing: ["location", 3] })).toEqual({
      message: "No.",
      missing: ["location"]
    });
    expect(refusalFrom({ error: "No." })).toBeNull();
    expect(refusalFrom(null)).toBeNull();
  });
});
