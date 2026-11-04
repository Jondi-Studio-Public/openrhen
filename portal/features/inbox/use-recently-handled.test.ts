import { describe, expect, it, vi } from "vitest";
import type { CaptureItem } from "@/state/portal-state";
import { FAKE_MAIL_SOURCE_TYPE, registerFakeMailSource } from "@/test/fake-mail-source";
import { proposalTypeLabel, splitHandled, splitReplaced } from "./use-recently-handled";

// The core Inbox only: the seam is stubbed empty, as it is in the OpenRhen export, and a stand-in mail source is registered.
vi.mock("@/state/private/index", () => ({}));
registerFakeMailSource();

const NOW = Date.parse("2026-08-18T09:00:00.000Z");

const capture = (overrides: Partial<CaptureItem> = {}): CaptureItem => ({
  id: "c",
  text: "A thought",
  status: "confirmed",
  proposalType: "action",
  proposedFields: {},
  sourceType: "manual",
  createdAt: "2026-08-01T00:00:00.000Z",
  reviewedAt: "2026-08-17T00:00:00.000Z",
  ...overrides
});

describe("proposalTypeLabel", () => {
  it("names a proposal type in the words the review form uses", () => {
    expect(proposalTypeLabel("fixed_commitment")).toBe("Fixed commitment");
    expect(proposalTypeLabel("email_change")).toBe("Email change");
    expect(proposalTypeLabel("action")).toBe("Action");
  });
});

describe("splitHandled", () => {
  it("says the original is kept, without the stored type word", () => {
    const { captured } = splitHandled([capture({ proposalType: "fixed_commitment" })], NOW);
    expect(captured[0]!.detail).toBe("Fixed commitment · the original is kept");
  });

  it("counts from when a proposal was decided, not when it was captured, newest first", () => {
    const { captured } = splitHandled(
      [
        capture({
          id: "captured-newest",
          createdAt: "2026-08-17T00:00:00.000Z",
          reviewedAt: "2026-08-17T09:00:00.000Z"
        }),
        capture({
          id: "captured-oldest",
          createdAt: "2026-08-01T00:00:00.000Z",
          reviewedAt: "2026-08-18T08:00:00.000Z"
        }),
        capture({ id: "middle", createdAt: "2026-08-10T00:00:00.000Z", reviewedAt: "2026-08-17T12:00:00.000Z" })
      ],
      NOW
    );
    expect(captured.map((row) => row.id)).toEqual(["captured-oldest", "middle", "captured-newest"]);
  });

  it("drops what was handled more than 7 days ago and what is still pending", () => {
    const { captured } = splitHandled(
      [
        capture({ id: "old", reviewedAt: "2026-08-10T00:00:00.000Z" }),
        capture({ id: "edge", reviewedAt: "2026-08-11T10:00:00.000Z" }),
        capture({ id: "pending", status: "pending", reviewedAt: undefined, createdAt: "2026-08-17T00:00:00.000Z" })
      ],
      NOW
    );
    expect(captured.map((row) => row.id)).toEqual(["edge"]);
  });

  it("falls back to the capture time for a row with no reviewedAt yet", () => {
    const { captured } = splitHandled(
      [capture({ id: "no-reviewed-at", createdAt: "2026-08-17T00:00:00.000Z", reviewedAt: undefined })],
      NOW
    );
    expect(captured.map((row) => row.id)).toEqual(["no-reviewed-at"]);
  });

  it("scopes each room: thread changes to Emails, dropped kept items to Someday & reference", () => {
    const out = splitHandled(
      [
        capture({ id: "thread", proposalType: "email_change", sourceType: FAKE_MAIL_SOURCE_TYPE, sourceId: "t1" }),
        capture({ id: "ignored-capture", status: "ignored" }),
        capture({ id: "dropped", status: "ignored", proposalType: "someday" }),
        capture({ id: "still-filed", status: "confirmed", proposalType: "reference" })
      ],
      NOW
    );
    expect(out.emails.map((row) => row.id)).toEqual(["thread"]);
    expect(out.captured.map((row) => row.id)).toEqual(["ignored-capture"]);
    expect(out.kept.map((row) => row.id)).toEqual(["dropped"]);
  });

  it("titles a row by its corrected title and carries the outcome", () => {
    const { captured } = splitHandled(
      [capture({ proposedFields: { title: "Dentist visit" }, status: "ignored" })],
      NOW
    );
    expect(captured[0]).toMatchObject({ title: "Dentist visit", outcome: "ignored" });
  });
});

describe("splitReplaced", () => {
  const replaced = (overrides: Partial<CaptureItem> = {}) =>
    capture({
      status: "superseded",
      proposalType: "email_change",
      sourceType: FAKE_MAIL_SOURCE_TYPE,
      reviewedAt: "2026-08-17T00:00:00.000Z",
      ...overrides
    });

  it("lists mail proposals replaced in the last 7 days, newest first, counted from when they were replaced", () => {
    const rows = splitReplaced(
      [
        replaced({ id: "older", reviewedAt: "2026-08-16T00:00:00.000Z" }),
        replaced({ id: "newer", reviewedAt: "2026-08-18T08:00:00.000Z" }),
        replaced({ id: "legacy", sourceType: "mail", reviewedAt: "2026-08-17T12:00:00.000Z" }),
        replaced({ id: "stale", reviewedAt: "2026-08-10T00:00:00.000Z" })
      ],
      NOW
    );
    expect(rows.map((row) => row.id)).toEqual(["newer", "legacy", "older"]);
    expect(rows[0]).toMatchObject({ outcome: "replaced", at: "2026-08-18T08:00:00.000Z" });
  });

  it("leaves out everything that is not a replaced mail proposal", () => {
    const rows = splitReplaced(
      [
        replaced({ id: "pending", status: "pending" }),
        replaced({ id: "confirmed", status: "confirmed" }),
        replaced({ id: "ignored", status: "ignored" }),
        replaced({ id: "manual", sourceType: "manual_capture" })
      ],
      NOW
    );
    expect(rows).toEqual([]);
  });
});
