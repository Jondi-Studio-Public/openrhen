import { describe, expect, it } from "vitest";
import { registerPortalExtension } from "@/state/portal-extensions";
import { createSeedState, type CaptureItem, type PortalState } from "@/state/portal-state";
import {
  canUndoIgnore,
  captureIgnoreCommand,
  captureKeepAgainCommand,
  captureReopenCommand,
  captureRestoreCommand,
  captureUnignoreCommand,
  captureReviewCommand,
  emailChangeConfirmCommand,
  isKeptForLater,
  isReplaced
} from "@/features/capture/capture-commands";
import { emptyProposalDraft } from "@/features/capture/proposal-draft";
import type { ProposalDraft } from "@/features/capture/proposals";

const seed = () => createSeedState(new Date("2026-08-19T00:00:00.000Z"));

const captureFixture = (overrides: Partial<CaptureItem> = {}): CaptureItem =>
  ({
    id: "proposal-1",
    version: 3,
    status: "pending",
    createdAt: "2026-08-19T10:00:00.000Z",
    reviewedAt: undefined,
    proposalType: "action",
    text: "Learn the guitar",
    proposedFields: {
      title: "Learn the guitar",
      projectId: "music",
      expectedMinutes: 30
    },
    ...overrides
  }) as unknown as CaptureItem;

describe("captureReviewCommand", () => {
  it("claims the capture's own version and names the normalized proposal", () => {
    const state: PortalState = { ...seed(), captures: [captureFixture({ version: 2 })] };
    const draft: ProposalDraft = {
      ...emptyProposalDraft(),
      proposalType: "action",
      title: "Learn guitar",
      projectId: "music"
    };
    const command = captureReviewCommand("proposal-1", draft, state);
    expect(command).not.toBeNull();
    expect(command?.expectedVersion).toBe(2);
    expect(command?.entityType).toBe("capture_review");
    expect(command?.entity).toMatchObject({
      id: "proposal-1",
      proposalType: "action",
      draft
    });
  });

  it("saves against no expected version when the capture has never been stored", () => {
    const state: PortalState = { ...seed(), captures: [captureFixture({ version: undefined })] };
    const draft: ProposalDraft = { ...emptyProposalDraft(), proposalType: "action" };
    const command = captureReviewCommand("proposal-1", draft, state);
    expect(command?.expectedVersion).toBeNull();
  });

  it("asks for a tentative commitment only when confirming as tentative", () => {
    const state: PortalState = { ...seed(), captures: [captureFixture()] };
    const draft: ProposalDraft = { ...emptyProposalDraft(), proposalType: "fixed_commitment" };
    expect(captureReviewCommand("proposal-1", draft, state)?.entity).not.toHaveProperty("commitmentStatus");
    expect(captureReviewCommand("proposal-1", draft, state, true)?.entity).toMatchObject({
      commitmentStatus: "tentative"
    });
  });

  it("returns null when the capture is no longer available", () => {
    const state: PortalState = seed();
    const draft: ProposalDraft = { ...emptyProposalDraft(), proposalType: "action" };
    const command = captureReviewCommand("proposal-1", draft, state);
    expect(command).toBeNull();
  });
});

describe("captureIgnoreCommand", () => {
  it("marks the capture ignored with the original proposal metadata and the provided timestamp", () => {
    const state: PortalState = { ...seed(), captures: [captureFixture({ version: 2 })] };
    const reviewedAt = "2026-08-20T15:30:00.000Z";
    const command = captureIgnoreCommand("proposal-1", reviewedAt, state);
    expect(command).not.toBeNull();
    expect(command?.expectedVersion).toBe(2);
    expect(command?.entityType).toBe("capture");
    expect(command?.entity).toMatchObject({
      id: "proposal-1",
      status: "ignored",
      proposalType: "action",
      proposedFields: {
        title: "Learn the guitar",
        projectId: "music",
        expectedMinutes: 30
      },
      reviewedAt: "2026-08-20T15:30:00.000Z"
    });
  });

  it("saves against no expected version when the capture has never been stored", () => {
    const state: PortalState = { ...seed(), captures: [captureFixture({ version: undefined })] };
    const command = captureIgnoreCommand("proposal-1", "2026-08-20T15:30:00.000Z", state);
    expect(command?.expectedVersion).toBeNull();
  });

  it("returns null when the capture is no longer available", () => {
    const state: PortalState = seed();
    const command = captureIgnoreCommand("proposal-1", "2026-08-20T15:30:00.000Z", state);
    expect(command).toBeNull();
  });
});

registerPortalExtension({ id: "example-restricted", notRestorableSourceTypes: ["restricted"] });

describe("canUndoIgnore", () => {
  it.each([
    ["manual", true],
    ["ai_extraction", true],
    ["mail_thread", true],
    ["restricted", false]
  ])("a %s capture: %s", (sourceType, expected) => {
    expect(canUndoIgnore(captureFixture({ sourceType }))).toBe(expected);
  });

  it("is false for a capture that is not there", () => {
    expect(canUndoIgnore(undefined)).toBe(false);
  });
});

describe("captureUnignoreCommand", () => {
  it("puts an ignored proposal back to pending against its own version, without a review time", () => {
    const state: PortalState = {
      ...seed(),
      captures: [captureFixture({ status: "ignored", sourceType: "manual", reviewedAt: "2026-08-20T15:30:00.000Z" })]
    };
    const command = captureUnignoreCommand("proposal-1", state);
    expect(command?.expectedVersion).toBe(3);
    expect(command?.type).toBe("save_entity");
    expect(command?.entityType).toBe("capture");
    expect(command?.entity).toMatchObject({
      id: "proposal-1",
      status: "pending",
      proposalType: "action",
      proposedFields: { title: "Learn the guitar" }
    });
    expect(command?.entity).not.toHaveProperty("reviewedAt");
  });

  it("saves against no expected version when the capture has never been stored", () => {
    const state: PortalState = { ...seed(), captures: [captureFixture({ status: "ignored", version: undefined })] };
    expect(captureUnignoreCommand("proposal-1", state)?.expectedVersion).toBeNull();
  });

  it("refuses a capture that is not ignored, cannot be undone exactly, or is missing", () => {
    const only = (overrides: Partial<CaptureItem>): PortalState => ({
      ...seed(),
      captures: [captureFixture(overrides)]
    });
    expect(captureUnignoreCommand("proposal-1", only({ status: "pending" }))).toBeNull();
    expect(captureUnignoreCommand("proposal-1", only({ status: "confirmed" }))).toBeNull();
    expect(captureUnignoreCommand("proposal-1", only({ status: "ignored", sourceType: "restricted" }))).toBeNull();
    expect(captureUnignoreCommand("proposal-1", seed())).toBeNull();
  });
});

describe("captureKeepAgainCommand", () => {
  const kept = captureFixture({
    status: "confirmed",
    proposalType: "reference",
    reviewedAt: "2026-08-19T11:00:00.000Z"
  });

  it("files a dropped item again as it was kept, against the version it has now", () => {
    const state: PortalState = {
      ...seed(),
      captures: [{ ...kept, status: "ignored", version: 4, reviewedAt: "2026-08-20T09:00:00.000Z" }]
    };
    const command = captureKeepAgainCommand(kept, state);
    expect(command?.expectedVersion).toBe(4);
    expect(command?.entity).toMatchObject({
      id: "proposal-1",
      status: "confirmed",
      proposalType: "reference",
      reviewedAt: "2026-08-19T11:00:00.000Z"
    });
  });

  it("refuses an item that is gone or still kept", () => {
    expect(captureKeepAgainCommand(kept, { ...seed(), captures: [] })).toBeNull();
    expect(captureKeepAgainCommand(kept, { ...seed(), captures: [kept] })).toBeNull();
  });
});

describe("captureReopenCommand", () => {
  it("sends a kept Someday item back to pending against its own version, without a review time", () => {
    const state: PortalState = {
      ...seed(),
      captures: [
        captureFixture({ status: "confirmed", proposalType: "someday", reviewedAt: "2026-08-19T11:00:00.000Z" })
      ]
    };
    const command = captureReopenCommand("proposal-1", state);
    expect(command?.expectedVersion).toBe(3);
    expect(command?.entityType).toBe("capture");
    expect(command?.entity).toMatchObject({ id: "proposal-1", status: "pending", proposalType: "someday" });
    expect(command?.entity).not.toHaveProperty("reviewedAt");
  });

  it("refuses anything that is not a kept Someday or Reference item", () => {
    const confirmedAction: PortalState = { ...seed(), captures: [captureFixture({ status: "confirmed" })] };
    const ignoredSomeday: PortalState = {
      ...seed(),
      captures: [captureFixture({ status: "ignored", proposalType: "someday" })]
    };
    expect(captureReopenCommand("proposal-1", confirmedAction)).toBeNull();
    expect(captureReopenCommand("proposal-1", ignoredSomeday)).toBeNull();
    expect(captureReopenCommand("proposal-1", seed())).toBeNull();
  });
});

describe("isKeptForLater", () => {
  it("is true only for confirmed Someday and Reference items", () => {
    expect(isKeptForLater(captureFixture({ status: "confirmed", proposalType: "reference" }))).toBe(true);
    expect(isKeptForLater(captureFixture({ status: "confirmed", proposalType: "someday" }))).toBe(true);
    expect(isKeptForLater(captureFixture({ status: "pending", proposalType: "someday" }))).toBe(false);
    expect(isKeptForLater(captureFixture({ status: "confirmed", proposalType: "action" }))).toBe(false);
  });
});

describe("emailChangeConfirmCommand", () => {
  it("confirms a reasoning change at the version in hand, carrying the answers", () => {
    const command = emailChangeConfirmCommand(captureFixture({ proposalType: "email_change" }), {
      endsAt: "2026-10-02T05:00:00.000Z"
    });
    expect(command).toMatchObject({
      expectedVersion: 3,
      type: "save_entity",
      entityType: "capture_review",
      entity: { id: "proposal-1", proposalType: "email_change", answers: { endsAt: "2026-10-02T05:00:00.000Z" } }
    });
  });
});

describe("captureRestoreCommand", () => {
  it("sends a replaced proposal back to pending against its own version, flagged as a restore", () => {
    const state: PortalState = {
      ...seed(),
      captures: [
        captureFixture({
          status: "superseded",
          proposalType: "email_change",
          reviewedAt: "2026-08-19T11:00:00.000Z"
        })
      ]
    };
    const command = captureRestoreCommand("proposal-1", state);
    expect(command?.expectedVersion).toBe(3);
    expect(command?.entityType).toBe("capture");
    expect(command?.entity).toMatchObject({ id: "proposal-1", status: "pending", restore: true });
    expect(command?.entity).not.toHaveProperty("reviewedAt");
  });

  it("refuses a pending, confirmed or ignored proposal, and one that is gone", () => {
    for (const status of ["pending", "confirmed", "ignored"] as const) {
      const state: PortalState = { ...seed(), captures: [captureFixture({ status })] };
      expect(captureRestoreCommand("proposal-1", state)).toBeNull();
    }
    expect(captureRestoreCommand("proposal-1", seed())).toBeNull();
  });
});

describe("isReplaced", () => {
  it("is true only for a superseded proposal", () => {
    expect(isReplaced(captureFixture({ status: "superseded" }))).toBe(true);
    expect(isReplaced(captureFixture({ status: "pending" }))).toBe(false);
    expect(isReplaced(captureFixture({ status: "ignored" }))).toBe(false);
  });
});
