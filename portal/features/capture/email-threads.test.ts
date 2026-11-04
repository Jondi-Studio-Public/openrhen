import { describe, expect, it, vi } from "vitest";
import type { CaptureItem } from "@/state/portal-state";
import { FAKE_MAIL_SOURCE_TYPE, registerFakeMailSource } from "@/test/fake-mail-source";
import { groupEmailThreads, isEmailThreadChange } from "./email-threads";

// The core Inbox only: the seam is stubbed empty, as it is in the OpenRhen export, and a stand-in mail source is registered.
vi.mock("@/state/private/index", () => ({}));
registerFakeMailSource();

const item = (id: string, sourceId: string, extra: Partial<CaptureItem> = {}): CaptureItem => ({
  id,
  version: 1,
  text: id,
  status: "pending",
  proposalType: "email_change",
  proposedFields: { ref: id, subject: `Subject ${sourceId}` },
  sourceType: FAKE_MAIL_SOURCE_TYPE,
  sourceId,
  createdAt: "2026-09-10T01:00:00.000Z",
  ...extra
});

describe("email thread grouping", () => {
  it("claims only email_change items the registered mail source owns", () => {
    expect(isEmailThreadChange(item("a", "s1"))).toBe(true);
    expect(isEmailThreadChange(item("a", "s1", { proposalType: "action" }))).toBe(false);
    expect(isEmailThreadChange(item("a", "s1", { sourceType: "manual_capture" }))).toBe(false);
  });

  it("needs a source id to be a thread change", () => {
    expect(isEmailThreadChange(item("a", "", { sourceId: "" }))).toBe(false);
  });

  it("keeps first-seen order", () => {
    const groups = groupEmailThreads([item("a", "s2"), item("b", "s1"), item("c", "s2")]);
    expect(groups.map((g) => [g.sourceId, g.items.map((i) => i.id)])).toEqual([
      ["s2", ["a", "c"]],
      ["s1", ["b"]]
    ]);
  });

  it("leaves out changes with no source", () => {
    expect(groupEmailThreads([item("a", "s1"), item("b", "", { sourceId: "" })]).map((g) => g.sourceId)).toEqual([
      "s1"
    ]);
  });
});
