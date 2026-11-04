import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSeedState, type PortalState, type StoredDeliverable } from "@/state/portal-state";
import { blocker, criterion, deliverable, session, step } from "@/features/deliverables/test-fixtures";

const holder = vi.hoisted(() => ({
  current: null as PortalState | null,
  saveEntity: vi.fn()
}));

vi.mock("@/server/persistence/state-store", () => ({
  getStateStore: () => ({
    get: async () => holder.current,
    saveEntity: holder.saveEntity
  })
}));

const proposalHolder = vi.hoisted(() => ({
  retainCalls: [] as { sourceTitle: string; capturedText?: string }[],
  failRetain: false
}));

// The retained-feedback path calls the real proposal store's `retain`; a full Postgres round trip is
// exercised elsewhere, so this stands in for it and only checks what applyWorkspaceTool asks it to save.
vi.mock("@/server/persistence/postgres/deliverable-proposal-store", () => ({
  withDeliverableProposalStore: async (operation: (store: unknown) => Promise<PortalState>) =>
    operation({
      retain: async (input: { sourceTitle: string; capturedText?: string }) => {
        if (proposalHolder.failRetain) throw new Error("the proposal store is unavailable.");
        proposalHolder.retainCalls.push(input);
        return holder.current!;
      }
    })
}));

import { applyWorkspaceTool } from "./workspace-moves";

describe("deliverable chat workspace transitions", () => {
  beforeEach(() => {
    proposalHolder.retainCalls = [];
    proposalHolder.failRetain = false;
    holder.saveEntity.mockReset();
    holder.saveEntity.mockImplementation(async (command: { entity: StoredDeliverable }) => {
      const previous = holder.current!.deliverables.find((item) => item.id === command.entity.id)!;
      const saved = { ...command.entity, version: (previous.version ?? 0) + 1 };
      holder.current = {
        ...holder.current!,
        deliverables: holder.current!.deliverables.map((item) => (item.id === saved.id ? saved : item))
      };
      return holder.current;
    });
    const plannedStep = step("model", { title: "Create three part models" });
    const completionCriterion = criterion("models", {
      title: "Three required models completed",
      stepIds: [plannedStep.id]
    });
    const approvedFixture = deliverable({
      status: "needs_breakdown",
      criteria: [completionCriterion],
      steps: [plannedStep]
    });
    const { contractApprovedAt: _contract, planApprovedAt: _plan, ...breakdown } = approvedFixture;
    holder.current = {
      ...createSeedState(new Date("2026-08-25T00:00:00.000Z")),
      deliverables: [breakdown],
      activeSession: session({ targetId: breakdown.id, actionId: breakdown.id, stepId: plannedStep.id })
    };
  });

  it("moves safely through Carry out and Review while leaving final completion to the person", async () => {
    await expect(
      applyWorkspaceTool(
        "assessment-2",
        { name: "start_carry_out", approvalNote: "Agreed in chat." },
        { requireSession: true }
      )
    ).resolves.toMatchObject({ summary: expect.stringContaining("the work can start") });
    expect(holder.current!.deliverables[0]).toMatchObject({
      status: "ready",
      approvalNote: "Agreed in chat.",
      contractVersion: 2,
      planVersion: 2
    });

    await applyWorkspaceTool(
      "assessment-2",
      {
        name: "mark_steps_complete",
        completion: {
          stepTitles: ["Create three part models"],
          evidenceNote: "The screenshot shows all three finished model tabs."
        }
      },
      { requireSession: true }
    );
    expect(holder.current!.deliverables[0]?.steps[0]).toMatchObject({
      status: "done",
      remainingMinutes: 0,
      details: "Completion evidence: The screenshot shows all three finished model tabs."
    });

    await applyWorkspaceTool("assessment-2", { name: "begin_review" }, { requireSession: true });
    expect(holder.current!.deliverables[0]?.status).toBe("under_review");

    await applyWorkspaceTool(
      "assessment-2",
      {
        name: "record_review",
        review: {
          criteria: [
            {
              title: "Three required models completed",
              state: "satisfied",
              evidenceNote: "All three finished models are visible."
            }
          ],
          summary: "The agreed completion contract passes."
        }
      },
      { requireSession: true }
    );
    expect(holder.current!.deliverables[0]).toMatchObject({ status: "ready_to_complete" });
    expect(holder.current!.deliverables[0]?.completedAt).toBeUndefined();
  });

  it("records and resolves blockers in any phase through the aggregate save", async () => {
    // Still in Breakdown here — the blocker tools must not be rejected as stale phase actions.
    await expect(
      applyWorkspaceTool(
        "assessment-2",
        {
          name: "record_blocker",
          report: {
            description: "Waiting for the teacher to unlock the Moodle submission.",
            category: "waiting_on_someone",
            stepTitles: ["Create three part models"]
          }
        },
        { requireSession: true }
      )
    ).resolves.toMatchObject({ summary: expect.stringContaining("stay excluded until it clears") });
    const saved = holder.current!.deliverables[0]!;
    expect(saved.blockers[0]).toMatchObject({
      description: "Waiting for the teacher to unlock the Moodle submission.",
      category: "waiting_on_someone",
      state: "open",
      stepIds: [saved.steps[0]!.id]
    });

    await expect(
      applyWorkspaceTool(
        "assessment-2",
        {
          name: "record_blocker",
          report: {
            description: "waiting for the teacher to unlock the moodle submission.",
            category: "waiting_on_someone",
            stepTitles: []
          }
        },
        { requireSession: true }
      )
    ).resolves.toMatchObject({ summary: expect.stringContaining("already recorded"), applied: false });
    expect(holder.current!.deliverables[0]?.blockers).toHaveLength(1);

    await expect(
      applyWorkspaceTool(
        "assessment-2",
        {
          name: "record_blocker",
          report: { description: "Another blocker", category: "other", stepTitles: ["A step that does not exist"] }
        },
        { requireSession: true }
      )
    ).rejects.toThrow("not current step titles");

    await expect(
      applyWorkspaceTool(
        "assessment-2",
        {
          name: "resolve_blocker",
          resolution: { blockerDescription: "Nothing like this exists", resolutionNote: "n/a" }
        },
        { requireSession: true }
      )
    ).rejects.toThrow("No recorded blocker is described as");

    await expect(
      applyWorkspaceTool(
        "assessment-2",
        {
          name: "resolve_blocker",
          resolution: {
            blockerDescription: "Waiting for the teacher to unlock the Moodle submission.",
            resolutionNote: "The teacher opened the submission."
          }
        },
        { requireSession: true }
      )
    ).resolves.toMatchObject({ summary: expect.stringContaining("resolved"), applied: true });
    expect(holder.current!.deliverables[0]?.blockers[0]).toMatchObject({ state: "resolved" });
  });

  it("offers extend_plan in Breakdown and Carry out but rejects it as stale in Review", async () => {
    // Still in Breakdown here (see beforeEach).
    await expect(
      applyWorkspaceTool(
        "assessment-2",
        {
          name: "extend_plan",
          addition: {
            steps: [{ title: "Sketch the layout", expectedMinutes: 20, criteriaServed: [], dependsOnStepTitles: [] }]
          }
        },
        { requireSession: true }
      )
    ).resolves.toMatchObject({ summary: expect.stringContaining("Added 1 step") });

    const carryOutStep = step("model", { title: "Create three part models" });
    const carryOutFixture = deliverable({ status: "in_progress", steps: [carryOutStep] });
    holder.current = {
      ...createSeedState(new Date("2026-08-25T00:00:00.000Z")),
      deliverables: [carryOutFixture],
      activeSession: session({ targetId: carryOutFixture.id, actionId: carryOutFixture.id, stepId: carryOutStep.id })
    };
    await expect(
      applyWorkspaceTool(
        "assessment-2",
        {
          name: "extend_plan",
          addition: {
            steps: [
              { title: "Package the deliverable", expectedMinutes: 10, criteriaServed: [], dependsOnStepTitles: [] }
            ]
          }
        },
        { requireSession: true }
      )
    ).resolves.toMatchObject({ summary: expect.stringContaining("Added 1 step") });

    const reviewFixture = deliverable({ status: "under_review", steps: [carryOutStep] });
    holder.current = {
      ...createSeedState(new Date("2026-08-25T00:00:00.000Z")),
      deliverables: [reviewFixture],
      activeSession: session({ targetId: reviewFixture.id, actionId: reviewFixture.id, stepId: carryOutStep.id })
    };
    await expect(
      applyWorkspaceTool(
        "assessment-2",
        {
          name: "extend_plan",
          addition: {
            steps: [{ title: "One more step", expectedMinutes: 10, criteriaServed: [], dependsOnStepTitles: [] }]
          }
        },
        { requireSession: true }
      )
    ).rejects.toThrow("needs Breakdown or Carry out");
  });

  it("extends the plan steps-only: it links to an existing criterion but never creates one", async () => {
    const saved = holder.current!.deliverables[0]!;
    const criteriaBefore = saved.criteria.length;
    await expect(
      applyWorkspaceTool(
        "assessment-2",
        {
          name: "extend_plan",
          addition: {
            steps: [
              {
                title: "Redraw the callouts",
                expectedMinutes: 20,
                criteriaServed: ["Three required models completed"],
                dependsOnStepTitles: []
              }
            ]
          }
        },
        { requireSession: true }
      )
    ).resolves.toMatchObject({ summary: expect.stringContaining("Added 1 step") });
    const after = holder.current!.deliverables[0]!;
    expect(after.criteria).toHaveLength(criteriaBefore);
    expect(after.criteria[0]?.stepIds).toContain(after.steps.find((item) => item.title === "Redraw the callouts")!.id);
  });

  it("retrofits a new step's dependency onto an existing handoff step through extend_plan", async () => {
    await expect(
      applyWorkspaceTool(
        "assessment-2",
        {
          name: "extend_plan",
          addition: {
            steps: [
              {
                title: "Redraw the callouts",
                expectedMinutes: 20,
                criteriaServed: [],
                dependsOnStepTitles: []
              },
              {
                title: "Create three part models",
                expectedMinutes: 90,
                criteriaServed: [],
                dependsOnStepTitles: ["Redraw the callouts"]
              }
            ]
          }
        },
        { requireSession: true }
      )
    ).resolves.toMatchObject({ summary: expect.stringContaining("1 new dependency link") });
    const saved = holder.current!.deliverables[0]!;
    const byTitle = (title: string) => saved.steps.find((item) => item.title === title)!;
    expect(byTitle("Create three part models").dependencyIds).toContain(byTitle("Redraw the callouts").id);
  });

  it("rejects extend_plan when a retrofit would close a dependency cycle, and saves nothing", async () => {
    await applyWorkspaceTool(
      "assessment-2",
      {
        name: "extend_plan",
        addition: {
          steps: [
            {
              title: "Review the models",
              expectedMinutes: 15,
              criteriaServed: [],
              dependsOnStepTitles: ["Create three part models"]
            }
          ]
        }
      },
      { requireSession: true }
    );
    holder.saveEntity.mockClear();
    await expect(
      applyWorkspaceTool(
        "assessment-2",
        {
          name: "extend_plan",
          addition: {
            steps: [
              {
                title: "Create three part models",
                expectedMinutes: 90,
                criteriaServed: [],
                dependsOnStepTitles: ["Review the models"]
              }
            ]
          }
        },
        { requireSession: true }
      )
    ).rejects.toThrow('depend on itself through "Review the models"');
    expect(holder.saveEntity).not.toHaveBeenCalled();
  });

  it("retains resolve_blocker feedback as a durable source", async () => {
    await applyWorkspaceTool(
      "assessment-2",
      {
        name: "record_blocker",
        report: {
          description: "Waiting for the teacher to unlock the Moodle submission.",
          category: "waiting_on_someone",
          stepTitles: []
        }
      },
      { requireSession: true }
    );
    await expect(
      applyWorkspaceTool(
        "assessment-2",
        {
          name: "resolve_blocker",
          resolution: {
            blockerDescription: "Waiting for the teacher to unlock the Moodle submission.",
            resolutionNote: "The teacher replied with revisions.",
            feedback: "Please redraw the pressure relief valve callouts and resubmit."
          }
        },
        { requireSession: true }
      )
    ).resolves.toMatchObject({ summary: expect.stringContaining("Retained the feedback") });
    expect(proposalHolder.retainCalls).toHaveLength(1);
    expect(proposalHolder.retainCalls[0]).toMatchObject({
      capturedText: "Please redraw the pressure relief valve callouts and resubmit.",
      sourceTitle: expect.stringContaining("Waiting for the teacher to unlock the Moodle submission.")
    });
  });

  it("reports resolve_blocker honestly when the blocker resolved but retaining its feedback failed", async () => {
    await applyWorkspaceTool(
      "assessment-2",
      {
        name: "record_blocker",
        report: {
          description: "Waiting for the teacher to unlock the Moodle submission.",
          category: "waiting_on_someone",
          stepTitles: []
        }
      },
      { requireSession: true }
    );
    proposalHolder.failRetain = true;
    // A prior version of this handler let the retain failure propagate uncaught, which the caller
    // turns into "the edit was not applied" — false, since the blocker really was resolved.
    const { summary } = await applyWorkspaceTool(
      "assessment-2",
      {
        name: "resolve_blocker",
        resolution: {
          blockerDescription: "Waiting for the teacher to unlock the Moodle submission.",
          resolutionNote: "The teacher replied with revisions.",
          feedback: "Please redraw the pressure relief valve callouts and resubmit."
        }
      },
      { requireSession: true }
    );
    expect(summary).toContain("resolved");
    expect(summary).toContain("could not be retained");
    expect(holder.current!.deliverables[0]?.blockers[0]).toMatchObject({ state: "resolved" });
    expect(proposalHolder.retainCalls).toHaveLength(0);
  });

  it("resolves a blocker without feedback exactly as before, retaining nothing", async () => {
    await applyWorkspaceTool(
      "assessment-2",
      {
        name: "record_blocker",
        report: { description: "Waiting on a reply.", category: "waiting_on_someone", stepTitles: [] }
      },
      { requireSession: true }
    );
    await expect(
      applyWorkspaceTool(
        "assessment-2",
        {
          name: "resolve_blocker",
          resolution: { blockerDescription: "Waiting on a reply.", resolutionNote: "It cleared." }
        },
        { requireSession: true }
      )
    ).resolves.toMatchObject({ summary: expect.stringContaining("resolved") });
    expect(proposalHolder.retainCalls).toHaveLength(0);
  });

  it("chains a new step's dependencies by title, including one added earlier in the same call", async () => {
    await expect(
      applyWorkspaceTool(
        "assessment-2",
        {
          name: "add_to_breakdown",
          addition: {
            criteria: [],
            steps: [
              {
                title: "Review the models",
                expectedMinutes: 15,
                criteriaServed: [],
                dependsOnStepTitles: ["Create three part models"]
              },
              {
                title: "Submit the assessment",
                expectedMinutes: 5,
                criteriaServed: [],
                dependsOnStepTitles: ["Review the models"]
              }
            ]
          }
        },
        { requireSession: true }
      )
    ).resolves.toMatchObject({ summary: expect.stringContaining("Added") });
    const saved = holder.current!.deliverables[0]!;
    const byTitle = (title: string) => saved.steps.find((item) => item.title === title)!;
    expect(byTitle("Review the models").dependencyIds).toEqual([byTitle("Create three part models").id]);
    expect(byTitle("Submit the assessment").dependencyIds).toEqual([byTitle("Review the models").id]);
  });

  it("reports an unresolved dependency title back to the model instead of saving a broken chain", async () => {
    await expect(
      applyWorkspaceTool(
        "assessment-2",
        {
          name: "add_to_breakdown",
          addition: {
            criteria: [],
            steps: [
              {
                title: "Submit the assessment",
                expectedMinutes: 5,
                criteriaServed: [],
                dependsOnStepTitles: ["A step that was never proposed"]
              }
            ]
          }
        },
        { requireSession: true }
      )
    ).rejects.toThrow("A step that was never proposed");
    // Nothing was persisted: the save never ran once the unresolved title was found.
    expect(holder.saveEntity).not.toHaveBeenCalled();
  });

  it("rejects stale phase tools and refuses to review while required work is open", async () => {
    await applyWorkspaceTool("assessment-2", { name: "start_carry_out", approvalNote: null }, { requireSession: true });
    await expect(
      applyWorkspaceTool(
        "assessment-2",
        { name: "add_to_breakdown", addition: { criteria: [], steps: [] } },
        { requireSession: true }
      )
    ).rejects.toThrow("nothing was changed");
    await expect(
      applyWorkspaceTool("assessment-2", { name: "begin_review" }, { requireSession: true })
    ).rejects.toThrow("required steps are still open");
  });

  describe("submit_for_result and the waiting arc", () => {
    it("submits for result from Carry out, recording a stepless open blocker and setting submittedAt", async () => {
      const doneStep = step("model", { title: "Create three part models", status: "done" });
      const fixture = deliverable({ status: "in_progress", steps: [doneStep] });
      holder.current = {
        ...createSeedState(new Date("2026-08-25T00:00:00.000Z")),
        deliverables: [fixture],
        activeSession: null
      };
      await expect(
        applyWorkspaceTool(
          "assessment-2",
          {
            name: "submit_for_result",
            submission: { waitingFor: "the client to confirm receipt", category: "waiting_on_someone" }
          },
          { requireSession: false }
        )
      ).resolves.toMatchObject({ summary: expect.stringContaining("Submitted and waiting on") });
      const saved = holder.current!.deliverables[0]!;
      expect(saved.status).toBe("awaiting_result");
      expect(saved.submittedAt).toBeTruthy();
      expect(saved.blockers[0]).toMatchObject({
        description: "the client to confirm receipt",
        category: "waiting_on_someone",
        state: "open",
        stepIds: []
      });
    });

    it("refuses submit_for_result while a required step is still open", async () => {
      const openStep = step("model", { title: "Create three part models" });
      const fixture = deliverable({ status: "in_progress", steps: [openStep] });
      holder.current = {
        ...createSeedState(new Date("2026-08-25T00:00:00.000Z")),
        deliverables: [fixture],
        activeSession: null
      };
      await expect(
        applyWorkspaceTool(
          "assessment-2",
          { name: "submit_for_result", submission: { waitingFor: "the client", category: "other" } },
          { requireSession: false }
        )
      ).rejects.toThrow("required steps are still open");
    });

    it("returns an awaiting_result deliverable to under_review only once the last open blocker clears", async () => {
      const doneStep = step("model", { title: "Create three part models", status: "done" });
      const fixture = deliverable({
        status: "awaiting_result",
        submittedAt: "2026-08-20T00:00:00.000Z",
        steps: [doneStep],
        blockers: [
          blocker("submission", { description: "Waiting on the marker", stepIds: [] }),
          blocker("other", { description: "Also waiting on the library", stepIds: [] })
        ]
      });
      holder.current = {
        ...createSeedState(new Date("2026-08-25T00:00:00.000Z")),
        deliverables: [fixture],
        activeSession: null
      };

      await applyWorkspaceTool(
        "assessment-2",
        {
          name: "resolve_blocker",
          resolution: { blockerDescription: "Also waiting on the library", resolutionNote: "Cleared." }
        },
        { requireSession: false }
      );
      expect(holder.current!.deliverables[0]?.status).toBe("awaiting_result");

      await applyWorkspaceTool(
        "assessment-2",
        {
          name: "resolve_blocker",
          resolution: {
            blockerDescription: "Waiting on the marker",
            resolutionNote: "The marker replied.",
            feedback: "Distinction, no revisions needed."
          }
        },
        { requireSession: false }
      );
      expect(holder.current!.deliverables[0]?.status).toBe("under_review");
    });

    it("warns in begin_review's summary about an unsettled result-dependent criterion when nothing has been submitted", async () => {
      const doneStep = step("model", { title: "Create three part models", status: "done" });
      const resultCriterion = criterion("models", {
        title: "Client confirms receipt",
        stepIds: [doneStep.id],
        verificationMethod: "submission_receipt"
      });
      const fixture = deliverable({ status: "in_progress", steps: [doneStep], criteria: [resultCriterion] });
      holder.current = {
        ...createSeedState(new Date("2026-08-25T00:00:00.000Z")),
        deliverables: [fixture],
        activeSession: null
      };
      const { summary } = await applyWorkspaceTool("assessment-2", { name: "begin_review" }, { requireSession: false });
      expect(summary).toContain("submit_for_result instead");
    });

    it("keeps begin_review's summary plain once the deliverable has already been submitted", async () => {
      const doneStep = step("model", { title: "Create three part models", status: "done" });
      const resultCriterion = criterion("models", {
        title: "Client confirms receipt",
        stepIds: [doneStep.id],
        verificationMethod: "submission_receipt"
      });
      const fixture = deliverable({
        status: "in_progress",
        steps: [doneStep],
        criteria: [resultCriterion],
        submittedAt: "2026-08-20T00:00:00.000Z"
      });
      holder.current = {
        ...createSeedState(new Date("2026-08-25T00:00:00.000Z")),
        deliverables: [fixture],
        activeSession: null
      };
      const { summary } = await applyWorkspaceTool("assessment-2", { name: "begin_review" }, { requireSession: false });
      expect(summary).not.toContain("submit_for_result");
    });
  });

  describe("mark_steps_complete tells the person what happened to time tracking", () => {
    // These stand in for the postgres layer's own rollDeliverableSessionForward — exercised for real
    // in state-store.integration.test.ts — so the mocked save here mimics exactly what it changes: the
    // deliverable's steps, and the session's stepId (or its absence). This test only checks that
    // applyWorkspaceTool reads that change back correctly and describes it in its summary.
    it("names the next step when the save rolls a running session forward onto it", async () => {
      const first = step("model", { title: "Create three part models", status: "doing" });
      const second = step("write-up", { title: "Write the summary", sortOrder: 1 });
      const contract = criterion("models", {
        title: "Three required models completed",
        stepIds: [first.id, second.id]
      });
      const fixture = deliverable({ criteria: [contract], steps: [first, second] });
      holder.current = {
        ...createSeedState(new Date("2026-08-25T00:00:00.000Z")),
        deliverables: [fixture],
        activeSession: session({ targetId: fixture.id, actionId: fixture.id, stepId: first.id })
      };
      holder.saveEntity.mockImplementationOnce(async (command: { entity: StoredDeliverable }) => {
        const previous = holder.current!.deliverables.find((item) => item.id === command.entity.id)!;
        const saved = { ...command.entity, version: (previous.version ?? 0) + 1 };
        holder.current = {
          ...holder.current!,
          deliverables: holder.current!.deliverables.map((item) => (item.id === saved.id ? saved : item)),
          activeSession: {
            ...holder.current!.activeSession!,
            stepId: second.id,
            version: (holder.current!.activeSession!.version ?? 0) + 1
          }
        };
        return holder.current;
      });
      await expect(
        applyWorkspaceTool(
          "assessment-2",
          {
            name: "mark_steps_complete",
            completion: { stepTitles: ["Create three part models"], evidenceNote: "Confirmed by the person." }
          },
          { requireSession: true }
        )
      ).resolves.toMatchObject({ summary: expect.stringContaining("Tracking has moved on to “Write the summary”.") });
    });

    it("says tracking stopped when the completed step was the last one left", async () => {
      const onlyStep = step("model", { title: "Create three part models", status: "doing" });
      const contract = criterion("models", { title: "The model is complete", stepIds: [onlyStep.id] });
      const fixture = deliverable({ criteria: [contract], steps: [onlyStep] });
      holder.current = {
        ...createSeedState(new Date("2026-08-25T00:00:00.000Z")),
        deliverables: [fixture],
        activeSession: session({ targetId: fixture.id, actionId: fixture.id, stepId: onlyStep.id })
      };
      holder.saveEntity.mockImplementationOnce(async (command: { entity: StoredDeliverable }) => {
        const previous = holder.current!.deliverables.find((item) => item.id === command.entity.id)!;
        const saved = { ...command.entity, version: (previous.version ?? 0) + 1 };
        holder.current = {
          ...holder.current!,
          deliverables: holder.current!.deliverables.map((item) => (item.id === saved.id ? saved : item)),
          activeSession: null
        };
        return holder.current;
      });
      await expect(
        applyWorkspaceTool(
          "assessment-2",
          {
            name: "mark_steps_complete",
            completion: { stepTitles: ["Create three part models"], evidenceNote: "Confirmed by the person." }
          },
          { requireSession: true }
        )
      ).resolves.toMatchObject({
        summary: expect.stringContaining("That was the last step, so tracking has stopped.")
      });
    });

    it("adds no tracking note when the completed step was not the one being timed", async () => {
      const tracked = step("model", { title: "Create three part models" });
      const other = step("write-up", { title: "Write the summary", sortOrder: 1 });
      const contract = criterion("models", { title: "Both parts done", stepIds: [tracked.id, other.id] });
      const fixture = deliverable({ criteria: [contract], steps: [tracked, other] });
      holder.current = {
        ...createSeedState(new Date("2026-08-25T00:00:00.000Z")),
        deliverables: [fixture],
        activeSession: session({ targetId: fixture.id, actionId: fixture.id, stepId: tracked.id })
      };
      const result = await applyWorkspaceTool(
        "assessment-2",
        {
          name: "mark_steps_complete",
          completion: { stepTitles: ["Write the summary"], evidenceNote: "Confirmed by the person." }
        },
        { requireSession: true }
      );
      expect(result.summary).not.toContain("Tracking has moved");
      expect(result.summary).not.toContain("tracking has stopped");
    });
  });
});
