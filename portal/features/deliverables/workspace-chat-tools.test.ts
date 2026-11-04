import { describe, expect, it } from "vitest";
import { assess, blocker, criterion, deliverable, step } from "@/features/deliverables/test-fixtures";
import {
  markStepsComplete,
  recordBlocker,
  recordCriterionReview,
  resolveBlocker,
  submitForResult
} from "./workspace-chat-tools";

describe("workspace chat tools", () => {
  it("marks only named existing steps complete and is idempotent", () => {
    const original = deliverable({
      steps: [
        step("model", { title: "Create the three models", status: "doing", remainingMinutes: 80 }),
        step("pdf", { title: "Export the PDFs", remainingMinutes: 15 })
      ]
    });
    const first = markStepsComplete(
      original,
      { stepTitles: [" create THE THREE models "], evidenceNote: "The screenshot shows all three parts." },
      "2026-08-25T03:00:00.000Z"
    );
    expect(first).toMatchObject({ matchedTitles: ["Create the three models"], changed: true });
    expect(first.deliverable.steps[0]).toMatchObject({
      status: "done",
      remainingMinutes: 0,
      completedAt: "2026-08-25T03:00:00.000Z"
    });
    expect(first.deliverable.steps[1]?.status).toBe("planned");
    const replay = markStepsComplete(first.deliverable, {
      stepTitles: ["Create the three models"],
      evidenceNote: "The screenshot shows all three parts."
    });
    expect(replay.changed).toBe(false);
  });

  it("structurally re-records a blocker when a resubmit step carrying reblockOnComplete completes", () => {
    const resubmit = step("resubmit", {
      title: "Resubmit the drawing package",
      status: "doing",
      reblockOnComplete: {
        description: "Waiting for the teacher's email response on the resubmission.",
        category: "waiting_on_someone"
      }
    });
    const handoff = step("handoff", { title: "Obtain final approval", dependencyIds: ["resubmit"] });
    const original = deliverable({ steps: [resubmit, handoff] });
    const result = markStepsComplete(
      original,
      { stepTitles: ["Resubmit the drawing package"], evidenceNote: "Sent the revised package back." },
      "2026-09-01T01:00:00.000Z"
    );
    expect(result.changed).toBe(true);
    expect(result.deliverable.steps[0]?.status).toBe("done");
    expect(result.reblocked).toEqual([
      {
        description: "Waiting for the teacher's email response on the resubmission.",
        stepTitles: ["Obtain final approval"]
      }
    ]);
    const newBlocker = result.deliverable.blockers[0]!;
    expect(newBlocker).toMatchObject({
      state: "open",
      description: "Waiting for the teacher's email response on the resubmission.",
      category: "waiting_on_someone",
      stepIds: ["handoff"]
    });
    expect(assess(result.deliverable).executableStepIds).not.toContain("handoff");

    // Replaying the same completion must not re-arm a second time: the step is already done, so it
    // never re-enters the "newly completed" set the re-arm reads from.
    const replay = markStepsComplete(result.deliverable, {
      stepTitles: ["Resubmit the drawing package"],
      evidenceNote: "Sent the revised package back."
    });
    expect(replay.changed).toBe(false);
    expect(replay.reblocked).toEqual([]);
    expect(replay.deliverable.blockers).toHaveLength(1);
  });

  it("creates a fresh open blocker when re-recording a description that was already resolved once", () => {
    const resubmit = step("resubmit", {
      title: "Resubmit the drawing package",
      reblockOnComplete: {
        description: "Waiting for the teacher's email response on the resubmission.",
        category: "waiting_on_someone"
      }
    });
    const handoff = step("handoff", { title: "Obtain final approval", dependencyIds: ["resubmit"] });
    const original = deliverable({
      steps: [resubmit, handoff],
      blockers: [
        blocker("first-round", {
          description: "Waiting for the teacher's email response on the resubmission.",
          state: "resolved",
          stepIds: ["handoff"],
          resolvedAt: "2026-08-20T00:00:00.000Z"
        })
      ]
    });
    const result = markStepsComplete(original, {
      stepTitles: ["Resubmit the drawing package"],
      evidenceNote: "Sent it back again."
    });
    expect(result.deliverable.blockers).toHaveLength(2);
    const reopened = result.deliverable.blockers.find((item) => item.id !== "first-round")!;
    expect(reopened).toMatchObject({ state: "open", stepIds: ["handoff"] });
    expect(assess(result.deliverable).executableStepIds).not.toContain("handoff");
  });

  it("completes an approval-path step with no reblockOnComplete and re-arms nothing", () => {
    const handoff = step("handoff", { title: "Obtain final approval" });
    const original = deliverable({
      steps: [handoff],
      blockers: [
        blocker("wait", {
          description: "Waiting for the teacher's email response on the resubmission.",
          state: "open",
          stepIds: ["handoff"]
        })
      ]
    });
    const resolved = resolveBlocker(original, {
      blockerDescription: "Waiting for the teacher's email response on the resubmission.",
      resolutionNote: "The teacher approved it with no further changes."
    }).deliverable;
    const result = markStepsComplete(resolved, {
      stepTitles: ["Obtain final approval"],
      evidenceNote: "The teacher confirmed approval by email."
    });
    expect(result.changed).toBe(true);
    expect(result.reblocked).toEqual([]);
    expect(result.deliverable.blockers).toHaveLength(1);
    expect(result.deliverable.blockers[0]?.state).toBe("resolved");
  });

  it("audits criteria, preserves notes, and stops short of final completion", () => {
    const original = deliverable({
      status: "under_review",
      criteria: [
        criterion("parts", { title: "Three part files exist", notes: "From the brief." }),
        criterion("submit", { title: "Submission verified" })
      ]
    });
    const partial = recordCriterionReview(original, {
      criteria: [
        { title: "Three part files exist", state: "satisfied", evidenceNote: "Three .ipt files are visible." },
        { title: "Submission verified", state: "uncertain", evidenceNote: "No receipt has been shown." }
      ],
      summary: "Files exist; submission still needs proof."
    });
    expect(partial.deliverable.status).toBe("under_review");
    expect(partial.deliverable.criteria[0]?.notes).toBe("From the brief.\nReview: Three .ipt files are visible.");
    expect(partial.deliverable.criteria[1]).toMatchObject({ state: "uncertain" });

    const complete = recordCriterionReview(partial.deliverable, {
      criteria: [{ title: "Submission verified", state: "satisfied", evidenceNote: "Receipt is visible." }],
      summary: "All required criteria now pass."
    });
    expect(complete.deliverable.status).toBe("ready_to_complete");
    expect(complete.deliverable.completedAt).toBeUndefined();
  });

  it("records a blocker against named steps so readiness excludes them, and replays are idempotent", () => {
    const original = deliverable({
      steps: [
        step("zip", { title: "Create and verify the ZIP package", status: "done", remainingMinutes: 0 }),
        step("submit", { title: "Submit the final package" })
      ]
    });
    const first = recordBlocker(
      original,
      {
        description: "Waiting for the teacher to unlock the Moodle submission.",
        category: "waiting_on_someone",
        stepTitles: [" submit THE final package "],
        proposedResolution: "The teacher confirms Moodle is open."
      },
      "2026-08-30T01:00:00.000Z",
      "blocker-moodle"
    );
    expect(first).toMatchObject({ matchedTitles: ["Submit the final package"], changed: true });
    expect(first.deliverable.blockers[0]).toMatchObject({
      id: "blocker-moodle",
      state: "open",
      category: "waiting_on_someone",
      stepIds: ["submit"],
      createdAt: "2026-08-30T01:00:00.000Z"
    });
    // The step's own status is untouched; readiness derives the exclusion from the open blocker.
    expect(first.deliverable.steps[1]?.status).toBe("planned");
    const readiness = assess(first.deliverable);
    expect(readiness.executableStepIds).not.toContain("submit");
    expect(readiness.steps.find((item) => item.stepId === "submit")).toMatchObject({
      reason: "blocked",
      blockerIds: ["blocker-moodle"]
    });

    const replay = recordBlocker(first.deliverable, {
      description: "waiting for the teacher to unlock the moodle submission.",
      category: "waiting_on_someone",
      stepTitles: ["Submit the final package"]
    });
    expect(replay.changed).toBe(false);
    expect(replay.deliverable.blockers).toHaveLength(1);
  });

  it("resolves a blocker by description, keeps the note, and tells no-match from already-resolved", () => {
    const original = deliverable({
      blockers: [blocker("moodle", { description: "Moodle is locked.", stepIds: ["submit"] })],
      steps: [step("submit", { title: "Submit the final package" })]
    });
    const first = resolveBlocker(
      original,
      { blockerDescription: " moodle IS locked. ", resolutionNote: "The teacher opened the submission." },
      "2026-08-31T01:00:00.000Z"
    );
    expect(first).toMatchObject({ matchedTitles: ["Moodle is locked."], changed: true });
    expect(first.deliverable.blockers[0]).toMatchObject({
      state: "resolved",
      resolvedAt: "2026-08-31T01:00:00.000Z",
      resolutionNotes: "Resolved: The teacher opened the submission."
    });
    expect(assess(first.deliverable).executableStepIds).toContain("submit");

    const replay = resolveBlocker(first.deliverable, {
      blockerDescription: "Moodle is locked.",
      resolutionNote: "The teacher opened the submission."
    });
    expect(replay).toMatchObject({ matchedTitles: ["Moodle is locked."], changed: false });

    const unknown = resolveBlocker(first.deliverable, {
      blockerDescription: "A blocker nobody recorded",
      resolutionNote: "n/a"
    });
    expect(unknown).toMatchObject({ matchedTitles: [], changed: false });
  });

  it("submitForResult moves to awaiting_result with a stepless blocker that blocks nothing in readiness", () => {
    const original = deliverable({
      status: "in_progress",
      steps: [step("submit", { title: "Submit the final package", status: "done" })]
    });
    const result = submitForResult(
      original,
      { waitingFor: "the client to confirm receipt", category: "waiting_on_someone" },
      "2026-09-01T00:00:00.000Z"
    );
    expect(result.status).toBe("awaiting_result");
    expect(result.submittedAt).toBe("2026-09-01T00:00:00.000Z");
    expect(result.blockers[0]).toMatchObject({ description: "the client to confirm receipt", stepIds: [] });
    // A submission blocker names no steps, so readiness never reports a step blocked by it.
    expect(assess(result).steps.every((entry) => !entry.blockerIds.includes(result.blockers[0]!.id))).toBe(true);

    const resubmitted = submitForResult(
      result,
      { waitingFor: "a second look", category: "other" },
      "2026-09-05T00:00:00.000Z"
    );
    // submittedAt is set once by the first submission and is not overwritten by a later one.
    expect(resubmitted.submittedAt).toBe("2026-09-01T00:00:00.000Z");
    expect(resubmitted.blockers).toHaveLength(2);
  });

  it("resolveBlocker returns an awaiting_result deliverable to under_review only once every open blocker clears", () => {
    const submitted = deliverable({
      status: "awaiting_result",
      submittedAt: "2026-09-01T00:00:00.000Z",
      steps: [step("submit", { title: "Submit the final package", status: "done" })],
      blockers: [
        blocker("result", { description: "Waiting on the client", stepIds: [] }),
        blocker("extra", { description: "Also waiting on legal", stepIds: [] })
      ]
    });
    const partial = resolveBlocker(submitted, {
      blockerDescription: "Also waiting on legal",
      resolutionNote: "Cleared."
    });
    expect(partial.deliverable.status).toBe("awaiting_result");

    const cleared = resolveBlocker(partial.deliverable, {
      blockerDescription: "Waiting on the client",
      resolutionNote: "The client confirmed.",
      feedback: "Looks great, no changes needed."
    });
    expect(cleared.deliverable.status).toBe("under_review");
  });
});
