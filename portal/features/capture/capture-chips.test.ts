import { describe, expect, it } from "vitest";
import { emptyProposalDraft } from "./proposal-draft";
import {
  applyChip,
  chipOfDraft,
  defaultProjectId,
  guessChip,
  mentionsClockTime,
  preselectCaptureDraft
} from "./capture-chips";

const project = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: id, status: "active", ...extra });
const confirmed = (projectId: string, reviewedAt: string) => ({
  id: `c-${projectId}-${reviewedAt}`,
  status: "confirmed",
  proposalType: "action",
  createdAt: "2026-01-01T00:00:00.000Z",
  reviewedAt,
  proposedFields: { projectId }
});
const state = (projects: unknown[], captures: unknown[] = []) => ({ projects, captures }) as never;

describe("guessChip", () => {
  it.each([
    "call Sam at 3pm",
    "dentist tomorrow 9",
    "gym 6:30",
    "lunch at noon",
    "meet @ 4",
    "monday at 2",
    "tomorrow 9 standup",
    "at 4 then",
    "at 6 Thursday"
  ])("reads a time in %j", (text) => {
    expect(mentionsClockTime(text)).toBe(true);
    expect(guessChip(text)).toBe("time");
  });

  it.each([
    "buy printer ink",
    "call the bank tomorrow",
    "read chapter 3",
    "email Sam about the 5th",
    "get 20% off",
    "the 5th at the bank",
    "meet on the 3rd"
  ])("calls %j a task", (text) => {
    expect(guessChip(text)).toBe("task");
  });
});

describe("defaultProjectId", () => {
  const projects = [
    project("older", { lastWorkedAt: "2026-10-01T00:00:00.000Z" }),
    project("recent", { lastWorkedAt: "2026-10-20T00:00:00.000Z" }),
    project("paused", { status: "paused", lastWorkedAt: "2026-10-27T00:00:00.000Z" })
  ];

  it("prefers the suggestion, then the last confirmed capture's project, then the latest active one", () => {
    const captures = [confirmed("older", "2026-10-02T00:00:00.000Z"), confirmed("recent", "2026-10-01T00:00:00.000Z")];
    expect(defaultProjectId(state(projects, captures), "recent")).toBe("recent");
    expect(defaultProjectId(state(projects, captures))).toBe("older");
    expect(defaultProjectId(state(projects))).toBe("recent");
  });

  it("ignores a suggested or used project that no longer exists, and falls back to list order", () => {
    expect(defaultProjectId(state(projects, [confirmed("gone", "2026-10-02T00:00:00.000Z")]), "gone")).toBe("recent");
    expect(defaultProjectId(state([project("a"), project("b")]))).toBe("a");
  });

  it("skips suggested and last-used projects that are no longer active", () => {
    const list = [project("done", { status: "completed" }), project("live")];
    expect(defaultProjectId(state(list, [confirmed("done", "2026-10-02T00:00:00.000Z")]), "done")).toBe("live");
  });

  it("does not count a Later capture as the last project used", () => {
    const later = { ...confirmed("older", "2026-10-09T00:00:00.000Z"), proposalType: "someday" };
    const task = { ...confirmed("recent", "2026-10-01T00:00:00.000Z"), proposalType: "action" };
    expect(defaultProjectId(state(projects, [later, task]))).toBe("recent");
  });

  it("has none when there are no projects", () => {
    expect(defaultProjectId(state([]))).toBeNull();
  });
});

describe("preselectCaptureDraft", () => {
  const draft = { ...emptyProposalDraft(), title: "buy printer ink" };

  it("makes an unsorted thought a task in the default project", () => {
    expect(preselectCaptureDraft(draft, { text: "buy printer ink" }, state([project("p1")]))).toMatchObject({
      proposalType: "action",
      projectId: "p1"
    });
  });

  it("keeps the times an unsorted capture already carries and guesses At a time", () => {
    const dated = { ...draft, title: "Diploma class", startsAt: "2026-11-02T10:00", endsAt: "2026-11-02T11:00" };
    expect(preselectCaptureDraft(dated, { text: "Diploma class" }, state([project("p1")]))).toMatchObject({
      proposalType: "fixed_commitment",
      startsAt: "2026-11-02T10:00",
      endsAt: "2026-11-02T11:00",
      projectId: ""
    });
  });

  it("uses the suggested project over the rest", () => {
    const next = preselectCaptureDraft(draft, { text: "x" }, state([project("p1"), project("p2")]), "p2");
    expect(next.projectId).toBe("p2");
  });

  it("gives a timed thought At a time with no project", () => {
    const timed = { ...draft, title: "dentist at 3pm" };
    expect(preselectCaptureDraft(timed, { text: timed.title }, state([project("p1")]))).toMatchObject({
      proposalType: "fixed_commitment",
      projectId: ""
    });
  });

  it("leaves a capture that already has a type, and a task with no project to ask", () => {
    const typed = { ...draft, proposalType: "deliverable" as const };
    expect(preselectCaptureDraft(typed, { text: "x" }, state([project("p1")]))).toBe(typed);
    expect(preselectCaptureDraft(draft, { text: "x" }, state([]))).toMatchObject({
      proposalType: "action",
      projectId: ""
    });
  });
});

describe("applyChip", () => {
  const draft = { ...emptyProposalDraft(), proposalType: "fixed_commitment" as const };

  it("sets the type, adding a project only for a task that has none", () => {
    expect(applyChip(draft, "task", state([project("p1")])).projectId).toBe("p1");
    expect(applyChip({ ...draft, projectId: "p9" }, "task", state([project("p1")])).projectId).toBe("p9");
    expect(applyChip(draft, "later", state([project("p1")]))).toMatchObject({ proposalType: "someday", projectId: "" });
    expect(applyChip({ ...draft, projectId: "p9" }, "later", state([])).projectId).toBe("");
    expect(applyChip(draft, "time", state([])).proposalType).toBe("fixed_commitment");
  });

  it("maps a draft back to its chip", () => {
    expect(["action", "fixed_commitment", "someday", "outcome"].map((t) => chipOfDraft(t as never))).toEqual([
      "task",
      "time",
      "later",
      null
    ]);
  });
});
