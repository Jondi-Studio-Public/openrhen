import { describe, expect, it } from "vitest";
import { issueSnapshotObservationSchema, nowPanelViewSchema } from "@openrhen/contracts";
import { buildNowPanelView } from "@/features/diagnostics/now-view";

const observation = (description: unknown) => ({
  description,
  observedAt: "2026-08-15T00:19:27.703Z",
  timezone: "Australia/Sydney",
  url: "http://localhost:3000/",
  userAgent: "test",
  viewport: { width: 1280, height: 800 },
  view: buildNowPanelView({ mode: "recommendation" }),
  state: null
});

describe("issue report description guard", () => {
  // A snapshot carries megabytes of state. The panel already disables Capture until something is
  // typed, but the route is what writes rows, so the rule has to hold there too — otherwise a stray
  // caller or a retry could fill the table with reports nobody can act on.
  it("refuses a capture with no description", () => {
    expect(issueSnapshotObservationSchema.safeParse(observation("")).success).toBe(false);
    expect(issueSnapshotObservationSchema.safeParse(observation(undefined)).success).toBe(false);
  });

  it("refuses whitespace standing in for a description", () => {
    expect(issueSnapshotObservationSchema.safeParse(observation("   ")).success).toBe(false);
    expect(issueSnapshotObservationSchema.safeParse(observation("\n\t  \n")).success).toBe(false);
  });

  it("accepts a real description and stores it trimmed", () => {
    const parsed = issueSnapshotObservationSchema.safeParse(observation("  the recommendation is stale  "));
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.description).toBe("the recommendation is stale");
  });

  it("refuses a description beyond the stored limit", () => {
    expect(issueSnapshotObservationSchema.safeParse(observation("x".repeat(4001))).success).toBe(false);
    expect(issueSnapshotObservationSchema.safeParse(observation("x".repeat(4000))).success).toBe(true);
  });
});

describe("buildNowPanelView", () => {
  it("produces a valid view from the minimum a branch can supply", () => {
    const view = buildNowPanelView({ mode: "nothing_fits" });
    expect(nowPanelViewSchema.safeParse(view).success).toBe(true);
    expect(view.primary).toBeNull();
    expect(view.session).toBeNull();
    expect(view.currentDirective).toBeNull();
  });

  it("records a target-less directive as null rather than an empty identifier", () => {
    const view = buildNowPanelView({
      mode: "recovery",
      currentDirective: { kind: "recovery", title: "Rest", recommendedMinutes: 45 }
    });
    expect(view.currentDirective).toEqual({ kind: "recovery", targetId: null, title: "Rest", recommendedMinutes: 45 });
  });

  it("records the answer and boundary panels as their own modes with a target-less directive", () => {
    const answer = buildNowPanelView({
      mode: "answer",
      currentDirective: {
        kind: "answer",
        title: "Answer a question",
        recommendedMinutes: 0,
        question: "Is the laptop with you?",
        contextIds: ["laptop"],
        candidate: null
      }
    });
    expect(nowPanelViewSchema.safeParse(answer).success).toBe(true);
    expect(answer.currentDirective).toEqual({
      kind: "answer",
      targetId: null,
      title: "Answer a question",
      recommendedMinutes: 0
    });
    const boundary = buildNowPanelView({
      mode: "boundary",
      currentDirective: {
        kind: "boundary",
        title: "Nothing fits before the horizon",
        recommendedMinutes: 0,
        boundaryAt: "2026-08-18T12:00:00.000Z",
        boundaryKind: "daily_horizon",
        nextFit: null
      }
    });
    expect(nowPanelViewSchema.safeParse(boundary).success).toBe(true);
    expect(boundary.mode).toBe("boundary");
  });

  it("keeps the target of a directive that has one", () => {
    const view = buildNowPanelView({
      mode: "sleep_due",
      currentDirective: { kind: "sleep", targetId: "sleep-1", title: "Sleep", recommendedMinutes: 420 }
    });
    expect(view.currentDirective?.targetId).toBe("sleep-1");
  });

  it("caps evidence and alternatives so one odd recommendation cannot balloon a capture", () => {
    const view = buildNowPanelView({
      mode: "recommendation",
      evidence: Array.from({ length: 100 }, (_item, index) => `fact ${index}`),
      alternativeActionIds: Array.from({ length: 100 }, (_item, index) => `action-${index}`)
    });
    expect(view.evidence).toHaveLength(40);
    expect(view.alternativeActionIds).toHaveLength(20);
    expect(nowPanelViewSchema.safeParse(view).success).toBe(true);
  });

  it("rejects a non-finite countdown instead of writing NaN into the record", () => {
    expect(buildNowPanelView({ mode: "action_session", countdownSeconds: Number.NaN }).countdownSeconds).toBeNull();
    expect(buildNowPanelView({ mode: "action_session", countdownSeconds: 91.6 }).countdownSeconds).toBe(92);
  });

  it("survives a session whose title is missing", () => {
    const view = buildNowPanelView({
      mode: "activity_session",
      session: {
        id: "s1",
        status: "running",
        targetType: "sleep",
        targetId: "sleep-1",
        plannedMinutes: 420,
        plannedEndAt: "2026-08-15T21:00:00.000Z"
      }
    });
    expect(view.session?.targetTitle).toBeNull();
    expect(nowPanelViewSchema.safeParse(view).success).toBe(true);
  });
});
