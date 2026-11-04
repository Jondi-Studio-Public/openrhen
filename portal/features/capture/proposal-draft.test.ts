import { describe, expect, it } from "vitest";
import type { CaptureItem } from "@/state/portal-state";
import { emptyProposalDraft, normalizeProposalDraft, proposalDraftFromCapture } from "./proposal-draft";

const capture = (overrides: Partial<CaptureItem> = {}): CaptureItem => ({
  id: "c1",
  text: "Renew passport",
  status: "pending",
  proposalType: "unclassified",
  proposedFields: {},
  sourceType: "manual",
  createdAt: "2026-08-18T01:00:00.000Z",
  ...overrides
});

describe("proposalDraftFromCapture", () => {
  it("starts from the capture's own text when nothing has been proposed yet", () => {
    expect(proposalDraftFromCapture(capture())).toEqual({
      ...emptyProposalDraft(),
      proposalType: "unclassified",
      title: "Renew passport"
    });
  });

  it("takes what an earlier proposal filled in, cut to what a datetime-local input can hold", () => {
    const draft = proposalDraftFromCapture(
      capture({
        proposalType: "action",
        proposedFields: {
          title: "Renew the passport",
          projectId: "p1",
          expectedMinutes: 20,
          pessimisticMinutes: 40,
          energy: "low",
          externalDeadlineAt: "2026-09-01T09:30:00.000Z",
          value: "not a number",
          startsAt: 12
        }
      })
    );
    expect(draft).toMatchObject({
      proposalType: "action",
      title: "Renew the passport",
      projectId: "p1",
      expectedMinutes: 20,
      pessimisticMinutes: 40,
      energy: "low",
      externalDeadlineAt: "2026-09-01T09:30",
      value: 3,
      startsAt: ""
    });
  });

  it("falls back to medium energy for an unknown value", () => {
    expect(proposalDraftFromCapture(capture({ proposedFields: { energy: "frantic" } })).energy).toBe("medium");
  });
});

describe("normalizeProposalDraft", () => {
  it("turns filled local date-times into instants and leaves blanks blank", () => {
    const draft = { ...emptyProposalDraft(), startsAt: "2026-08-20T10:00", externalDeadlineAt: "" };
    const normalized = normalizeProposalDraft(draft);
    expect(normalized.startsAt).toBe(new Date("2026-08-20T10:00").toISOString());
    expect(normalized.externalDeadlineAt).toBe("");
    expect(normalized.endsAt).toBe("");
  });
});
