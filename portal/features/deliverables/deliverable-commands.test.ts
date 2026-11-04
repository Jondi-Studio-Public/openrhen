import { describe, expect, it } from "vitest";
import type { StoredDeliverableContractProposal } from "@/state/portal-state";
import { deliverable, session } from "@/features/deliverables/test-fixtures";
import {
  deliverablePersistCommand,
  finishActivityCommand,
  pauseResumeSessionCommand,
  reviewProposalCommand,
  switchDeliverableStepCommand
} from "@/features/deliverables/deliverable-commands";

const proposal = (overrides: Partial<StoredDeliverableContractProposal> = {}): StoredDeliverableContractProposal => ({
  id: "proposal-1",
  version: 2,
  sourceId: "source-1",
  status: "pending",
  key: "budget",
  title: "Stay under budget",
  required: true,
  basis: "explicit",
  confidence: "high",
  evidence: [],
  sourceType: "email",
  createdAt: "2026-08-17T00:00:00.000Z",
  ...overrides
});

describe("deliverablePersistCommand", () => {
  it("claims the version it is given, not the version on the body it is handed", () => {
    // The body carries version 9 (say, a stale draft's own idea of the record); the caller states it
    // actually read version 3. If the builder ever goes back to reading `deliverable.version` instead
    // of its own parameter, this assertion catches it.
    const body = deliverable({ version: 9 });
    const command = deliverablePersistCommand(body, 3);
    expect(command.expectedVersion).toBe(3);
    expect(command.expectedVersion).not.toBe(body.version);
  });

  it("saves against no expected version when the caller passes null (the insert case)", () => {
    const command = deliverablePersistCommand(deliverable(), null);
    expect(command.expectedVersion).toBeNull();
  });

  it("restates the whole aggregate as the entity, unchanged", () => {
    const body = deliverable({ title: "Assessment 2", status: "in_progress" });
    const command = deliverablePersistCommand(body, body.version ?? null);
    expect(command.entityType).toBe("deliverable");
    expect(command.entity).toMatchObject({ id: body.id, title: "Assessment 2", status: "in_progress" });
  });
});

describe("finishActivityCommand", () => {
  it("claims the session's own version", () => {
    const command = finishActivityCommand(session({ version: 5 }), "completed");
    expect(command.expectedVersion).toBe(5);
  });

  it("saves against no expected version when the session has never been stored", () => {
    const command = finishActivityCommand(session({ version: undefined }), "completed");
    expect(command.expectedVersion).toBeNull();
  });

  it("includes the fixed note markComplete always sends", () => {
    const command = finishActivityCommand(session(), "completed", "Deliverable marked complete.");
    expect(command).toMatchObject({
      type: "finish_activity",
      sessionId: "session-1",
      outcome: "completed",
      note: "Deliverable marked complete."
    });
  });

  it("omits note when finish's note is blank", () => {
    const command = finishActivityCommand(session(), "stopped", "   ");
    expect(command).not.toHaveProperty("note");
  });

  it("trims a non-blank note from finish", () => {
    const command = finishActivityCommand(session(), "blocked", "  Waiting on a reply  ");
    expect((command as { note?: string }).note).toBe("Waiting on a reply");
  });

  it("includes endedAt only when finish provides one", () => {
    const withEnd = finishActivityCommand(session(), "completed", "", "2026-08-18T09:10:00.000Z");
    expect((withEnd as { endedAt?: string }).endedAt).toBe("2026-08-18T09:10:00.000Z");
    const withoutEnd = finishActivityCommand(session(), "completed", "");
    expect(withoutEnd).not.toHaveProperty("endedAt");
  });
});

describe("reviewProposalCommand", () => {
  it("claims the proposal's own version when no draft has replaced it", () => {
    const stored = proposal({ version: 2 });
    const command = reviewProposalCommand(stored, stored, "confirm");
    expect(command.expectedVersion).toBe(2);
    expect(command.entityType).toBe("deliverable_contract_review");
    expect(command.entity).toMatchObject({ id: "proposal-1", decision: "confirm", criterion: stored });
  });

  it("claims the seeded draft's version, not the live proposal's — the fourth instance", () => {
    const live = proposal({ version: 4 });
    // `criterion` is what `proposalDrafts[proposal.id]` held: seeded at version 2, before the live
    // proposal moved to 4 underneath it. Nothing on the page reseeds `proposalDrafts`, so the version
    // that must be sent is the seeded one.
    const draft = proposal({ version: 2, title: "Stay well under budget" });
    const command = reviewProposalCommand(live, draft, "ignore");
    expect(command.expectedVersion).toBe(2);
    expect(command.expectedVersion).not.toBe(live.version);
    expect(command.entity).toMatchObject({ id: "proposal-1", decision: "ignore", criterion: draft });
  });
});

describe("switchDeliverableStepCommand", () => {
  it("claims the session's own version", () => {
    const command = switchDeliverableStepCommand(session({ version: 6 }), "step-2");
    expect(command).toMatchObject({ type: "switch_deliverable_step", sessionId: "session-1", stepId: "step-2" });
    expect(command.expectedVersion).toBe(6);
  });

  it("saves against no expected version when the session has never been stored", () => {
    const command = switchDeliverableStepCommand(session({ version: undefined }), "step-2");
    expect(command.expectedVersion).toBeNull();
  });
});

describe("pauseResumeSessionCommand", () => {
  it("resumes a paused session", () => {
    const command = pauseResumeSessionCommand(session({ status: "paused" }));
    expect(command).toMatchObject({ type: "resume_activity", sessionId: "session-1" });
  });

  it("pauses a running session", () => {
    const command = pauseResumeSessionCommand(session({ status: "running" }));
    expect(command.type).toBe("pause_activity");
  });

  it("claims the session's own version either way", () => {
    const command = pauseResumeSessionCommand(session({ version: 7, status: "paused" }));
    expect(command.expectedVersion).toBe(7);
  });
});
