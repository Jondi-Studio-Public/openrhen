import { describe, expect, it } from "vitest";
import { createSeedState } from "@/state/portal-state";
import { confirmProposal, ignoreProposal, validateProposal, type ProposalDraft } from "./proposals";

const baseDraft = (state = createSeedState()): ProposalDraft => ({
  proposalType: "action",
  title: "Read the assignment brief",
  areaId: state.areas[0]!.id,
  outcomeId: state.outcomes[0]!.id,
  projectId: state.projects[0]!.id,
  definitionOfDone: "",
  value: 3,
  internalDeadlineAt: "",
  externalDeadlineAt: "",
  expectedMinutes: 30,
  pessimisticMinutes: 45,
  energy: "high",
  startsAt: "",
  endsAt: "",
  location: "",
  locationId: ""
});

describe("proposal confirmation", () => {
  it("keeps a quick capture out of committed planning data", () => {
    const state = createSeedState();
    state.captures.push({
      id: "capture-1",
      text: "Assignment due Friday",
      createdAt: new Date().toISOString(),
      status: "pending",
      proposalType: "unclassified",
      proposedFields: {},
      sourceType: "manual_capture"
    });
    expect(state.actions).toHaveLength(2);
    expect(state.captures[0]?.status).toBe("pending");
  });

  it("creates the selected entity only after confirmation", () => {
    const state = createSeedState();
    state.captures.push({
      id: "capture-1",
      text: "Read assignment brief",
      createdAt: new Date().toISOString(),
      status: "pending",
      proposalType: "unclassified",
      proposedFields: {},
      sourceType: "manual_capture"
    });
    const confirmed = confirmProposal(state, "capture-1", baseDraft(state), "2026-08-08T09:00:00.000Z");
    expect(confirmed.actions).toHaveLength(3);
    expect(confirmed.actions[2]).toMatchObject({
      title: "Read the assignment brief",
      expectedMinutes: 30,
      pessimisticMinutes: 45
    });
    expect(confirmed.captures[0]).toMatchObject({
      status: "confirmed",
      proposalType: "action",
      reviewedAt: "2026-08-08T09:00:00.000Z"
    });
  });

  it("retains ignored proposals without creating planning data", () => {
    const state = createSeedState();
    state.captures.push({
      id: "capture-1",
      text: "Maybe someday",
      createdAt: new Date().toISOString(),
      status: "pending",
      proposalType: "unclassified",
      proposedFields: {},
      sourceType: "manual_capture"
    });
    const ignored = ignoreProposal(state, "capture-1", "2026-08-08T09:00:00.000Z");
    expect(ignored.actions).toHaveLength(2);
    expect(ignored.captures[0]).toMatchObject({ status: "ignored", reviewedAt: "2026-08-08T09:00:00.000Z" });
  });

  it("refuses to commit an item that is not awaiting review", () => {
    const state = createSeedState();
    expect(() => confirmProposal(state, "missing-capture", baseDraft(state))).toThrow("no longer awaiting review");
    expect(state.actions).toHaveLength(2);
  });

  it("creates a deliverable under the chosen project with its deadline", () => {
    const state = createSeedState();
    state.captures.push({
      id: "capture-1",
      text: "Assessment 3 due next Friday",
      createdAt: new Date().toISOString(),
      status: "pending",
      proposalType: "unclassified",
      proposedFields: {},
      sourceType: "email"
    });
    const draft: ProposalDraft = {
      ...baseDraft(state),
      proposalType: "deliverable",
      title: "Assessment 3",
      externalDeadlineAt: "2026-09-14T09:00:00.000Z",
      notes: "Covers modules 4-6."
    };
    const confirmed = confirmProposal(state, "capture-1", draft, "2026-08-08T09:00:00.000Z");
    expect(confirmed.deliverables).toHaveLength(state.deliverables.length + 1);
    const created = confirmed.deliverables.at(-1)!;
    expect(created).toMatchObject({
      projectId: state.projects[0]!.id,
      title: "Assessment 3",
      status: "needs_breakdown",
      externalDeadlineAt: "2026-09-14T09:00:00.000Z",
      details: "Covers modules 4-6."
    });
    expect(confirmed.captures[0]).toMatchObject({ status: "confirmed", proposalType: "deliverable" });
  });

  it("requires a project before a deliverable proposal can be confirmed", () => {
    const state = createSeedState();
    const draft: ProposalDraft = { ...baseDraft(state), proposalType: "deliverable", projectId: "" };
    expect(validateProposal(state, draft)).toBe("Choose the project this deliverable belongs to.");
  });

  it("leaves event/action proposals unaffected by the deliverable branch", () => {
    const state = createSeedState();
    state.captures.push({
      id: "capture-1",
      text: "Read assignment brief",
      createdAt: new Date().toISOString(),
      status: "pending",
      proposalType: "unclassified",
      proposedFields: {},
      sourceType: "manual_capture"
    });
    const confirmed = confirmProposal(state, "capture-1", baseDraft(state), "2026-08-08T09:00:00.000Z");
    expect(confirmed.deliverables).toHaveLength(state.deliverables.length);
    expect(confirmed.actions).toHaveLength(3);
  });
});
